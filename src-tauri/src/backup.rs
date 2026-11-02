//! JSON 备份 / 恢复（V0.4）。
//!
//! 备份文件包含全部看板、列表、任务（含回收站中的软删除任务）和收件箱，
//! 导入时先完整校验，再在一个事务里「清空 + 全量写回」，失败自动回滚。
//!
//! 文件格式与前端 `src/lib/backup.ts` 保持一致：
//! `{ app: "tideline", formatVersion: 1, exportedAt, boards, lists, cards, inbox }`

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::models::*;
use crate::repo;

pub const BACKUP_APP: &str = "tideline";
pub const BACKUP_FORMAT_VERSION: u32 = 1;

/// 组装全量备份；`cards` 来自 `get_all_cards`，因此回收站也会被带上。
pub fn build(conn: &Connection) -> Result<BackupFile, String> {
    let snapshot = repo::get_snapshot(conn)?;
    Ok(BackupFile {
        app: BACKUP_APP.to_string(),
        format_version: BACKUP_FORMAT_VERSION,
        exported_at: repo::now_iso(),
        boards: snapshot.boards,
        lists: snapshot.lists,
        cards: repo::get_all_cards(conn)?,
        inbox: snapshot.inbox,
        dependencies: repo::get_dependencies(conn)?,
        board_sets: repo::get_board_sets(conn)?,
        goals: repo::get_goals(conn)?,
        team_members: repo::get_team_members(conn)?,
        overtime_records: repo::get_overtime_records(conn)?,
        performance_records: repo::get_performance_records(conn)?,
        member_tenures: repo::get_member_tenures(conn)?,
        projects: repo::get_projects(conn)?,
        project_meta_fields: repo::get_all_project_meta(conn)?,
        project_roles: repo::get_all_project_roles(conn)?,
        recurrences: crate::automation::get_recurrences(conn)?,
        automation_rules: crate::automation::get_automation_rules(conn)?,
        card_activity: crate::automation::get_all_card_activity(conn)?,
        custom_fields: repo::get_all_custom_fields(conn)?,
        card_field_values: repo::get_all_card_field_values(conn)?,
        saved_views: repo::get_all_saved_views(conn)?,
    })
}

impl BackupFile {
    pub fn summary(&self) -> BackupSummary {
        BackupSummary {
            boards: self.boards.len(),
            lists: self.lists.len(),
            cards: self.cards.len(),
            trashed: self.cards.iter().filter(|card| card.deleted_at.is_some()).count(),
            inbox: self.inbox.len(),
            dependencies: self.dependencies.len(),
            board_sets: self.board_sets.len(),
            goals: self.goals.len(),
            team_members: self.team_members.len(),
            overtime_records: self.overtime_records.len(),
            performance_records: self.performance_records.len(),
            member_tenures: self.member_tenures.len(),
            projects: self.projects.len(),
            project_meta_fields: self.project_meta_fields.len(),
            project_roles: self.project_roles.len(),
            recurrences: self.recurrences.len(),
            automation_rules: self.automation_rules.len(),
            card_activity: self.card_activity.len(),
            custom_fields: self.custom_fields.len(),
            card_field_values: self.card_field_values.len(),
            saved_views: self.saved_views.len(),
        }
    }
}

/// 依赖图是否含环（DFS 三色标记）。
fn dependency_graph_has_cycle(edges: &HashMap<String, Vec<String>>) -> bool {
    fn visit(
        node: &str,
        edges: &HashMap<String, Vec<String>>,
        states: &mut HashMap<String, u8>,
    ) -> bool {
        match states.get(node).copied().unwrap_or(0) {
            1 => return true,
            2 => return false,
            _ => {}
        }
        states.insert(node.to_string(), 1);
        if let Some(next) = edges.get(node) {
            for neighbor in next {
                if visit(neighbor, edges, states) {
                    return true;
                }
            }
        }
        states.insert(node.to_string(), 2);
        false
    }

    let mut states = HashMap::new();
    for node in edges.keys() {
        if visit(node, edges, &mut states) {
            return true;
        }
    }
    false
}

/// 兼容 V0.8 旧备份：旧备份只有团队人员/加班/绩效，没有项目、角色与项目归属。
/// 恢复前先补一个默认项目与默认角色，并把旧记录归入默认项目。
fn normalize_legacy_backup(backup: &mut BackupFile) {
    let has_legacy_team = !backup.team_members.is_empty()
        || !backup.overtime_records.is_empty()
        || !backup.performance_records.is_empty();
    if backup.projects.is_empty() && has_legacy_team {
        let default_project_id = "p_default".to_string();
        backup.projects.push(Project {
            id: default_project_id,
            name: "默认项目".to_string(),
            description: "由 V0.8 项目组数据自动迁移".to_string(),
            color: "#0f766e".to_string(),
            status: ProjectStatus::Active,
            starred: false,
            created_at: backup.exported_at.clone(),
            updated_at: backup.exported_at.clone(),
        });
    }
    if backup.projects.is_empty() {
        return;
    }
    let fallback_project_id = backup.projects[0].id.clone();
    let default_roles = [
        ("开发", "#2f6fd0"),
        ("测试", "#9a6512"),
        ("需求", "#0f766e"),
        ("设计", "#5a48c9"),
        ("其他", "#64748b"),
    ];
    let role_for_legacy = |role: MemberRole| -> &'static str {
        match role {
            MemberRole::Dev => "开发",
            MemberRole::Test => "测试",
            MemberRole::Requirements => "需求",
            MemberRole::Design => "设计",
            MemberRole::Other => "其他",
        }
    };

    for member in &mut backup.team_members {
        if member.project_id.trim().is_empty()
            || !backup.projects.iter().any(|project| project.id == member.project_id)
        {
            member.project_id = fallback_project_id.clone();
        }
        let has_roles = backup
            .project_roles
            .iter()
            .any(|role| role.project_id == member.project_id);
        if !has_roles {
            for (index, (name, color)) in default_roles.iter().enumerate() {
                backup.project_roles.push(ProjectRole {
                    id: format!("pr_mig_{}_{}", member.project_id, index),
                    project_id: member.project_id.clone(),
                    name: name.to_string(),
                    color: color.to_string(),
                    position: index as i64,
                    created_at: backup.exported_at.clone(),
                    updated_at: backup.exported_at.clone(),
                });
            }
        }
        let role_still_valid = backup.project_roles.iter().any(|role| {
            role.id == member.role_id && role.project_id == member.project_id
        });
        if !role_still_valid {
            let legacy_name = role_for_legacy(member.role);
            let replacement = backup
                .project_roles
                .iter()
                .find(|role| {
                    role.project_id == member.project_id && role.name == legacy_name
                })
                .or_else(|| {
                    backup
                        .project_roles
                        .iter()
                        .find(|role| role.project_id == member.project_id)
                });
            member.role_id = replacement.map(|role| role.id.clone()).unwrap_or_default();
        }
    }

    let member_projects: HashMap<String, String> = backup
        .team_members
        .iter()
        .map(|member| (member.id.clone(), member.project_id.clone()))
        .collect();

    // 旧备份或早期 V0.8.3 备份缺失时间段时，用成员的入组/出组字段补首段。
    let members_for_tenure = backup.team_members.clone();
    for member in &members_for_tenure {
        let has_tenure = backup
            .member_tenures
            .iter()
            .any(|tenure| tenure.member_id == member.id);
        if has_tenure {
            continue;
        }
        let ended_at = if member.status == MemberStatus::Released {
            member.released_at.clone().or_else(|| Some(member.joined_at.clone()))
        } else {
            None
        };
        backup.member_tenures.push(MemberTenure {
            id: format!("mt_bak_{}", member.id),
            member_id: member.id.clone(),
            project_id: member.project_id.clone(),
            started_at: member.joined_at.clone(),
            ended_at,
            note: "由旧备份成员记录补全".to_string(),
            created_at: backup.exported_at.clone(),
            updated_at: backup.exported_at.clone(),
        });
    }
    for tenure in &mut backup.member_tenures {
        if tenure.project_id.trim().is_empty() {
            tenure.project_id = member_projects
                .get(&tenure.member_id)
                .cloned()
                .unwrap_or_else(|| fallback_project_id.clone());
        }
    }

    for record in &mut backup.overtime_records {
        if record.project_id.trim().is_empty() {
            record.project_id = member_projects
                .get(&record.member_id)
                .cloned()
                .unwrap_or_else(|| fallback_project_id.clone());
        }
    }
    for record in &mut backup.performance_records {
        if record.project_id.trim().is_empty() {
            record.project_id = member_projects
                .get(&record.member_id)
                .cloned()
                .unwrap_or_else(|| fallback_project_id.clone());
        }
    }
}

