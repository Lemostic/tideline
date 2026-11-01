//! 本地提醒（V0.11）：到期 / 逾期 / 每日摘要的判定、设置与投递去重。
//!
//! 提醒默认全部关闭。提醒是副作用：任何一条通知发不出去都不能影响任务读写，
//! 因此这里把「算出哪些任务该提醒」与「真正弹出通知」分开，
//! 前者可单元测试，后者由桌面端调度线程调用。

use rusqlite::{params, Connection};

use crate::models::{NotificationSettings, NotificationSettingsInput};
use crate::repo::DbResult;

/// 提醒种类。
pub const KIND_DUE: &str = "due";
pub const KIND_OVERDUE: &str = "overdue";
pub const KIND_DAILY_SUMMARY: &str = "daily_summary";

/// 提前天数的取值范围。
const MIN_LEAD_DAYS: i64 = 0;
const MAX_LEAD_DAYS: i64 = 30;

/// 默认每日摘要时间。
const DEFAULT_SUMMARY_TIME: &str = "09:00";

/// 读取提醒设置（表里固定只有一行，缺失时补默认值）。
pub fn get_settings(conn: &Connection) -> DbResult<NotificationSettings> {
    let settings = conn
        .query_row(
            "SELECT due_enabled, overdue_enabled, daily_summary_enabled, daily_summary_time, \
             lead_days, updated_at FROM notification_settings WHERE id = 1",
            [],
            |row| {
                Ok(NotificationSettings {
                    due_enabled: row.get::<_, i64>("due_enabled")? != 0,
                    overdue_enabled: row.get::<_, i64>("overdue_enabled")? != 0,
                    daily_summary_enabled: row.get::<_, i64>("daily_summary_enabled")? != 0,
                    daily_summary_time: row.get("daily_summary_time")?,
                    lead_days: row.get("lead_days")?,
                    updated_at: row.get("updated_at")?,
                })
            },
        )
        .ok();
    match settings {
        Some(value) => Ok(value),
        None => {
            let stamp = crate::repo::now_iso();
            conn.execute(
                "INSERT OR IGNORE INTO notification_settings \
                 (id, due_enabled, overdue_enabled, daily_summary_enabled, daily_summary_time, \
                  lead_days, updated_at) \
                 VALUES (1, 0, 0, 0, ?1, 1, ?2)",
                params![DEFAULT_SUMMARY_TIME, &stamp],
            )
            .map_err(|error| error.to_string())?;
            Ok(NotificationSettings {
                due_enabled: false,
                overdue_enabled: false,
                daily_summary_enabled: false,
                daily_summary_time: DEFAULT_SUMMARY_TIME.to_string(),
                lead_days: 1,
                updated_at: stamp,
            })
        }
    }
}

/// 更新提醒设置：只更新传入的字段。
pub fn set_settings(
    conn: &Connection,
    input: &NotificationSettingsInput,
) -> DbResult<NotificationSettings> {
    let mut settings = get_settings(conn)?;
    if let Some(value) = input.due_enabled {
        settings.due_enabled = value;
    }
    if let Some(value) = input.overdue_enabled {
        settings.overdue_enabled = value;
    }
    if let Some(value) = input.daily_summary_enabled {
        settings.daily_summary_enabled = value;
    }
    if let Some(value) = input.daily_summary_time.as_ref() {
        let trimmed = value.trim().to_string();
        if !is_valid_time(&trimmed) {
            return Err("每日摘要时间格式应为 HH:MM".to_string());
        }
        settings.daily_summary_time = trimmed;
    }
    if let Some(value) = input.lead_days {
        if !(MIN_LEAD_DAYS..=MAX_LEAD_DAYS).contains(&value) {
            return Err(format!(
                "提前提醒天数必须在 {MIN_LEAD_DAYS} 到 {MAX_LEAD_DAYS} 之间"
            ));
        }
        settings.lead_days = value;
    }
    settings.updated_at = crate::repo::now_iso();
    conn.execute(
        "UPDATE notification_settings SET due_enabled = ?1, overdue_enabled = ?2, \
         daily_summary_enabled = ?3, daily_summary_time = ?4, lead_days = ?5, updated_at = ?6 \
         WHERE id = 1",
        params![
            settings.due_enabled as i64,
            settings.overdue_enabled as i64,
            settings.daily_summary_enabled as i64,
            &settings.daily_summary_time,
            settings.lead_days,
            &settings.updated_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(settings)
}

/// `HH:MM` 是否合法。
pub fn is_valid_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let hour: u32 = match value.get(0..2).and_then(|part| part.parse().ok()) {
        Some(value) => value,
        None => return false,
    };
    let minute: u32 = match value.get(3..5).and_then(|part| part.parse().ok()) {
        Some(value) => value,
        None => return false,
    };
    hour < 24 && minute < 60
}

/// 一条待投递的提醒。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingReminder {
    pub kind: String,
    /// 去重键：同一天同一条提醒只发一次
    pub card_id: String,
    pub title: String,
    pub body: String,
}

