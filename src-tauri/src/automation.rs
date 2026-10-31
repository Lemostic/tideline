//! 自动化（V0.11）的纯逻辑：重复日期推算与规则动作计算。
//!
//! 这里不碰数据库连接，只做可测试的日期与字段计算；
//! 前端 `src/lib/automation.ts` 保持同一套语义，两边都用单元测试锁定。

use rusqlite::{params, Connection, Row};

use crate::models::{
    AutomationRule, AutomationRulePatch, Card, CardActivity, NewAutomationRuleInput,
    NewRecurrenceInput, Priority, Recurrence, RecurrenceFrequency, RecurrencePatch, RuleAction,
    RuleActionKind, RuleTrigger, Subtask,
};
use crate::repo::{self, DbResult};

/// 一年中的某个月的天数。
pub fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

/// 把 `YYYY-MM-DD` 解析成 (年, 月, 日)；非法输入返回 None。
fn parse_parts(date_key: &str) -> Option<(i64, i64, i64)> {
    let bytes = date_key.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = date_key.get(0..4)?.parse().ok()?;
    let month: i64 = date_key.get(5..7)?.parse().ok()?;
    let day: i64 = date_key.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) {
        return None;
    }
    if day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some((year, month, day))
}

/// 把 (年, 月, 日) 拼成 `YYYY-MM-DD`。
fn format_parts(year: i64, month: i64, day: i64) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