/// 备份文件结构 / 引用完整性校验。导入前必须先调用，避免半套数据写进库。
pub fn validate(backup: &BackupFile) -> Result<(), String> {
    if backup.app != BACKUP_APP {
        return Err("这不是潮线 tideline 的备份文件（app 字段不匹配）".to_string());
    }
    if backup.format_version != BACKUP_FORMAT_VERSION {
        return Err(format!(
            "备份格式版本 {} 不受支持，当前仅支持版本 {}",
            backup.format_version, BACKUP_FORMAT_VERSION
        ));
    }

    let mut board_ids = HashSet::new();
    for board in &backup.boards {
        if board.id.trim().is_empty() {
            return Err("备份中存在空的看板 id".to_string());
        }
        if !board_ids.insert(board.id.as_str()) {
            return Err(format!("备份中存在重复的看板 id：{}", board.id));
        }
    }

    let mut list_board: HashMap<&str, &str> = HashMap::new();
    let mut list_ids = HashSet::new();
    for list in &backup.lists {
        if list.id.trim().is_empty() {
            return Err("备份中存在空的列表 id".to_string());
        }
        if !list_ids.insert(list.id.as_str()) {
            return Err(format!("备份中存在重复的列表 id：{}", list.id));
        }
        if !board_ids.contains(list.board_id.as_str()) {
            return Err(format!("列表「{}」引用了不存在的看板", list.title));
        }
        list_board.insert(list.id.as_str(), list.board_id.as_str());
    }

    let mut card_ids = HashSet::new();
    let mut card_board: HashMap<&str, &str> = HashMap::new();
    for card in &backup.cards {
        if card.id.trim().is_empty() {
            return Err("备份中存在空的任务 id".to_string());
        }
        if !card_ids.insert(card.id.as_str()) {
            return Err(format!("备份中存在重复的任务 id：{}", card.id));
        }
        if !board_ids.contains(card.board_id.as_str()) {
            return Err(format!("任务「{}」引用了不存在的看板", card.title));
        }
        let Some(list_board_id) = list_board.get(card.list_id.as_str()) else {
            return Err(format!("任务「{}」引用了不存在的列表", card.title));
        };
        if *list_board_id != card.board_id {
            return Err(format!("任务「{}」的列表与看板不一致", card.title));
        }
        if card.estimated_minutes.is_some_and(|minutes| minutes < 0)
            || card.actual_minutes.is_some_and(|minutes| minutes < 0)
        {
            return Err(format!("任务「{}」的工时分钟数不能为负数", card.title));
        }
        card_board.insert(card.id.as_str(), card.board_id.as_str());
    }

    // V0.11：重复配置与规则引用的任务、列表必须存在。
    let mut recurrence_ids = HashSet::new();
    for recurrence in &backup.recurrences {
        if recurrence.id.trim().is_empty() {
            return Err("备份中存在空的重复配置 id".to_string());
        }
        if !recurrence_ids.insert(recurrence.id.as_str()) {
            return Err(format!("备份中存在重复的重复配置 id：{}", recurrence.id));
        }
        if !card_ids.contains(recurrence.card_id.as_str()) {
            return Err(format!(
                "重复配置引用了不存在的任务：{}",
                recurrence.card_id
            ));
        }
    }
    let mut rule_ids = HashSet::new();
    for rule in &backup.automation_rules {
        if rule.id.trim().is_empty() {
            return Err("备份中存在空的规则 id".to_string());
        }
        if !rule_ids.insert(rule.id.as_str()) {
            return Err(format!("备份中存在重复的规则 id：{}", rule.id));
        }
        if let Some(list_id) = rule.list_id.as_ref() {
            if !list_ids.contains(list_id.as_str()) {
                return Err(format!("规则「{}」引用了不存在的列表", rule.name));
            }
        }
    }
    for activity in &backup.card_activity {
        if !card_ids.contains(activity.card_id.as_str()) {
            return Err(format!(
                "任务活动引用了不存在的任务：{}",
                activity.card_id
            ));
        }
    }

    let mut dependency_edges: HashMap<String, Vec<String>> = HashMap::new();    for dependency in &backup.dependencies {
        if dependency.card_id == dependency.depends_on_card_id {
            return Err("备份中存在任务依赖自己的数据".to_string());
        }
        let Some(card_board_id) = card_board.get(dependency.card_id.as_str()) else {
            return Err(format!("依赖引用了不存在的任务：{}", dependency.card_id));
        };
        let Some(blocker_board_id) = card_board.get(dependency.depends_on_card_id.as_str())
        else {
            return Err(format!(
                "依赖引用了不存在的前置任务：{}",
                dependency.depends_on_card_id
            ));
        };
        // V0.12：放开跨看板限制；只有 blocks 类型参与循环检测。
        let _ = (card_board_id, blocker_board_id);
        if dependency.relation_type.is_blocking() {
            dependency_edges
                .entry(dependency.card_id.clone())
                .or_default()
                .push(dependency.depends_on_card_id.clone());
        }
    }
    if dependency_graph_has_cycle(&dependency_edges) {
        return Err("备份中的任务依赖存在循环".to_string());
    }

    let mut inbox_ids = HashSet::new();
    for item in &backup.inbox {
        if item.id.trim().is_empty() {
            return Err("备份中存在空的收件箱条目 id".to_string());
        }
        if !inbox_ids.insert(item.id.as_str()) {
            return Err(format!("备份中存在重复的收件箱条目 id：{}", item.id));
        }
    }

    let mut set_ids = HashSet::new();
    for set in &backup.board_sets {
        if set.id.trim().is_empty() {
            return Err("备份中存在空的看板集 id".to_string());
        }
        if !set_ids.insert(set.id.as_str()) {
            return Err(format!("备份中存在重复的看板集 id：{}", set.id));
        }
        let mut members = HashSet::new();
        for board_id in &set.board_ids {
            if !members.insert(board_id.as_str()) {
                return Err(format!("看板集「{}」中存在重复的看板", set.title));
            }
            if !board_ids.contains(board_id.as_str()) {
                return Err(format!("看板集「{}」引用了不存在的看板", set.title));
            }
        }
    }

    let mut goal_ids = HashSet::new();
    for goal in &backup.goals {
        if goal.id.trim().is_empty() {
            return Err("备份中存在空的目标 id".to_string());
        }
        if !goal_ids.insert(goal.id.as_str()) {
            return Err(format!("备份中存在重复的目标 id：{}", goal.id));
        }
        let mut linked = HashSet::new();
        for card_id in &goal.card_ids {
            if !linked.insert(card_id.as_str()) {
                return Err(format!("目标「{}」中存在重复的关联任务", goal.title));
            }
            if !card_ids.contains(card_id.as_str()) {
                return Err(format!("目标「{}」关联了不存在的任务", goal.title));
            }
        }
    }
    for goal in &backup.goals {
        if let Some(parent_id) = &goal.parent_id {
            if !goal_ids.contains(parent_id.as_str()) {
                return Err(format!("目标「{}」引用了不存在的父目标", goal.title));
            }
            let mut current = Some(parent_id.clone());
            let mut seen = 0;
            while let Some(id) = current {
                if id == goal.id {
                    return Err("备份中的目标层级存在循环".to_string());
                }
                seen += 1;
                if seen > 100 {
                    return Err("备份中的目标层级过深".to_string());
                }
                current = backup
                    .goals
                    .iter()
                    .find(|item| item.id == id)
                    .and_then(|item| item.parent_id.clone());
            }
        }
    }

    let mut project_ids = HashSet::new();
    for project in &backup.projects {
        if project.id.trim().is_empty() {
            return Err("备份中存在空的项目 id".to_string());
        }
        if !project_ids.insert(project.id.as_str()) {
            return Err(format!("备份中存在重复的项目 id：{}", project.id));
        }
        if project.name.trim().is_empty() {
            return Err("备份中存在未命名项目".to_string());
        }
    }

    let mut project_roles: HashMap<String, String> = HashMap::new();
    for role in &backup.project_roles {
        if role.id.trim().is_empty() {
            return Err("备份中存在空的项目角色 id".to_string());
        }
        if project_roles.insert(role.id.clone(), role.project_id.clone()).is_some() {
            return Err(format!("备份中存在重复的项目角色 id：{}", role.id));
        }
        if !project_ids.contains(role.project_id.as_str()) {
            return Err("项目角色引用了不存在的项目".to_string());
        }
    }

    let mut meta_ids = HashSet::new();
    for field in &backup.project_meta_fields {
        if field.id.trim().is_empty() {
            return Err("备份中存在空的项目元数据 id".to_string());
        }
        if !meta_ids.insert(field.id.as_str()) {
            return Err(format!("备份中存在重复的项目元数据 id：{}", field.id));
        }
        if !project_ids.contains(field.project_id.as_str()) {
            return Err("项目元数据引用了不存在的项目".to_string());
        }
    }

    let mut member_ids = HashSet::new();
    for member in &backup.team_members {
        if member.id.trim().is_empty() {
            return Err("备份中存在空的项目成员 id".to_string());
        }
        if !member_ids.insert(member.id.as_str()) {
            return Err(format!("备份中存在重复的项目成员 id：{}", member.id));
        }
        if member.name.trim().is_empty() {
            return Err("备份中存在未命名的项目成员".to_string());
        }
        if !project_ids.contains(member.project_id.as_str()) {
            return Err("项目成员引用了不存在的项目".to_string());
        }
        match project_roles.get(&member.role_id) {
            Some(project_id) if project_id == &member.project_id => {}
            _ => return Err("项目成员引用了不属于该项目的角色".to_string()),
        }
    }

    let member_project_map: HashMap<&str, &str> = backup
        .team_members
        .iter()
        .map(|member| (member.id.as_str(), member.project_id.as_str()))
        .collect();

    let mut tenure_ids = HashSet::new();
    let mut tenure_intervals: HashMap<&str, Vec<(&str, Option<&str>)>> = HashMap::new();
    for tenure in &backup.member_tenures {
        if tenure.id.trim().is_empty() {
            return Err("备份中存在空的投入时间段 id".to_string());
        }
        if !tenure_ids.insert(tenure.id.as_str()) {
            return Err(format!("备份中存在重复的投入时间段 id：{}", tenure.id));
        }
        let Some(member_project) = member_project_map.get(tenure.member_id.as_str()) else {
            return Err("投入时间段引用了不存在的项目成员".to_string());
        };
        if !project_ids.contains(tenure.project_id.as_str())
            || *member_project != tenure.project_id
        {
            return Err("投入时间段的项目归属与成员不一致".to_string());
        }
        if tenure.started_at.trim().is_empty() {
            return Err("备份中的投入时间段缺少开始日期".to_string());
        }
        if let Some(ended_at) = &tenure.ended_at {
            if ended_at.trim().is_empty() || ended_at < &tenure.started_at {
                return Err("备份中的投入时间段结束日期无效".to_string());
            }
        }
        let intervals = tenure_intervals
            .entry(tenure.member_id.as_str())
            .or_default();
        let new_end = tenure.ended_at.as_deref().unwrap_or("9999-12-31");
        for (old_start, old_end) in intervals.iter() {
            let old_end = old_end.unwrap_or("9999-12-31");
            if tenure.started_at.as_str() < old_end && *old_start < new_end {
                return Err("备份中同一成员的投入时间段存在重叠".to_string());
            }
        }
        intervals.push((tenure.started_at.as_str(), tenure.ended_at.as_deref()));
    }

    let mut overtime_ids = HashSet::new();
    for record in &backup.overtime_records {
        if record.id.trim().is_empty() {
            return Err("备份中存在空的加班记录 id".to_string());
        }
        if !overtime_ids.insert(record.id.as_str()) {
            return Err(format!("备份中存在重复的加班记录 id：{}", record.id));
        }
        if !member_ids.contains(record.member_id.as_str()) {
            return Err("加班记录引用了不存在的项目成员".to_string());
        }
        if !project_ids.contains(record.project_id.as_str()) {
            return Err("加班记录引用了不存在的项目".to_string());
        }
        if !record.hours.is_finite() || record.hours <= 0.0 {
            return Err("备份中的加班时长无效".to_string());
        }
        // V0.13.2：未出勤必须有原因；其它状态不应带未出勤原因。
        match record.status {
            OvertimeStatus::Absent => {
                let reason = record.absence_reason.trim();
                if reason.is_empty() {
                    return Err("备份中的未出勤记录缺少原因".to_string());
                }
                if reason.chars().count() > 200 {
                    return Err("备份中的未出勤原因超过 200 字".to_string());
                }
            }
            _ if !record.absence_reason.trim().is_empty() => {
                return Err("备份中的非未出勤记录不应包含未出勤原因".to_string());
            }
            _ => {}
        }
    }

    let mut performance_ids = HashSet::new();
    for record in &backup.performance_records {
        if record.id.trim().is_empty() {
            return Err("备份中存在空的绩效记录 id".to_string());
        }
        if !performance_ids.insert(record.id.as_str()) {
            return Err(format!("备份中存在重复的绩效记录 id：{}", record.id));
        }
        if !member_ids.contains(record.member_id.as_str()) {
            return Err("绩效记录引用了不存在的项目成员".to_string());
        }
        if !project_ids.contains(record.project_id.as_str()) {
            return Err("绩效记录引用了不存在的项目".to_string());
        }
        if record.points == 0 {
            return Err("备份中的绩效分值不能为 0".to_string());
        }
    }

    // V0.13.0：自定义字段与任务字段取值。
    let mut custom_field_ids = HashSet::new();
    let mut custom_field_types: HashMap<&str, CustomFieldType> = HashMap::new();
    let mut custom_field_options: HashMap<&str, HashSet<&str>> = HashMap::new();
    let mut custom_field_boards: HashMap<&str, &str> = HashMap::new();
    let mut custom_field_names: HashMap<&str, HashSet<&str>> = HashMap::new();
    for field in &backup.custom_fields {
        if field.id.trim().is_empty() {
            return Err("备份中存在空的自定义字段 id".to_string());
        }
        if !custom_field_ids.insert(field.id.as_str()) {
            return Err(format!("备份中存在重复的自定义字段 id：{}", field.id));
        }
        if !board_ids.contains(field.board_id.as_str()) {
            return Err(format!("自定义字段「{}」引用了不存在的看板", field.name));
        }
        let name = field.name.trim();
        if name.is_empty() {
            return Err("备份中存在未命名的自定义字段".to_string());
        }
        let names = custom_field_names.entry(field.board_id.as_str()).or_default();
        if !names.insert(name) {
            return Err(format!("看板中存在同名的自定义字段：{name}"));
        }
        let mut option_ids = HashSet::new();
        for option in &field.options {
            if option.id.trim().is_empty() {
                return Err(format!("自定义字段「{name}」中存在空的选项 id"));
            }
            if !option_ids.insert(option.id.as_str()) {
                return Err(format!(
                    "自定义字段「{name}」中存在重复的选项 id：{}",
                    option.id
                ));
            }
            if option.label.trim().is_empty() {
                return Err(format!("自定义字段「{name}」中存在未命名的选项"));
            }
        }
        match field.field_type {
            CustomFieldType::Select => {
                if field.options.is_empty() {
                    return Err(format!("单选自定义字段「{name}」缺少选项"));
                }
            }
            CustomFieldType::Number => {
                if !field.options.is_empty() {
                    return Err(format!("数值自定义字段「{name}」不应带选项"));
                }
            }
        }
        custom_field_types.insert(field.id.as_str(), field.field_type);
        custom_field_options.insert(field.id.as_str(), option_ids);
        custom_field_boards.insert(field.id.as_str(), field.board_id.as_str());
    }

    let mut card_field_value_keys = HashSet::new();
    for value in &backup.card_field_values {
        if !card_ids.contains(value.card_id.as_str()) {
            return Err(format!("字段值引用了不存在的任务：{}", value.card_id));
        }
        let Some(field_type) = custom_field_types.get(value.field_id.as_str()) else {
            return Err(format!("字段值引用了不存在的自定义字段：{}", value.field_id));
        };
        if !card_field_value_keys.insert((value.card_id.as_str(), value.field_id.as_str())) {
            return Err(format!(
                "备份中存在重复的任务字段值：{} / {}",
                value.card_id, value.field_id
            ));
        }
        let field_board = custom_field_boards
            .get(value.field_id.as_str())
            .copied()
            .unwrap_or_default();
        let card_board_id = card_board
            .get(value.card_id.as_str())
            .copied()
            .unwrap_or_default();
        if field_board != card_board_id {
            return Err("任务字段值与自定义字段不属于同一看板".to_string());
        }
        match field_type {
            CustomFieldType::Select => {
                let Some(option_id) = value.value_text.as_deref() else {
                    return Err("单选自定义字段的字段值缺少选项".to_string());
                };
                let option_exists = custom_field_options
                    .get(value.field_id.as_str())
                    .map(|options| options.contains(option_id))
                    .unwrap_or(false);
                if !option_exists {
                    return Err(format!(
                        "单选自定义字段的字段值引用了不存在的选项：{option_id}"
                    ));
                }
                if value.value_number.is_some() {
                    return Err("单选自定义字段的字段值不应包含数值".to_string());
                }
            }
            CustomFieldType::Number => {
                if value.value_text.is_some() {
                    return Err("数值自定义字段的字段值不应包含文本".to_string());
                }
                let Some(number) = value.value_number else {
                    return Err("数值自定义字段的字段值缺少数值".to_string());
                };
                if !number.is_finite() {
                    return Err("数值自定义字段的字段值必须是有限数".to_string());
                }
            }
        }
    }

    // V0.13.1：保存的筛选视图。
    let mut saved_view_ids = HashSet::new();
    let mut saved_view_names: HashMap<&str, HashSet<&str>> = HashMap::new();
    for view in &backup.saved_views {
        if view.id.trim().is_empty() {
            return Err("备份中存在空的保存视图 id".to_string());
        }
        if !saved_view_ids.insert(view.id.as_str()) {
            return Err(format!("备份中存在重复的保存视图 id：{}", view.id));
        }
        if !board_ids.contains(view.board_id.as_str()) {
            return Err(format!("保存视图「{}」引用了不存在的看板", view.name));
        }
        if view.name.trim().is_empty() {
            return Err("备份中存在未命名的保存视图".to_string());
        }
        let names = saved_view_names.entry(view.board_id.as_str()).or_default();
        if !names.insert(view.name.trim()) {
            return Err(format!("看板中存在同名的保存视图：{}", view.name));
        }
        if view.view_type.trim().is_empty() {
            return Err(format!("保存视图「{}」缺少视图类型", view.name));
        }
        for filter in &view.filters.field_filters {
            let Some(field_type) = custom_field_types.get(filter.field_id.as_str()) else {
                return Err(format!(
                    "保存视图「{}」引用了不存在的自定义字段：{}",
                    view.name, filter.field_id
                ));
            };
            let field_board = custom_field_boards.get(filter.field_id.as_str()).copied();
            if field_board != Some(view.board_id.as_str()) {
                return Err(format!(
                    "保存视图「{}」引用了其它看板的自定义字段",
                    view.name
                ));
            }
            match field_type {
                CustomFieldType::Select => {
                    for option_id in &filter.option_ids {
                        let exists = custom_field_options
                            .get(filter.field_id.as_str())
                            .map(|options| options.contains(option_id.as_str()))
                            .unwrap_or(false);
                        if !exists {
                            return Err(format!(
                                "保存视图「{}」引用了不存在的选项：{option_id}",
                                view.name
                            ));
                        }
                    }
                }
                CustomFieldType::Number => {
                    for bound in [filter.min, filter.max].into_iter().flatten() {
                        if !bound.is_finite() {
                            return Err(format!("保存视图「{}」的数值区间无效", view.name));
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// 用备份替换当前库：单事务内先清空四张表，再按原 id 全量写回。
pub fn restore(conn: &mut Connection, backup: &BackupFile) -> Result<BackupSummary, String> {
    let mut normalized = backup.clone();
    normalize_legacy_backup(&mut normalized);
    let backup = &normalized;
    validate(backup)?;
    let tx = conn.transaction().map_err(|error| format!("恢复失败：{error}"))?;
    tx.execute("DELETE FROM card_field_values", [])
        .and_then(|_| tx.execute("DELETE FROM custom_fields", []))
        .and_then(|_| tx.execute("DELETE FROM saved_views", []))
        .and_then(|_| tx.execute("DELETE FROM recurrence_runs", []))
        .and_then(|_| tx.execute("DELETE FROM card_activity", []))
        .and_then(|_| tx.execute("DELETE FROM recurrences", []))
        .and_then(|_| tx.execute("DELETE FROM automation_rules", []))
        .and_then(|_| tx.execute("DELETE FROM goal_cards", []))
        .and_then(|_| tx.execute("DELETE FROM goals", []))
        .and_then(|_| tx.execute("DELETE FROM performance_records", []))
        .and_then(|_| tx.execute("DELETE FROM overtime_records", []))
        .and_then(|_| tx.execute("DELETE FROM member_tenures", []))
        .and_then(|_| tx.execute("DELETE FROM team_members", []))
        .and_then(|_| tx.execute("DELETE FROM project_meta_fields", []))
        .and_then(|_| tx.execute("DELETE FROM project_roles", []))
        .and_then(|_| tx.execute("DELETE FROM projects", []))
        .and_then(|_| tx.execute("DELETE FROM board_set_boards", []))
        .and_then(|_| tx.execute("DELETE FROM board_sets", []))
        .and_then(|_| tx.execute("DELETE FROM card_dependencies", []))
        .and_then(|_| tx.execute("DELETE FROM cards", []))
        .and_then(|_| tx.execute("DELETE FROM lists", []))
        .and_then(|_| tx.execute("DELETE FROM boards", []))
        .and_then(|_| tx.execute("DELETE FROM inbox_items", []))
        .map_err(|error| format!("清理旧数据失败：{error}"))?;

    for project in &backup.projects {
        tx.execute(
            "INSERT INTO projects \
             (id, name, description, color, status, starred, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &project.id,
                &project.name,
                &project.description,
                &project.color,
                project.status.as_str(),
                project.starred as i64,
                &project.created_at,
                &project.updated_at,
            ],
        )
        .map_err(|error| format!("写入项目「{}」失败：{error}", project.name))?;
    }

    for role in &backup.project_roles {
        tx.execute(
            "INSERT INTO project_roles \
             (id, project_id, name, color, position, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &role.id,
                &role.project_id,
                &role.name,
                &role.color,
                role.position,
                &role.created_at,
                &role.updated_at,
            ],
        )
        .map_err(|error| format!("写入项目角色「{}」失败：{error}", role.name))?;
    }

    for field in &backup.project_meta_fields {
        tx.execute(
            "INSERT INTO project_meta_fields \
             (id, project_id, name, value, position, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &field.id,
                &field.project_id,
                &field.name,
                &field.value,
                field.position,
                &field.created_at,
                &field.updated_at,
            ],
        )
        .map_err(|error| format!("写入项目元数据「{}」失败：{error}", field.name))?;
    }

    for board in &backup.boards {
        tx.execute(
            "INSERT INTO boards (id, title, description, color, starred, created_at, updated_at, label_colors) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &board.id,
                &board.title,
                &board.description,
                board.color.as_str(),
                board.starred as i64,
                &board.created_at,
                &board.updated_at,
                serde_json::to_string(&board.label_colors).map_err(|error| error.to_string())?,
            ],
        )
        .map_err(|error| format!("写入看板「{}」失败：{error}", board.title))?;
    }

    for field in &backup.custom_fields {
        let options_json = serde_json::to_string(&field.options)
            .map_err(|error| format!("字段选项序列化失败：{error}"))?;
        tx.execute(
            "INSERT INTO custom_fields \
             (id, board_id, name, field_type, options_json, sort_order, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &field.id,
                &field.board_id,
                &field.name,
                field.field_type.as_str(),
                options_json,
                field.sort_order,
                &field.created_at,
                &field.updated_at,
            ],
        )
        .map_err(|error| format!("写入自定义字段「{}」失败：{error}", field.name))?;
    }

    for view in &backup.saved_views {
        let filters_json = serde_json::to_string(&view.filters)
            .map_err(|error| format!("筛选条件序列化失败：{error}"))?;
        let sort_json = serde_json::to_string(&view.sort)
            .map_err(|error| format!("排序方式序列化失败：{error}"))?;
        tx.execute(
            "INSERT INTO saved_views \
             (id, board_id, name, view_type, filters_json, sort_json, is_builtin, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &view.id,
                &view.board_id,
                &view.name,
                &view.view_type,
                filters_json,
                sort_json,
                view.is_builtin as i64,
                &view.created_at,
                &view.updated_at,
            ],
        )
        .map_err(|error| format!("写入保存视图「{}」失败：{error}", view.name))?;
    }

    for list in &backup.lists {
        tx.execute(
            "INSERT INTO lists (id, board_id, title, color, wip_limit, position, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &list.id,
                &list.board_id,
                &list.title,
                list.color.as_str(),
                list.wip_limit,
                list.position,
                &list.created_at,
            ],
        )
        .map_err(|error| format!("写入列表「{}」失败：{error}", list.title))?;
    }

    for card in &backup.cards {
        let labels = serde_json::to_string(&card.labels)
            .map_err(|error| format!("任务标签序列化失败：{error}"))?;
        let subtasks = serde_json::to_string(&card.subtasks)
            .map_err(|error| format!("子任务序列化失败：{error}"))?;
        tx.execute(
            "INSERT INTO cards \
             (id, board_id, list_id, title, description, due_date, start_date, priority, accent, \
              completed, labels, subtasks, position, deleted_at, recurrence_id, generated_from_id, \
              estimated_minutes, actual_minutes, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                &card.id,
                &card.board_id,
                &card.list_id,
                &card.title,
                &card.description,
                &card.due_date,
                &card.start_date,
                card.priority.map(Priority::as_str),
                card.accent.map(BoardColor::as_str),
                card.completed as i64,
                labels,
                subtasks,
                card.position,
                &card.deleted_at,
                &card.recurrence_id,
                &card.generated_from_id,
                card.estimated_minutes,
                card.actual_minutes,
                &card.created_at,
                &card.updated_at,
            ],
        )
        .map_err(|error| format!("写入任务「{}」失败：{error}", card.title))?;
    }

    for value in &backup.card_field_values {
        tx.execute(
            "INSERT INTO card_field_values (card_id, field_id, value_text, value_number) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                &value.card_id,
                &value.field_id,
                &value.value_text,
                &value.value_number,
            ],
        )
        .map_err(|error| {
            format!(
                "写入任务字段值失败（{} / {}）：{error}",
                value.card_id, value.field_id
            )
        })?;
    }

    for recurrence in &backup.recurrences {
        let weekdays = serde_json::to_string(&recurrence.weekdays)
            .map_err(|error| format!("重复配置星期序列化失败：{error}"))?;
        tx.execute(
            "INSERT INTO recurrences \
             (id, card_id, frequency, interval_value, weekdays, next_due_date, enabled, \
              created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &recurrence.id,
                &recurrence.card_id,
                recurrence.frequency.as_str(),
                recurrence.interval_value,
                weekdays,
                &recurrence.next_due_date,
                recurrence.enabled as i64,
                &recurrence.created_at,
                &recurrence.updated_at,
            ],
        )
        .map_err(|error| format!("写入重复配置失败：{error}"))?;
    }

    for rule in &backup.automation_rules {
        let actions = serde_json::to_string(&rule.actions)
            .map_err(|error| format!("规则动作序列化失败：{error}"))?;
        tx.execute(
            "INSERT INTO automation_rules \
             (id, name, trigger, list_id, actions, enabled, last_error, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &rule.id,
                &rule.name,
                rule.trigger.as_str(),
                &rule.list_id,
                actions,
                rule.enabled as i64,
                &rule.last_error,
                &rule.created_at,
                &rule.updated_at,
            ],
        )
        .map_err(|error| format!("写入本地规则「{}」失败：{error}", rule.name))?;
    }

    for activity in &backup.card_activity {
        tx.execute(
            "INSERT INTO card_activity \
             (id, card_id, event_type, field, old_value, new_value, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &activity.id,
                &activity.card_id,
                &activity.event_type,
                &activity.field,
                &activity.old_value,
                &activity.new_value,
                &activity.created_at,
            ],
        )
        .map_err(|error| format!("写入任务活动失败：{error}"))?;
    }

    for goal in &backup.goals {
        tx.execute(
            "INSERT INTO goals (id, title, description, scope, status, start_date, due_date, \
             manual_progress, parent_id, position, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                &goal.id,
                &goal.title,
                &goal.description,
                goal.scope.as_str(),
                goal.status.as_str(),
                &goal.start_date,
                &goal.due_date,
                goal.manual_progress,
                &goal.parent_id,
                goal.position,
                &goal.created_at,
                &goal.updated_at,
            ],
        )
        .map_err(|error| format!("写入目标「{}」失败：{error}", goal.title))?;
        for (position, card_id) in goal.card_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO goal_cards (goal_id, card_id, position) VALUES (?1, ?2, ?3)",
                params![&goal.id, card_id, position as i64],
            )
            .map_err(|error| format!("写入目标关联任务失败：{error}"))?;
        }
    }

    for board_set in &backup.board_sets {
        tx.execute(
            "INSERT INTO board_sets (id, title, description, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                &board_set.id,
                &board_set.title,
                &board_set.description,
                &board_set.created_at,
                &board_set.updated_at,
            ],
        )
        .map_err(|error| format!("写入看板集「{}」失败：{error}", board_set.title))?;
        for (position, board_id) in board_set.board_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO board_set_boards (set_id, board_id, position) VALUES (?1, ?2, ?3)",
                params![&board_set.id, board_id, position as i64],
            )
            .map_err(|error| format!("写入看板集成员失败：{error}"))?;
        }
    }

    for member in &backup.team_members {
        tx.execute(
            "INSERT INTO team_members \
             (id, project_id, role_id, name, role, status, joined_at, released_at, note, \
              created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                &member.id,
                &member.project_id,
                &member.role_id,
                &member.name,
                member.role.as_str(),
                member.status.as_str(),
                &member.joined_at,
                &member.released_at,
                &member.note,
                &member.created_at,
                &member.updated_at,
            ],
        )
        .map_err(|error| format!("写入项目成员「{}」失败：{error}", member.name))?;
    }

    for tenure in &backup.member_tenures {
        tx.execute(
            "INSERT INTO member_tenures \
             (id, member_id, project_id, started_at, ended_at, note, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &tenure.id,
                &tenure.member_id,
                &tenure.project_id,
                &tenure.started_at,
                &tenure.ended_at,
                &tenure.note,
                &tenure.created_at,
                &tenure.updated_at,
            ],
        )
        .map_err(|error| format!("写入成员投入时间段失败：{error}"))?;
    }

    for record in &backup.overtime_records {
        tx.execute(
            "INSERT INTO overtime_records \
             (id, project_id, member_id, date, hours, status, absence_reason, note, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                &record.id,
                &record.project_id,
                &record.member_id,
                &record.date,
                record.hours,
                record.status.as_str(),
                &record.absence_reason,
                &record.note,
                &record.created_at,
                &record.updated_at,
            ],
        )
        .map_err(|error| format!("写入加班记录失败：{error}"))?;
    }

    for record in &backup.performance_records {
        tx.execute(
            "INSERT INTO performance_records \
             (id, project_id, member_id, date, points, reason, category, note, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &record.id,
                &record.project_id,
                &record.member_id,
                &record.date,
                record.points,
                &record.reason,
                record.category.as_str(),
                &record.note,
                &record.created_at,
            ],
        )
        .map_err(|error| format!("写入绩效记录失败：{error}"))?;
    }

    for item in &backup.inbox {
        tx.execute(
            "INSERT INTO inbox_items (id, content, created_at) VALUES (?1, ?2, ?3)",
            params![&item.id, &item.content, &item.created_at],
        )
        .map_err(|error| format!("写入收件箱条目失败：{error}"))?;
    }

    for dependency in &backup.dependencies {
        tx.execute(
            "INSERT INTO card_dependencies (card_id, depends_on_card_id, relation_type) \
             VALUES (?1, ?2, ?3)",
            params![
                &dependency.card_id,
                &dependency.depends_on_card_id,
                dependency.relation_type.as_str(),
            ],
        )
        .map_err(|error| format!("写入任务依赖失败：{error}"))?;
    }

    tx.commit().map_err(|error| format!("恢复失败：{error}"))?;
    Ok(backup.summary())
}