/// 选出今天该提醒的任务。
///
/// `today` 是本地日期 `YYYY-MM-DD`。到期提醒包含「今天到期」与「未来 lead_days 天内到期」。
pub fn collect_due_reminders(
    conn: &Connection,
    settings: &NotificationSettings,
    today: &str,
) -> DbResult<Vec<PendingReminder>> {
    let mut reminders: Vec<PendingReminder> = Vec::new();
    if !settings.due_enabled && !settings.overdue_enabled {
        return Ok(reminders);
    }

    let mut statement = conn
        .prepare(
            "SELECT id, title, due_date FROM cards \
             WHERE deleted_at IS NULL AND completed = 0 AND due_date IS NOT NULL",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, String>("title")?,
                row.get::<_, String>("due_date")?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let cards = rows
        .collect::<rusqlite::Result<Vec<(String, String, String)>>>()
        .map_err(|error| error.to_string())?;

    let horizon = crate::automation::add_days(today, settings.lead_days);
    for (card_id, title, due_date) in cards {
        if settings.overdue_enabled && due_date.as_str() < today {
            reminders.push(PendingReminder {
                kind: KIND_OVERDUE.to_string(),
                card_id: card_id.clone(),
                title: title.clone(),
                body: format!("「{title}」已逾期（截止 {due_date}）"),
            });
            continue;
        }
        if settings.due_enabled {
            let is_today = due_date == today;
            let within_lead = horizon
                .as_ref()
                .map(|limit| due_date <= *limit)
                .unwrap_or(false);
            if is_today || within_lead {
                reminders.push(PendingReminder {
                    kind: KIND_DUE.to_string(),
                    card_id,
                    title: title.clone(),
                    body: format!("「{title}」即将到期（截止 {due_date}）"),
                });
            }
        }
    }
    Ok(reminders)
}

/// 选出每日摘要的内容：今天到期与已逾期且未完成的任务数量。
pub fn collect_daily_summary(
    conn: &Connection,
    today: &str,
) -> DbResult<(usize, usize)> {
    let due_today: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards \
             WHERE deleted_at IS NULL AND completed = 0 AND due_date = ?1",
            [today],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let overdue: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards \
             WHERE deleted_at IS NULL AND completed = 0 AND due_date < ?1",
            [today],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok((due_today as usize, overdue as usize))
}

/// 今天是否已经到了每日摘要的时间点（本地时间 `HH:MM`）。
pub fn should_send_daily_summary(
    settings: &NotificationSettings,
    now_hour: u32,
    now_minute: u32,
) -> bool {
    if !settings.daily_summary_enabled {
        return false;
    }
    let Some((hour, minute)) = parse_time(&settings.daily_summary_time) else {
        return false;
    };
    // 到点即发，之后一直为真（去重由投递记录负责）。
    (now_hour, now_minute) >= (hour, minute)
}

/// 解析 `HH:MM`。
fn parse_time(value: &str) -> Option<(u32, u32)> {
    if !is_valid_time(value) {
        return None;
    }
    let hour = value.get(0..2)?.parse().ok()?;
    let minute = value.get(3..5)?.parse().ok()?;
    Some((hour, minute))
}

/// 判断这条提醒今天是否已经投递过；未投递过时写入记录。
pub fn mark_delivered(
    conn: &Connection,
    kind: &str,
    day: &str,
    card_id: &str,
) -> DbResult<bool> {
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO notification_deliveries \
             (kind, day, card_id, delivered_at) VALUES (?1, ?2, ?3, ?4)",
            params![kind, day, card_id, crate::repo::now_iso()],
        )
        .map_err(|error| error.to_string())?;
    Ok(inserted > 0)
}