/// 某一天是星期几（0=周日 … 6=周六）。用 Sakamoto 算法，不引入日期库。
fn weekday_of(year: i64, month: i64, day: i64) -> i64 {
    const MONTH_OFFSETS: [i64; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let mut y = year;
    if month < 3 {
        y -= 1;
    }
    let offset = MONTH_OFFSETS[(month - 1) as usize];
    (y + y / 4 - y / 100 + y / 400 + offset + day).rem_euclid(7)
}

/// 给纯日期加天数（返回新的 `YYYY-MM-DD`）。
pub fn add_days(date_key: &str, days: i64) -> Option<String> {
    let (year, month, day) = parse_parts(date_key)?;
    // 用 Howard Hinnant 的 days_from_civil 反推，避免跨月计算出错。
    let total = days_from_civil(year, month, day) + days;
    let (new_year, new_month, new_day) = civil_from_days(total);
    Some(format_parts(new_year, new_month, new_day))
}

/// 公历日期 → 「1970-01-01 起的天数」。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 「1970-01-01 起的天数」 → 公历日期。
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 重复日期推算的输入。
pub struct RecurrenceSpec {
    pub frequency: &'static str,
    pub interval_days: i64,
    pub weekdays: Vec<i64>,
}

/// 计算下一次到期日期。
///
/// - daily：基准日 + 1 天
/// - weekly：基准日之后最近的指定星期
/// - monthly：下个月的同一天；当月没有该日时收敛到当月最后一天
/// - interval：基准日 + 间隔天数
pub fn next_recurrence_date(
    spec: &RecurrenceSpec,
    base_date: &str,
) -> Option<String> {
    let (year, month, day) = parse_parts(base_date)?;
    match spec.frequency {
        "daily" => add_days(base_date, 1),
        "interval" => {
            if spec.interval_days < 1 {
                return None;
            }
            add_days(base_date, spec.interval_days)
        }
        "weekly" => {
            let weekdays: Vec<i64> = spec
                .weekdays
                .iter()
                .copied()
                .filter(|value| (0..=6).contains(value))
                .collect();
            if weekdays.is_empty() {
                return None;
            }
            for offset in 1..=7 {
                let candidate = add_days(base_date, offset)?;
                let (y, m, d) = parse_parts(&candidate)?;
                if weekdays.contains(&weekday_of(y, m, d)) {
                    return Some(candidate);
                }
            }
            None
        }
        "monthly" => {
            let mut next_year = year;
            let mut next_month = month + 1;
            if next_month > 12 {
                next_month = 1;
                next_year += 1;
            }
            let max_day = days_in_month(next_year, next_month);
            Some(format_parts(next_year, next_month, day.min(max_day)))
        }
        _ => None,
    }
}

/// 规则动作执行后，任务各字段应有的新值。
#[derive(Debug, Default, PartialEq)]
pub struct RuleOutcome {
    pub due_date: Option<Option<String>>,
    pub priority: Option<Option<Priority>>,
    pub labels: Option<Vec<String>>,
    pub subtasks: Option<Vec<Subtask>>,
}

/// 校验规则动作；合法返回 None，非法返回可读错误。
pub fn validate_rule_actions(actions: &[RuleAction]) -> Option<String> {
    if actions.is_empty() {
        return Some("规则至少需要一个动作".to_string());
    }
    for action in actions {
        match action.kind {
            RuleActionKind::SetDueDateOffset => {
                if !(-365..=365).contains(&action.offset_days) {
                    return Some("日期偏移必须是 -365 到 365 之间的整数天".to_string());
                }
            }
            RuleActionKind::ClearDueDate => {}
            RuleActionKind::SetPriority => {
                if action.priority.is_none() {
                    return Some("设置优先级动作需要选择一个优先级".to_string());
                }
            }
            RuleActionKind::AddLabels => {
                if action.labels.is_empty() {
                    return Some("添加标签动作至少需要一个标签".to_string());
                }
                if action
                    .labels
                    .iter()
                    .any(|label| label.trim().is_empty() || label.chars().count() > 12)
                {
                    return Some("标签不能为空，且单个标签最多 12 个字".to_string());
                }
            }
            RuleActionKind::AppendSubtasks => {
                if action.subtasks.is_empty() {
                    return Some("追加子任务动作至少需要一个子任务".to_string());
                }
                if action
                    .subtasks
                    .iter()
                    .any(|title| title.trim().is_empty() || title.chars().count() > 60)
                {
                    return Some("子任务标题不能为空，且单个子任务最多 60 个字".to_string());
                }
            }
        }
    }
    None
}

/// 计算规则动作对任务产生的字段变更（只含真正变化的字段）。
pub fn apply_rule_actions(
    labels: &[String],
    subtasks: &[Subtask],
    priority: Option<Priority>,
    actions: &[RuleAction],
    today: &str,
) -> RuleOutcome {
    let mut outcome = RuleOutcome::default();
    let mut next_labels = labels.to_vec();
    let mut next_subtasks = subtasks.to_vec();

    for action in actions {
        match action.kind {
            RuleActionKind::SetDueDateOffset => {
                outcome.due_date = Some(add_days(today, action.offset_days));
            }
            RuleActionKind::ClearDueDate => {
                outcome.due_date = Some(None);
            }
            RuleActionKind::SetPriority => {
                if let Some(value) = action.priority {
                    outcome.priority = Some(Some(value));
                }
            }
            RuleActionKind::AddLabels => {
                for label in &action.labels {
                    let value = label.trim();
                    if !value.is_empty() && !next_labels.iter().any(|item| item == value) {
                        next_labels.push(value.to_string());
                    }
                }
            }
            RuleActionKind::AppendSubtasks => {
                for title in &action.subtasks {
                    let value = title.trim();
                    if !value.is_empty()
                        && !next_subtasks.iter().any(|item| item.title == value)
                    {
                        next_subtasks.push(Subtask {
                            id: crate::repo::create_id("s"),
                            title: value.to_string(),
                            done: false,
                        });
                    }
                }
            }
        }
    }

    if next_labels.len() != labels.len() {
        outcome.labels = Some(next_labels);
    }
    if next_subtasks.len() != subtasks.len() {
        outcome.subtasks = Some(next_subtasks);
    }
    let _ = priority;
    outcome
}

// ---------------------------------------------------------------------------
// 数据库访问层
// ---------------------------------------------------------------------------

const RECURRENCE_COLUMNS: &str =
    "id, card_id, frequency, interval_value, weekdays, next_due_date, enabled, created_at, updated_at";
const RULE_COLUMNS: &str =
    "id, name, trigger, list_id, actions, enabled, last_error, created_at, updated_at";
const ACTIVITY_COLUMNS: &str = "id, card_id, event_type, field, old_value, new_value, created_at";

fn row_to_recurrence(row: &Row<'_>) -> rusqlite::Result<Recurrence> {
    let frequency: String = row.get("frequency")?;
    let weekdays: String = row.get("weekdays")?;
    Ok(Recurrence {
        id: row.get("id")?,
        card_id: row.get("card_id")?,
        frequency: RecurrenceFrequency::from_db(&frequency),
        interval_value: row.get("interval_value")?,
        weekdays: serde_json::from_str(&weekdays).unwrap_or_default(),
        next_due_date: row.get("next_due_date")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_rule(row: &Row<'_>) -> rusqlite::Result<AutomationRule> {
    let trigger: String = row.get("trigger")?;
    let actions: String = row.get("actions")?;
    Ok(AutomationRule {
        id: row.get("id")?,
        name: row.get("name")?,
        trigger: RuleTrigger::from_db(&trigger),
        list_id: row.get("list_id")?,
        actions: serde_json::from_str(&actions).unwrap_or_default(),
        enabled: row.get::<_, i64>("enabled")? != 0,
        last_error: row.get("last_error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_activity(row: &Row<'_>) -> rusqlite::Result<CardActivity> {
    Ok(CardActivity {
        id: row.get("id")?,
        card_id: row.get("card_id")?,
        event_type: row.get("event_type")?,
        field: row.get("field")?,
        old_value: row.get("old_value")?,
        new_value: row.get("new_value")?,
        created_at: row.get("created_at")?,
    })
}

/// 全部重复配置。
pub fn get_recurrences(conn: &Connection) -> DbResult<Vec<Recurrence>> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {RECURRENCE_COLUMNS} FROM recurrences ORDER BY created_at ASC, id ASC"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_to_recurrence)
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<Recurrence>>>()
        .map_err(|error| error.to_string())
}

/// 某张任务的重复配置（最多一条）。
pub fn get_recurrence_by_card(conn: &Connection, card_id: &str) -> DbResult<Option<Recurrence>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {RECURRENCE_COLUMNS} FROM recurrences WHERE card_id = ?1 \
                 ORDER BY created_at ASC LIMIT 1"
            ),
            [card_id],
            row_to_recurrence,
        )
        .ok())
}

/// 新建重复配置：同一张任务只保留一条，旧配置先删掉。
pub fn create_recurrence(
    conn: &mut Connection,
    input: NewRecurrenceInput,
) -> DbResult<Recurrence> {
    let card = repo::get_card(conn, &input.card_id)?;
    if card.deleted_at.is_some() {
        return Err("回收站中的任务不能设置重复".to_string());
    }
    let frequency = input.frequency;
    let interval_value = match frequency {
        RecurrenceFrequency::Interval => input.interval_value.unwrap_or(1).max(1),
        _ => 1,
    };
    let weekdays = input
        .weekdays
        .map(|days| {
            days.into_iter()
                .filter(|day| (0..=6).contains(day))
                .collect::<Vec<i64>>()
        })
        .unwrap_or_default();
    if frequency == RecurrenceFrequency::Weekly && weekdays.is_empty() {
        return Err("每周重复至少要选择一个星期".to_string());
    }
    let base = match input.next_due_date {
        Some(Some(value)) => value,
        _ => card
            .due_date
            .clone()
            .unwrap_or_else(|| today_key()),
    };
    let next_due_date = next_recurrence_date(
        &RecurrenceSpec {
            frequency: frequency.as_str(),
            interval_days: interval_value,
            weekdays: weekdays.clone(),
        },
        &base,
    );

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM recurrences WHERE card_id = ?1",
        [&input.card_id],
    )
    .map_err(|error| error.to_string())?;
    let now = repo::now_iso();
    let recurrence = Recurrence {
        id: repo::create_id("r"),
        card_id: input.card_id,
        frequency,
        interval_value,
        weekdays,
        next_due_date,
        enabled: true,
        created_at: now.clone(),
        updated_at: now,
    };
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
            serde_json::to_string(&recurrence.weekdays)
                .map_err(|error| format!("星期序列化失败：{error}"))?,
            &recurrence.next_due_date,
            recurrence.enabled as i64,
            &recurrence.created_at,
            &recurrence.updated_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(recurrence)
}

/// 修改重复配置。
pub fn update_recurrence(
    conn: &mut Connection,
    id: &str,
    patch: RecurrencePatch,
) -> DbResult<Recurrence> {
    let mut recurrence = get_recurrence(conn, id)?;
    if let Some(frequency) = patch.frequency {
        recurrence.frequency = frequency;
    }
    if let Some(interval_value) = patch.interval_value {
        recurrence.interval_value = if recurrence.frequency == RecurrenceFrequency::Interval {
            interval_value.max(1)
        } else {
            1
        };
    }
    if let Some(weekdays) = patch.weekdays {
        recurrence.weekdays = weekdays
            .into_iter()
            .filter(|day| (0..=6).contains(day))
            .collect::<Vec<i64>>();
    }
    if recurrence.frequency == RecurrenceFrequency::Weekly && recurrence.weekdays.is_empty() {
        return Err("每周重复至少要选择一个星期".to_string());
    }
    if let Some(next_due_date) = patch.next_due_date {
        recurrence.next_due_date = next_due_date;
    }    if let Some(enabled) = patch.enabled {
        recurrence.enabled = enabled;
    }
    recurrence.updated_at = repo::now_iso();
    conn.execute(
        "UPDATE recurrences SET frequency = ?1, interval_value = ?2, weekdays = ?3, \
         next_due_date = ?4, enabled = ?5, updated_at = ?6 WHERE id = ?7",
        params![
            recurrence.frequency.as_str(),
            recurrence.interval_value,
            serde_json::to_string(&recurrence.weekdays)
                .map_err(|error| format!("星期序列化失败：{error}"))?,
            &recurrence.next_due_date,
            recurrence.enabled as i64,
            &recurrence.updated_at,
            &recurrence.id,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(recurrence)
}

/// 删除重复配置。
pub fn delete_recurrence(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM recurrences WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn get_recurrence(conn: &Connection, id: &str) -> DbResult<Recurrence> {
    conn.query_row(
        &format!("SELECT {RECURRENCE_COLUMNS} FROM recurrences WHERE id = ?1"),
        [id],
        row_to_recurrence,
    )
    .map_err(|error| error.to_string())
}

/// 全部本地规则。
pub fn get_automation_rules(conn: &Connection) -> DbResult<Vec<AutomationRule>> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {RULE_COLUMNS} FROM automation_rules ORDER BY created_at ASC, id ASC"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_to_rule)
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<AutomationRule>>>()
        .map_err(|error| error.to_string())
}

/// 新建规则：默认关闭，动作先过一遍校验。
pub fn create_automation_rule(
    conn: &mut Connection,
    input: NewAutomationRuleInput,
) -> DbResult<AutomationRule> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("规则名称不能为空".to_string());
    }
    if let Some(message) = validate_rule_actions(&input.actions) {
        return Err(message);
    }
    if input.trigger == RuleTrigger::MoveToList {
        let list_id = input
            .list_id
            .clone()
            .ok_or_else(|| "移动触发必须选择一个目标列表".to_string())?;
        repo::get_list(conn, &list_id)?;
    }
    let now = repo::now_iso();
    let rule = AutomationRule {
        id: repo::create_id("ar"),
        name,
        trigger: input.trigger,
        list_id: input.list_id,
        actions: input.actions,
        enabled: input.enabled.unwrap_or(false),
        last_error: String::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    conn.execute(
        "INSERT INTO automation_rules \
         (id, name, trigger, list_id, actions, enabled, last_error, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            &rule.id,
            &rule.name,
            rule.trigger.as_str(),
            &rule.list_id,
            serde_json::to_string(&rule.actions)
                .map_err(|error| format!("规则动作序列化失败：{error}"))?,
            rule.enabled as i64,
            &rule.last_error,
            &rule.created_at,
            &rule.updated_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(rule)
}

/// 修改规则。
pub fn update_automation_rule(
    conn: &mut Connection,
    id: &str,
    patch: AutomationRulePatch,
) -> DbResult<AutomationRule> {
    let mut rule = get_automation_rule(conn, id)?;
    if let Some(name) = patch.name {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            return Err("规则名称不能为空".to_string());
        }
        rule.name = trimmed;
    }
    if let Some(trigger) = patch.trigger {
        rule.trigger = trigger;
    }
    if let Some(list_id) = patch.list_id {
        rule.list_id = list_id;
    }
    if let Some(actions) = patch.actions {
        if let Some(message) = validate_rule_actions(&actions) {
            return Err(message);
        }
        rule.actions = actions;
    }
    if let Some(enabled) = patch.enabled {
        rule.enabled = enabled;
    }
    if rule.trigger == RuleTrigger::MoveToList {
        let list_id = rule
            .list_id
            .clone()
            .ok_or_else(|| "移动触发必须选择一个目标列表".to_string())?;
        repo::get_list(conn, &list_id)?;
    }
    rule.updated_at = repo::now_iso();
    conn.execute(
        "UPDATE automation_rules SET name = ?1, trigger = ?2, list_id = ?3, actions = ?4, \
         enabled = ?5, updated_at = ?6 WHERE id = ?7",
        params![
            &rule.name,
            rule.trigger.as_str(),
            &rule.list_id,
            serde_json::to_string(&rule.actions)
                .map_err(|error| format!("规则动作序列化失败：{error}"))?,
            rule.enabled as i64,
            &rule.updated_at,
            &rule.id,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(rule)
}

/// 删除规则。
pub fn delete_automation_rule(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM automation_rules WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn get_automation_rule(conn: &Connection, id: &str) -> DbResult<AutomationRule> {
    conn.query_row(
        &format!("SELECT {RULE_COLUMNS} FROM automation_rules WHERE id = ?1"),
        [id],
        row_to_rule,
    )
    .map_err(|error| error.to_string())
}

/// 记录一条任务活动；调用方负责放在同一事务里。
pub fn insert_activity(
    conn: &Connection,
    card_id: &str,
    event_type: &str,
    field: &str,
    old_value: &str,
    new_value: &str,
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO card_activity \
         (id, card_id, event_type, field, old_value, new_value, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            repo::create_id("act"),
            card_id,
            event_type,
            field,
            old_value,
            new_value,
            repo::now_iso(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// 某张任务的最近活动（倒序，最多 limit 条）。
pub fn get_card_activity(
    conn: &Connection,
    card_id: &str,
    limit: i64,
) -> DbResult<Vec<CardActivity>> {
    let limit = limit.clamp(1, 500);
    let mut statement = conn
        .prepare(&format!(
            "SELECT {ACTIVITY_COLUMNS} FROM card_activity WHERE card_id = ?1 \
             ORDER BY created_at DESC, id DESC LIMIT ?2"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![card_id, limit], row_to_activity)
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<CardActivity>>>()
        .map_err(|error| error.to_string())
}

/// 备份用：全部活动日志（按时间正序，便于恢复后保持顺序）。
pub fn get_all_card_activity(conn: &Connection) -> DbResult<Vec<CardActivity>> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {ACTIVITY_COLUMNS} FROM card_activity ORDER BY created_at ASC, id ASC"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_to_activity)
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<CardActivity>>>()
        .map_err(|error| error.to_string())
}

/// 本地日期 `YYYY-MM-DD`。
pub fn today_key() -> String {
    repo::now_iso()[..10].to_string()
}

/// 规则执行结果：写回了哪些字段。
#[derive(Debug, Default)]
pub struct RuleRunResult {
    /// 实际写入的字段补丁
    pub patch: Vec<(String, String)>,
    /// 执行失败时的可读原因
    pub error: Option<String>,
}

/// 执行命中的规则，返回实际写入的字段补丁。
///
/// 规则失败不影响主流程：错误写进 `error`，调用方只记录不抛出。
pub fn run_rules(
    conn: &mut Connection,
    card: &Card,
    trigger: RuleTrigger,
    today: &str,
) -> DbResult<RuleRunResult> {
    let mut result = RuleRunResult::default();
    let rules = get_automation_rules(conn)?;
    let matching: Vec<AutomationRule> = rules
        .into_iter()
        .filter(|rule| {
            if !rule.enabled || rule.trigger != trigger {
                return false;
            }
            if trigger == RuleTrigger::MoveToList {
                return rule.list_id.as_deref() == Some(card.list_id.as_str());
            }
            true
        })
        .collect();
    if matching.is_empty() {
        return Ok(result);
    }

    for rule in matching {
        let outcome = apply_rule_actions(
            &card.labels,
            &card.subtasks,
            card.priority,
            &rule.actions,
            today,
        );
        let mut patch_parts: Vec<(String, String)> = Vec::new();
        if let Some(due_date) = outcome.due_date.clone() {
            patch_parts.push((
                "dueDate".to_string(),
                due_date.clone().unwrap_or_default(),
            ));
        }
        if let Some(priority) = outcome.priority.clone() {
            let value = match priority {
                Some(item) => item.as_str().to_string(),
                None => String::new(),
            };
            patch_parts.push(("priority".to_string(), value));
        }
        if let Some(labels) = outcome.labels.clone() {
            patch_parts.push(("labels".to_string(), labels.join(",")));
        }
        if let Some(subtasks) = outcome.subtasks.clone() {
            patch_parts.push((
                "subtasks".to_string(),
                subtasks
                    .iter()
                    .map(|item| item.title.clone())
                    .collect::<Vec<String>>()
                    .join(","),
            ));
        }
        if patch_parts.is_empty() {
            continue;
        }

        match apply_rule_patch(conn, &card.id, &outcome) {
            Ok(()) => {
                for (field, value) in &patch_parts {
                    insert_activity(conn, &card.id, "updated", field, "", value)?;
                }
                result.patch.extend(patch_parts);
                // 规则执行成功，清掉上次的失败提示
                conn.execute(
                    "UPDATE automation_rules SET last_error = '' WHERE id = ?1",
                    [&rule.id],
                )
                .map_err(|error| error.to_string())?;
            }
            Err(message) => {
                conn.execute(
                    "UPDATE automation_rules SET last_error = ?1 WHERE id = ?2",
                    params![message, &rule.id],
                )
                .map_err(|error| error.to_string())?;
                result.error = Some(message);
            }
        }
    }
    Ok(result)
}

/// 把规则计算出的字段变更写回任务。
fn apply_rule_patch(
    conn: &mut Connection,
    card_id: &str,
    outcome: &RuleOutcome,
) -> Result<(), String> {
    let labels_json = match &outcome.labels {
        Some(labels) => serde_json::to_string(labels).map_err(|error| error.to_string())?,
        None => String::new(),
    };
    let subtasks_json = match &outcome.subtasks {
        Some(subtasks) => serde_json::to_string(subtasks).map_err(|error| error.to_string())?,
        None => String::new(),
    };
    conn.execute(
        "UPDATE cards SET \
         due_date = COALESCE(?1, due_date), \
         priority = CASE WHEN ?2 = '' THEN priority ELSE ?2 END, \
         labels = CASE WHEN ?3 = '' THEN labels ELSE ?3 END, \
         subtasks = CASE WHEN ?4 = '' THEN subtasks ELSE ?4 END, \
         updated_at = ?5 \
         WHERE id = ?6",
        params![
            outcome.due_date.clone().flatten(),
            outcome
                .priority
                .flatten()
                .map(|item| item.as_str().to_string())
                .unwrap_or_default(),
            labels_json,
            subtasks_json,
            repo::now_iso(),
            card_id,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// 完成任务后滚动重复任务，返回生成的新任务（没有重复配置时返回 None）。
///
/// 幂等性由 `recurrence_runs` 的主键保证：同一个完成事件重复执行不会重复生成。
pub fn roll_recurrence(
    conn: &mut Connection,
    card_id: &str,
) -> DbResult<Option<Card>> {
    let Some(recurrence) = get_recurrence_by_card(conn, card_id)? else {
        return Ok(None);
    };
    if !recurrence.enabled {
        return Ok(None);
    }
    let card = repo::get_card(conn, card_id)?;
    if card.deleted_at.is_some() {
        return Ok(None);
    }

    // 已经为这次完成生成过就不再生成。
    let already: Option<String> = conn
        .query_row(
            "SELECT generated_card_id FROM recurrence_runs \
             WHERE recurrence_id = ?1 AND completed_card_id = ?2",
            params![&recurrence.id, card_id],
            |row| row.get(0),
        )
        .ok();
    if already.is_some() {
        return Ok(None);
    }

    let base = recurrence
        .next_due_date
        .clone()
        .or_else(|| card.due_date.clone())
        .unwrap_or_else(today_key);
    let next_due = next_recurrence_date(
        &RecurrenceSpec {
            frequency: recurrence.frequency.as_str(),
            interval_days: recurrence.interval_value,
            weekdays: recurrence.weekdays.clone(),
        },
        &base,
    );

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let now = repo::now_iso();
    let generated_id = repo::create_id("c");
    let position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM cards \
             WHERE list_id = ?1 AND deleted_at IS NULL",
            [&card.list_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let labels_json = serde_json::to_string(&card.labels).map_err(|error| error.to_string())?;
    let subtasks_json = serde_json::to_string(&card.subtasks).map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO cards \
         (id, board_id, list_id, title, description, due_date, start_date, priority, accent, \
          completed, labels, subtasks, position, deleted_at, recurrence_id, generated_from_id, \
          created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, 0, ?9, ?10, ?11, NULL, ?12, ?13, ?14, ?14)",
        params![
            &generated_id,
            &card.board_id,
            &card.list_id,
            &card.title,
            &card.description,
            &next_due,
            card.priority.map(|item| item.as_str().to_string()),
            card.accent.map(|item| item.as_str().to_string()),
            labels_json,
            subtasks_json,
            position,
            &recurrence.id,
            &card.id,
            &now,
        ],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO recurrence_runs \
         (recurrence_id, completed_card_id, generated_card_id, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
        params![&recurrence.id, &card.id, &generated_id, &now],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE recurrences SET next_due_date = ?1, updated_at = ?2 WHERE id = ?3",
        params![&next_due, &now, &recurrence.id],
    )
    .map_err(|error| error.to_string())?;
    insert_activity(&tx, &generated_id, "recurrence", "", "", &card.id)?;
    tx.commit().map_err(|error| error.to_string())?;

    Ok(Some(repo::get_card(conn, &generated_id)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(frequency: &'static str) -> RecurrenceSpec {
        RecurrenceSpec {
            frequency,
            interval_days: 1,
            weekdays: Vec::new(),
        }
    }
    #[test]
    fn daily_moves_one_day() {
        assert_eq!(
            next_recurrence_date(&spec("daily"), "2026-01-31"),
            Some("2026-02-01".to_string())
        );
    }

    #[test]
    fn monthly_clamps_to_end_of_short_month() {
        assert_eq!(
            next_recurrence_date(&spec("monthly"), "2026-01-31"),
            Some("2026-02-28".to_string())
        );
        assert_eq!(
            next_recurrence_date(&spec("monthly"), "2028-01-31"),
            Some("2028-02-29".to_string())
        );
        assert_eq!(
            next_recurrence_date(&spec("monthly"), "2026-12-15"),
            Some("2027-01-15".to_string())
        );
    }

    #[test]
    fn weekly_picks_next_matching_day() {
        let mut weekly = spec("weekly");
        // 2026-01-05 是周一
        weekly.weekdays = vec![1];
        assert_eq!(
            next_recurrence_date(&weekly, "2026-01-05"),
            Some("2026-01-12".to_string())
        );
        // 基准日当天就命中时，往后找而不是回到当天
        weekly.weekdays = vec![5];
        assert_eq!(
            next_recurrence_date(&weekly, "2026-01-05"),
            Some("2026-01-09".to_string())
        );
    }

    #[test]
    fn interval_requires_positive_days() {
        let mut interval = spec("interval");
        interval.interval_days = 5;
        assert_eq!(
            next_recurrence_date(&interval, "2026-01-01"),
            Some("2026-01-06".to_string())
        );
        interval.interval_days = 0;
        assert_eq!(next_recurrence_date(&interval, "2026-01-01"), None);
    }

    #[test]
    fn invalid_base_date_returns_none() {
        assert_eq!(next_recurrence_date(&spec("daily"), "2026-13-01"), None);
        assert_eq!(next_recurrence_date(&spec("daily"), "not-a-date"), None);
    }

    #[test]
    fn weekday_matches_known_dates() {
        assert_eq!(weekday_of(2026, 1, 5), 1); // 周一
        assert_eq!(weekday_of(2026, 1, 11), 0); // 周日
    }

    #[test]
    fn rule_actions_only_report_real_changes() {
        let labels = vec!["研发".to_string()];
        let subtasks = vec![Subtask {
            id: "s1".to_string(),
            title: "写文档".to_string(),
            done: false,
        }];
        let actions = vec![RuleAction {
            kind: RuleActionKind::AddLabels,
            offset_days: 0,
            priority: None,
            labels: vec!["研发".to_string(), "高风险".to_string()],
            subtasks: Vec::new(),
        }];
        let outcome = apply_rule_actions(&labels, &subtasks, None, &actions, "2026-01-01");
        assert_eq!(
            outcome.labels,
            Some(vec!["研发".to_string(), "高风险".to_string()])
        );
        assert_eq!(outcome.subtasks, None);
    }

    #[test]
    fn rule_actions_validate_bounds() {
        assert!(validate_rule_actions(&[]).is_some());
        let bad_offset = RuleAction {
            kind: RuleActionKind::SetDueDateOffset,
            offset_days: 400,
            priority: None,
            labels: Vec::new(),
            subtasks: Vec::new(),
        };
        assert!(validate_rule_actions(&[bad_offset]).is_some());
    }
}