/// 桌面端导出目录：优先「文档」，不存在时退回用户主目录。
pub fn default_export_path() -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .ok_or_else(|| "无法确定用户目录，无法导出备份".to_string())?;
    let documents = home.join("Documents");
    let directory = if documents.is_dir() { documents } else { home };
    Ok(directory.join(format!("tideline-backup-{stamp}.json")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::models::{
        CardFieldValueInput, CustomField, CustomFieldOption, CustomFieldType, IdInput,
        NewBoardInput, NewCardInput, NewCustomFieldInput, NewListInput, NewSavedViewInput,
        Priority, SavedView, SavedViewFilters, SavedViewSort, SetCardFieldValuesInput,
        SetDependenciesInput,
    };

    fn seed(conn: &mut Connection) -> Card {
        let board = repo::create_board(
            conn,
            NewBoardInput {
                title: "备份测试".to_string(),
                description: Some("简介".to_string()),
                color: None,
            },
        )
        .expect("创建看板");
        let list = repo::create_list(
            conn,
            NewListInput {
                board_id: board.id.clone(),
                title: "待办".to_string(),
                color: None,
                wip_limit: None,
            },
        )
        .expect("创建列表");
        repo::create_card(
            conn,
            NewCardInput {
                board_id: board.id.clone(),
                list_id: list.id.clone(),
                parent_card_id: None,
                title: "任务 A".to_string(),
                description: Some("描述".to_string()),
                due_date: Some("2026-05-01".to_string()),
                start_date: Some("2026-04-01".to_string()),
                estimated_minutes: None,
                actual_minutes: None,
                priority: Some(Priority::High),
                accent: None,
                labels: Some(vec!["研发".to_string()]),
                subtasks: Some(vec![Subtask {
                    id: "s_1".to_string(),
                    title: "步骤".to_string(),
                    done: true,
                }]),
            },
        )
        .expect("创建任务")
    }

    #[test]
    fn build_then_restore_round_trips_all_data() {
        let mut conn = db::open_in_memory().expect("内存库");
        let card = seed(&mut conn);
        repo::delete_card(
            &mut conn,
            IdInput {
                id: card.id.clone(),
            },
        )
        .expect("软删除任务");

        let backup = build(&conn).expect("构建备份");
        assert_eq!(backup.summary().boards, 1);
        assert_eq!(backup.summary().lists, 1);
        assert_eq!(backup.summary().cards, 1);
        assert_eq!(backup.summary().trashed, 1);
        assert_eq!(backup.cards[0].labels, vec!["研发".to_string()]);

        // 破坏当前数据，再恢复：回到备份时的状态。
        let extra = repo::create_board(
            &mut conn,
            NewBoardInput {
                title: "临时看板".to_string(),
                description: None,
                color: None,
            },
        )
        .expect("创建临时看板");
        assert!(repo::delete_board(&mut conn, IdInput { id: extra.id }).is_ok());

        let restored = restore(&mut conn, &backup).expect("恢复备份");
        assert_eq!(restored, backup.summary());
        let snapshot = repo::get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.boards.len(), 1);
        assert_eq!(snapshot.boards[0].title, "备份测试");
        assert!(snapshot.cards.is_empty(), "活动任务在备份里已删除");
        let trash = repo::get_trash(&conn).expect("回收站");
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].title, "任务 A");
        assert_eq!(trash[0].labels, vec!["研发".to_string()]);
        assert_eq!(trash[0].priority, Some(Priority::High));
        assert_eq!(trash[0].subtasks.len(), 1);
    }

    #[test]
    fn label_colors_survive_backup_and_old_backup_defaults_to_empty() {
        let mut conn = db::open_in_memory().unwrap();
        let card = seed(&mut conn);
        let colors = std::collections::HashMap::from([("研发".to_string(), BoardColor::Rose)]);
        repo::update_board(&mut conn, UpdateBoardInput {
            id: card.board_id,
            patch: BoardPatch { label_colors: Some(colors.clone()), ..Default::default() },
        }).unwrap();
        let backup = build(&conn).unwrap();
        restore(&mut conn, &backup).unwrap();
        assert_eq!(repo::get_snapshot(&conn).unwrap().boards[0].label_colors, colors);

        let mut old = serde_json::to_value(backup).unwrap();
        old["boards"][0].as_object_mut().unwrap().remove("labelColors");
        let old: BackupFile = serde_json::from_value(old).unwrap();
        restore(&mut conn, &old).unwrap();
        assert!(repo::get_snapshot(&conn).unwrap().boards[0].label_colors.is_empty());
    }

    #[test]
    fn task_minutes_survive_backup_and_old_backup_defaults_to_null() {
        let mut conn = db::open_in_memory().expect("memory db");
        let card = seed(&mut conn);
        conn.execute("UPDATE cards SET estimated_minutes = 120, actual_minutes = 40 WHERE id = ?1", [&card.id])
            .expect("set task minutes");
        let backup = build(&conn).expect("export backup");
        let json = serde_json::to_value(&backup).expect("serialize backup");
        assert_eq!(json["cards"][0]["estimatedMinutes"], 120);
        assert_eq!(json["cards"][0]["actualMinutes"], 40);
        restore(&mut conn, &backup).expect("restore backup");
        let restored = repo::get_snapshot(&conn).expect("snapshot").cards.remove(0);
        assert_eq!((restored.estimated_minutes, restored.actual_minutes), (Some(120), Some(40)));

        let mut old = json;
        old["cards"][0].as_object_mut().expect("card object").remove("estimatedMinutes");
        old["cards"][0].as_object_mut().expect("card object").remove("actualMinutes");
        let old_backup: BackupFile = serde_json::from_value(old).expect("read old backup");
        restore(&mut conn, &old_backup).expect("restore old backup");
        let old_card = repo::get_snapshot(&conn).expect("snapshot").cards.remove(0);
        assert_eq!((old_card.estimated_minutes, old_card.actual_minutes), (None, None));
    }

    #[test]
    fn invalid_reference_is_rejected_before_writing() {
        let mut conn = db::open_in_memory().expect("内存库");
        seed(&mut conn);
        let mut backup = build(&conn).expect("构建备份");

        backup.cards[0].list_id = "l_unknown".to_string();
        let error = restore(&mut conn, &backup).expect_err("应拒绝无效引用");
        assert!(error.contains("不存在的列表"), "错误信息：{error}");

        // 校验失败时原数据不能被清空。
        let snapshot = repo::get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.boards.len(), 1);
        assert_eq!(snapshot.cards.len(), 1);
    }

    #[test]
    fn unsupported_format_is_rejected() {
        let mut conn = db::open_in_memory().expect("内存库");
        let mut backup = build(&conn).expect("空备份");
        backup.format_version = 99;
        assert!(validate(&backup).is_err());
        backup.format_version = BACKUP_FORMAT_VERSION;
        backup.app = "other".to_string();
        assert!(validate(&backup).is_err());
    }

    #[test]
    fn empty_backup_restores_empty_database() {
        let mut conn = db::open_in_memory().expect("内存库");
        seed(&mut conn);
        let empty = BackupFile {
            app: BACKUP_APP.to_string(),
            format_version: BACKUP_FORMAT_VERSION,
            exported_at: repo::now_iso(),
            boards: Vec::new(),
            lists: Vec::new(),
            cards: Vec::new(),
            inbox: Vec::new(),
            dependencies: Vec::new(),
            board_sets: Vec::new(),
            goals: Vec::new(),
            team_members: Vec::new(),
            overtime_records: Vec::new(),
            performance_records: Vec::new(),
            member_tenures: Vec::new(),
            projects: Vec::new(),
            project_meta_fields: Vec::new(),
            project_roles: Vec::new(),
            recurrences: Vec::new(),
            automation_rules: Vec::new(),
            card_activity: Vec::new(),
            custom_fields: Vec::new(),
            card_field_values: Vec::new(),
            saved_views: Vec::new(),
        };
        let summary = restore(&mut conn, &empty).expect("恢复空备份");
        assert_eq!(summary.cards, 0);
        let snapshot = repo::get_snapshot(&conn).expect("快照");
        assert!(snapshot.boards.is_empty());
        assert!(snapshot.lists.is_empty());
        assert!(snapshot.cards.is_empty());
    }

    #[test]
    fn dependencies_round_trip_through_backup() {
        let mut conn = db::open_in_memory().expect("内存库");
        let first = seed(&mut conn);
        let snapshot = repo::get_snapshot(&conn).expect("快照");
        let board_id = snapshot.boards[0].id.clone();
        let list_id = snapshot.lists[0].id.clone();
        let second = repo::create_card(
            &mut conn,
            NewCardInput {
                board_id,
                list_id,
                title: "任务 B".to_string(),
                ..Default::default()
            },
        )
        .expect("创建任务 B");
        repo::set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: second.id.clone(),
                depends_on: vec![first.id.clone()],
                relation_types: Vec::new(),
            },
        )
        .expect("设置依赖");

        let backup = build(&conn).expect("构建备份");
        assert_eq!(backup.summary().dependencies, 1);
        assert_eq!(backup.dependencies[0].card_id, second.id);

        let restored = restore(&mut conn, &backup).expect("恢复备份");
        assert_eq!(restored.dependencies, 1);
        let snapshot = repo::get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.dependencies.len(), 1);
        assert_eq!(snapshot.dependencies[0].depends_on_card_id, first.id);
    }

    #[test]
    fn automation_data_round_trips_through_backup() {
        let mut conn = db::open_in_memory().expect("内存库");
        let card = seed(&mut conn);
        crate::automation::create_recurrence(
            &mut conn,
            crate::models::NewRecurrenceInput {
                card_id: card.id.clone(),
                frequency: crate::models::RecurrenceFrequency::Daily,
                interval_value: None,
                weekdays: None,
                next_due_date: None,
            },
        )
        .expect("创建重复配置");
        crate::automation::create_automation_rule(
            &mut conn,
            crate::models::NewAutomationRuleInput {
                name: "备份规则".to_string(),
                trigger: crate::models::RuleTrigger::Complete,
                list_id: None,
                actions: vec![crate::models::RuleAction {
                    kind: crate::models::RuleActionKind::AddLabels,
                    offset_days: 0,
                    priority: None,
                    labels: vec!["研发".to_string()],
                    subtasks: Vec::new(),
                }],
                enabled: Some(true),
            },
        )
        .expect("创建规则");

        let backup = build(&conn).expect("构建备份");
        assert_eq!(backup.summary().recurrences, 1);
        assert_eq!(backup.summary().automation_rules, 1);

        let restored = restore(&mut conn, &backup).expect("恢复备份");
        assert_eq!(restored.recurrences, 1);
        assert_eq!(restored.automation_rules, 1);
        let snapshot = repo::get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.recurrences.len(), 1);
        assert_eq!(snapshot.automation_rules.len(), 1);
        assert!(snapshot.automation_rules[0].enabled, "规则启用状态应随备份恢复");
    }

    #[test]
    fn backup_without_automation_fields_is_accepted() {
        // V0.10 备份没有 recurrences / automationRules / cardActivity 字段，
        // 反序列化后应按空集合处理，不影响恢复。
        let mut conn = db::open_in_memory().expect("内存库");
        seed(&mut conn);
        let mut backup = build(&conn).expect("构建备份");
        backup.recurrences.clear();
        backup.automation_rules.clear();
        backup.card_activity.clear();
        validate(&backup).expect("校验应通过");
        let restored = restore(&mut conn, &backup).expect("恢复备份");
        assert_eq!(restored.recurrences, 0);
        assert_eq!(restored.automation_rules, 0);
    }

    #[test]
    fn invalid_dependency_backup_is_rejected() {
        let mut conn = db::open_in_memory().expect("内存库");
        seed(&mut conn);
        let mut backup = build(&conn).expect("构建备份");
        if backup.cards.is_empty() {
            backup.cards.push(Card {
                id: "c_x".to_string(),
                board_id: "b_x".to_string(),
                list_id: "l_x".to_string(),
                parent_card_id: None,
                title: "x".to_string(),
                description: String::new(),
                due_date: None,
                start_date: None,
                estimated_minutes: None,
                actual_minutes: None,
                priority: None,
                accent: None,
                completed: false,
                deleted_at: None,
                labels: Vec::new(),
                subtasks: Vec::new(),
                position: 0,
                recurrence_id: None,
                generated_from_id: None,
                created_at: repo::now_iso(),
                updated_at: repo::now_iso(),
            });
        }
        backup.dependencies.push(CardDependency {
            card_id: backup.cards[0].id.clone(),
            depends_on_card_id: "c_missing".to_string(),
            relation_type: RelationType::Blocks,
        });
        let error = validate(&backup).expect_err("应拒绝不存在的依赖");
        assert!(error.contains("不存在"), "错误：{error}");
    }

    #[test]
    fn board_sets_round_trip_through_backup() {
        let mut conn = db::open_in_memory().expect("内存库");
        seed(&mut conn);
        let snapshot = repo::get_snapshot(&conn).expect("快照");
        let board_id = snapshot.boards[0].id.clone();
        let board_set = repo::create_board_set(
            &mut conn,
            NewBoardSetInput {
                title: "汇总".to_string(),
                description: Some("跨看板".to_string()),
                board_ids: vec![board_id.clone()],
            },
        )
        .expect("创建看板集");

        let backup = build(&conn).expect("构建备份");
        assert_eq!(backup.summary().board_sets, 1);
        let restored = restore(&mut conn, &backup).expect("恢复备份");
        assert_eq!(restored.board_sets, 1);
        let snapshot = repo::get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.board_sets.len(), 1);
        assert_eq!(snapshot.board_sets[0].id, board_set.id);
        assert_eq!(snapshot.board_sets[0].board_ids, vec![board_id]);
    }

    #[test]
    fn goals_round_trip_through_backup() {
        let mut conn = db::open_in_memory().expect("内存库");
        seed(&mut conn);
        let mut snapshot = repo::get_snapshot(&conn).expect("快照");
        if snapshot.cards.is_empty() {
            let board = &snapshot.boards[0];
            let list = &snapshot.lists[0];
            let card = repo::create_card(
                &mut conn,
                NewCardInput {
                    board_id: board.id.clone(),
                    list_id: list.id.clone(),
                    title: "目标任务".to_string(),
                    ..Default::default()
                },
            )
            .expect("创建任务");
            snapshot.cards.push(card);
        }
        let card_id = snapshot.cards[0].id.clone();
        let goal = repo::create_goal(
            &mut conn,
            NewGoalInput {
                title: "目标".to_string(),
                description: Some("备份".to_string()),
                scope: Some(GoalScope::Company),
                status: None,
                start_date: None,
                due_date: None,
                manual_progress: Some(30),
                parent_id: None,
                card_ids: Some(vec![card_id.clone()]),
            },
        )
        .expect("创建目标");
        let backup = build(&conn).expect("构建备份");
        assert_eq!(backup.summary().goals, 1);
        let restored = restore(&mut conn, &backup).expect("恢复备份");
        assert_eq!(restored.goals, 1);
        let snapshot = repo::get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.goals.len(), 1);
        assert_eq!(snapshot.goals[0].id, goal.id);
        assert_eq!(snapshot.goals[0].card_ids, vec![card_id]);
    }

    #[test]
    fn team_resources_round_trip_through_backup() {
        let mut conn = db::open_in_memory().expect("内存库");
        seed(&mut conn);
        let project = repo::create_project(
            &mut conn,
            NewProjectInput {
                name: "项目A".to_string(),
                description: Some("备份项目".to_string()),
                color: Some("#2f6fd0".to_string()),
                starred: Some(true),
            },
        )
        .expect("创建项目");
        let roles = repo::get_project_roles(&conn, &project.id).expect("项目角色");
        let member = repo::create_team_member(
            &mut conn,
            NewTeamMemberInput {
                project_id: project.id.clone(),
                role_id: roles[0].id.clone(),
                name: "张三".to_string(),
                joined_at: Some("2026-10-01".to_string()),
                note: None,
            },
        )
        .expect("创建成员");
        repo::create_overtime(
            &mut conn,
            NewOvertimeInput {
                member_id: member.id.clone(),
                date: "2026-10-31".to_string(),
                hours: 8.0,
                status: Some(OvertimeStatus::Done),
                absence_reason: None,
                note: None,
            },
        )
        .expect("创建加班");
        repo::create_performance(
            &mut conn,
            NewPerformanceInput {
                member_id: member.id.clone(),
                date: "2026-10-31".to_string(),
                points: 5,
                reason: "提前交付".to_string(),
                category: Some(PerformanceCategory::Delivery),
                note: None,
            },
        )
        .expect("创建绩效");

        let backup = build(&conn).expect("构建备份");
        assert_eq!(backup.summary().team_members, 1);
        assert_eq!(backup.summary().overtime_records, 1);
        assert_eq!(backup.summary().performance_records, 1);
        assert_eq!(backup.summary().member_tenures, 1);
        let restored = restore(&mut conn, &backup).expect("恢复备份");
        assert_eq!(restored.team_members, 1);
        assert_eq!(restored.member_tenures, 1);
        let snapshot = repo::get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.team_members[0].id, member.id);
        assert_eq!(snapshot.member_tenures[0].member_id, member.id);
        assert_eq!(snapshot.member_tenures[0].ended_at, None);
        assert_eq!(snapshot.overtime_records[0].member_id, member.id);
        assert_eq!(snapshot.performance_records[0].member_id, member.id);
    }

    #[test]
    fn overtime_absence_round_trips_and_rejects_dirty_backup() {
        let mut conn = db::open_in_memory().expect("内存库");
        let project = repo::create_project(
            &mut conn,
            NewProjectInput {
                name: "项目C".to_string(),
                description: None,
                color: None,
                starred: None,
            },
        )
        .expect("创建项目");
        let roles = repo::get_project_roles(&conn, &project.id).expect("项目角色");
        let member = repo::create_team_member(
            &mut conn,
            NewTeamMemberInput {
                project_id: project.id.clone(),
                role_id: roles[0].id.clone(),
                name: "王五".to_string(),
                joined_at: Some("2026-10-01".to_string()),
                note: None,
            },
        )
        .expect("创建成员");
        repo::create_overtime(
            &mut conn,
            NewOvertimeInput {
                member_id: member.id.clone(),
                date: "2026-10-31".to_string(),
                hours: 8.0,
                status: Some(OvertimeStatus::Absent),
                absence_reason: Some("临时发烧请假".to_string()),
                note: None,
            },
        )
        .expect("创建未出勤记录");

        let backup = build(&conn).expect("构建备份");
        let json = serde_json::to_string(&backup).expect("序列化备份");
        assert!(json.contains("\"absenceReason\":\"临时发烧请假\""));

        let mut target = db::open_in_memory().expect("目标内存库");
        let restored = restore(&mut target, &backup).expect("恢复备份");
        assert_eq!(restored.overtime_records, 1);
        let snapshot = repo::get_snapshot(&target).expect("快照");
        assert_eq!(snapshot.overtime_records[0].status, OvertimeStatus::Absent);
        assert_eq!(snapshot.overtime_records[0].absence_reason, "临时发烧请假");

        // 旧备份没有 absenceReason 字段：按空串兼容。
        let mut value: serde_json::Value = serde_json::from_str(&json).expect("解析 JSON");
        value["overtimeRecords"][0]
            .as_object_mut()
            .expect("加班记录对象")
            .remove("absenceReason");
        let legacy: BackupFile = serde_json::from_value(value).expect("旧备份反序列化");
        assert_eq!(legacy.overtime_records[0].absence_reason, "");
        assert_eq!(legacy.overtime_records[0].status, OvertimeStatus::Absent);

        // 未出勤缺少原因：拒绝。
        let mut missing = backup.clone();
        missing.overtime_records[0].absence_reason = String::new();
        let error = validate(&missing).expect_err("未出勤缺少原因应被拒绝");
        assert!(error.contains("未出勤记录缺少原因"), "错误：{error}");

        // 非未出勤却带原因：拒绝。
        let mut dirty = backup.clone();
        dirty.overtime_records[0].status = OvertimeStatus::Done;
        let error = validate(&dirty).expect_err("非未出勤不应带原因");
        assert!(error.contains("不应包含未出勤原因"), "错误：{error}");
    }

    #[test]
    fn custom_fields_round_trip_through_backup() {
        let mut conn = db::open_in_memory().expect("内存库");
        let card = seed(&mut conn);
        let field = repo::create_custom_field(
            &mut conn,
            NewCustomFieldInput {
                board_id: card.board_id.clone(),
                name: "优先级".to_string(),
                field_type: CustomFieldType::Select,
                options: vec![CustomFieldOption {
                    id: "opt_high".to_string(),
                    label: "高".to_string(),
                    color: "#0f766e".to_string(),
                }],
            },
        )
        .expect("创建自定义字段");
        repo::set_card_field_values(
            &mut conn,
            SetCardFieldValuesInput {
                card_id: card.id.clone(),
                values: vec![CardFieldValueInput {
                    field_id: field.id.clone(),
                    value_text: Some("opt_high".to_string()),
                    value_number: None,
                }],
            },
        )
        .expect("写入字段取值");

        let backup = build(&conn).expect("构建备份");
        assert_eq!(backup.summary().custom_fields, 1);
        assert_eq!(backup.summary().card_field_values, 1);

        let restored = restore(&mut conn, &backup).expect("恢复备份");
        assert_eq!(restored.custom_fields, 1);
        assert_eq!(restored.card_field_values, 1);

        let snapshot = repo::get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.custom_fields.len(), 1);
        assert_eq!(snapshot.custom_fields[0].options.len(), 1);
        assert_eq!(snapshot.card_field_values.len(), 1);
        assert_eq!(
            snapshot.card_field_values[0].value_text.as_deref(),
            Some("opt_high")
        );
    }

    #[test]
    fn backup_with_dangling_custom_field_is_rejected() {
        let mut conn = db::open_in_memory().expect("内存库");
        seed(&mut conn);
        let mut backup = build(&conn).expect("构建备份");
        backup.custom_fields.push(CustomField {
            id: "cf_missing".to_string(),
            board_id: "board_missing".to_string(),
            name: "缺失看板字段".to_string(),
            field_type: CustomFieldType::Number,
            options: Vec::new(),
            sort_order: 0,
            created_at: "2026-11-01T00:00:00.000Z".to_string(),
            updated_at: "2026-11-01T00:00:00.000Z".to_string(),
        });
        let error = validate(&backup).expect_err("引用不存在看板的字段应被拒绝");
        assert!(error.contains("引用了不存在的看板"));
    }

    #[test]
    fn saved_views_round_trip_through_backup() {
        let mut conn = db::open_in_memory().expect("内存库");
        let card = seed(&mut conn);
        let view = repo::create_saved_view(
            &mut conn,
            NewSavedViewInput {
                board_id: card.board_id.clone(),
                name: "本周重点".to_string(),
                view_type: "table".to_string(),
                filters: SavedViewFilters {
                    keyword: "发布".to_string(),
                    status: "active".to_string(),
                    ..Default::default()
                },
                sort: SavedViewSort {
                    key: "created-desc".to_string(),
                    direction: "desc".to_string(),
                },
            },
        )
        .expect("创建保存视图");

        let backup = build(&conn).expect("构建备份");
        // 3 个内置视图 + 1 个自建视图
        assert_eq!(backup.summary().saved_views, 4);

        let restored = restore(&mut conn, &backup).expect("恢复备份");
        assert_eq!(restored.saved_views, 4);

        let snapshot = repo::get_snapshot(&conn).expect("快照");
        let saved = snapshot
            .saved_views
            .iter()
            .find(|item| item.id == view.id)
            .expect("视图应存在");
        assert_eq!(saved.name, "本周重点");
        assert_eq!(saved.view_type, "table");
        assert_eq!(saved.filters.keyword, "发布");
        assert_eq!(saved.filters.status, "active");
        assert_eq!(saved.sort.key, "created-desc");
        assert_eq!(saved.sort.direction, "desc");
    }

    #[test]
    fn backup_with_saved_view_referencing_missing_board_is_rejected() {
        let mut conn = db::open_in_memory().expect("内存库");
        seed(&mut conn);
        let mut backup = build(&conn).expect("构建备份");
        backup.saved_views.push(SavedView {
            id: "sv_missing".to_string(),
            board_id: "board_missing".to_string(),
            name: "悬空视图".to_string(),
            view_type: "board".to_string(),
            filters: SavedViewFilters::default(),
            sort: SavedViewSort::default(),
            is_builtin: false,
            created_at: "2026-11-02T00:00:00.000Z".to_string(),
            updated_at: "2026-11-02T00:00:00.000Z".to_string(),
        });
        let error = validate(&backup).expect_err("引用不存在看板的视图应被拒绝");
        assert!(error.contains("引用了不存在的看板"));
    }
}