/// 清理早于给定日期的投递记录，避免表无限增长。
pub fn prune_deliveries(conn: &Connection, before: &str) -> DbResult<()> {
    conn.execute(
        "DELETE FROM notification_deliveries WHERE day < ?1",
        [before],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 桌面端调度线程
// ---------------------------------------------------------------------------

/// 提醒检查的间隔（秒）。分钟级足够：提醒本身按天去重。
const CHECK_INTERVAL_SECONDS: u64 = 60;

/// 启动后台提醒线程：每分钟检查一次到期 / 逾期 / 每日摘要。
///
/// 线程随进程退出而结束。发送通知失败只记录日志，不重试也不影响任务读写。
pub fn spawn_scheduler(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(CHECK_INTERVAL_SECONDS));
        if let Err(error) = run_once(&app) {
            eprintln!("[tideline] 提醒检查失败：{error}");
        }
    });
}

/// 执行一轮提醒检查：算出该提醒的任务 → 去重 → 弹出系统通知。
pub fn run_once(app: &tauri::AppHandle) -> DbResult<()> {
    use tauri::Manager;

    let settings = {
        let db = app.state::<crate::db::Db>();
        let conn = db.lock()?;
        get_settings(&conn)?
    };
    if !settings.due_enabled && !settings.overdue_enabled && !settings.daily_summary_enabled {
        return Ok(());
    }

    let now = crate::repo::now_iso();
    let today = now[..10].to_string();
    let hour: u32 = now.get(11..13).and_then(|part| part.parse().ok()).unwrap_or(0);
    let minute: u32 = now.get(14..16).and_then(|part| part.parse().ok()).unwrap_or(0);

    let db = app.state::<crate::db::Db>();
    let mut conn = db.lock()?;
    let mut pending = collect_due_reminders(&conn, &settings, &today)?;
    if should_send_daily_summary(&settings, hour, minute) {
        let (due_today, overdue) = collect_daily_summary(&conn, &today)?;
        if due_today + overdue > 0 {
            pending.push(PendingReminder {
                kind: KIND_DAILY_SUMMARY.to_string(),
                card_id: String::new(),
                title: "今日待办摘要".to_string(),
                body: format!("今天到期 {due_today} 项，已逾期 {overdue} 项"),
            });
        }
    }

    for reminder in pending {
        // 同一天同一条提醒只投递一次。
        if !mark_delivered(&conn, &reminder.kind, &today, &reminder.card_id)? {
            continue;
        }
        if let Err(error) = notify(app, &reminder.title, &reminder.body) {
            eprintln!("[tideline] 发送提醒失败：{error}");
        }
    }
    // 只保留最近 30 天的投递记录。
    let cutoff = crate::automation::add_days(&today, -30).unwrap_or(today);
    let _ = prune_deliveries(&conn, &cutoff);
    Ok(())
}

