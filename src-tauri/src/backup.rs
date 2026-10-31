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
        card_board.insert(card.id.as_str(), card.board_id.as_str());
    }

    let mut dependency_edges: HashMap<String, Vec<String>> = HashMap::new();
    for dependency in &backup.dependencies {
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
        if card_board_id != blocker_board_id {
            return Err("备份中存在跨看板的任务依赖".to_string());
        }
        dependency_edges
            .entry(dependency.card_id.clone())
            .or_default()
            .push(dependency.depends_on_card_id.clone());
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
        if !record.hours.is_finite() || record.hours <= 0.0 {
            return Err("备份中的加班时长无效".to_string());
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
        if record.points == 0 {
            return Err("备份中的绩效分值不能为 0".to_string());
        }
    }

    Ok(())
}

/// 用备份替换当前库：单事务内先清空四张表，再按原 id 全量写回。
pub fn restore(conn: &mut Connection, backup: &BackupFile) -> Result<BackupSummary, String> {
    validate(backup)?;
    let tx = conn.transaction().map_err(|error| format!("恢复失败：{error}"))?;
    tx.execute("DELETE FROM goal_cards", [])
        .and_then(|_| tx.execute("DELETE FROM goals", []))
        .and_then(|_| tx.execute("DELETE FROM performance_records", []))
        .and_then(|_| tx.execute("DELETE FROM overtime_records", []))
        .and_then(|_| tx.execute("DELETE FROM team_members", []))
        .and_then(|_| tx.execute("DELETE FROM board_set_boards", []))
        .and_then(|_| tx.execute("DELETE FROM board_sets", []))
        .and_then(|_| tx.execute("DELETE FROM card_dependencies", []))
        .and_then(|_| tx.execute("DELETE FROM cards", []))
        .and_then(|_| tx.execute("DELETE FROM lists", []))
        .and_then(|_| tx.execute("DELETE FROM boards", []))
        .and_then(|_| tx.execute("DELETE FROM inbox_items", []))
        .map_err(|error| format!("清理旧数据失败：{error}"))?;

    for board in &backup.boards {
        tx.execute(
            "INSERT INTO boards (id, title, description, color, starred, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &board.id,
                &board.title,
                &board.description,
                board.color.as_str(),
                board.starred as i64,
                &board.created_at,
                &board.updated_at,
            ],
        )
        .map_err(|error| format!("写入看板「{}」失败：{error}", board.title))?;
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
              completed, labels, subtasks, position, deleted_at, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
                &card.created_at,
                &card.updated_at,
            ],
        )
        .map_err(|error| format!("写入任务「{}」失败：{error}", card.title))?;
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
             (id, name, role, status, joined_at, released_at, note, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &member.id,
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

    for record in &backup.overtime_records {
        tx.execute(
            "INSERT INTO overtime_records \
             (id, member_id, date, hours, status, note, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &record.id,
                &record.member_id,
                &record.date,
                record.hours,
                record.status.as_str(),
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
             (id, member_id, date, points, reason, category, note, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &record.id,
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
            "INSERT INTO card_dependencies (card_id, depends_on_card_id) VALUES (?1, ?2)",
            params![&dependency.card_id, &dependency.depends_on_card_id],
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
        IdInput, NewBoardInput, NewCardInput, NewListInput, Priority, SetDependenciesInput,
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
                title: "任务 A".to_string(),
                description: Some("描述".to_string()),
                due_date: Some("2026-05-01".to_string()),
                start_date: Some("2026-04-01".to_string()),
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
    fn invalid_dependency_backup_is_rejected() {
        let mut conn = db::open_in_memory().expect("内存库");
        seed(&mut conn);
        let mut backup = build(&conn).expect("构建备份");
        if backup.cards.is_empty() {
            backup.cards.push(Card {
                id: "c_x".to_string(),
                board_id: "b_x".to_string(),
                list_id: "l_x".to_string(),
                title: "x".to_string(),
                description: String::new(),
                due_date: None,
                start_date: None,
                priority: None,
                accent: None,
                completed: false,
                deleted_at: None,
                labels: Vec::new(),
                subtasks: Vec::new(),
                position: 0,
                created_at: repo::now_iso(),
                updated_at: repo::now_iso(),
            });
        }
        backup.dependencies.push(CardDependency {
            card_id: backup.cards[0].id.clone(),
            depends_on_card_id: "c_missing".to_string(),
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
        let member = repo::create_team_member(
            &mut conn,
            NewTeamMemberInput {
                name: "张三".to_string(),
                role: MemberRole::Dev,
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
        let restored = restore(&mut conn, &backup).expect("恢复备份");
        assert_eq!(restored.team_members, 1);
        let snapshot = repo::get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.team_members[0].id, member.id);
        assert_eq!(snapshot.overtime_records[0].member_id, member.id);
        assert_eq!(snapshot.performance_records[0].member_id, member.id);
    }
}