/// 弹出系统通知；任何失败都只返回错误，不抛出。
fn notify(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_summary_time() {
        assert!(is_valid_time("09:00"));
        assert!(is_valid_time("23:59"));
        assert!(!is_valid_time("24:00"));
        assert!(!is_valid_time("9:00"));
        assert!(!is_valid_time("0900"));
    }

    #[test]
    fn daily_summary_respects_time_and_switch() {
        let mut settings = NotificationSettings {
            due_enabled: false,
            overdue_enabled: false,
            daily_summary_enabled: true,
            daily_summary_time: "09:00".to_string(),
            lead_days: 1,
            updated_at: String::new(),
        };
        assert!(!should_send_daily_summary(&settings, 8, 59));
        assert!(should_send_daily_summary(&settings, 9, 0));
        assert!(should_send_daily_summary(&settings, 10, 30));
        settings.daily_summary_enabled = false;
        assert!(!should_send_daily_summary(&settings, 10, 30));
    }

    #[test]
    fn delivery_deduplicates_same_day() {
        let conn = crate::db::open_in_memory().expect("内存库");
        assert!(mark_delivered(&conn, KIND_DUE, "2026-01-01", "c_1").expect("投递"));
        assert!(!mark_delivered(&conn, KIND_DUE, "2026-01-01", "c_1").expect("重复投递"));
        assert!(mark_delivered(&conn, KIND_DUE, "2026-01-02", "c_1").expect("次日投递"));
    }

    fn settings(due: bool, overdue: bool, lead_days: i64) -> NotificationSettings {
        NotificationSettings {
            due_enabled: due,
            overdue_enabled: overdue,
            daily_summary_enabled: false,
            daily_summary_time: "09:00".to_string(),
            lead_days,
            updated_at: String::new(),
        }
    }

    fn seed_card(conn: &mut rusqlite::Connection, title: &str, due_date: &str) -> String {
        let board = crate::repo::create_board(
            conn,
            crate::models::NewBoardInput {
                title: "提醒测试".to_string(),
                description: None,
                color: None,
            },
        )
        .expect("创建看板");
        let list = crate::repo::create_list(
            conn,
            crate::models::NewListInput {
                board_id: board.id.clone(),
                title: "待办".to_string(),
                color: None,
                wip_limit: None,
            },
        )
        .expect("创建待办列");
        let card = crate::repo::create_card(
            conn,
            crate::models::NewCardInput {
                board_id: board.id.clone(),
                list_id: list.id.clone(),
                title: title.to_string(),
                description: None,
                due_date: Some(due_date.to_string()),
                start_date: None,
                estimated_minutes: None,
                actual_minutes: None,
                priority: None,
                accent: None,
                labels: None,
                subtasks: None,
            },
        )
        .expect("创建任务");
        card.id
    }

    #[test]
    fn due_reminders_respect_switches_and_lead_days() {
        let mut conn = crate::db::open_in_memory().expect("内存库");
        seed_card(&mut conn, "今天到期", "2026-01-05");
        seed_card(&mut conn, "两天后到期", "2026-01-07");
        seed_card(&mut conn, "很久以后", "2026-03-01");

        // 全部关闭时不产生提醒
        let none = collect_due_reminders(&conn, &settings(false, false, 1), "2026-01-05")
            .expect("收集提醒");
        assert!(none.is_empty(), "提醒开关全关时不应产生提醒");

        // 只开到期：今天到期与两天后（lead_days=2）命中
        let due = collect_due_reminders(&conn, &settings(true, false, 2), "2026-01-05")
            .expect("收集提醒");
        let titles: Vec<String> = due.iter().map(|item| item.title.clone()).collect();
        assert!(titles.contains(&"今天到期".to_string()));
        assert!(titles.contains(&"两天后到期".to_string()));
        assert!(!titles.contains(&"很久以后".to_string()));
        assert!(due.iter().all(|item| item.kind == KIND_DUE));
    }

    #[test]
    fn overdue_reminders_only_fire_for_past_due_dates() {
        let mut conn = crate::db::open_in_memory().expect("内存库");
        seed_card(&mut conn, "已经逾期", "2026-01-01");
        seed_card(&mut conn, "还没到期", "2026-01-05");

        let overdue = collect_due_reminders(&conn, &settings(false, true, 1), "2026-01-05")
            .expect("收集提醒");
        assert_eq!(overdue.len(), 1, "只有逾期的任务应该提醒");
        assert_eq!(overdue[0].kind, KIND_OVERDUE);
        assert_eq!(overdue[0].title, "已经逾期");
    }

    #[test]
    fn completed_tasks_are_not_reminded() {
        let mut conn = crate::db::open_in_memory().expect("内存库");
        let card_id = seed_card(&mut conn, "已完成的任务", "2026-01-05");
        crate::repo::update_card(
            &mut conn,
            crate::models::UpdateCardInput {
                id: card_id,
                patch: crate::models::CardPatch {
                    completed: Some(true),
                    ..Default::default()
                },
            },
        )
        .expect("标记完成");

        let reminders = collect_due_reminders(&conn, &settings(true, true, 1), "2026-01-05")
            .expect("收集提醒");
        assert!(reminders.is_empty(), "已完成的任务不应再提醒");
    }

    #[test]
    fn default_settings_keep_every_switch_off() {
        let conn = crate::db::open_in_memory().expect("内存库");
        let settings = get_settings(&conn).expect("读取设置");
        assert!(!settings.due_enabled);
        assert!(!settings.overdue_enabled);
        assert!(!settings.daily_summary_enabled);
        assert_eq!(settings.daily_summary_time, "09:00");
        assert_eq!(settings.lead_days, 1);
    }
}
