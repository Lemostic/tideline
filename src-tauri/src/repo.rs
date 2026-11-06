//! 数据访问语义层：行为基准是前端 `src/lib/api.ts` 中的 `localApi` 实现。
//!
//! 所有函数都接收 `&Connection` / `&mut Connection`（不依赖 Tauri 运行时），
//! 因此可以用内存 SQLite 做单元测试；Tauri 命令层只负责加锁并透传 `Result<_, String>`。
//!
//! 与前端保持一致的关键语义：
//! - 创建时标题 `trim()` 后为空则回退到「未命名看板 / 未命名列表 / 未命名任务」；
//! - 列表 / 卡片 position 从 0 递增，删除或移动后重新归一化；
//! - `move_card` 的 `toIndex` 越界时收敛到 `[0, len]`；
//! - 卡片不能跨看板移动（会报错），但 `convert_inbox_item` 允许显式指定列表；
//! - 删除看板 / 列表依赖外键级联清理子数据；
//! - `delete_card` 是软删除（deleted_at），`get_snapshot` 只返回活动卡片，
//!   回收站通过 `get_trash` 读取，由 `restore_card` / `purge_card` / `empty_trash` 管理。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::models::*;

pub type DbResult<T> = Result<T, String>;

fn db_err(error: rusqlite::Error) -> String {
    error.to_string()
}

// ---------------------------------------------------------------------------
// 时间戳与 ID
// ---------------------------------------------------------------------------

static ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 生成与 `new Date().toISOString()` 同形态的 UTC 时间戳，例如
/// `2026-10-29T16:19:11.123Z`（前端 `nowISO()` 的基准）。
pub fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    iso_from_unix(now.as_secs() as i64, now.subsec_millis())
}

/// 把 Unix 秒 + 毫秒转成 ISO-8601 UTC 字符串（不引入额外日期库）。
pub fn iso_from_unix(seconds: i64, millis: u32) -> String {
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant 的 `civil_from_days` 算法：把「1970-01-01 起的天数」转成公历日期。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// 向下取整的整数除法：Hinnant 的日期算法要求 floor 语义，
/// 而 Rust 的 `/` 是向零截断，负数年份必须先校正。
fn floor_div(a: i64, b: i64) -> i64 {
    let quotient = a / b;
    if (a % b != 0) && ((a < 0) != (b < 0)) {
        quotient - 1
    } else {
        quotient
    }
}

/// Howard Hinnant 的 `days_from_civil` 算法：把公历日期转成「1970-01-01 起的天数」。
///
/// 与上面的 `civil_from_days` 互为逆运算，用于计算两个日期之间的自然日天数
/// （不引入 chrono 等额外依赖）。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = floor_div(shifted, 400);
    let year_of_era = shifted - era * 400; // [0, 399]
    let month_prime = (month + 9) % 12; // 3 月 = 0 … 2 月 = 11
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1; // [0, 365]
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// 该年是否为闰年（公历规则：4 年一闰，百年不闰，四百年再闰）。
fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// 某年某月的天数；月份非法时返回 0。
fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// 严格解析 `YYYY-MM-DD`；格式或日期本身不合法时返回 `None`。
fn parse_iso_date(raw: &str) -> Option<(i64, i64, i64)> {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    // 只接受 ASCII 数字，避免 `+2026` 之类的宽松解析。
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        return None;
    }
    let year: i64 = trimmed.get(0..4)?.parse().ok()?;
    let month: i64 = trimmed.get(5..7)?.parse().ok()?;
    let day: i64 = trimmed.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some((year, month, day))
}

/// 生成与前端 `createId(prefix)` 风格一致的 ID（前缀 + 纳秒 + 自增序号）。
pub fn create_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    let sequence = ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{nanos:x}{sequence:x}")
}

/// 标题兜底：`trim()` 后为空则用默认文案（对齐 localApi 的 `||` 逻辑）。
fn fallback_trimmed(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// 可选描述兜底：缺失时为空串；存在时 trim（对齐 localApi 的 `?.trim() ?? ''`）。
fn trimmed_or_empty(value: Option<String>) -> String {
    value
        .map(|inner| inner.trim().to_string())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// labels / subtasks 的 JSON 文本互转
// ---------------------------------------------------------------------------

/// 标签数组 → SQLite TEXT（JSON 数组）；序列化失败返回可读错误。
fn labels_to_json(labels: &[String]) -> DbResult<String> {
    serde_json::to_string(labels).map_err(|error| format!("标签序列化失败：{error}"))
}

/// SQLite TEXT → 标签数组；历史脏数据解析失败时回退空数组。
fn labels_from_json(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

/// 子任务数组 → SQLite TEXT（JSON 数组）；序列化失败返回可读错误。
fn subtasks_to_json(subtasks: &[Subtask]) -> DbResult<String> {
    serde_json::to_string(subtasks).map_err(|error| format!("子任务序列化失败：{error}"))
}

/// SQLite TEXT → 子任务数组；历史脏数据解析失败时回退空数组。
fn subtasks_from_json(raw: &str) -> Vec<Subtask> {
    serde_json::from_str(raw).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

const BOARD_COLUMNS: &str = "id, title, description, color, starred, label_colors, created_at, updated_at";
const LIST_COLUMNS: &str = "id, board_id, title, color, wip_limit, position, created_at";
const CARD_COLUMNS: &str = "id, board_id, list_id, parent_card_id, title, description, due_date, start_date, estimated_minutes, actual_minutes, priority, accent, completed, labels, subtasks, position, deleted_at, recurrence_id, generated_from_id, created_at, updated_at";
const INBOX_COLUMNS: &str = "id, content, created_at";

fn row_to_board(row: &Row<'_>) -> rusqlite::Result<Board> {
    let color: String = row.get("color")?;
    Ok(Board {
        id: row.get("id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        color: BoardColor::from_db(&color),
        starred: row.get::<_, i64>("starred")? != 0,
        label_colors: serde_json::from_str(&row.get::<_, String>("label_colors")?).unwrap_or_default(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_list(row: &Row<'_>) -> rusqlite::Result<List> {
    Ok(List {
        id: row.get("id")?,
        board_id: row.get("board_id")?,
        title: row.get("title")?,
        color: BoardColor::from_db(row.get::<_, String>("color")?.as_str()),
        wip_limit: row.get("wip_limit")?,
        position: row.get("position")?,
        created_at: row.get("created_at")?,
    })
}

fn row_to_card(row: &Row<'_>) -> rusqlite::Result<Card> {
    let priority: Option<String> = row.get("priority")?;
    let accent: Option<String> = row.get("accent")?;
    let labels: String = row.get("labels")?;
    let subtasks: String = row.get("subtasks")?;
    Ok(Card {
        id: row.get("id")?,
        board_id: row.get("board_id")?,
        list_id: row.get("list_id")?,
        parent_card_id: row.get("parent_card_id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        due_date: row.get("due_date")?,
        start_date: row.get("start_date")?,
        estimated_minutes: row.get("estimated_minutes")?,
        actual_minutes: row.get("actual_minutes")?,
        priority: priority.as_deref().and_then(Priority::from_db),
        accent: accent.map(|value| BoardColor::from_db(&value)),
        completed: row.get::<_, i64>("completed")? != 0,
        labels: labels_from_json(&labels),
        subtasks: subtasks_from_json(&subtasks),
        position: row.get("position")?,
        deleted_at: row.get("deleted_at")?,
        recurrence_id: row.get("recurrence_id")?,
        generated_from_id: row.get("generated_from_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_inbox(row: &Row<'_>) -> rusqlite::Result<InboxItem> {
    Ok(InboxItem {
        id: row.get("id")?,
        content: row.get("content")?,
        created_at: row.get("created_at")?,
    })
}

fn collect_rows<T>(
    conn: &Connection,
    sql: &str,
    mapper: fn(&Row<'_>) -> rusqlite::Result<T>,
) -> DbResult<Vec<T>> {
    let mut statement = conn.prepare(sql).map_err(db_err)?;
    let rows = statement.query_map([], mapper).map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<T>>>().map_err(db_err)
}

// ---------------------------------------------------------------------------
// 查询辅助
// ---------------------------------------------------------------------------

pub fn get_board(conn: &Connection, id: &str) -> DbResult<Board> {
    conn.query_row(
        &format!("SELECT {BOARD_COLUMNS} FROM boards WHERE id = ?1"),
        [id],
        row_to_board,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("看板不存在：{id}"))
}

pub fn get_list(conn: &Connection, id: &str) -> DbResult<List> {
    conn.query_row(
        &format!("SELECT {LIST_COLUMNS} FROM lists WHERE id = ?1"),
        [id],
        row_to_list,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("列表不存在：{id}"))
}

pub fn get_card(conn: &Connection, id: &str) -> DbResult<Card> {
    conn.query_row(
        &format!("SELECT {CARD_COLUMNS} FROM cards WHERE id = ?1"),
        [id],
        row_to_card,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("任务不存在：{id}"))
}

fn find_inbox_item(conn: &Connection, id: &str) -> DbResult<Option<InboxItem>> {
    conn.query_row(
        &format!("SELECT {INBOX_COLUMNS} FROM inbox_items WHERE id = ?1"),
        [id],
        row_to_inbox,
    )
    .optional()
    .map_err(db_err)
}

fn touch_board(conn: &Connection, board_id: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE boards SET updated_at = ?1 WHERE id = ?2",
        params![now_iso(), board_id],
    )
    .map_err(db_err)?;
    Ok(())
}

/// 把某个列表内**活动**卡片的 position 重新压成 0..n（按当前 position 升序）。
///
/// 回收站里的卡片（`deleted_at` 非空）不参与归一化，恢复时再追加到列表末尾。
fn normalize_card_positions(conn: &Connection, list_id: &str) -> DbResult<()> {
    let ids: Vec<String> = {
        let mut statement = conn
            .prepare(
                "SELECT id FROM cards WHERE list_id = ?1 AND parent_card_id IS NULL \
                 AND deleted_at IS NULL \
                 ORDER BY position ASC, created_at ASC, id ASC",
            )
            .map_err(db_err)?;
        let rows = statement
            .query_map([list_id], |row| row.get::<_, String>(0))
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<Vec<String>>>()
            .map_err(db_err)?
    };
    for (position, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE cards SET position = ?1 WHERE id = ?2",
            params![position as i64, id],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

/// 把某个看板内列表的 position 重新压成 0..n。
fn normalize_list_positions(conn: &Connection, board_id: &str) -> DbResult<()> {
    let ids: Vec<String> = {
        let mut statement = conn
            .prepare(
                "SELECT id FROM lists WHERE board_id = ?1 \
                 ORDER BY position ASC, created_at ASC, id ASC",
            )
            .map_err(db_err)?;
        let rows = statement
            .query_map([board_id], |row| row.get::<_, String>(0))
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<Vec<String>>>()
            .map_err(db_err)?
    };
    for (position, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE lists SET position = ?1 WHERE id = ?2",
            params![position as i64, id],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

/// 启动快照：与 localApi 的排序完全一致；只返回活动任务（软删除的在回收站）。
pub fn get_snapshot(conn: &Connection) -> DbResult<Snapshot> {
    Ok(Snapshot {
        boards: collect_rows(
            conn,
            &format!("SELECT {BOARD_COLUMNS} FROM boards ORDER BY created_at ASC, id ASC"),
            row_to_board,
        )?,
        lists: collect_rows(
            conn,
            &format!(
                "SELECT {LIST_COLUMNS} FROM lists ORDER BY position ASC, created_at ASC, id ASC"
            ),
            row_to_list,
        )?,
        cards: collect_rows(
            conn,
            &format!(
                "SELECT {CARD_COLUMNS} FROM cards WHERE deleted_at IS NULL \
                 ORDER BY position ASC, created_at ASC, id ASC"
            ),
            row_to_card,
        )?,
        inbox: collect_rows(
            conn,
            &format!("SELECT {INBOX_COLUMNS} FROM inbox_items ORDER BY created_at DESC, id DESC"),
            row_to_inbox,
        )?,
        dependencies: get_dependencies(conn)?,
        board_sets: get_board_sets(conn)?,
        goals: get_goals(conn)?,
        team_members: get_team_members(conn)?,
        overtime_records: get_overtime_records(conn)?,
        performance_records: get_performance_records(conn)?,
        leave_records: get_leave_records(conn)?,
        member_tenures: get_member_tenures(conn)?,
        projects: get_projects(conn)?,
        project_meta_fields: get_all_project_meta(conn)?,
        project_roles: get_all_project_roles(conn)?,
        recurrences: crate::automation::get_recurrences(conn)?,
        automation_rules: crate::automation::get_automation_rules(conn)?,
        custom_fields: get_all_custom_fields(conn)?,
        card_field_values: get_all_card_field_values(conn)?,
        saved_views: get_all_saved_views(conn)?,
    })
}

/// 备份用：返回全部任务（包含回收站里的软删除任务）。
pub fn get_all_cards(conn: &Connection) -> DbResult<Vec<Card>> {
    collect_rows(
        conn,
        &format!(
            "SELECT {CARD_COLUMNS} FROM cards \
             ORDER BY board_id ASC, position ASC, created_at ASC, id ASC"
        ),
        row_to_card,
    )
}

/// 全部任务关系边（V0.4 起为依赖，V0.12 起带类型）。
pub fn get_dependencies(conn: &Connection) -> DbResult<Vec<CardDependency>> {
    let mut statement = conn
        .prepare(
            "SELECT card_id, depends_on_card_id, relation_type FROM card_dependencies \
             ORDER BY card_id ASC, depends_on_card_id ASC",
        )
        .map_err(db_err)?;
    let rows = statement
        .query_map([], |row| {
            Ok(CardDependency {
                card_id: row.get(0)?,
                depends_on_card_id: row.get(1)?,
                relation_type: RelationType::from_str_lossy(&row.get::<_, String>(2)?),
            })
        })
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

// ---------------------------------------------------------------------------
// 看板集（V0.5.4）
// ---------------------------------------------------------------------------

const BOARD_SET_COLUMNS: &str = "id, title, description, created_at, updated_at";

fn row_to_board_set(row: &Row<'_>) -> rusqlite::Result<BoardSet> {
    Ok(BoardSet {
        id: row.get("id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        board_ids: Vec::new(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn load_board_set_members(
    conn: &Connection,
    set_id: &str,
) -> DbResult<Vec<String>> {
    let mut statement = conn
        .prepare(
            "SELECT board_id FROM board_set_boards WHERE set_id = ?1 \
             ORDER BY position ASC, board_id ASC",
        )
        .map_err(db_err)?;
    let rows = statement
        .query_map([set_id], |row| row.get::<_, String>(0))
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

/// 校验并去重看板 id；返回去重后的顺序。不存在的看板直接报错。
fn normalized_board_ids(conn: &Connection, board_ids: &[String]) -> DbResult<Vec<String>> {
    let mut unique = Vec::new();
    for id in board_ids {
        if unique.contains(id) {
            continue;
        }
        let exists: Option<i64> = conn
            .query_row("SELECT 1 FROM boards WHERE id = ?1", [id], |row| row.get(0))
            .optional()
            .map_err(db_err)?;
        if exists.is_none() {
            return Err(format!("看板不存在：{id}"));
        }
        unique.push(id.clone());
    }
    Ok(unique)
}

fn write_board_set_members(
    conn: &Connection,
    set_id: &str,
    board_ids: &[String],
) -> DbResult<()> {
    for (position, board_id) in board_ids.iter().enumerate() {
        conn.execute(
            "INSERT INTO board_set_boards (set_id, board_id, position) VALUES (?1, ?2, ?3)",
            params![set_id, board_id, position as i64],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

pub fn get_board_sets(conn: &Connection) -> DbResult<Vec<BoardSet>> {
    let mut sets = collect_rows(
        conn,
        &format!(
            "SELECT {BOARD_SET_COLUMNS} FROM board_sets \
             ORDER BY created_at ASC, id ASC"
        ),
        row_to_board_set,
    )?;
    for set in &mut sets {
        set.board_ids = load_board_set_members(conn, &set.id)?;
    }
    Ok(sets)
}

fn get_board_set(conn: &Connection, id: &str) -> DbResult<BoardSet> {
    let mut set = conn
        .query_row(
            &format!("SELECT {BOARD_SET_COLUMNS} FROM board_sets WHERE id = ?1"),
            [id],
            row_to_board_set,
        )
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| format!("看板集不存在：{id}"))?;
    set.board_ids = load_board_set_members(conn, id)?;
    Ok(set)
}

pub fn create_board_set(conn: &mut Connection, input: NewBoardSetInput) -> DbResult<BoardSet> {
    let tx = conn.transaction().map_err(db_err)?;
    let board_ids = normalized_board_ids(&tx, &input.board_ids)?;
    let now = now_iso();
    let set = BoardSet {
        id: create_id("s"),
        title: fallback_trimmed(&input.title, "未命名看板集"),
        description: trimmed_or_empty(input.description),
        board_ids,
        created_at: now.clone(),
        updated_at: now,
    };
    tx.execute(
        "INSERT INTO board_sets (id, title, description, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![&set.id, &set.title, &set.description, &set.created_at, &set.updated_at],
    )
    .map_err(db_err)?;
    write_board_set_members(&tx, &set.id, &set.board_ids)?;
    tx.commit().map_err(db_err)?;
    Ok(set)
}

pub fn update_board_set(conn: &mut Connection, input: UpdateBoardSetInput) -> DbResult<BoardSet> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut set = get_board_set(&tx, &input.id)?;
    let mut replace_members = input.patch.board_ids.is_some();
    if let Some(title) = input.patch.title {
        set.title = if title.trim().is_empty() {
            "未命名看板集".to_string()
        } else {
            title.trim().to_string()
        };
    }
    if let Some(description) = input.patch.description {
        set.description = description;
    }
    if let Some(board_ids) = input.patch.board_ids {
        set.board_ids = normalized_board_ids(&tx, &board_ids)?;
        replace_members = true;
    }
    set.updated_at = now_iso();
    tx.execute(
        "UPDATE board_sets SET title = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
        params![&set.title, &set.description, &set.updated_at, &set.id],
    )
    .map_err(db_err)?;
    if replace_members {
        tx.execute("DELETE FROM board_set_boards WHERE set_id = ?1", [&set.id])
            .map_err(db_err)?;
        write_board_set_members(&tx, &set.id, &set.board_ids)?;
    }
    tx.commit().map_err(db_err)?;
    Ok(set)
}

pub fn delete_board_set(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("DELETE FROM board_sets WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 目标（V0.6）
// ---------------------------------------------------------------------------

const GOAL_COLUMNS: &str = "id, title, description, scope, status, start_date, due_date, \
                            manual_progress, parent_id, position, created_at, updated_at";

fn row_to_goal(row: &Row<'_>) -> rusqlite::Result<Goal> {
    Ok(Goal {
        id: row.get("id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        scope: GoalScope::from_db(row.get::<_, String>("scope")?.as_str()),
        status: GoalStatus::from_db(row.get::<_, String>("status")?.as_str()),
        start_date: row.get("start_date")?,
        due_date: row.get("due_date")?,
        manual_progress: row.get("manual_progress")?,
        parent_id: row.get("parent_id")?,
        card_ids: Vec::new(),
        position: row.get("position")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn load_goal_cards(conn: &Connection, goal_id: &str) -> DbResult<Vec<String>> {
    let mut statement = conn
        .prepare(
            "SELECT card_id FROM goal_cards WHERE goal_id = ?1 \
             ORDER BY position ASC, card_id ASC",
        )
        .map_err(db_err)?;
    let rows = statement
        .query_map([goal_id], |row| row.get::<_, String>(0))
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

fn normalized_goal_card_ids(conn: &Connection, card_ids: &[String]) -> DbResult<Vec<String>> {
    let mut unique = Vec::new();
    for id in card_ids {
        if unique.contains(id) {
            continue;
        }
        let exists: Option<i64> = conn
            .query_row("SELECT 1 FROM cards WHERE id = ?1", [id], |row| row.get(0))
            .optional()
            .map_err(db_err)?;
        if exists.is_none() {
            return Err(format!("任务不存在：{id}"));
        }
        unique.push(id.clone());
    }
    Ok(unique)
}

fn write_goal_cards(conn: &Connection, goal_id: &str, card_ids: &[String]) -> DbResult<()> {
    for (position, card_id) in card_ids.iter().enumerate() {
        conn.execute(
            "INSERT INTO goal_cards (goal_id, card_id, position) VALUES (?1, ?2, ?3)",
            params![goal_id, card_id, position as i64],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

fn normalize_parent_id(parent_id: Option<String>) -> Option<String> {
    parent_id.and_then(|id| {
        let trimmed = id.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

/// 校验父目标存在且不会形成环（沿父链向上查找）。
fn validate_goal_parent(
    conn: &Connection,
    goal_id: Option<&str>,
    parent_id: Option<&str>,
) -> DbResult<()> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    if Some(parent_id) == goal_id {
        return Err("目标不能把自己设为父目标".to_string());
    }
    let mut current = Some(parent_id.to_string());
    let mut seen = 0;
    while let Some(id) = current {
        if Some(id.as_str()) == goal_id {
            return Err("目标层级不能形成循环".to_string());
        }
        seen += 1;
        if seen > 100 {
            return Err("目标层级过深，已停止保存".to_string());
        }
        let parent: Option<Option<String>> = conn
            .query_row("SELECT parent_id FROM goals WHERE id = ?1", [&id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db_err)?;
        let Some(parent) = parent else {
            return Err(format!("父目标不存在：{id}"));
        };
        current = parent;
    }
    Ok(())
}

fn next_goal_position(conn: &Connection) -> DbResult<i64> {
    let max: Option<i64> = conn
        .query_row("SELECT MAX(position) FROM goals", [], |row| row.get(0))
        .optional()
        .map_err(db_err)?
        .flatten();
    Ok(max.unwrap_or(-1) + 1)
}

pub fn get_goals(conn: &Connection) -> DbResult<Vec<Goal>> {
    let mut goals = collect_rows(
        conn,
        &format!("SELECT {GOAL_COLUMNS} FROM goals ORDER BY position ASC, id ASC"),
        row_to_goal,
    )?;
    for goal in &mut goals {
        goal.card_ids = load_goal_cards(conn, &goal.id)?;
    }
    Ok(goals)
}

fn get_goal(conn: &Connection, id: &str) -> DbResult<Goal> {
    let mut goal = conn
        .query_row(
            &format!("SELECT {GOAL_COLUMNS} FROM goals WHERE id = ?1"),
            [id],
            row_to_goal,
        )
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| format!("目标不存在：{id}"))?;
    goal.card_ids = load_goal_cards(conn, id)?;
    Ok(goal)
}

pub fn create_goal(conn: &mut Connection, input: NewGoalInput) -> DbResult<Goal> {
    let tx = conn.transaction().map_err(db_err)?;
    let parent_id = normalize_parent_id(input.parent_id);
    validate_goal_parent(&tx, None, parent_id.as_deref())?;
    let card_ids = normalized_goal_card_ids(&tx, &input.card_ids.unwrap_or_default())?;
    let now = now_iso();
    let goal = Goal {
        id: create_id("g"),
        title: fallback_trimmed(&input.title, "未命名目标"),
        description: trimmed_or_empty(input.description),
        scope: input.scope.unwrap_or(GoalScope::Team),
        status: input.status.unwrap_or(GoalStatus::Active),
        start_date: input.start_date.and_then(non_empty),
        due_date: input.due_date.and_then(non_empty),
        manual_progress: input.manual_progress.unwrap_or(0).clamp(0, 100),
        parent_id,
        card_ids,
        position: next_goal_position(&tx)?,
        created_at: now.clone(),
        updated_at: now,
    };
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
    .map_err(db_err)?;
    write_goal_cards(&tx, &goal.id, &goal.card_ids)?;
    tx.commit().map_err(db_err)?;
    Ok(goal)
}

pub fn update_goal(conn: &mut Connection, input: UpdateGoalInput) -> DbResult<Goal> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut goal = get_goal(&tx, &input.id)?;
    let replace_cards = input.patch.card_ids.is_some();

    if let Some(title) = input.patch.title {
        goal.title = fallback_trimmed(&title, "未命名目标");
    }
    if let Some(description) = input.patch.description {
        goal.description = description;
    }
    if let Some(scope) = input.patch.scope {
        goal.scope = scope;
    }
    if let Some(status) = input.patch.status {
        goal.status = status;
    }
    if let Some(start_date) = input.patch.start_date {
        goal.start_date = start_date.and_then(non_empty);
    }
    if let Some(due_date) = input.patch.due_date {
        goal.due_date = due_date.and_then(non_empty);
    }
    if let Some(progress) = input.patch.manual_progress {
        goal.manual_progress = progress.clamp(0, 100);
    }
    if let Some(card_ids) = input.patch.card_ids {
        goal.card_ids = normalized_goal_card_ids(&tx, &card_ids)?;
    }
    if let Some(parent_id) = input.patch.parent_id {
        let parent_id = normalize_parent_id(parent_id);
        validate_goal_parent(&tx, Some(&goal.id), parent_id.as_deref())?;
        goal.parent_id = parent_id;
    }
    goal.updated_at = now_iso();
    tx.execute(
        "UPDATE goals SET title = ?1, description = ?2, scope = ?3, status = ?4, \
         start_date = ?5, due_date = ?6, manual_progress = ?7, parent_id = ?8, \
         updated_at = ?9 WHERE id = ?10",
        params![
            &goal.title,
            &goal.description,
            goal.scope.as_str(),
            goal.status.as_str(),
            &goal.start_date,
            &goal.due_date,
            goal.manual_progress,
            &goal.parent_id,
            &goal.updated_at,
            &goal.id,
        ],
    )
    .map_err(db_err)?;
    if replace_cards {
        tx.execute("DELETE FROM goal_cards WHERE goal_id = ?1", [&goal.id])
            .map_err(db_err)?;
        write_goal_cards(&tx, &goal.id, &goal.card_ids)?;
    }
    tx.commit().map_err(db_err)?;
    Ok(goal)
}

pub fn delete_goal(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("DELETE FROM goals WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 项目 / 自定义元数据 / 自定义角色（V0.9）
// ---------------------------------------------------------------------------

const DEFAULT_PROJECT_ROLES: &[(&str, &str)] = &[
    ("开发", "#2f6fd0"),
    ("测试", "#9a6512"),
    ("需求", "#0f766e"),
    ("设计", "#5a48c9"),
    ("其他", "#64748b"),
];

fn row_to_project(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        color: row.get("color")?,
        status: ProjectStatus::from_db(row.get::<_, String>("status")?.as_str()),
        starred: row.get::<_, i64>("starred")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_project_meta(row: &Row<'_>) -> rusqlite::Result<ProjectMetaField> {
    Ok(ProjectMetaField {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        name: row.get("name")?,
        value: row.get("value")?,
        position: row.get("position")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_project_role(row: &Row<'_>) -> rusqlite::Result<ProjectRole> {
    Ok(ProjectRole {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        name: row.get("name")?,
        color: row.get("color")?,
        position: row.get("position")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn get_projects(conn: &Connection) -> DbResult<Vec<Project>> {
    collect_rows(
        conn,
        "SELECT id, name, description, color, status, starred, created_at, updated_at \
         FROM projects ORDER BY starred DESC, status ASC, updated_at DESC, name ASC",
        row_to_project,
    )
}

fn get_project(conn: &Connection, id: &str) -> DbResult<Project> {
    conn.query_row(
        "SELECT id, name, description, color, status, starred, created_at, updated_at \
         FROM projects WHERE id = ?1",
        [id],
        row_to_project,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("项目不存在：{id}"))
}

fn validate_project_color(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "#0f766e".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn create_project(conn: &mut Connection, input: NewProjectInput) -> DbResult<Project> {
    let now = now_iso();
    let project = Project {
        id: create_id("p"),
        name: fallback_trimmed(&input.name, "未命名项目"),
        description: input.description.unwrap_or_default(),
        color: validate_project_color(input.color.as_deref().unwrap_or("")),
        status: ProjectStatus::Active,
        starred: input.starred.unwrap_or(false),
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute(
        "INSERT INTO projects \
         (id, name, description, color, status, starred, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?6)",
        params![
            &project.id,
            &project.name,
            &project.description,
            &project.color,
            project.starred as i64,
            &project.created_at,
        ],
    )
    .map_err(db_err)?;
    for (position, (name, color)) in DEFAULT_PROJECT_ROLES.iter().enumerate() {
        tx.execute(
            "INSERT INTO project_roles \
             (id, project_id, name, color, position, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                create_id("pr"),
                &project.id,
                name,
                color,
                position as i64,
                &now,
            ],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)?;
    Ok(project)
}

pub fn update_project(conn: &mut Connection, input: UpdateProjectInput) -> DbResult<Project> {
    let mut project = get_project(conn, &input.id)?;
    if let Some(name) = input.patch.name {
        project.name = fallback_trimmed(&name, "未命名项目");
    }
    if let Some(description) = input.patch.description {
        project.description = description;
    }
    if let Some(color) = input.patch.color {
        project.color = validate_project_color(&color);
    }
    if let Some(status) = input.patch.status {
        project.status = status;
    }
    if let Some(starred) = input.patch.starred {
        project.starred = starred;
    }
    project.updated_at = now_iso();
    conn.execute(
        "UPDATE projects SET name = ?1, description = ?2, color = ?3, status = ?4, \
         starred = ?5, updated_at = ?6 WHERE id = ?7",
        params![
            &project.name,
            &project.description,
            &project.color,
            project.status.as_str(),
            project.starred as i64,
            &project.updated_at,
            &project.id,
        ],
    )
    .map_err(db_err)?;
    Ok(project)
}

/// 删除项目：旧库的 project_id 列没有外键，因此显式清理所有项目内数据。
pub fn delete_project(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("DELETE FROM performance_records WHERE project_id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.execute("DELETE FROM overtime_records WHERE project_id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.execute("DELETE FROM leave_records WHERE project_id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.execute("DELETE FROM team_members WHERE project_id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.execute("DELETE FROM project_meta_fields WHERE project_id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.execute("DELETE FROM project_roles WHERE project_id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.execute("DELETE FROM projects WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(())
}

pub fn get_project_meta_fields(
    conn: &Connection,
    project_id: &str,
) -> DbResult<Vec<ProjectMetaField>> {
    let mut statement = conn
        .prepare(
            "SELECT id, project_id, name, value, position, created_at, updated_at \
             FROM project_meta_fields WHERE project_id = ?1 ORDER BY position ASC, created_at ASC",
        )
        .map_err(db_err)?;
    let rows = statement
        .query_map([project_id], row_to_project_meta)
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

pub fn get_all_project_meta(conn: &Connection) -> DbResult<Vec<ProjectMetaField>> {
    collect_rows(
        conn,
        "SELECT id, project_id, name, value, position, created_at, updated_at \
         FROM project_meta_fields ORDER BY project_id ASC, position ASC, created_at ASC",
        row_to_project_meta,
    )
}

pub fn get_all_project_roles(conn: &Connection) -> DbResult<Vec<ProjectRole>> {
    collect_rows(
        conn,
        "SELECT id, project_id, name, color, position, created_at, updated_at \
         FROM project_roles ORDER BY project_id ASC, position ASC, created_at ASC",
        row_to_project_role,
    )
}

pub fn create_project_meta(
    conn: &mut Connection,
    input: NewProjectMetaInput,
) -> DbResult<ProjectMetaField> {
    let _project = get_project(conn, &input.project_id)?;
    let now = now_iso();
    let position: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM project_meta_fields WHERE project_id = ?1",
            [&input.project_id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    let field = ProjectMetaField {
        id: create_id("pm"),
        project_id: input.project_id,
        name: fallback_trimmed(&input.name, "未命名字段"),
        value: input.value.unwrap_or_default(),
        position,
        created_at: now.clone(),
        updated_at: now,
    };
    conn.execute(
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
    .map_err(db_err)?;
    Ok(field)
}

pub fn update_project_meta(
    conn: &mut Connection,
    input: UpdateProjectMetaInput,
) -> DbResult<ProjectMetaField> {
    let mut field: ProjectMetaField = conn
        .query_row(
            "SELECT id, project_id, name, value, position, created_at, updated_at \
             FROM project_meta_fields WHERE id = ?1",
            [&input.id],
            row_to_project_meta,
        )
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| format!("项目元数据不存在：{}", input.id))?;
    if let Some(name) = input.patch.name {
        field.name = fallback_trimmed(&name, "未命名字段");
    }
    if let Some(value) = input.patch.value {
        field.value = value;
    }
    field.updated_at = now_iso();
    conn.execute(
        "UPDATE project_meta_fields SET name = ?1, value = ?2, updated_at = ?3 WHERE id = ?4",
        params![&field.name, &field.value, &field.updated_at, &field.id],
    )
    .map_err(db_err)?;
    Ok(field)
}

pub fn delete_project_meta(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    conn.execute("DELETE FROM project_meta_fields WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    Ok(())
}

pub fn get_project_roles(conn: &Connection, project_id: &str) -> DbResult<Vec<ProjectRole>> {
    let mut statement = conn
        .prepare(
            "SELECT id, project_id, name, color, position, created_at, updated_at \
             FROM project_roles WHERE project_id = ?1 ORDER BY position ASC, created_at ASC",
        )
        .map_err(db_err)?;
    let rows = statement
        .query_map([project_id], row_to_project_role)
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

fn get_project_role(conn: &Connection, id: &str) -> DbResult<ProjectRole> {
    conn.query_row(
        "SELECT id, project_id, name, color, position, created_at, updated_at \
         FROM project_roles WHERE id = ?1",
        [id],
        row_to_project_role,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("项目角色不存在：{id}"))
}

fn require_project_role(conn: &Connection, project_id: &str, role_id: &str) -> DbResult<()> {
    let role = get_project_role(conn, role_id)?;
    if role.project_id != project_id {
        return Err("角色不属于该项目".to_string());
    }
    Ok(())
}

pub fn create_project_role(
    conn: &mut Connection,
    input: NewProjectRoleInput,
) -> DbResult<ProjectRole> {
    let _project = get_project(conn, &input.project_id)?;
    let now = now_iso();
    let position: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM project_roles WHERE project_id = ?1",
            [&input.project_id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    let role = ProjectRole {
        id: create_id("pr"),
        project_id: input.project_id,
        name: fallback_trimmed(&input.name, "未命名角色"),
        color: validate_project_color(input.color.as_deref().unwrap_or("#64748b")),
        position,
        created_at: now.clone(),
        updated_at: now,
    };
    conn.execute(
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
    .map_err(db_err)?;
    Ok(role)
}

pub fn update_project_role(
    conn: &mut Connection,
    input: UpdateProjectRoleInput,
) -> DbResult<ProjectRole> {
    let mut role = get_project_role(conn, &input.id)?;
    if let Some(name) = input.patch.name {
        role.name = fallback_trimmed(&name, "未命名角色");
    }
    if let Some(color) = input.patch.color {
        role.color = validate_project_color(&color);
    }
    role.updated_at = now_iso();
    conn.execute(
        "UPDATE project_roles SET name = ?1, color = ?2, updated_at = ?3 WHERE id = ?4",
        params![&role.name, &role.color, &role.updated_at, &role.id],
    )
    .map_err(db_err)?;
    Ok(role)
}

pub fn delete_project_role(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let role = get_project_role(conn, &input.id)?;
    let used: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM team_members WHERE role_id = ?1",
            [&role.id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    if used > 0 {
        return Err("该角色仍被项目成员使用，请先调整成员角色".to_string());
    }
    conn.execute("DELETE FROM project_roles WHERE id = ?1", [&role.id])
        .map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 项目组成员 / 加班 / 绩效（V0.8，V0.9 起按项目隔离）
// ---------------------------------------------------------------------------

fn today_key() -> String {
    now_iso()[..10].to_string()
}

fn normalize_date(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        today_key()
    } else {
        trimmed.to_string()
    }
}

fn require_team_member(conn: &Connection, id: &str) -> DbResult<TeamMember> {
    get_team_member(conn, id)
}

fn row_to_team_member(row: &Row<'_>) -> rusqlite::Result<TeamMember> {
    Ok(TeamMember {
        id: row.get("id")?,
        project_id: row.get::<_, Option<String>>("project_id")?.unwrap_or_default(),
        role_id: row.get::<_, Option<String>>("role_id")?.unwrap_or_default(),
        name: row.get("name")?,
        role: MemberRole::from_db(row.get::<_, String>("role")?.as_str()),
        status: MemberStatus::from_db(row.get::<_, String>("status")?.as_str()),
        joined_at: row.get("joined_at")?,
        released_at: row.get("released_at")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_overtime(row: &Row<'_>) -> rusqlite::Result<OvertimeRecord> {
    Ok(OvertimeRecord {
        id: row.get("id")?,
        project_id: row.get::<_, Option<String>>("project_id")?.unwrap_or_default(),
        member_id: row.get("member_id")?,
        date: row.get("date")?,
        hours: row.get("hours")?,
        status: OvertimeStatus::from_db(row.get::<_, String>("status")?.as_str()),
        absence_reason: row.get("absence_reason")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_performance(row: &Row<'_>) -> rusqlite::Result<PerformanceRecord> {
    Ok(PerformanceRecord {
        id: row.get("id")?,
        project_id: row.get::<_, Option<String>>("project_id")?.unwrap_or_default(),
        member_id: row.get("member_id")?,
        date: row.get("date")?,
        points: row.get("points")?,
        reason: row.get("reason")?,
        category: PerformanceCategory::from_db(row.get::<_, String>("category")?.as_str()),
        note: row.get("note")?,
        created_at: row.get("created_at")?,
    })
}

fn row_to_leave(row: &Row<'_>) -> rusqlite::Result<LeaveRecord> {
    Ok(LeaveRecord {
        id: row.get("id")?,
        project_id: row.get::<_, Option<String>>("project_id")?.unwrap_or_default(),
        member_id: row.get("member_id")?,
        start_date: row.get("start_date")?,
        end_date: row.get("end_date")?,
        days: row.get::<_, Option<f64>>("days")?.unwrap_or_default(),
        leave_type: LeaveType::from_db(row.get::<_, String>("leave_type")?.as_str()),
        reason: row.get("reason")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn get_team_members(conn: &Connection) -> DbResult<Vec<TeamMember>> {
    collect_rows(
        conn,
        "SELECT id, project_id, role_id, name, role, status, joined_at, released_at, note, \
         created_at, updated_at FROM team_members \
         ORDER BY project_id ASC, status ASC, joined_at ASC, name ASC",
        row_to_team_member,
    )
}

fn row_to_tenure(row: &Row<'_>) -> rusqlite::Result<MemberTenure> {
    Ok(MemberTenure {
        id: row.get("id")?,
        member_id: row.get("member_id")?,
        project_id: row.get("project_id")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn get_member_tenures(conn: &Connection) -> DbResult<Vec<MemberTenure>> {
    collect_rows(
        conn,
        "SELECT id, member_id, project_id, started_at, ended_at, note, created_at, updated_at \
         FROM member_tenures ORDER BY project_id ASC, started_at ASC, created_at ASC",
        row_to_tenure,
    )
}

fn get_member_tenure(conn: &Connection, id: &str) -> DbResult<MemberTenure> {
    conn.query_row(
        "SELECT id, member_id, project_id, started_at, ended_at, note, created_at, updated_at \
         FROM member_tenures WHERE id = ?1",
        [id],
        row_to_tenure,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("投入时间段不存在：{id}"))
}

fn validate_tenure_dates(started_at: &str, ended_at: Option<&str>) -> DbResult<()> {
    if started_at.trim().is_empty() {
        return Err("入组日期不能为空".to_string());
    }
    if let Some(ended_at) = ended_at {
        if ended_at.trim().is_empty() {
            return Err("出组日期不能为空".to_string());
        }
        if ended_at < started_at {
            return Err("出组日期不能早于入组日期".to_string());
        }
    }
    Ok(())
}

/// 同一成员的时间段不能重叠；开放段最多只能有一段。
fn validate_tenure_overlap(
    conn: &Connection,
    member_id: &str,
    started_at: &str,
    ended_at: Option<&str>,
    exclude_id: Option<&str>,
) -> DbResult<()> {
    let mut statement = conn
        .prepare(
            "SELECT id, started_at, ended_at FROM member_tenures WHERE member_id = ?1",
        )
        .map_err(db_err)?;
    let rows = statement
        .query_map([member_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(db_err)?;
    for row in rows {
        let (id, existing_start, existing_end) = row.map_err(db_err)?;
        if Some(id.as_str()) == exclude_id {
            continue;
        }
        if ended_at.is_none() && existing_end.is_none() {
            return Err("该成员已有一段未结束的投入记录，请先填写出组日期".to_string());
        }
        let new_end = ended_at.unwrap_or("9999-12-31");
        let old_end = existing_end.as_deref().unwrap_or("9999-12-31");
        if started_at < old_end && existing_start.as_str() < new_end {
            return Err(format!(
                "时间段与已有记录（{existing_start} 至 {}）重叠",
                existing_end.as_deref().unwrap_or("至今")
            ));
        }
    }
    Ok(())
}

fn sync_member_tenures(conn: &Connection, member_id: &str) -> DbResult<()> {
    let mut statement = conn
        .prepare(
            "SELECT started_at, ended_at FROM member_tenures WHERE member_id = ?1 \
             ORDER BY started_at ASC",
        )
        .map_err(db_err)?;
    let rows = statement
        .query_map([member_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        })
        .map_err(db_err)?;
    let mut earliest: Option<String> = None;
    let mut latest_end: Option<String> = None;
    let mut has_open = false;
    let mut count = 0;
    for row in rows {
        let (start, end) = row.map_err(db_err)?;
        count += 1;
        if earliest.is_none() || start < *earliest.as_ref().unwrap() {
            earliest = Some(start);
        }
        match end {
            Some(end) => {
                if latest_end.is_none() || end > *latest_end.as_ref().unwrap() {
                    latest_end = Some(end);
                }
            }
            None => has_open = true,
        }
    }
    if count == 0 {
        conn.execute(
            "UPDATE team_members SET status = 'released', released_at = COALESCE(released_at, ?1), \
             updated_at = ?2 WHERE id = ?3",
            params![today_key(), now_iso(), member_id],
        )
        .map_err(db_err)?;
        return Ok(());
    }
    let status = if has_open { "active" } else { "released" };
    let joined_at = earliest.unwrap_or_else(today_key);
    conn.execute(
        "UPDATE team_members SET status = ?1, joined_at = ?2, released_at = ?3, updated_at = ?4 \
         WHERE id = ?5",
        params![
            status,
            joined_at,
            if has_open { None } else { latest_end },
            now_iso(),
            member_id,
        ],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn create_tenure(conn: &mut Connection, input: NewTenureInput) -> DbResult<MemberTenure> {
    let member = get_team_member(conn, &input.member_id)?;
    let started_at = normalize_date(&input.started_at);
    let ended_at = input.ended_at.and_then(non_empty);
    validate_tenure_dates(&started_at, ended_at.as_deref())?;
    validate_tenure_overlap(
        conn,
        &member.id,
        &started_at,
        ended_at.as_deref(),
        None,
    )?;
    let now = now_iso();
    let tenure = MemberTenure {
        id: create_id("mt"),
        member_id: member.id.clone(),
        project_id: member.project_id,
        started_at,
        ended_at,
        note: input.note.unwrap_or_default(),
        created_at: now.clone(),
        updated_at: now,
    };
    conn.execute(
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
    .map_err(db_err)?;
    sync_member_tenures(conn, &tenure.member_id)?;
    Ok(tenure)
}

pub fn update_tenure(conn: &mut Connection, input: UpdateTenureInput) -> DbResult<MemberTenure> {
    let mut tenure = get_member_tenure(conn, &input.id)?;
    if let Some(started_at) = input.patch.started_at {
        tenure.started_at = normalize_date(&started_at);
    }
    if let Some(ended_at) = input.patch.ended_at {
        tenure.ended_at = ended_at.and_then(non_empty);
    }
    if let Some(note) = input.patch.note {
        tenure.note = note;
    }
    validate_tenure_dates(&tenure.started_at, tenure.ended_at.as_deref())?;
    validate_tenure_overlap(
        conn,
        &tenure.member_id,
        &tenure.started_at,
        tenure.ended_at.as_deref(),
        Some(&tenure.id),
    )?;
    tenure.updated_at = now_iso();
    conn.execute(
        "UPDATE member_tenures SET started_at = ?1, ended_at = ?2, note = ?3, updated_at = ?4 \
         WHERE id = ?5",
        params![
            &tenure.started_at,
            &tenure.ended_at,
            &tenure.note,
            &tenure.updated_at,
            &tenure.id,
        ],
    )
    .map_err(db_err)?;
    sync_member_tenures(conn, &tenure.member_id)?;
    Ok(tenure)
}

pub fn delete_tenure(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let tenure = get_member_tenure(conn, &input.id)?;
    conn.execute("DELETE FROM member_tenures WHERE id = ?1", [&tenure.id])
        .map_err(db_err)?;
    sync_member_tenures(conn, &tenure.member_id)?;
    Ok(())
}

fn get_team_member(conn: &Connection, id: &str) -> DbResult<TeamMember> {
    conn.query_row(
        "SELECT id, project_id, role_id, name, role, status, joined_at, released_at, note, \
         created_at, updated_at FROM team_members WHERE id = ?1",
        [id],
        row_to_team_member,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("项目成员不存在：{id}"))
}

pub fn create_team_member(
    conn: &mut Connection,
    input: NewTeamMemberInput,
) -> DbResult<TeamMember> {
    let _project = get_project(conn, &input.project_id)?;
    require_project_role(conn, &input.project_id, &input.role_id)?;
    let now = now_iso();
    let member = TeamMember {
        id: create_id("m"),
        project_id: input.project_id,
        role_id: input.role_id,
        name: fallback_trimmed(&input.name, "未命名成员"),
        role: MemberRole::Other,
        status: MemberStatus::Active,
        joined_at: input
            .joined_at
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(today_key),
        released_at: None,
        note: input.note.unwrap_or_default(),
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    conn.execute(
        "INSERT INTO team_members \
         (id, project_id, role_id, name, role, status, joined_at, released_at, note, \
          created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, 'other', ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            &member.id,
            &member.project_id,
            &member.role_id,
            &member.name,
            member.status.as_str(),
            &member.joined_at,
            &member.released_at,
            &member.note,
            &member.created_at,
            &member.updated_at,
        ],
    )
    .map_err(db_err)?;
    let tenure = MemberTenure {
        id: create_id("mt"),
        member_id: member.id.clone(),
        project_id: member.project_id.clone(),
        started_at: member.joined_at.clone(),
        ended_at: None,
        note: "首次入组".to_string(),
        created_at: now,
        updated_at: member.updated_at.clone(),
    };
    conn.execute(
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
    .map_err(db_err)?;
    Ok(member)
}

pub fn update_team_member(
    conn: &mut Connection,
    input: UpdateTeamMemberInput,
) -> DbResult<TeamMember> {
    let mut member = get_team_member(conn, &input.id)?;
    let old_status = member.status;
    let status_patch = input.patch.status;
    if let Some(name) = input.patch.name {
        member.name = fallback_trimmed(&name, "未命名成员");
    }
    if let Some(role_id) = input.patch.role_id {
        require_project_role(conn, &member.project_id, &role_id)?;
        member.role_id = role_id;
    }
    if let Some(joined_at) = input.patch.joined_at {
        if !joined_at.trim().is_empty() {
            member.joined_at = joined_at;
        }
    }
    if let Some(released_at) = input.patch.released_at {
        member.released_at = released_at.and_then(non_empty);
    }
    if let Some(note) = input.patch.note {
        member.note = note;
    }
    member.updated_at = now_iso();
    conn.execute(
        "UPDATE team_members SET name = ?1, role_id = ?2, note = ?3, updated_at = ?4 \
         WHERE id = ?5",
        params![
            &member.name,
            &member.role_id,
            &member.note,
            &member.updated_at,
            &member.id,
        ],
    )
    .map_err(db_err)?;

    // 状态切换对应一段投入记录的结束/开启，历史段保留不覆盖。
    if let Some(status) = status_patch {
        if status != old_status {
            match status {
                MemberStatus::Released => {
                    let end = member
                        .released_at
                        .clone()
                        .unwrap_or_else(today_key);
                    conn.execute(
                        "UPDATE member_tenures SET ended_at = ?1, updated_at = ?2 \
                         WHERE member_id = ?3 AND ended_at IS NULL",
                        params![end, now_iso(), &member.id],
                    )
                    .map_err(db_err)?;
                }
                MemberStatus::Active => {
                    let open_count: i64 = conn
                        .query_row(
                            "SELECT COUNT(*) FROM member_tenures \
                             WHERE member_id = ?1 AND ended_at IS NULL",
                            [&member.id],
                            |row| row.get(0),
                        )
                        .map_err(db_err)?;
                    if open_count == 0 {
                        let now = now_iso();
                        conn.execute(
                            "INSERT INTO member_tenures \
                             (id, member_id, project_id, started_at, ended_at, note, created_at, updated_at) \
                             VALUES (?1, ?2, ?3, date('now'), NULL, '回归项目', ?4, ?4)",
                            params![create_id("mt"), &member.id, &member.project_id, now],
                        )
                        .map_err(db_err)?;
                    }
                }
            }
            sync_member_tenures(conn, &member.id)?;
        }
    }
    get_team_member(conn, &member.id)
}

pub fn delete_team_member(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    conn.execute("DELETE FROM team_members WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    Ok(())
}

pub fn get_overtime_records(conn: &Connection) -> DbResult<Vec<OvertimeRecord>> {
    collect_rows(
        conn,
        "SELECT id, project_id, member_id, date, hours, status, absence_reason, note, \
         created_at, updated_at \
         FROM overtime_records ORDER BY date DESC, created_at DESC",
        row_to_overtime,
    )
}

fn get_overtime(conn: &Connection, id: &str) -> DbResult<OvertimeRecord> {
    conn.query_row(
        "SELECT id, project_id, member_id, date, hours, status, absence_reason, note, \
         created_at, updated_at \
         FROM overtime_records WHERE id = ?1",
        [id],
        row_to_overtime,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("加班记录不存在：{id}"))
}

/// V0.13.2：未出勤原因长度上限，与前端表单保持一致。
const ABSENCE_REASON_MAX_CHARS: usize = 200;

/// 归一未出勤原因：未出勤必须填写 1–200 字（trim 后），其它状态一律清空。
fn normalize_absence_reason(status: OvertimeStatus, reason: &str) -> DbResult<String> {
    if status != OvertimeStatus::Absent {
        return Ok(String::new());
    }
    let text = reason.trim();
    if text.is_empty() {
        return Err("请填写未出勤原因".to_string());
    }
    if text.chars().count() > ABSENCE_REASON_MAX_CHARS {
        return Err(format!("未出勤原因最多 {ABSENCE_REASON_MAX_CHARS} 字"));
    }
    Ok(text.to_string())
}

pub fn create_overtime(
    conn: &mut Connection,
    input: NewOvertimeInput,
) -> DbResult<OvertimeRecord> {
    let member = require_team_member(conn, &input.member_id)?;
    if !input.hours.is_finite() || input.hours <= 0.0 {
        return Err("加班时长必须大于 0".to_string());
    }
    let status = input.status.unwrap_or(OvertimeStatus::Planned);
    let absence_reason =
        normalize_absence_reason(status, input.absence_reason.as_deref().unwrap_or(""))?;
    let now = now_iso();
    let record = OvertimeRecord {
        id: create_id("ot"),
        project_id: member.project_id,
        member_id: input.member_id,
        date: normalize_date(&input.date),
        hours: (input.hours * 10.0).round() / 10.0,
        status,
        absence_reason,
        note: input.note.unwrap_or_default(),
        created_at: now.clone(),
        updated_at: now,
    };
    conn.execute(
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
    .map_err(db_err)?;
    Ok(record)
}

pub fn update_overtime(
    conn: &mut Connection,
    input: UpdateOvertimeInput,
) -> DbResult<OvertimeRecord> {
    let mut record = get_overtime(conn, &input.id)?;
    if let Some(member_id) = input.patch.member_id {
        let member = require_team_member(conn, &member_id)?;
        record.project_id = member.project_id;
        record.member_id = member_id;
    }
    if let Some(date) = input.patch.date {
        if !date.trim().is_empty() {
            record.date = date;
        }
    }
    if let Some(hours) = input.patch.hours {
        if !hours.is_finite() || hours <= 0.0 {
            return Err("加班时长必须大于 0".to_string());
        }
        record.hours = (hours * 10.0).round() / 10.0;
    }
    if let Some(status) = input.patch.status {
        record.status = status;
    }
    if let Some(absence_reason) = input.patch.absence_reason {
        record.absence_reason = absence_reason;
    }
    record.absence_reason = normalize_absence_reason(record.status, &record.absence_reason)?;
    if let Some(note) = input.patch.note {
        record.note = note;
    }
    record.updated_at = now_iso();
    conn.execute(
        "UPDATE overtime_records SET project_id = ?1, member_id = ?2, date = ?3, hours = ?4, \
         status = ?5, absence_reason = ?6, note = ?7, updated_at = ?8 WHERE id = ?9",
        params![
            &record.project_id,
            &record.member_id,
            &record.date,
            record.hours,
            record.status.as_str(),
            &record.absence_reason,
            &record.note,
            &record.updated_at,
            &record.id,
        ],
    )
    .map_err(db_err)?;
    Ok(record)
}

pub fn delete_overtime(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    conn.execute("DELETE FROM overtime_records WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    Ok(())
}

pub fn get_performance_records(conn: &Connection) -> DbResult<Vec<PerformanceRecord>> {
    collect_rows(
        conn,
        "SELECT id, project_id, member_id, date, points, reason, category, note, created_at \
         FROM performance_records ORDER BY date DESC, created_at DESC",
        row_to_performance,
    )
}

fn get_performance(conn: &Connection, id: &str) -> DbResult<PerformanceRecord> {
    conn.query_row(
        "SELECT id, project_id, member_id, date, points, reason, category, note, created_at \
         FROM performance_records WHERE id = ?1",
        [id],
        row_to_performance,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("绩效记录不存在：{id}"))
}

pub fn create_performance(
    conn: &mut Connection,
    input: NewPerformanceInput,
) -> DbResult<PerformanceRecord> {
    let member = require_team_member(conn, &input.member_id)?;
    if input.points == 0 {
        return Err("绩效分值不能为 0".to_string());
    }
    let record = PerformanceRecord {
        id: create_id("pf"),
        project_id: member.project_id,
        member_id: input.member_id,
        date: normalize_date(&input.date),
        points: input.points.clamp(-100, 100),
        reason: fallback_trimmed(&input.reason, "绩效记录"),
        category: input.category.unwrap_or(PerformanceCategory::Other),
        note: input.note.unwrap_or_default(),
        created_at: now_iso(),
    };
    conn.execute(
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
    .map_err(db_err)?;
    Ok(record)
}

pub fn update_performance(
    conn: &mut Connection,
    input: UpdatePerformanceInput,
) -> DbResult<PerformanceRecord> {
    let mut record = get_performance(conn, &input.id)?;
    if let Some(member_id) = input.patch.member_id {
        let member = require_team_member(conn, &member_id)?;
        record.project_id = member.project_id;
        record.member_id = member_id;
    }
    if let Some(date) = input.patch.date {
        if !date.trim().is_empty() {
            record.date = date;
        }
    }
    if let Some(points) = input.patch.points {
        if points == 0 {
            return Err("绩效分值不能为 0".to_string());
        }
        record.points = points.clamp(-100, 100);
    }
    if let Some(reason) = input.patch.reason {
        record.reason = fallback_trimmed(&reason, "绩效记录");
    }
    if let Some(category) = input.patch.category {
        record.category = category;
    }
    if let Some(note) = input.patch.note {
        record.note = note;
    }
    conn.execute(
        "UPDATE performance_records SET project_id = ?1, member_id = ?2, date = ?3, \
         points = ?4, reason = ?5, category = ?6, note = ?7 WHERE id = ?8",
        params![
            &record.project_id,
            &record.member_id,
            &record.date,
            record.points,
            &record.reason,
            record.category.as_str(),
            &record.note,
            &record.id,
        ],
    )
    .map_err(db_err)?;
    Ok(record)
}

pub fn delete_performance(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    conn.execute("DELETE FROM performance_records WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 请假记录（V0.16.0）
// ---------------------------------------------------------------------------

/// 请假事由长度上限，与前端表单保持一致。
const LEAVE_REASON_MAX_CHARS: usize = 200;

/// 请假天数上限，与前端表单保持一致。
const LEAVE_DAYS_MAX: f64 = 366.0;

/// 请假天数允许的小数位数，与前端 `LEAVE_DAYS_DECIMALS` 一致。
const LEAVE_DAYS_DECIMALS: u32 = 2;

/// 请假记录的全部列，供查询与插入复用。
const LEAVE_COLUMNS: &str = "id, project_id, member_id, start_date, end_date, days, \
     leave_type, reason, note, created_at, updated_at";

/// 归一请假事由：trim 后必须非空，且不超过 200 字。
fn normalize_leave_reason(reason: &str) -> DbResult<String> {
    let text = reason.trim();
    if text.is_empty() {
        return Err("请填写请假事由".to_string());
    }
    if text.chars().count() > LEAVE_REASON_MAX_CHARS {
        return Err(format!("请假事由最多 {LEAVE_REASON_MAX_CHARS} 字"));
    }
    Ok(text.to_string())
}

/// 归一请假天数：必须 > 0、<= 366，且最多两位小数；写库前四舍五入到两位。
fn normalize_leave_days(days: f64) -> DbResult<f64> {
    if !days.is_finite() || days <= 0.0 {
        return Err("请假天数必须大于 0".to_string());
    }
    if days > LEAVE_DAYS_MAX {
        return Err(format!("请假天数不能超过 {LEAVE_DAYS_MAX} 天"));
    }
    let factor = 10f64.powi(LEAVE_DAYS_DECIMALS as i32);
    let rounded = (days * factor).round() / factor;
    if (rounded - days).abs() > 1e-9 {
        return Err(format!("请假天数最多 {LEAVE_DAYS_DECIMALS} 位小数"));
    }
    Ok(rounded)
}

/// 计算两个 `YYYY-MM-DD` 之间的自然日天数（含首尾）。
///
/// 日期格式非法或区间倒置时返回 `None`；备份归一化与导入校验共用同一套算法，
/// 保证落库天数与备份天数口径一致。
pub fn inclusive_days_between(start_date: &str, end_date: &str) -> Option<i64> {
    let start = parse_iso_date(start_date)?;
    let end = parse_iso_date(end_date)?;
    let days =
        days_from_civil(end.0, end.1, end.2) - days_from_civil(start.0, start.1, start.2) + 1;
    if days < 1 {
        None
    } else {
        Some(days)
    }
}

/// 校验请假起止日期：必须是合法且不倒置的 ISO 日期对。
///
/// 天数改为用户手填后，起止日期只作区间参考，但仍然要求格式合法且
/// 结束日期不早于开始日期，避免把明显错误的区间写进库。
fn validate_leave_date_range(start_date: &str, end_date: &str) -> DbResult<()> {
    if inclusive_days_between(start_date, end_date).is_some() {
        return Ok(());
    }
    // 两个日期都能解析但区间倒置 → 报区间错误；否则是格式错误。
    if parse_iso_date(start_date).is_some() && parse_iso_date(end_date).is_some() {
        return Err("结束日期不能早于开始日期".to_string());
    }
    Err("请假日期格式无效，请使用 YYYY-MM-DD 格式".to_string())
}

pub fn get_leave_records(conn: &Connection) -> DbResult<Vec<LeaveRecord>> {
    collect_rows(
        conn,
        &format!(
            "SELECT {LEAVE_COLUMNS} FROM leave_records \
             ORDER BY start_date DESC, created_at DESC"
        ),
        row_to_leave,
    )
}

fn get_leave(conn: &Connection, id: &str) -> DbResult<LeaveRecord> {
    conn.query_row(
        &format!("SELECT {LEAVE_COLUMNS} FROM leave_records WHERE id = ?1"),
        [id],
        row_to_leave,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("请假记录不存在：{id}"))
}

/// 新建请假记录：项目归属按成员推导，天数由用户手填。
pub fn create_leave(conn: &mut Connection, input: NewLeaveInput) -> DbResult<LeaveRecord> {
    let member = require_team_member(conn, &input.member_id)?;
    let start_date = input.start_date.trim().to_string();
    let end_date = input.end_date.trim().to_string();
    validate_leave_date_range(&start_date, &end_date)?;
    let days = normalize_leave_days(input.days)?;
    let reason = normalize_leave_reason(&input.reason)?;
    let now = now_iso();
    let record = LeaveRecord {
        id: create_id("lv"),
        project_id: member.project_id,
        member_id: input.member_id,
        start_date,
        end_date,
        days,
        leave_type: input.leave_type.unwrap_or(LeaveType::Other),
        reason,
        note: input.note.unwrap_or_default(),
        created_at: now.clone(),
        updated_at: now,
    };
    conn.execute(
        "INSERT INTO leave_records \
         (id, project_id, member_id, start_date, end_date, days, leave_type, reason, note, \
          created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            &record.id,
            &record.project_id,
            &record.member_id,
            &record.start_date,
            &record.end_date,
            record.days,
            record.leave_type.as_str(),
            &record.reason,
            &record.note,
            &record.created_at,
            &record.updated_at,
        ],
    )
    .map_err(db_err)?;
    Ok(record)
}

/// 修改请假记录：换成员时重新推导项目，改天数时按用户输入落库。
pub fn update_leave(conn: &mut Connection, input: UpdateLeaveInput) -> DbResult<LeaveRecord> {
    let mut record = get_leave(conn, &input.id)?;
    if let Some(member_id) = input.patch.member_id {
        let member = require_team_member(conn, &member_id)?;
        record.project_id = member.project_id;
        record.member_id = member_id;
    }
    if let Some(start_date) = input.patch.start_date {
        let trimmed = start_date.trim();
        if !trimmed.is_empty() {
            record.start_date = trimmed.to_string();
        }
    }
    if let Some(end_date) = input.patch.end_date {
        let trimmed = end_date.trim();
        if !trimmed.is_empty() {
            record.end_date = trimmed.to_string();
        }
    }
    // 起止日期始终重新校验；天数与日期无关，改日期不会动它。
    validate_leave_date_range(&record.start_date, &record.end_date)?;
    if let Some(days) = input.patch.days {
        record.days = normalize_leave_days(days)?;
    }
    if let Some(leave_type) = input.patch.leave_type {
        record.leave_type = leave_type;
    }
    if let Some(reason) = input.patch.reason {
        record.reason = normalize_leave_reason(&reason)?;
    }
    if let Some(note) = input.patch.note {
        record.note = note;
    }
    record.updated_at = now_iso();
    conn.execute(
        "UPDATE leave_records SET project_id = ?1, member_id = ?2, start_date = ?3, end_date = ?4, \
         days = ?5, leave_type = ?6, reason = ?7, note = ?8, updated_at = ?9 WHERE id = ?10",
        params![
            &record.project_id,
            &record.member_id,
            &record.start_date,
            &record.end_date,
            record.days,
            record.leave_type.as_str(),
            &record.reason,
            &record.note,
            &record.updated_at,
            &record.id,
        ],
    )
    .map_err(db_err)?;
    Ok(record)
}

pub fn delete_leave(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    conn.execute("DELETE FROM leave_records WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    Ok(())
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 判断从 `from` 出发沿依赖边是否可达 `target`（用于拒绝循环依赖）。
fn dependency_reaches(
    edges: &HashMap<String, Vec<String>>,
    from: &str,
    target: &str,
) -> bool {
    let mut stack = vec![from.to_string()];
    let mut visited = std::collections::HashSet::new();
    while let Some(current) = stack.pop() {
        if current == target {
            return true;
        }
        if !visited.insert(current.clone()) {
            continue;
        }
        if let Some(next) = edges.get(&current) {
            stack.extend(next.iter().cloned());
        }
    }
    false
}

/// 整体替换某张任务的关系列表（V0.4 起为前置任务，V0.12 起支持多种关系类型）。
///
/// 约束：不能关联自己；关联目标必须是未删除的任务；`blocks` 类型不能形成循环。
/// V0.12 起放开跨看板限制——看板集本就是跨看板容器，跨看板依赖是真实需求。
pub fn set_card_dependencies(
    conn: &mut Connection,
    input: SetDependenciesInput,
) -> DbResult<Vec<CardDependency>> {
    let tx = conn.transaction().map_err(db_err)?;
    let card = get_card(&tx, &input.card_id)?;
    if card.deleted_at.is_some() {
        return Err("回收站中的任务不能设置关系".to_string());
    }

    // 目标 id 与关系类型一一对应；缺省类型按 blocks 处理。
    let mut relations: Vec<(String, RelationType)> = Vec::new();
    for (index, id) in input.depends_on.iter().enumerate() {
        if *id == card.id {
            return Err("任务不能关联自己".to_string());
        }
        if relations.iter().any(|(existing, _)| existing == id) {
            continue;
        }
        let relation_type = input
            .relation_types
            .get(index)
            .copied()
            .unwrap_or(RelationType::Blocks);
        relations.push((id.clone(), relation_type));
    }

    for (id, _) in &relations {
        let target = get_card(&tx, id).map_err(|_| format!("关联任务不存在：{id}"))?;
        if target.deleted_at.is_some() {
            return Err(format!("关联任务「{}」在回收站中", target.title));
        }
    }

    // 构建阻塞关系图：只有 blocks 类型参与循环依赖检测。
    let mut edges: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut statement = tx
            .prepare(
                "SELECT d.card_id, d.depends_on_card_id \
                 FROM card_dependencies d JOIN cards c ON c.id = d.card_id \
                 WHERE d.relation_type = 'blocks'",
            )
            .map_err(db_err)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_err)?;
        for row in rows {
            let (from, to) = row.map_err(db_err)?;
            if from == card.id {
                continue;
            }
            edges.entry(from).or_default().push(to);
        }
    }
    // 只有 blocks 关系参与环检测；relates / duplicates 不构成阻塞链。
    let blocking: Vec<String> = relations
        .iter()
        .filter(|(_, relation_type)| relation_type.is_blocking())
        .map(|(id, _)| id.clone())
        .collect();
    edges.insert(card.id.clone(), blocking.clone());
    for blocker in &blocking {
        if dependency_reaches(&edges, blocker, &card.id) {
            return Err("前置任务形成了循环依赖".to_string());
        }
    }

    tx.execute(
        "DELETE FROM card_dependencies WHERE card_id = ?1",
        [&card.id],
    )
    .map_err(db_err)?;
    for (id, relation_type) in &relations {
        tx.execute(
            "INSERT INTO card_dependencies (card_id, depends_on_card_id, relation_type) \
             VALUES (?1, ?2, ?3)",
            params![&card.id, id, relation_type.as_str()],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)?;

    Ok(relations
        .into_iter()
        .map(|(depends_on_card_id, relation_type)| CardDependency {
            card_id: card.id.clone(),
            depends_on_card_id,
            relation_type,
        })
        .collect())
}

pub fn create_board(conn: &mut Connection, input: NewBoardInput) -> DbResult<Board> {
    let tx = conn.transaction().map_err(db_err)?;
    let now = now_iso();
    let board = Board {
        id: create_id("b"),
        title: fallback_trimmed(&input.title, "未命名看板"),
        description: trimmed_or_empty(input.description),
        color: input.color.unwrap_or(BoardColor::Blue),
        starred: false,
        label_colors: HashMap::new(),
        created_at: now.clone(),
        updated_at: now,
    };
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
    .map_err(db_err)?;
    // V0.13.1：新建看板同时补齐内置保存视图（全部 / 我的任务 / 最近更新）。
    ensure_builtin_saved_views(&tx, &board.id)?;
    tx.commit().map_err(db_err)?;
    Ok(board)
}

/// V0.15.0：一次性创建看板与它的看板列（Excel 导入用）。
///
/// 与 `create_board` + 多次 `create_list` 的区别：整件事在一个事务里完成，
/// 不会出现「看板已经建好、看板列还没建完」的中间态，导入失败也不会留半成品。
pub fn create_board_with_lists(
    conn: &mut Connection,
    input: NewBoardWithListsInput,
) -> DbResult<CreatedBoardWithLists> {
    let tx = conn.transaction().map_err(db_err)?;
    let now = now_iso();
    let board = Board {
        id: create_id("b"),
        title: fallback_trimmed(&input.title, "未命名看板"),
        description: trimmed_or_empty(input.description),
        color: input.color.unwrap_or(BoardColor::Blue),
        starred: false,
        label_colors: HashMap::new(),
        created_at: now.clone(),
        updated_at: now.clone(),
    };
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
    .map_err(db_err)?;
    ensure_builtin_saved_views(&tx, &board.id)?;

    // 看板列：去空、去重、保序；一条都没有时补一条「待办」
    let mut titles: Vec<String> = Vec::new();
    for title in &input.list_titles {
        let trimmed = title.trim();
        if trimmed.is_empty() || titles.iter().any(|item| item == trimmed) {
            continue;
        }
        titles.push(trimmed.to_string());
    }
    if titles.is_empty() {
        titles.push("待办".to_string());
    }

    let mut lists: Vec<List> = Vec::with_capacity(titles.len());
    for (index, title) in titles.iter().enumerate() {
        let list = List {
            id: create_id("l"),
            board_id: board.id.clone(),
            title: title.clone(),
            color: BoardColor::Slate,
            wip_limit: None,
            position: index as i64,
            created_at: now.clone(),
        };
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
                &list.created_at
            ],
        )
        .map_err(db_err)?;
        lists.push(list);
    }

    tx.commit().map_err(db_err)?;
    Ok(CreatedBoardWithLists { board, lists })
}

pub fn update_board(conn: &mut Connection, input: UpdateBoardInput) -> DbResult<Board> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut board = get_board(&tx, &input.id)?;
    // localApi 的 updateBoard 是 Object.assign，不做 trim（与 create 不同）。
    if let Some(title) = input.patch.title {
        board.title = title;
    }
    if let Some(description) = input.patch.description {
        board.description = description;
    }
    if let Some(color) = input.patch.color {
        board.color = color;
    }
    if let Some(starred) = input.patch.starred {
        board.starred = starred;
    }
    if let Some(label_colors) = input.patch.label_colors {
        board.label_colors = label_colors;
    }
    board.updated_at = now_iso();
    tx.execute(
        "UPDATE boards SET title = ?1, description = ?2, color = ?3, starred = ?4, updated_at = ?5, label_colors = ?7 \
         WHERE id = ?6",
        params![
            &board.title,
            &board.description,
            board.color.as_str(),
            board.starred as i64,
            &board.updated_at,
            &board.id,
            serde_json::to_string(&board.label_colors).map_err(|error| error.to_string())?,
        ],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(board)
}

/// 删除看板：列表与任务由外键 `ON DELETE CASCADE` 清理；不存在时静默成功（对齐 localApi）。
pub fn delete_board(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("DELETE FROM boards WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(())
}

pub fn create_list(conn: &mut Connection, input: NewListInput) -> DbResult<List> {
    let tx = conn.transaction().map_err(db_err)?;
    get_board(&tx, &input.board_id)?;
    let position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM lists WHERE board_id = ?1",
            [&input.board_id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    let list = List {
        id: create_id("l"),
        board_id: input.board_id,
        title: fallback_trimmed(&input.title, "未命名列表"),
        color: input.color.unwrap_or(BoardColor::Slate),
        wip_limit: input.wip_limit.filter(|value| *value > 0),
        position,
        created_at: now_iso(),
    };
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
            &list.created_at
        ],
    )
    .map_err(db_err)?;
    touch_board(&tx, &list.board_id)?;
    tx.commit().map_err(db_err)?;
    Ok(list)
}

pub fn update_list(conn: &mut Connection, input: UpdateListInput) -> DbResult<List> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut list = get_list(&tx, &input.id)?;
    if let Some(title) = input.patch.title {
        list.title = fallback_trimmed(&title, "未命名列表");
    }
    if let Some(color) = input.patch.color {
        list.color = color;
    }
    if let Some(wip_limit) = input.patch.wip_limit {
        list.wip_limit = wip_limit.filter(|value| *value > 0);
    }
    tx.execute(
        "UPDATE lists SET title = ?1, color = ?2, wip_limit = ?3 WHERE id = ?4",
        params![
            &list.title,
            list.color.as_str(),
            list.wip_limit,
            &list.id,
        ],
    )
    .map_err(db_err)?;
    touch_board(&tx, &list.board_id)?;
    tx.commit().map_err(db_err)?;
    Ok(list)
}

pub fn delete_list(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    let list = get_list(&tx, &input.id)?;
    tx.execute("DELETE FROM lists WHERE id = ?1", [&list.id])
        .map_err(db_err)?;
    normalize_list_positions(&tx, &list.board_id)?;
    touch_board(&tx, &list.board_id)?;
    tx.commit().map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 活动日志（V0.11）
// ---------------------------------------------------------------------------

/// 把新旧卡片之间实际发生变化的字段写成活动日志。
///
/// 只记录真正变化的字段；调用方负责把这次调用放在写任务的事务里。
pub fn record_card_changes(
    conn: &Connection,
    old: &Card,
    new: &Card,
) -> DbResult<()> {
    let mut changes: Vec<(&str, String, String)> = Vec::new();
    if old.title != new.title {
        changes.push(("title", old.title.clone(), new.title.clone()));
    }
    if old.description != new.description {
        changes.push(("description", old.description.clone(), new.description.clone()));
    }
    if old.list_id != new.list_id {
        changes.push(("listId", old.list_id.clone(), new.list_id.clone()));
    }
    if old.completed != new.completed {
        changes.push((
            "completed",
            old.completed.to_string(),
            new.completed.to_string(),
        ));
    }
    if old.due_date != new.due_date {
        changes.push((
            "dueDate",
            old.due_date.clone().unwrap_or_default(),
            new.due_date.clone().unwrap_or_default(),
        ));
    }
    if old.start_date != new.start_date {
        changes.push((
            "startDate",
            old.start_date.clone().unwrap_or_default(),
            new.start_date.clone().unwrap_or_default(),
        ));
    }
    for (field, before, after) in [
        ("estimatedMinutes", old.estimated_minutes, new.estimated_minutes),
        ("actualMinutes", old.actual_minutes, new.actual_minutes),
    ] {
        if before != after {
            changes.push((field, before.map(|value| value.to_string()).unwrap_or_default(),
                after.map(|value| value.to_string()).unwrap_or_default()));
        }
    }
    if old.priority != new.priority {
        changes.push((
            "priority",
            old.priority.map(|value| value.as_str().to_string()).unwrap_or_default(),
            new.priority.map(|value| value.as_str().to_string()).unwrap_or_default(),
        ));
    }
    if old.accent != new.accent {
        changes.push((
            "accent",
            old.accent.map(|value| value.as_str().to_string()).unwrap_or_default(),
            new.accent.map(|value| value.as_str().to_string()).unwrap_or_default(),
        ));
    }
    if old.labels != new.labels {
        changes.push(("labels", old.labels.join(","), new.labels.join(",")));
    }
    if old.subtasks != new.subtasks {
        let old_titles = old
            .subtasks
            .iter()
            .map(|item| item.title.clone())
            .collect::<Vec<String>>()
            .join(",");
        let new_titles = new
            .subtasks
            .iter()
            .map(|item| item.title.clone())
            .collect::<Vec<String>>()
            .join(",");
        changes.push(("subtasks", old_titles, new_titles));
    }
    for (field, old_value, new_value) in changes {
        crate::automation::insert_activity(conn, &new.id, "updated", field, &old_value, &new_value)?;
    }
    Ok(())
}

/// 记录一次事件级活动（创建、移动、完成、删除、恢复等）。
pub fn record_card_event(
    conn: &Connection,
    card_id: &str,
    event_type: &str,
    detail: &str,
) -> DbResult<()> {
    crate::automation::insert_activity(conn, card_id, event_type, "", "", detail)
}

fn validate_card_minutes(card: &Card) -> DbResult<()> {
    if card.estimated_minutes.is_some_and(|minutes| minutes < 0)
        || card.actual_minutes.is_some_and(|minutes| minutes < 0)
    {
        return Err("工时分钟数不能为负数".to_string());
    }
    Ok(())
}

/// 递归子树 id（含自身）。
fn subtree_ids(conn: &Connection, root_id: &str) -> DbResult<Vec<String>> {
    let mut statement = conn
        .prepare(
            "WITH RECURSIVE subtree(id) AS ( \
                 SELECT ?1 \
                 UNION ALL \
                 SELECT cards.id FROM cards JOIN subtree ON cards.parent_card_id = subtree.id \
             ) SELECT id FROM subtree",
        )
        .map_err(db_err)?;
    let rows = statement
        .query_map([root_id], |row| row.get::<_, String>(0))
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<String>>>()
        .map_err(db_err)
}

/// 沿父链计算深度（主任务为 0）；超过技术上限直接报错，防止脏数据成环。
fn card_depth(conn: &Connection, card_id: &str) -> DbResult<usize> {
    let mut depth = 0usize;
    let mut current = Some(card_id.to_string());
    while let Some(id) = current {
        if depth > crate::models::MAX_TASK_DEPTH {
            return Err("任务层级过深".to_string());
        }
        current = conn
            .query_row(
                "SELECT parent_card_id FROM cards WHERE id = ?1",
                [&id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(db_err)?
            .flatten();
        depth += 1;
    }
    Ok(depth.saturating_sub(1))
}

/// 主任务移动列表时，把整棵子树的 list_id 一起同步。
fn sync_subtree_list(conn: &Connection, root_id: &str, list_id: &str) -> DbResult<()> {
    for id in subtree_ids(conn, root_id)?.iter().skip(1) {
        conn.execute(
            "UPDATE cards SET list_id = ?1 WHERE id = ?2",
            params![list_id, id],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

pub fn create_card(conn: &mut Connection, input: NewCardInput) -> DbResult<Card> {
    let tx = conn.transaction().map_err(db_err)?;
    get_list(&tx, &input.list_id)?;
    let parent_card_id = input.parent_card_id.clone();
    if let Some(parent_id) = &parent_card_id {
        let parent = get_card(&tx, parent_id)?;
        if parent.board_id != input.board_id {
            return Err("子任务必须与父任务在同一看板".to_string());
        }
        if parent.list_id != input.list_id {
            return Err("子任务必须跟随父任务列表".to_string());
        }
        if parent.deleted_at.is_some() {
            return Err("父任务在回收站中，不能添加子任务".to_string());
        }
        if card_depth(&tx, &parent.id)? + 1 > crate::models::MAX_TASK_DEPTH {
            return Err("任务层级过深".to_string());
        }
    }
    let position: i64 = if let Some(parent_id) = &parent_card_id {
        tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM cards \
             WHERE parent_card_id = ?1 AND deleted_at IS NULL",
            [parent_id],
            |row| row.get(0),
        )
        .map_err(db_err)?
    } else {
        tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM cards \
             WHERE list_id = ?1 AND parent_card_id IS NULL AND deleted_at IS NULL",
            [&input.list_id],
            |row| row.get(0),
        )
        .map_err(db_err)?
    };
    let now = now_iso();
    let card = Card {
        id: create_id("c"),
        board_id: input.board_id,
        list_id: input.list_id,
        parent_card_id,
        title: fallback_trimmed(&input.title, "未命名任务"),
        description: trimmed_or_empty(input.description),
        due_date: input.due_date,
        start_date: input.start_date,
        estimated_minutes: input.estimated_minutes,
        actual_minutes: input.actual_minutes,
        priority: input.priority,
        accent: input.accent,
        completed: false,
        deleted_at: None,
        labels: input.labels.unwrap_or_default(),
        subtasks: input.subtasks.unwrap_or_default(),
        position,
        recurrence_id: None,
        generated_from_id: None,
        created_at: now.clone(),
        updated_at: now,
    };
    validate_card_minutes(&card)?;
    let labels_json = labels_to_json(&card.labels)?;
    let subtasks_json = subtasks_to_json(&card.subtasks)?;
    tx.execute(
        "INSERT INTO cards \
         (id, board_id, list_id, parent_card_id, title, description, due_date, start_date, priority, accent, completed, \
         labels, subtasks, position, deleted_at, recurrence_id, generated_from_id, estimated_minutes, actual_minutes, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, NULL, NULL, ?15, ?16, ?17, ?18)",
        params![
            &card.id,
            &card.board_id,
            &card.list_id,
            &card.parent_card_id,
            &card.title,
            &card.description,
            &card.due_date,
            &card.start_date,
            card.priority.map(Priority::as_str),
            card.accent.map(BoardColor::as_str),
            card.completed as i64,
            &labels_json,
            &subtasks_json,
            card.position,
            card.estimated_minutes,
            card.actual_minutes,
            &card.created_at,
            &card.updated_at,
        ],
    )
    .map_err(db_err)?;
    touch_board(&tx, &card.board_id)?;
    record_card_event(&tx, &card.id, "created", "")?;
    tx.commit().map_err(db_err)?;
    Ok(card)
}

pub fn update_card(conn: &mut Connection, input: UpdateCardInput) -> DbResult<Card> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut card = get_card(&tx, &input.id)?;
    let previous = card.clone();
    if let Some(title) = input.patch.title {
        card.title = fallback_trimmed(&title, "未命名任务");
    }
    if let Some(description) = input.patch.description {
        card.description = description;
    }
    if let Some(due_date) = input.patch.due_date {
        card.due_date = due_date;
    }
    if let Some(start_date) = input.patch.start_date {
        card.start_date = start_date;
    }
    if let Some(minutes) = input.patch.estimated_minutes {
        card.estimated_minutes = minutes;
    }
    if let Some(minutes) = input.patch.actual_minutes {
        card.actual_minutes = minutes;
    }
    validate_card_minutes(&card)?;
    if let Some(priority) = input.patch.priority {
        card.priority = priority;
    }
    if let Some(accent) = input.patch.accent {
        card.accent = accent;
    }
    if let Some(completed) = input.patch.completed {
        card.completed = completed;
    }
    // 标签 / 子任务由前端整体增删后提交，这里直接整体替换。
    if let Some(labels) = input.patch.labels {
        card.labels = labels;
    }
    if let Some(subtasks) = input.patch.subtasks {
        card.subtasks = subtasks;
    }
    if let Some(next_list_id) = input.patch.list_id.as_ref() {
        if card.parent_card_id.is_some() && next_list_id != &card.list_id {
            return Err("子任务不能单独移动列表".to_string());
        }
    }
    if let Some(next_list_id) = input.patch.list_id {
        if next_list_id != card.list_id {
            let target = get_list(&tx, &next_list_id)?;
            if target.board_id != card.board_id {
                return Err("不能跨看板移动任务".to_string());
            }
            let old_list_id = card.list_id.clone();
            card.list_id = next_list_id;
            // 先落库 list_id，旧列表归一化时就不会再算上这张卡。
            tx.execute(
                "UPDATE cards SET list_id = ?1 WHERE id = ?2",
                params![&card.list_id, &card.id],
            )
            .map_err(db_err)?;
            // 主任务移动列表时，整棵子树一起跟随。
            sync_subtree_list(&tx, &card.id, &card.list_id)?;
            normalize_card_positions(&tx, &old_list_id)?;
            card.position = tx
                .query_row(
                    "SELECT COUNT(*) FROM cards WHERE list_id = ?1 AND id != ?2 \
                     AND parent_card_id IS NULL AND deleted_at IS NULL",
                    params![&card.list_id, &card.id],
                    |row| row.get(0),
                )
                .map_err(db_err)?;
        }
    }
    card.updated_at = now_iso();
    let labels_json = labels_to_json(&card.labels)?;
    let subtasks_json = subtasks_to_json(&card.subtasks)?;
    tx.execute(
        "UPDATE cards SET title = ?1, description = ?2, due_date = ?3, start_date = ?4, \
         priority = ?5, accent = ?6, completed = ?7, labels = ?8, subtasks = ?9, position = ?10, \
         estimated_minutes = ?11, actual_minutes = ?12, updated_at = ?13 WHERE id = ?14",
        params![
            &card.title,
            &card.description,
            &card.due_date,
            &card.start_date,
            card.priority.map(Priority::as_str),
            card.accent.map(BoardColor::as_str),
            card.completed as i64,
            &labels_json,
            &subtasks_json,
            card.position,
            card.estimated_minutes,
            card.actual_minutes,
            &card.updated_at,
            &card.id,
        ],
    )
    .map_err(db_err)?;
    touch_board(&tx, &card.board_id)?;
    record_card_changes(&tx, &previous, &card)?;
    if !previous.completed && card.completed {
        record_card_event(&tx, &card.id, "completed", "")?;
        // 完成时执行本地规则并滚动重复任务；失败只记录，不影响本次完成。
        let _ = crate::automation::run_rules(
            &tx,
            &card,
            crate::models::RuleTrigger::Complete,
            &crate::automation::today_key(),
        );
        let _ = crate::automation::roll_recurrence(&tx, &card.id);
    }
    if previous.list_id != card.list_id {
        record_card_event(&tx, &card.id, "moved", "")?;
        // 直接改 list_id 也算移动到某一列，触发 move_to_list 规则。
        let _ = crate::automation::run_rules(
            &tx,
            &card,
            crate::models::RuleTrigger::MoveToList,
            &crate::automation::today_key(),
        );
    }
    tx.commit().map_err(db_err)?;
    Ok(card)
}

pub fn delete_card(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    let card = get_card(&tx, &input.id)?;
    // 软删除：整棵子树一起放进回收站，物理行保留；重复删除是无操作（对齐 localApi）。
    if card.deleted_at.is_none() {
        let now = now_iso();
        let ids = subtree_ids(&tx, &card.id)?;
        for id in &ids {
            tx.execute(
                "UPDATE cards SET deleted_at = ?1, updated_at = ?1 \
                 WHERE id = ?2 AND deleted_at IS NULL",
                params![&now, id],
            )
            .map_err(db_err)?;
            // 删除任务后，指向它的依赖边一并移除，避免其他任务被已删除任务阻塞。
            tx.execute(
                "DELETE FROM card_dependencies WHERE card_id = ?1 OR depends_on_card_id = ?1",
                [id],
            )
            .map_err(db_err)?;
        }
        normalize_card_positions(&tx, &card.list_id)?;
        touch_board(&tx, &card.board_id)?;
        record_card_event(&tx, &card.id, "deleted", "")?;
    }
    tx.commit().map_err(db_err)?;
    Ok(())
}

/// 回收站列表：只返回软删除的任务，按删除时间倒序（最新删除的在前）。
pub fn get_trash(conn: &Connection) -> DbResult<Vec<Card>> {
    collect_rows(
        conn,
        &format!(
            "SELECT {CARD_COLUMNS} FROM cards WHERE deleted_at IS NOT NULL \
             ORDER BY deleted_at DESC, id DESC"
        ),
        row_to_card,
    )
}

/// 从回收站恢复：清空 deleted_at、追加到原列表末尾，并刷新看板时间。
///
/// 原列表 / 看板已被物理删除（理论上会被外键级联掉，这里做防御）时报可读错误。
pub fn restore_card(conn: &mut Connection, input: IdInput) -> DbResult<Card> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut card = get_card(&tx, &input.id)?;
    if card.deleted_at.is_none() {
        // 不在回收站里：直接返回原卡片，保持幂等。
        tx.commit().map_err(db_err)?;
        return Ok(card);
    }
    if get_board(&tx, &card.board_id).is_err() || get_list(&tx, &card.list_id).is_err() {
        return Err("原列表已删除，无法恢复".to_string());
    }
    let now = now_iso();
    // 恢复仍被删除的祖先链（根 → 父），避免子任务恢复后悬空。
    let mut ancestors = Vec::new();
    let mut cursor = card.parent_card_id.clone();
    while let Some(parent_id) = cursor {
        let parent = get_card(&tx, &parent_id)?;
        cursor = parent.parent_card_id.clone();
        ancestors.push(parent);
    }
    ancestors.reverse();
    for ancestor in ancestors {
        if ancestor.deleted_at.is_some() {
            tx.execute(
                "UPDATE cards SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
                params![&now, &ancestor.id],
            )
            .map_err(db_err)?;
            record_card_event(&tx, &ancestor.id, "restored", "")?;
            touch_board(&tx, &ancestor.board_id)?;
        }
    }
    // 恢复后追加到同级末尾（父任务不存在时即列表末尾）。
    let position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM cards \
             WHERE list_id = ?1 AND parent_card_id IS ?2 AND deleted_at IS NULL AND id != ?3",
            params![&card.list_id, &card.parent_card_id, &card.id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    let ids = subtree_ids(&tx, &card.id)?;
    // 只恢复与本次删除同批（同一 deleted_at）的后代；此前单独删除的后代保持不动。
    let batch_stamp = card.deleted_at.clone();
    for id in &ids {
        let existing: Option<String> = tx
            .query_row(
                "SELECT deleted_at FROM cards WHERE id = ?1",
                [id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(db_err)?
            .flatten();
        let same_batch = existing == batch_stamp || id == &card.id;
        if !same_batch {
            continue;
        }
        tx.execute(
            "UPDATE cards SET deleted_at = NULL, updated_at = ?1 \
             WHERE id = ?2 AND deleted_at IS NOT NULL",
            params![&now, id],
        )
        .map_err(db_err)?;
    }
    card.deleted_at = None;
    card.position = position;
    card.updated_at = now;
    tx.execute(
        "UPDATE cards SET position = ?1 WHERE id = ?2",
        params![card.position, &card.id],
    )
    .map_err(db_err)?;
    touch_board(&tx, &card.board_id)?;
    record_card_event(&tx, &card.id, "restored", "")?;
    tx.commit().map_err(db_err)?;
    Ok(card)
}

/// 彻底删除单个任务（回收站操作），不存在时静默成功（对齐 localApi）。
pub fn purge_card(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("DELETE FROM cards WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(())
}

/// 清空回收站：物理删除所有软删除任务，活动任务不受影响。
pub fn empty_trash(conn: &mut Connection) -> DbResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("DELETE FROM cards WHERE deleted_at IS NOT NULL", [])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(())
}

pub fn move_card(conn: &mut Connection, input: MoveCardInput) -> DbResult<Card> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut card = get_card(&tx, &input.card_id)?;
    if card.parent_card_id.is_some() {
        return Err("子任务不能单独移动列表".to_string());
    }
    let target = get_list(&tx, &input.to_list_id)?;
    if target.board_id != card.board_id {
        return Err("不能跨看板移动任务".to_string());
    }
    let old_list_id = card.list_id.clone();
    // 目标列表内除自身外的**活动主任务**，按 position 升序（回收站与子任务不参与）。
    let mut ids: Vec<String> = {
        let mut statement = tx
            .prepare(
                "SELECT id FROM cards WHERE list_id = ?1 AND id != ?2 AND parent_card_id IS NULL \
                 AND deleted_at IS NULL \
                 ORDER BY position ASC, created_at ASC, id ASC",
            )
            .map_err(db_err)?;
        let rows = statement
            .query_map(params![&input.to_list_id, &card.id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<Vec<String>>>()
            .map_err(db_err)?
    };
    let index = input.to_index.clamp(0, ids.len() as i64) as usize;
    ids.insert(index, card.id.clone());
    for (position, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE cards SET position = ?1 WHERE id = ?2",
            params![position as i64, id],
        )
        .map_err(db_err)?;
    }
    card.list_id = input.to_list_id;
    card.position = index as i64;
    card.updated_at = now_iso();
    tx.execute(
        "UPDATE cards SET list_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
        params![&card.list_id, card.position, &card.updated_at, &card.id],
    )
    .map_err(db_err)?;
    // 主任务移动列表时，整棵子树一起跟随。
    sync_subtree_list(&tx, &card.id, &card.list_id)?;
    if old_list_id != card.list_id {
        normalize_card_positions(&tx, &old_list_id)?;
    }
    touch_board(&tx, &card.board_id)?;
    if old_list_id != card.list_id {
        record_card_event(&tx, &card.id, "moved", &card.list_id)?;
        // 移动到指定列表时执行本地规则；失败只记录，不影响本次移动。
        let _ = crate::automation::run_rules(
            &tx,
            &card,
            crate::models::RuleTrigger::MoveToList,
            &crate::automation::today_key(),
        );
    }
    tx.commit().map_err(db_err)?;
    Ok(card)
}

pub fn add_inbox_item(conn: &mut Connection, input: AddInboxInput) -> DbResult<InboxItem> {
    let item = InboxItem {
        id: create_id("i"),
        content: input.content.trim().to_string(),
        created_at: now_iso(),
    };
    conn.execute(
        "INSERT INTO inbox_items (id, content, created_at) VALUES (?1, ?2, ?3)",
        params![&item.id, &item.content, &item.created_at],
    )
    .map_err(db_err)?;
    Ok(item)
}

pub fn delete_inbox_item(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    conn.execute("DELETE FROM inbox_items WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    Ok(())
}

pub fn convert_inbox_item(conn: &mut Connection, input: ConvertInboxInput) -> DbResult<Card> {
    let tx = conn.transaction().map_err(db_err)?;
    let item = find_inbox_item(&tx, &input.id)?.ok_or_else(|| "收件箱条目不存在".to_string())?;
    get_board(&tx, &input.board_id)?;
    let target_list_id = match input.list_id.filter(|value| !value.is_empty()) {
        Some(list_id) => {
            get_list(&tx, &list_id)?;
            list_id
        }
        None => tx
            .query_row(
                "SELECT id FROM lists WHERE board_id = ?1 \
                 ORDER BY position ASC, created_at ASC, id ASC LIMIT 1",
                [&input.board_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_err)?
            .ok_or_else(|| "看板还没有列表，请先添加列表".to_string())?,
    };
    let position: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE list_id = ?1",
            [&target_list_id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    // 对齐 localApi：首行截前 80 个字符作标题；含换行时整段内容作描述。
    let first_line = item.content.split('\n').next().unwrap_or("");
    let mut title: String = first_line.chars().take(80).collect();
    if title.is_empty() {
        title = "未命名任务".to_string();
    }
    let description = if item.content.contains('\n') {
        item.content.clone()
    } else {
        String::new()
    };
    let now = now_iso();
    let card = Card {
        id: create_id("c"),
        board_id: input.board_id,
        list_id: target_list_id,
        parent_card_id: None,
        title,
        description,
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
        position,
        recurrence_id: None,
        generated_from_id: None,
        created_at: now.clone(),
        updated_at: now,
    };
    let labels_json = labels_to_json(&card.labels)?;
    let subtasks_json = subtasks_to_json(&card.subtasks)?;
    tx.execute(
        "INSERT INTO cards \
         (id, board_id, list_id, title, description, due_date, start_date, priority, accent, completed, \
         labels, subtasks, position, deleted_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, NULL, ?6, ?7, ?8, ?9, NULL, ?10, ?11)",
        params![
            &card.id,
            &card.board_id,
            &card.list_id,
            &card.title,
            &card.description,
            card.completed as i64,
            &labels_json,
            &subtasks_json,
            card.position,
            &card.created_at,
            &card.updated_at,
        ],
    )
    .map_err(db_err)?;
    tx.execute("DELETE FROM inbox_items WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    touch_board(&tx, &card.board_id)?;
    tx.commit().map_err(db_err)?;
    Ok(card)
}

// ---------------------------------------------------------------------------
// 自定义字段（V0.13.0）
// ---------------------------------------------------------------------------

const CUSTOM_FIELD_COLUMNS: &str =
    "id, board_id, name, field_type, options_json, sort_order, created_at, updated_at";

/// 字段选项数组 → SQLite TEXT（JSON 数组）；序列化失败返回可读错误。
fn custom_field_options_to_json(options: &[CustomFieldOption]) -> DbResult<String> {
    serde_json::to_string(options).map_err(|error| format!("字段选项序列化失败：{error}"))
}

/// SQLite TEXT → 字段选项数组；历史脏数据解析失败时回退空数组。
fn custom_field_options_from_json(raw: &str) -> Vec<CustomFieldOption> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn row_to_custom_field(row: &Row<'_>) -> rusqlite::Result<CustomField> {
    let raw_type: String = row.get("field_type")?;
    Ok(CustomField {
        id: row.get("id")?,
        board_id: row.get("board_id")?,
        name: row.get("name")?,
        // 类型是脏数据时兜底为 select，避免一条脏数据炸掉整份快照
        field_type: CustomFieldType::from_db(&raw_type).unwrap_or(CustomFieldType::Select),
        options: custom_field_options_from_json(&row.get::<_, String>("options_json")?),
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_card_field_value(row: &Row<'_>) -> rusqlite::Result<CardFieldValue> {
    Ok(CardFieldValue {
        card_id: row.get("card_id")?,
        field_id: row.get("field_id")?,
        value_text: row.get("value_text")?,
        value_number: row.get("value_number")?,
    })
}

/// 字段名兜底：`trim()` 后为空则用「未命名字段」。
fn custom_field_name(raw: &str) -> String {
    fallback_trimmed(raw, "未命名字段")
}

/// 同一看板内字段名唯一（按 trim 后的字符串精确比较）。
fn ensure_unique_custom_field_name(
    conn: &Connection,
    board_id: &str,
    name: &str,
    exclude_id: Option<&str>,
) -> DbResult<()> {
    for field in get_custom_fields(conn, board_id)? {
        if exclude_id == Some(field.id.as_str()) {
            continue;
        }
        if field.name.trim() == name {
            return Err("该看板已存在同名字段".to_string());
        }
    }
    Ok(())
}

/// 规范化选项：id 非空且唯一，label 空时兜底「选项 N」，color 空时兜底默认色。
fn normalize_custom_field_options(
    options: &[CustomFieldOption],
) -> DbResult<Vec<CustomFieldOption>> {
    let mut normalized = Vec::with_capacity(options.len());
    let mut seen: HashSet<String> = HashSet::new();
    for (index, option) in options.iter().enumerate() {
        let id = option.id.trim().to_string();
        if id.is_empty() {
            return Err("选项 id 不能为空".to_string());
        }
        if !seen.insert(id.clone()) {
            return Err(format!("选项 id 重复：{id}"));
        }
        normalized.push(CustomFieldOption {
            id,
            label: fallback_trimmed(&option.label, &format!("选项 {}", index + 1)),
            color: fallback_trimmed(&option.color, "#64748b"),
        });
    }
    Ok(normalized)
}

/// 按字段类型校验并规范化选项列表：数值字段不允许带选项，单选字段至少一个选项。
fn prepare_custom_field_options(
    field_type: CustomFieldType,
    options: &[CustomFieldOption],
) -> DbResult<Vec<CustomFieldOption>> {
    match field_type {
        CustomFieldType::Select => {
            if options.is_empty() {
                return Err("单选字段至少需要一个选项".to_string());
            }
            normalize_custom_field_options(options)
        }
        CustomFieldType::Number => {
            if !options.is_empty() {
                return Err("数值字段不支持选项".to_string());
            }
            Ok(Vec::new())
        }
    }
}

/// 读取某个看板的全部自定义字段（按 sort_order、created_at 排序）。
pub fn get_custom_fields(conn: &Connection, board_id: &str) -> DbResult<Vec<CustomField>> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {CUSTOM_FIELD_COLUMNS} FROM custom_fields WHERE board_id = ?1 \
             ORDER BY sort_order ASC, created_at ASC"
        ))
        .map_err(db_err)?;
    let rows = statement
        .query_map([board_id], row_to_custom_field)
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

/// 读取全部自定义字段（快照与备份用）。
pub fn get_all_custom_fields(conn: &Connection) -> DbResult<Vec<CustomField>> {
    collect_rows(
        conn,
        &format!(
            "SELECT {CUSTOM_FIELD_COLUMNS} FROM custom_fields \
             ORDER BY board_id ASC, sort_order ASC, created_at ASC"
        ),
        row_to_custom_field,
    )
}

/// 读取全部任务字段取值（快照与备份用）。
pub fn get_all_card_field_values(conn: &Connection) -> DbResult<Vec<CardFieldValue>> {
    collect_rows(
        conn,
        "SELECT card_id, field_id, value_text, value_number FROM card_field_values \
         ORDER BY card_id ASC, field_id ASC",
        row_to_card_field_value,
    )
}

fn get_custom_field(conn: &Connection, id: &str) -> DbResult<CustomField> {
    conn.query_row(
        &format!("SELECT {CUSTOM_FIELD_COLUMNS} FROM custom_fields WHERE id = ?1"),
        [id],
        row_to_custom_field,
    )
    .optional()
    .map_err(db_err)?
    .ok_or_else(|| format!("自定义字段不存在：{id}"))
}

/// 新建自定义字段：字段名同看板内唯一，选项按类型校验。
pub fn create_custom_field(
    conn: &mut Connection,
    input: NewCustomFieldInput,
) -> DbResult<CustomField> {
    let _ = get_board(conn, &input.board_id)?;
    let name = custom_field_name(&input.name);
    ensure_unique_custom_field_name(conn, &input.board_id, &name, None)?;
    let options = prepare_custom_field_options(input.field_type, &input.options)?;
    let now = now_iso();
    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM custom_fields WHERE board_id = ?1",
            [&input.board_id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    let field = CustomField {
        id: create_id("cf"),
        board_id: input.board_id,
        name,
        field_type: input.field_type,
        options,
        sort_order,
        created_at: now.clone(),
        updated_at: now,
    };
    conn.execute(
        "INSERT INTO custom_fields \
         (id, board_id, name, field_type, options_json, sort_order, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            &field.id,
            &field.board_id,
            &field.name,
            field.field_type.as_str(),
            custom_field_options_to_json(&field.options)?,
            field.sort_order,
            &field.created_at,
            &field.updated_at,
        ],
    )
    .map_err(db_err)?;
    Ok(field)
}

/// 修改自定义字段：传入 options 时整体替换，被移除选项对应的字段值一并清理。
pub fn update_custom_field(
    conn: &mut Connection,
    input: UpdateCustomFieldInput,
) -> DbResult<CustomField> {
    let mut field = get_custom_field(conn, &input.id)?;
    let mut removed_option_ids: Vec<String> = Vec::new();
    if let Some(name) = input.patch.name {
        let new_name = custom_field_name(&name);
        if new_name != field.name {
            ensure_unique_custom_field_name(conn, &field.board_id, &new_name, Some(&field.id))?;
        }
        field.name = new_name;
    }
    if let Some(options) = input.patch.options {
        let normalized = prepare_custom_field_options(field.field_type, &options)?;
        // 被移除的选项 id：指向它们的字段值要一并删除，避免留下指向已删选项的脏值
        let kept: HashSet<String> = normalized.iter().map(|option| option.id.clone()).collect();
        removed_option_ids = field
            .options
            .iter()
            .map(|option| option.id.clone())
            .filter(|id| !kept.contains(id))
            .collect();
        field.options = normalized;
    }
    if let Some(sort_order) = input.patch.sort_order {
        field.sort_order = sort_order;
    }
    field.updated_at = now_iso();
    let options_json = custom_field_options_to_json(&field.options)?;
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute(
        "UPDATE custom_fields SET name = ?1, options_json = ?2, sort_order = ?3, updated_at = ?4 \
         WHERE id = ?5",
        params![
            &field.name,
            options_json,
            field.sort_order,
            &field.updated_at,
            &field.id
        ],
    )
    .map_err(db_err)?;
    for option_id in &removed_option_ids {
        tx.execute(
            "DELETE FROM card_field_values WHERE field_id = ?1 AND value_text = ?2",
            params![&field.id, option_id],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)?;
    Ok(field)
}

/// 删除自定义字段：显式清理字段值，旧库外键未生效时也不会留下孤儿行。
pub fn delete_custom_field(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute(
        "DELETE FROM card_field_values WHERE field_id = ?1",
        [&input.id],
    )
    .map_err(db_err)?;
    tx.execute("DELETE FROM custom_fields WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(())
}

/// 设置某张任务在一组字段上的取值；返回该任务当前的全部字段值。
pub fn set_card_field_values(
    conn: &mut Connection,
    input: SetCardFieldValuesInput,
) -> DbResult<Vec<CardFieldValue>> {
    // 任务必须存在，并取出它所在的看板
    let card_board_id: String = conn
        .query_row(
            "SELECT board_id FROM cards WHERE id = ?1",
            [&input.card_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| format!("任务不存在：{}", input.card_id))?;

    let mut seen: HashSet<String> = HashSet::new();
    let mut planned: Vec<(String, Option<String>, Option<f64>)> = Vec::new();
    for value in &input.values {
        if !seen.insert(value.field_id.clone()) {
            return Err(format!("字段重复赋值：{}", value.field_id));
        }
        let field = get_custom_field(conn, &value.field_id)?;
        if field.board_id != card_board_id {
            return Err("字段不属于任务所在看板".to_string());
        }
        match field.field_type {
            CustomFieldType::Select => {
                if value.value_number.is_some() {
                    return Err("单选字段只接受选项 id".to_string());
                }
                match value.value_text.as_deref() {
                    Some(option_id) => {
                        if !field.options.iter().any(|option| option.id == option_id) {
                            return Err(format!("选项不存在：{option_id}"));
                        }
                        planned.push((field.id.clone(), Some(option_id.to_string()), None));
                    }
                    None => planned.push((field.id.clone(), None, None)),
                }
            }
            CustomFieldType::Number => {
                if value.value_text.is_some() {
                    return Err("数值字段只接受数字".to_string());
                }
                match value.value_number {
                    Some(number) => {
                        if !number.is_finite() {
                            return Err("数值字段必须是有限数".to_string());
                        }
                        planned.push((field.id.clone(), None, Some(number)));
                    }
                    None => planned.push((field.id.clone(), None, None)),
                }
            }
        }
    }

    let tx = conn.transaction().map_err(db_err)?;
    for (field_id, value_text, value_number) in &planned {
        if value_text.is_none() && value_number.is_none() {
            // 两个值都为 null 表示清空该字段
            tx.execute(
                "DELETE FROM card_field_values WHERE card_id = ?1 AND field_id = ?2",
                params![&input.card_id, field_id],
            )
            .map_err(db_err)?;
        } else {
            tx.execute(
                "INSERT INTO card_field_values (card_id, field_id, value_text, value_number) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(card_id, field_id) DO UPDATE SET \
                 value_text = excluded.value_text, value_number = excluded.value_number",
                params![&input.card_id, field_id, value_text, value_number],
            )
            .map_err(db_err)?;
        }
    }
    tx.commit().map_err(db_err)?;

    let mut statement = conn
        .prepare(
            "SELECT card_id, field_id, value_text, value_number FROM card_field_values \
             WHERE card_id = ?1 ORDER BY field_id ASC",
        )
        .map_err(db_err)?;
    let rows = statement
        .query_map([&input.card_id], row_to_card_field_value)
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

// ---------------------------------------------------------------------------
// 保存的筛选视图（V0.13.1）
// ---------------------------------------------------------------------------

const SAVED_VIEW_COLUMNS: &str =
    "id, board_id, name, view_type, filters_json, sort_json, is_builtin, created_at, updated_at";

/// 内置视图的标识与名称：id 固定，重复补齐不会产生重复行。
const BUILTIN_SAVED_VIEWS: [(&str, &str); 3] = [
    ("all", "全部"),
    ("mine", "我的任务"),
    ("recent", "最近更新"),
];

/// 筛选条件 → JSON 文本；序列化失败返回可读错误。
fn saved_view_filters_to_json(filters: &SavedViewFilters) -> DbResult<String> {
    serde_json::to_string(filters).map_err(|error| format!("筛选条件序列化失败：{error}"))
}

/// JSON 文本 → 筛选条件；脏数据回退空条件。
fn saved_view_filters_from_json(raw: &str) -> SavedViewFilters {
    serde_json::from_str(raw).unwrap_or_default()
}

/// 排序方式 → JSON 文本；序列化失败返回可读错误。
fn saved_view_sort_to_json(sort: &SavedViewSort) -> DbResult<String> {
    serde_json::to_string(sort).map_err(|error| format!("排序方式序列化失败：{error}"))
}

/// JSON 文本 → 排序方式；脏数据回退默认排序。
fn saved_view_sort_from_json(raw: &str) -> SavedViewSort {
    serde_json::from_str(raw).unwrap_or_default()
}

fn row_to_saved_view(row: &Row<'_>) -> rusqlite::Result<SavedView> {
    let filters_json: String = row.get("filters_json")?;
    let sort_json: String = row.get("sort_json")?;
    Ok(SavedView {
        id: row.get("id")?,
        board_id: row.get("board_id")?,
        name: row.get("name")?,
        view_type: row.get("view_type")?,
        filters: saved_view_filters_from_json(&filters_json),
        sort: saved_view_sort_from_json(&sort_json),
        is_builtin: row.get::<_, i64>("is_builtin")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 筛选条件规范化：状态只认 all / active / completed，标签去空白。
fn normalize_saved_view_filters(filters: SavedViewFilters) -> SavedViewFilters {
    let status = match filters.status.trim() {
        "active" => "active",
        "completed" => "completed",
        _ => "all",
    }
    .to_string();
    SavedViewFilters {
        keyword: filters.keyword.trim().to_string(),
        status,
        priorities: filters.priorities,
        labels: filters
            .labels
            .into_iter()
            .map(|label| label.trim().to_string())
            .filter(|label| !label.is_empty())
            .collect(),
        field_filters: filters.field_filters,
        blocked: filters.blocked,
    }
}

/// 排序方式规范化：与前端 `normalizeSortKey` 同一套映射，
/// 方向由排序键决定（以 -desc 结尾即倒序），无法识别的键回退默认排序。
fn normalize_saved_view_sort(sort: SavedViewSort) -> SavedViewSort {
    let descending = sort.direction.trim() == "desc";
    let key = match sort.key.trim() {
        "due-asc" => "due-asc",
        "due-desc" => "due-desc",
        "due" => {
            if descending {
                "due-desc"
            } else {
                "due-asc"
            }
        }
        "priority" => "priority",
        "created-desc" => "created-desc",
        "created-asc" => "created-asc",
        "created" => {
            if descending {
                "created-desc"
            } else {
                "created-asc"
            }
        }
        "updated" | "updatedAt" | "updated-at" | "updated-desc" => "updated-desc",
        _ => "due-asc",
    };
    let direction = if key.ends_with("-desc") {
        "desc"
    } else {
        "asc"
    };
    SavedViewSort {
        key: key.to_string(),
        direction: direction.to_string(),
    }
}

/// 视图类型规范化：空值按看板视图处理，其它值原样保留（类型词表由前端定义）。
fn normalize_view_type(view_type: &str) -> String {
    let trimmed = view_type.trim();
    if trimmed.is_empty() {
        "board".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 字段筛选净化：与前端 `degradeLocalSavedViewFilters` 同一套降级规则 ——
/// 字段没了就丢掉整条条件，选项没了就去掉那个选项 id，选项被删光则整条失效。
fn sanitize_saved_view_field_filters(
    conn: &Connection,
    board_id: &str,
    filters: &mut SavedViewFilters,
) -> DbResult<()> {
    let fields = get_custom_fields(conn, board_id)?;
    let mut kept: Vec<SavedViewFieldFilter> = Vec::new();
    for mut filter in std::mem::take(&mut filters.field_filters) {
        let Some(field) = fields.iter().find(|field| field.id == filter.field_id) else {
            // 字段已被删除：丢掉整条条件
            continue;
        };
        if filter.option_ids.is_empty() {
            // 没有选项条件（数值区间等）：原样保留
            kept.push(filter);
            continue;
        }
        let valid: HashSet<&str> = field
            .options
            .iter()
            .map(|option| option.id.as_str())
            .collect();
        filter
            .option_ids
            .retain(|option_id| valid.contains(option_id.as_str()));
        if filter.option_ids.is_empty() {
            // 选项被删光：条件失效
            continue;
        }
        kept.push(filter);
    }
    filters.field_filters = kept;
    Ok(())
}

/// 读取时净化保存视图：失效的字段引用被忽略，视图仍可正常还原。
fn sanitize_saved_view(conn: &Connection, view: &mut SavedView) -> DbResult<()> {
    view.filters = normalize_saved_view_filters(view.filters.clone());
    view.sort = normalize_saved_view_sort(view.sort.clone());
    sanitize_saved_view_field_filters(conn, &view.board_id, &mut view.filters)
}

/// 读取某个看板的保存视图（内置视图在前）。
pub fn get_saved_views(conn: &Connection, board_id: &str) -> DbResult<Vec<SavedView>> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {SAVED_VIEW_COLUMNS} FROM saved_views WHERE board_id = ?1 \
             ORDER BY is_builtin DESC, created_at ASC, id ASC"
        ))
        .map_err(db_err)?;
    let rows = statement
        .query_map([board_id], row_to_saved_view)
        .map_err(db_err)?;
    let mut views = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    for view in &mut views {
        sanitize_saved_view(conn, view)?;
    }
    Ok(views)
}

/// 读取全部保存视图（快照与备份用）。
pub fn get_all_saved_views(conn: &Connection) -> DbResult<Vec<SavedView>> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {SAVED_VIEW_COLUMNS} FROM saved_views \
             ORDER BY board_id ASC, is_builtin DESC, created_at ASC, id ASC"
        ))
        .map_err(db_err)?;
    let rows = statement.query_map([], row_to_saved_view).map_err(db_err)?;
    let mut views = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    for view in &mut views {
        sanitize_saved_view(conn, view)?;
    }
    Ok(views)
}

fn get_saved_view(conn: &Connection, id: &str) -> DbResult<SavedView> {
    let mut view = conn
        .query_row(
            &format!("SELECT {SAVED_VIEW_COLUMNS} FROM saved_views WHERE id = ?1"),
            [id],
            row_to_saved_view,
        )
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| format!("保存视图不存在：{id}"))?;
    sanitize_saved_view(conn, &mut view)?;
    Ok(view)
}

/// 同一看板内视图名唯一（内置视图也占名，避免切换条里出现两个「全部」）。
fn ensure_unique_saved_view_name(
    conn: &Connection,
    board_id: &str,
    name: &str,
    exclude_id: Option<&str>,
) -> DbResult<()> {
    for view in get_saved_views(conn, board_id)? {
        if exclude_id == Some(view.id.as_str()) {
            continue;
        }
        if view.name.trim() == name {
            return Err("该看板已存在同名视图".to_string());
        }
    }
    Ok(())
}

/// 新建保存视图：字段筛选条件里的失效引用在写入前就被丢弃。
pub fn create_saved_view(conn: &mut Connection, input: NewSavedViewInput) -> DbResult<SavedView> {
    let _ = get_board(conn, &input.board_id)?;
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("请先填写视图名称".to_string());
    }
    ensure_unique_saved_view_name(conn, &input.board_id, &name, None)?;
    let mut filters = normalize_saved_view_filters(input.filters);
    sanitize_saved_view_field_filters(conn, &input.board_id, &mut filters)?;
    let sort = normalize_saved_view_sort(input.sort);
    let now = now_iso();
    let view = SavedView {
        id: create_id("sv"),
        board_id: input.board_id,
        name,
        view_type: normalize_view_type(&input.view_type),
        filters,
        sort,
        is_builtin: false,
        created_at: now.clone(),
        updated_at: now,
    };
    conn.execute(
        "INSERT INTO saved_views \
         (id, board_id, name, view_type, filters_json, sort_json, is_builtin, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)",
        params![
            &view.id,
            &view.board_id,
            &view.name,
            &view.view_type,
            saved_view_filters_to_json(&view.filters)?,
            saved_view_sort_to_json(&view.sort)?,
            &view.created_at,
            &view.updated_at,
        ],
    )
    .map_err(db_err)?;
    touch_board(conn, &view.board_id)?;
    Ok(view)
}

/// 修改保存视图：内置视图不可改。
pub fn update_saved_view(
    conn: &mut Connection,
    input: UpdateSavedViewInput,
) -> DbResult<SavedView> {
    let mut view = get_saved_view(conn, &input.id)?;
    if view.is_builtin {
        return Err("内置视图不可修改".to_string());
    }
    if let Some(name) = input.patch.name {
        let new_name = name.trim().to_string();
        if new_name.is_empty() {
            return Err("请先填写视图名称".to_string());
        }
        if new_name != view.name {
            ensure_unique_saved_view_name(conn, &view.board_id, &new_name, Some(&view.id))?;
        }
        view.name = new_name;
    }
    if let Some(view_type) = input.patch.view_type {
        view.view_type = normalize_view_type(&view_type);
    }
    if let Some(filters) = input.patch.filters {
        let mut filters = normalize_saved_view_filters(filters);
        sanitize_saved_view_field_filters(conn, &view.board_id, &mut filters)?;
        view.filters = filters;
    }
    if let Some(sort) = input.patch.sort {
        view.sort = normalize_saved_view_sort(sort);
    }
    view.updated_at = now_iso();
    conn.execute(
        "UPDATE saved_views SET name = ?1, view_type = ?2, filters_json = ?3, sort_json = ?4, \
         updated_at = ?5 WHERE id = ?6",
        params![
            &view.name,
            &view.view_type,
            saved_view_filters_to_json(&view.filters)?,
            saved_view_sort_to_json(&view.sort)?,
            &view.updated_at,
            &view.id,
        ],
    )
    .map_err(db_err)?;
    touch_board(conn, &view.board_id)?;
    Ok(view)
}

/// 删除保存视图：内置视图不可删，避免用户把自己锁死。
pub fn delete_saved_view(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let view = get_saved_view(conn, &input.id)?;
    if view.is_builtin {
        return Err("内置视图不可删除".to_string());
    }
    conn.execute("DELETE FROM saved_views WHERE id = ?1", [&input.id])
        .map_err(db_err)?;
    touch_board(conn, &view.board_id)?;
    Ok(())
}

/// 内置视图定义：id 固定，重复补齐不会产生重复行。
fn builtin_saved_view(board_id: &str, key: &str, name: &str, now: &str) -> SavedView {
    let (filters, sort) = match key {
        // 我的任务：只看未完成
        "mine" => (
            SavedViewFilters {
                status: "active".to_string(),
                ..Default::default()
            },
            SavedViewSort {
                key: "due-asc".to_string(),
                direction: "asc".to_string(),
            },
        ),
        // 最近更新：按更新时间倒序
        "recent" => (
            SavedViewFilters::default(),
            SavedViewSort {
                key: "updated-desc".to_string(),
                direction: "desc".to_string(),
            },
        ),
        _ => (
            SavedViewFilters::default(),
            SavedViewSort {
                key: "due-asc".to_string(),
                direction: "asc".to_string(),
            },
        ),
    };
    SavedView {
        id: format!("sv_builtin_{board_id}_{key}"),
        board_id: board_id.to_string(),
        name: name.to_string(),
        view_type: "board".to_string(),
        filters,
        sort,
        is_builtin: true,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    }
}

/// 给某个看板补齐内置视图（幂等）。
pub fn ensure_builtin_saved_views(conn: &Connection, board_id: &str) -> DbResult<()> {
    let now = now_iso();
    for (key, name) in BUILTIN_SAVED_VIEWS {
        let view = builtin_saved_view(board_id, key, name, &now);
        conn.execute(
            "INSERT OR IGNORE INTO saved_views \
             (id, board_id, name, view_type, filters_json, sort_json, is_builtin, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)",
            params![
                &view.id,
                &view.board_id,
                &view.name,
                &view.view_type,
                saved_view_filters_to_json(&view.filters)?,
                saved_view_sort_to_json(&view.sort)?,
                &view.created_at,
                &view.updated_at,
            ],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

/// 给所有既有看板补齐内置视图（V0.13.1 迁移用，幂等）。
pub fn backfill_builtin_saved_views(conn: &Connection) -> DbResult<()> {
    let mut statement = conn
        .prepare("SELECT id FROM boards ORDER BY created_at ASC, id ASC")
        .map_err(db_err)?;
    let board_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)?;
    for board_id in board_ids {
        ensure_builtin_saved_views(conn, &board_id)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 单元测试：内存 SQLite，覆盖核心命令、重排、级联与收件箱转换
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn memory_db() -> Connection {
        db::open_in_memory().expect("内存数据库应可初始化")
    }

    fn new_board(conn: &mut Connection, title: &str) -> Board {
        create_board(
            conn,
            NewBoardInput {
                title: title.to_string(),
                description: None,
                color: None,
            },
        )
        .expect("创建看板失败")
    }

    fn new_list(conn: &mut Connection, board_id: &str, title: &str) -> List {
        create_list(
            conn,
            NewListInput {
                board_id: board_id.to_string(),
                title: title.to_string(),
                color: None,
                wip_limit: None,
            },
        )
        .expect("创建列表失败")
    }

    fn new_card(conn: &mut Connection, board_id: &str, list_id: &str, title: &str) -> Card {
        create_card(
            conn,
            NewCardInput {
                board_id: board_id.to_string(),
                list_id: list_id.to_string(),
                title: title.to_string(),
                ..Default::default()
            },
        )
        .expect("创建任务失败")
    }

    fn id_input(id: &str) -> IdInput {
        IdInput { id: id.to_string() }
    }

    fn ordered_titles(conn: &Connection, list_id: &str) -> Vec<String> {
        let snapshot = get_snapshot(conn).expect("读取快照失败");
        let mut cards: Vec<&Card> = snapshot
            .cards
            .iter()
            .filter(|card| card.list_id == list_id)
            .collect();
        cards.sort_by_key(|card| card.position);
        cards.iter().map(|card| card.title.clone()).collect()
    }

    fn positions(conn: &Connection, list_id: &str) -> Vec<i64> {
        let snapshot = get_snapshot(conn).expect("读取快照失败");
        let mut cards: Vec<&Card> = snapshot
            .cards
            .iter()
            .filter(|card| card.list_id == list_id)
            .collect();
        cards.sort_by_key(|card| card.position);
        cards.iter().map(|card| card.position).collect()
    }

    #[test]
    fn schema_creates_all_tables() {
        let conn = memory_db();
        let mut statement = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .expect("查询表");
        let names: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .expect("读取表名")
            .collect::<rusqlite::Result<_>>()
            .expect("收集表名");
        for expected in [
            "boards",
            "lists",
            "cards",
            "inbox_items",
            "leave_records",
        ] {
            assert!(
                names.iter().any(|name| name == expected),
                "缺少表 {expected}"
            );
        }
    }

    #[test]
    fn iso_timestamp_is_utc_and_matches_frontend_shape() {
        assert_eq!(iso_from_unix(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_unix(1_700_000_000, 123),
            "2023-11-14T22:13:20.123Z"
        );
        let now = now_iso();
        assert_eq!(now.len(), 24);
        assert!(now.ends_with('Z'));
        assert_eq!(&now[4..5], "-");
    }

    #[test]
    fn create_board_applies_defaults_and_trim() {
        let mut conn = memory_db();
        let board = create_board(
            &mut conn,
            NewBoardInput {
                title: "  产品发布  ".to_string(),
                description: Some("  描述  ".to_string()),
                color: Some(BoardColor::Amber),
            },
        )
        .expect("创建看板");
        assert_eq!(board.title, "产品发布");
        assert_eq!(board.description, "描述");
        assert_eq!(board.color, BoardColor::Amber);
        assert!(!board.starred);
        assert_eq!(board.created_at, board.updated_at);

        let fallback = new_board(&mut conn, "   ");
        assert_eq!(fallback.title, "未命名看板");
        assert_eq!(fallback.description, "");
        assert_eq!(fallback.color, BoardColor::Blue);

        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.boards.len(), 2);
    }

    #[test]
    fn board_label_colors_survive_sqlite_round_trip() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let colors = HashMap::from([("研发".to_string(), BoardColor::Rose)]);
        update_board(&mut conn, UpdateBoardInput {
            id: board.id.clone(),
            patch: BoardPatch { label_colors: Some(colors.clone()), ..Default::default() },
        }).expect("更新颜色");
        assert_eq!(get_snapshot(&conn).unwrap().boards[0].label_colors, colors);
    }

    #[test]
    fn update_board_patches_fields() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "旧标题");
        let updated = update_board(
            &mut conn,
            UpdateBoardInput {
                id: board.id.clone(),
                patch: BoardPatch {
                    title: Some("新标题".to_string()),
                    starred: Some(true),
                    ..Default::default()
                },
            },
        )
        .expect("更新看板");
        assert_eq!(updated.title, "新标题");
        assert!(updated.starred);
        assert_eq!(updated.description, "");
        assert!(updated.updated_at >= board.updated_at);

        let err = update_board(
            &mut conn,
            UpdateBoardInput {
                id: "不存在".to_string(),
                patch: BoardPatch::default(),
            },
        )
        .unwrap_err();
        assert_eq!(err, "看板不存在：不存在");
    }

    #[test]
    fn list_positions_follow_and_normalise_on_delete() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let todo = new_list(&mut conn, &board.id, "待办");
        let doing = new_list(&mut conn, &board.id, "进行中");
        let blank = create_list(
            &mut conn,
            NewListInput {
                board_id: board.id.clone(),
                title: "   ".to_string(),
                color: None,
                wip_limit: None,
            },
        )
        .expect("创建列表");
        assert_eq!(blank.title, "未命名列表");
        assert_eq!((todo.position, doing.position, blank.position), (0, 1, 2));

        delete_list(&mut conn, id_input(&doing.id)).expect("删除列表");
        let snapshot = get_snapshot(&conn).expect("快照");
        let lists: Vec<&List> = snapshot
            .lists
            .iter()
            .filter(|list| list.board_id == board.id)
            .collect();
        assert_eq!(lists.len(), 2);
        assert_eq!(lists[0].position, 0);
        assert_eq!(lists[1].position, 1);
    }

    #[test]
    fn card_positions_and_patch_semantics() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let first = create_card(
            &mut conn,
            NewCardInput {
                board_id: board.id.clone(),
                list_id: list.id.clone(),
                title: "  任务一  ".to_string(),
                description: Some("  描述  ".to_string()),
                due_date: Some("2026-01-02".to_string()),
                priority: Some(Priority::High),
                ..Default::default()
            },
        )
        .expect("创建任务");
        assert_eq!(first.title, "任务一");
        assert_eq!(first.description, "描述");
        assert_eq!(first.position, 0);
        assert!(!first.completed);
        assert_eq!(first.due_date.as_deref(), Some("2026-01-02"));
        assert_eq!(first.priority, Some(Priority::High));

        let second = new_card(&mut conn, &board.id, &list.id, "任务二");
        assert_eq!(second.position, 1);

        let renamed = update_card(
            &mut conn,
            UpdateCardInput {
                id: first.id.clone(),
                patch: CardPatch {
                    title: Some("   ".to_string()),
                    ..Default::default()
                },
            },
        )
        .expect("更新任务");
        assert_eq!(renamed.title, "未命名任务");

        // 显式 null 清空截止日期与优先级（对应前端 patch.dueDate = null）。
        let cleared = update_card(
            &mut conn,
            UpdateCardInput {
                id: first.id.clone(),
                patch: CardPatch {
                    due_date: Some(None),
                    priority: Some(None),
                    completed: Some(true),
                    ..Default::default()
                },
            },
        )
        .expect("更新任务");
        assert_eq!(cleared.due_date, None);
        assert_eq!(cleared.priority, None);
        assert!(cleared.completed);

        // 字段缺失则保持原值。
        let untouched = update_card(
            &mut conn,
            UpdateCardInput {
                id: first.id.clone(),
                patch: CardPatch {
                    description: Some("新描述".to_string()),
                    ..Default::default()
                },
            },
        )
        .expect("更新任务");
        assert_eq!(untouched.description, "新描述");
        assert_eq!(untouched.due_date, None);
        assert!(untouched.completed);
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn sample_subtasks() -> Vec<Subtask> {
        vec![
            Subtask {
                id: "s_1".to_string(),
                title: "步骤一".to_string(),
                done: true,
            },
            Subtask {
                id: "s_2".to_string(),
                title: "步骤二".to_string(),
                done: false,
            },
        ]
    }

    #[test]
    fn task_minutes_round_trip_and_nullable_patches() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "board");
        let list = new_list(&mut conn, &board.id, "todo");
        let card = create_card(&mut conn, NewCardInput {
            board_id: board.id.clone(), list_id: list.id.clone(), title: "timed".into(),
            estimated_minutes: Some(90), actual_minutes: Some(45), ..Default::default()
        }).expect("create timed card");
        assert_eq!((card.estimated_minutes, card.actual_minutes), (Some(90), Some(45)));
        let updated = update_card(&mut conn, UpdateCardInput {
            id: card.id.clone(), patch: CardPatch { title: Some("renamed".into()), ..Default::default() }
        }).expect("update unrelated field");
        assert_eq!((updated.estimated_minutes, updated.actual_minutes), (Some(90), Some(45)));
        let cleared = update_card(&mut conn, UpdateCardInput {
            id: card.id.clone(), patch: CardPatch {
                estimated_minutes: Some(None), actual_minutes: Some(Some(0)), ..Default::default()
            }
        }).expect("clear estimate and set actual to zero");
        assert_eq!((cleared.estimated_minutes, cleared.actual_minutes), (None, Some(0)));
        let stored = get_snapshot(&conn).expect("snapshot").cards.into_iter()
            .find(|item| item.id == card.id).expect("card");
        assert_eq!((stored.estimated_minutes, stored.actual_minutes), (None, Some(0)));
        assert!(update_card(&mut conn, UpdateCardInput {
            id: card.id.clone(), patch: CardPatch { actual_minutes: Some(Some(-1)), ..Default::default() }
        }).is_err());
        assert_eq!(get_card(&conn, &card.id).expect("unchanged after rejected patch").actual_minutes, Some(0));
        assert!(create_card(&mut conn, NewCardInput {
            board_id: board.id, list_id: list.id, title: "invalid".into(),
            estimated_minutes: Some(-1), ..Default::default()
        }).is_err());
    }

    #[test]
    fn create_card_defaults_v02_fields() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let card = new_card(&mut conn, &board.id, &list.id, "普通任务");
        assert_eq!(card.start_date, None);
        assert_eq!(card.deleted_at, None);
        assert!(card.labels.is_empty());
        assert!(card.subtasks.is_empty());
    }

    #[test]
    fn create_card_persists_v02_fields_and_roundtrips() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let card = create_card(
            &mut conn,
            NewCardInput {
                board_id: board.id.clone(),
                list_id: list.id.clone(),
                title: "带扩展字段的任务".to_string(),
                start_date: Some("2026-02-01".to_string()),
                labels: Some(strings(&["研发", "高风险"])),
                subtasks: Some(sample_subtasks()),
                ..Default::default()
            },
        )
        .expect("创建任务");
        assert_eq!(card.start_date.as_deref(), Some("2026-02-01"));
        assert_eq!(card.labels, strings(&["研发", "高风险"]));
        assert_eq!(card.subtasks, sample_subtasks());

        // get_snapshot 的读回路径（Tauri 桌面端启动时走这里）
        let snapshot = get_snapshot(&conn).expect("快照");
        let stored = snapshot
            .cards
            .iter()
            .find(|item| item.id == card.id)
            .expect("快照里应有任务");
        assert_eq!(stored.start_date.as_deref(), Some("2026-02-01"));
        assert_eq!(stored.labels, card.labels);
        assert_eq!(stored.subtasks, card.subtasks);

        // 数据库里存的是 JSON 文本，便于后续查询/迁移
        let (labels_raw, subtasks_raw): (String, String) = conn
            .query_row(
                "SELECT labels, subtasks FROM cards WHERE id = ?1",
                [&card.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("读取原始 JSON");
        assert_eq!(labels_raw, r#"["研发","高风险"]"#);
        assert_eq!(
            subtasks_raw,
            r#"[{"id":"s_1","title":"步骤一","done":true},{"id":"s_2","title":"步骤二","done":false}]"#
        );
    }

    #[test]
    fn update_card_keeps_missing_v02_fields() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let card = create_card(
            &mut conn,
            NewCardInput {
                board_id: board.id.clone(),
                list_id: list.id.clone(),
                title: "原任务".to_string(),
                start_date: Some("2026-02-01".to_string()),
                labels: Some(strings(&["研发"])),
                subtasks: Some(sample_subtasks()),
                ..Default::default()
            },
        )
        .expect("创建任务");

        // patch 只带 title：其余新字段必须保持原值。
        let updated = update_card(
            &mut conn,
            UpdateCardInput {
                id: card.id.clone(),
                patch: CardPatch {
                    title: Some("改名任务".to_string()),
                    ..Default::default()
                },
            },
        )
        .expect("更新任务");
        assert_eq!(updated.title, "改名任务");
        assert_eq!(updated.start_date.as_deref(), Some("2026-02-01"));
        assert_eq!(updated.labels, strings(&["研发"]));
        assert_eq!(updated.subtasks, sample_subtasks());
    }

    #[test]
    fn update_card_clears_start_date_and_replaces_labels_and_subtasks() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let card = create_card(
            &mut conn,
            NewCardInput {
                board_id: board.id.clone(),
                list_id: list.id.clone(),
                title: "任务".to_string(),
                start_date: Some("2026-02-01".to_string()),
                labels: Some(strings(&["研发", "高风险"])),
                subtasks: Some(sample_subtasks()),
                ..Default::default()
            },
        )
        .expect("创建任务");

        // 显式 null 只清空 startDate，labels / subtasks 保持不变。
        let cleared = update_card(
            &mut conn,
            UpdateCardInput {
                id: card.id.clone(),
                patch: CardPatch {
                    start_date: Some(None),
                    ..Default::default()
                },
            },
        )
        .expect("清空起始日期");
        assert_eq!(cleared.start_date, None);
        assert_eq!(cleared.labels, strings(&["研发", "高风险"]));
        assert_eq!(cleared.subtasks, sample_subtasks());

        // 传数组即整体替换。
        let replaced = update_card(
            &mut conn,
            UpdateCardInput {
                id: card.id.clone(),
                patch: CardPatch {
                    labels: Some(strings(&["只有标签"])),
                    subtasks: Some(vec![Subtask {
                        id: "s_new".to_string(),
                        title: "新步骤".to_string(),
                        done: false,
                    }]),
                    ..Default::default()
                },
            },
        )
        .expect("整体替换");
        assert_eq!(replaced.labels, strings(&["只有标签"]));
        assert_eq!(
            replaced.subtasks,
            vec![Subtask {
                id: "s_new".to_string(),
                title: "新步骤".to_string(),
                done: false,
            }]
        );

        // 传空数组可整体清空。
        let emptied = update_card(
            &mut conn,
            UpdateCardInput {
                id: card.id.clone(),
                patch: CardPatch {
                    labels: Some(Vec::new()),
                    subtasks: Some(Vec::new()),
                    ..Default::default()
                },
            },
        )
        .expect("清空数组");
        assert!(emptied.labels.is_empty());
        assert!(emptied.subtasks.is_empty());
        // 清空后从数据库重新读取仍为空，而不是回退旧值。
        let reloaded = get_card(&conn, &card.id).expect("任务");
        assert!(reloaded.labels.is_empty());
        assert!(reloaded.subtasks.is_empty());
    }

    #[test]
    fn move_card_preserves_v02_fields() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let todo = new_list(&mut conn, &board.id, "待办");
        let doing = new_list(&mut conn, &board.id, "进行中");
        let card = create_card(
            &mut conn,
            NewCardInput {
                board_id: board.id.clone(),
                list_id: todo.id.clone(),
                title: "要移动的任务".to_string(),
                start_date: Some("2026-03-01".to_string()),
                labels: Some(strings(&["研发"])),
                subtasks: Some(sample_subtasks()),
                ..Default::default()
            },
        )
        .expect("创建任务");

        let moved = move_card(
            &mut conn,
            MoveCardInput {
                card_id: card.id.clone(),
                to_list_id: doing.id.clone(),
                to_index: 0,
            },
        )
        .expect("移动任务");
        assert_eq!(moved.list_id, doing.id);
        assert_eq!(moved.start_date.as_deref(), Some("2026-03-01"));
        assert_eq!(moved.labels, strings(&["研发"]));
        assert_eq!(moved.subtasks, sample_subtasks());

        let reloaded = get_card(&conn, &card.id).expect("任务");
        assert_eq!(reloaded.labels, strings(&["研发"]));
        assert_eq!(reloaded.subtasks, sample_subtasks());
        assert_eq!(reloaded.start_date.as_deref(), Some("2026-03-01"));
    }

    #[test]
    fn invalid_stored_json_falls_back_to_empty_collections() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let card = new_card(&mut conn, &board.id, &list.id, "脏数据任务");
        conn.execute(
            "UPDATE cards SET labels = '不是 JSON', subtasks = '{\"not\":\"array\"}' WHERE id = ?1",
            [&card.id],
        )
        .expect("写入脏数据");

        let reloaded = get_card(&conn, &card.id).expect("读取脏数据任务");
        assert!(reloaded.labels.is_empty());
        assert!(reloaded.subtasks.is_empty());
        assert_eq!(get_snapshot(&conn).expect("快照").cards.len(), 1);
    }

    #[test]
    fn update_card_moves_list_and_appends_at_end() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let todo = new_list(&mut conn, &board.id, "待办");
        let doing = new_list(&mut conn, &board.id, "进行中");
        let a = new_card(&mut conn, &board.id, &todo.id, "A");
        let b = new_card(&mut conn, &board.id, &todo.id, "B");
        let c = new_card(&mut conn, &board.id, &doing.id, "C");

        let moved = update_card(
            &mut conn,
            UpdateCardInput {
                id: a.id.clone(),
                patch: CardPatch {
                    list_id: Some(doing.id.clone()),
                    ..Default::default()
                },
            },
        )
        .expect("移动列表");
        assert_eq!(moved.list_id, doing.id);
        assert_eq!(moved.position, 1);
        assert_eq!(ordered_titles(&conn, &todo.id), vec!["B"]);
        assert_eq!(ordered_titles(&conn, &doing.id), vec!["C", "A"]);
        assert_eq!(positions(&conn, &todo.id), vec![0]);
        assert_eq!(card_in_position(&conn, &b.id), 0);
        let _ = c;
    }

    fn card_in_position(conn: &Connection, id: &str) -> i64 {
        get_card(conn, id).expect("任务应存在").position
    }

    #[test]
    fn update_card_rejects_cross_board_move() {
        let mut conn = memory_db();
        let board_a = new_board(&mut conn, "看板 A");
        let board_b = new_board(&mut conn, "看板 B");
        let list_a = new_list(&mut conn, &board_a.id, "待办");
        let list_b = new_list(&mut conn, &board_b.id, "待办");
        let card = new_card(&mut conn, &board_a.id, &list_a.id, "任务");

        let err = update_card(
            &mut conn,
            UpdateCardInput {
                id: card.id.clone(),
                patch: CardPatch {
                    list_id: Some(list_b.id.clone()),
                    ..Default::default()
                },
            },
        )
        .unwrap_err();
        assert_eq!(err, "不能跨看板移动任务");
        assert_eq!(get_card(&conn, &card.id).expect("任务").list_id, list_a.id);
    }

    #[test]
    fn move_card_reorders_within_list_and_clamps_index() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let _a = new_card(&mut conn, &board.id, &list.id, "A");
        let _b = new_card(&mut conn, &board.id, &list.id, "B");
        let c = new_card(&mut conn, &board.id, &list.id, "C");

        move_card(
            &mut conn,
            MoveCardInput {
                card_id: c.id.clone(),
                to_list_id: list.id.clone(),
                to_index: 0,
            },
        )
        .expect("移动到最前");
        assert_eq!(ordered_titles(&conn, &list.id), vec!["C", "A", "B"]);

        move_card(
            &mut conn,
            MoveCardInput {
                card_id: c.id.clone(),
                to_list_id: list.id.clone(),
                to_index: 99,
            },
        )
        .expect("越界收敛到末尾");
        assert_eq!(ordered_titles(&conn, &list.id), vec!["A", "B", "C"]);

        move_card(
            &mut conn,
            MoveCardInput {
                card_id: c.id.clone(),
                to_list_id: list.id.clone(),
                to_index: -5,
            },
        )
        .expect("负数收敛到 0");
        assert_eq!(ordered_titles(&conn, &list.id), vec!["C", "A", "B"]);
        assert_eq!(positions(&conn, &list.id), vec![0, 1, 2]);
        assert_eq!(card_in_position(&conn, &c.id), 0);
    }

    #[test]
    fn move_card_across_lists_renormalises_both_lists() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let todo = new_list(&mut conn, &board.id, "待办");
        let doing = new_list(&mut conn, &board.id, "进行中");
        let a = new_card(&mut conn, &board.id, &todo.id, "A");
        let b = new_card(&mut conn, &board.id, &todo.id, "B");
        let c = new_card(&mut conn, &board.id, &doing.id, "C");

        move_card(
            &mut conn,
            MoveCardInput {
                card_id: a.id.clone(),
                to_list_id: doing.id.clone(),
                to_index: 0,
            },
        )
        .expect("跨列表移动");

        let moved = get_card(&conn, &a.id).expect("任务");
        assert_eq!(moved.list_id, doing.id);
        assert_eq!(moved.position, 0);
        assert_eq!(ordered_titles(&conn, &todo.id), vec!["B"]);
        assert_eq!(ordered_titles(&conn, &doing.id), vec!["A", "C"]);
        assert_eq!(positions(&conn, &todo.id), vec![0]);
        assert_eq!(card_in_position(&conn, &b.id), 0);
        assert_eq!(card_in_position(&conn, &c.id), 1);
        let _ = c;
    }

    #[test]
    fn move_card_rejects_cross_board_move() {
        let mut conn = memory_db();
        let board_a = new_board(&mut conn, "看板 A");
        let board_b = new_board(&mut conn, "看板 B");
        let list_a = new_list(&mut conn, &board_a.id, "待办");
        let list_b = new_list(&mut conn, &board_b.id, "待办");
        let card = new_card(&mut conn, &board_a.id, &list_a.id, "任务");

        let err = move_card(
            &mut conn,
            MoveCardInput {
                card_id: card.id.clone(),
                to_list_id: list_b.id.clone(),
                to_index: 0,
            },
        )
        .unwrap_err();
        assert_eq!(err, "不能跨看板移动任务");
        assert_eq!(get_card(&conn, &card.id).expect("任务").list_id, list_a.id);

        let missing = move_card(
            &mut conn,
            MoveCardInput {
                card_id: "不存在".to_string(),
                to_list_id: list_a.id.clone(),
                to_index: 0,
            },
        )
        .unwrap_err();
        assert_eq!(missing, "任务不存在：不存在");
    }

    #[test]
    fn delete_card_normalises_position_gaps() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let a = new_card(&mut conn, &board.id, &list.id, "A");
        let b = new_card(&mut conn, &board.id, &list.id, "B");
        let c = new_card(&mut conn, &board.id, &list.id, "C");
        conn.execute("UPDATE cards SET position = 5 WHERE id = ?1", [&b.id])
            .expect("制造 position 空洞");
        conn.execute("UPDATE cards SET position = 9 WHERE id = ?1", [&c.id])
            .expect("制造 position 空洞");

        delete_card(&mut conn, id_input(&b.id)).expect("删除任务");
        // 软删除后活动卡片重新压成 0..n，回收站行不参与。
        assert_eq!(ordered_titles(&conn, &list.id), vec!["A", "C"]);
        assert_eq!(positions(&conn, &list.id), vec![0, 1]);
        assert_eq!(raw_card_count(&conn), 3);
        let trashed = get_trash(&conn).expect("回收站");
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].id, b.id);
        assert_eq!(trashed[0].position, 5);
        assert!(trashed[0].deleted_at.is_some());
        let _ = (a, c);
    }

    #[test]
    fn delete_list_cascades_cards() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let todo = new_list(&mut conn, &board.id, "待办");
        let doing = new_list(&mut conn, &board.id, "进行中");
        let card_todo = new_card(&mut conn, &board.id, &todo.id, "待办任务");
        let card_doing = new_card(&mut conn, &board.id, &doing.id, "进行中任务");

        delete_list(&mut conn, id_input(&todo.id)).expect("删除列表");
        let snapshot = get_snapshot(&conn).expect("快照");
        assert!(snapshot.lists.iter().all(|list| list.id != todo.id));
        assert!(snapshot.cards.iter().all(|card| card.id != card_todo.id));
        assert!(snapshot.cards.iter().any(|card| card.id == card_doing.id));
        assert_eq!(
            snapshot
                .lists
                .iter()
                .find(|list| list.id == doing.id)
                .expect("列表应存在")
                .position,
            0
        );
    }

    #[test]
    fn delete_board_cascades_lists_and_cards() {
        let mut conn = memory_db();
        let board_a = new_board(&mut conn, "看板 A");
        let board_b = new_board(&mut conn, "看板 B");
        let list_a = new_list(&mut conn, &board_a.id, "待办");
        let list_b = new_list(&mut conn, &board_b.id, "待办");
        let card_a = new_card(&mut conn, &board_a.id, &list_a.id, "任务 A");
        let card_b = new_card(&mut conn, &board_b.id, &list_b.id, "任务 B");

        delete_board(&mut conn, id_input(&board_a.id)).expect("删除看板");
        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.boards.len(), 1);
        assert_eq!(snapshot.boards[0].id, board_b.id);
        assert!(snapshot.lists.iter().all(|list| list.id != list_a.id));
        assert!(snapshot.cards.iter().all(|card| card.id != card_a.id));
        assert!(snapshot.cards.iter().any(|card| card.id == card_b.id));

        // 删除不存在的看板不报错（对齐 localApi 的 filter 语义）。
        delete_board(&mut conn, id_input("不存在的看板")).expect("静默成功");
    }

    #[test]
    fn convert_inbox_item_creates_card_in_first_list() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let todo = new_list(&mut conn, &board.id, "待办");
        let _doing = new_list(&mut conn, &board.id, "进行中");
        let item = add_inbox_item(
            &mut conn,
            AddInboxInput {
                content: "  第一行标题\n第二行内容  ".to_string(),
            },
        )
        .expect("添加收件箱");
        assert_eq!(item.content, "第一行标题\n第二行内容");

        let card = convert_inbox_item(
            &mut conn,
            ConvertInboxInput {
                id: item.id.clone(),
                board_id: board.id.clone(),
                list_id: None,
            },
        )
        .expect("转换收件箱");
        assert_eq!(card.title, "第一行标题");
        assert_eq!(card.description, "第一行标题\n第二行内容");
        assert_eq!(card.list_id, todo.id);
        assert_eq!(card.position, 0);
        assert_eq!(card.board_id, board.id);
        assert_eq!(card.due_date, None);
        assert_eq!(card.start_date, None);
        assert_eq!(card.priority, None);
        assert!(!card.completed);
        assert_eq!(card.deleted_at, None);
        assert!(card.labels.is_empty());
        assert!(card.subtasks.is_empty());
        assert!(get_snapshot(&conn).expect("快照").inbox.is_empty());
    }

    #[test]
    fn convert_inbox_item_explicit_list_and_single_line() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let _todo = new_list(&mut conn, &board.id, "待办");
        let doing = new_list(&mut conn, &board.id, "进行中");
        let item = add_inbox_item(
            &mut conn,
            AddInboxInput {
                content: "只有一行".to_string(),
            },
        )
        .expect("添加收件箱");
        let card = convert_inbox_item(
            &mut conn,
            ConvertInboxInput {
                id: item.id,
                board_id: board.id.clone(),
                list_id: Some(doing.id.clone()),
            },
        )
        .expect("转换收件箱");
        assert_eq!(card.list_id, doing.id);
        assert_eq!(card.title, "只有一行");
        assert_eq!(card.description, "");
    }

    #[test]
    fn convert_inbox_item_errors_without_list_or_item() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "空看板");
        let item = add_inbox_item(
            &mut conn,
            AddInboxInput {
                content: "标题".to_string(),
            },
        )
        .expect("添加收件箱");

        let err = convert_inbox_item(
            &mut conn,
            ConvertInboxInput {
                id: item.id.clone(),
                board_id: board.id.clone(),
                list_id: None,
            },
        )
        .unwrap_err();
        assert_eq!(err, "看板还没有列表，请先添加列表");
        // 失败后条目仍在（事务回滚）。
        assert_eq!(get_snapshot(&conn).expect("快照").inbox.len(), 1);

        new_list(&mut conn, &board.id, "待办");
        let err = convert_inbox_item(
            &mut conn,
            ConvertInboxInput {
                id: item.id.clone(),
                board_id: board.id.clone(),
                list_id: Some("不存在的列表".to_string()),
            },
        )
        .unwrap_err();
        assert_eq!(err, "列表不存在：不存在的列表");

        let err = convert_inbox_item(
            &mut conn,
            ConvertInboxInput {
                id: "不存在".to_string(),
                board_id: board.id.clone(),
                list_id: None,
            },
        )
        .unwrap_err();
        assert_eq!(err, "收件箱条目不存在");

        let err = convert_inbox_item(
            &mut conn,
            ConvertInboxInput {
                id: item.id,
                board_id: "不存在的看板".to_string(),
                list_id: None,
            },
        )
        .unwrap_err();
        assert_eq!(err, "看板不存在：不存在的看板");
    }

    #[test]
    fn convert_inbox_item_truncates_title_to_80_chars() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        new_list(&mut conn, &board.id, "待办");
        let item = add_inbox_item(
            &mut conn,
            AddInboxInput {
                content: "潮".repeat(120),
            },
        )
        .expect("添加收件箱");
        let card = convert_inbox_item(
            &mut conn,
            ConvertInboxInput {
                id: item.id,
                board_id: board.id.clone(),
                list_id: None,
            },
        )
        .expect("转换收件箱");
        assert_eq!(card.title.chars().count(), 80);
        assert_eq!(card.description, "");
    }

    // -----------------------------------------------------------------
    // V0.3 回收站（软删除）
    // -----------------------------------------------------------------

    fn raw_card_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .expect("统计卡片行数")
    }

    fn create_extended_card(
        conn: &mut Connection,
        board_id: &str,
        list_id: &str,
        title: &str,
    ) -> Card {
        create_card(
            conn,
            NewCardInput {
                board_id: board_id.to_string(),
                list_id: list_id.to_string(),
                title: title.to_string(),
                start_date: Some("2026-04-01".to_string()),
                labels: Some(strings(&["研发"])),
                subtasks: Some(sample_subtasks()),
                ..Default::default()
            },
        )
        .expect("创建扩展任务")
    }

    #[test]
    fn soft_delete_hides_card_from_snapshot_and_lists_in_trash() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let card = create_extended_card(&mut conn, &board.id, &list.id, "待删除任务");

        delete_card(&mut conn, id_input(&card.id)).expect("软删除任务");

        // get_snapshot 不再返回该卡片。
        assert!(get_snapshot(&conn)
            .expect("快照")
            .cards
            .iter()
            .all(|item| item.id != card.id));

        // 物理行保留，deleted_at / updated_at 同步写入。
        assert_eq!(raw_card_count(&conn), 1);
        let stored = get_card(&conn, &card.id).expect("回收站任务应还在");
        assert!(stored.deleted_at.is_some());
        assert_eq!(stored.deleted_at, Some(stored.updated_at.clone()));

        // get_trash 返回完整字段（含 V0.2 扩展字段）。
        let trash = get_trash(&conn).expect("读取回收站");
        assert_eq!(trash.len(), 1);
        let trashed = &trash[0];
        assert_eq!(trashed.id, card.id);
        assert_eq!(trashed.board_id, board.id);
        assert_eq!(trashed.list_id, list.id);
        assert_eq!(trashed.title, "待删除任务");
        assert_eq!(trashed.start_date.as_deref(), Some("2026-04-01"));
        assert_eq!(trashed.labels, strings(&["研发"]));
        assert_eq!(trashed.subtasks, sample_subtasks());

        // 重复删除是无操作：deleted_at 保持不变。
        delete_card(&mut conn, id_input(&card.id)).expect("重复删除");
        assert_eq!(
            get_card(&conn, &card.id).expect("任务").deleted_at,
            stored.deleted_at
        );
    }

    #[test]
    fn delete_card_renormalises_active_positions_but_keeps_trash_row() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let a = new_card(&mut conn, &board.id, &list.id, "A");
        let b = new_card(&mut conn, &board.id, &list.id, "B");
        let c = new_card(&mut conn, &board.id, &list.id, "C");

        delete_card(&mut conn, id_input(&b.id)).expect("软删除 B");
        assert_eq!(ordered_titles(&conn, &list.id), vec!["A", "C"]);
        assert_eq!(positions(&conn, &list.id), vec![0, 1]);
        assert_eq!(get_card(&conn, &a.id).expect("A").position, 0);
        assert_eq!(get_card(&conn, &c.id).expect("C").position, 1);
        // 回收站里的行保留原 position，不参与活动列表归一化。
        assert_eq!(get_card(&conn, &b.id).expect("B").position, 1);
    }

    #[test]
    fn get_trash_orders_by_deleted_at_desc() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let a = new_card(&mut conn, &board.id, &list.id, "A");
        let b = new_card(&mut conn, &board.id, &list.id, "B");
        let c = new_card(&mut conn, &board.id, &list.id, "C");

        delete_card(&mut conn, id_input(&c.id)).expect("删除 C");
        std::thread::sleep(std::time::Duration::from_millis(3));
        delete_card(&mut conn, id_input(&a.id)).expect("删除 A");

        let trash = get_trash(&conn).expect("回收站");
        let titles: Vec<String> = trash.iter().map(|card| card.title.clone()).collect();
        assert_eq!(titles, vec!["A", "C"]);
        assert!(b.deleted_at.is_none());
    }

    #[test]
    fn restore_card_appends_to_original_list_end() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let _a = new_card(&mut conn, &board.id, &list.id, "A");
        let _b = new_card(&mut conn, &board.id, &list.id, "B");
        let c = create_extended_card(&mut conn, &board.id, &list.id, "C");

        delete_card(&mut conn, id_input(&c.id)).expect("软删除 C");
        assert_eq!(ordered_titles(&conn, &list.id), vec!["A", "B"]);

        let restored = restore_card(&mut conn, id_input(&c.id)).expect("恢复任务");
        assert_eq!(restored.deleted_at, None);
        assert_eq!(restored.position, 2);
        assert_eq!(restored.labels, strings(&["研发"]));
        assert_eq!(restored.start_date.as_deref(), Some("2026-04-01"));
        assert_eq!(restored.subtasks, sample_subtasks());
        assert_eq!(ordered_titles(&conn, &list.id), vec!["A", "B", "C"]);
        assert_eq!(positions(&conn, &list.id), vec![0, 1, 2]);
        assert!(get_trash(&conn).expect("回收站").is_empty());

        // 对不在回收站里的任务再次恢复：幂等返回原卡片。
        let again = restore_card(&mut conn, id_input(&c.id)).expect("重复恢复");
        assert_eq!(again.id, c.id);
        assert_eq!(again.deleted_at, None);
    }

    #[test]
    fn restore_card_errors_when_original_list_is_gone() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let card = new_card(&mut conn, &board.id, &list.id, "孤儿任务");
        delete_card(&mut conn, id_input(&card.id)).expect("软删除");

        // 人为制造孤儿行（正常外键级联不会出现）：关闭外键后删列表。
        conn.execute_batch("PRAGMA foreign_keys = OFF;")
            .expect("关闭外键");
        conn.execute("DELETE FROM lists WHERE id = ?1", [&list.id])
            .expect("删除列表");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("恢复外键");

        let err = restore_card(&mut conn, id_input(&card.id)).unwrap_err();
        assert_eq!(err, "原列表已删除，无法恢复");
        // 失败后任务仍在回收站里。
        assert!(get_card(&conn, &card.id)
            .expect("任务")
            .deleted_at
            .is_some());
        assert_eq!(get_trash(&conn).expect("回收站").len(), 1);
    }

    #[test]
    fn purge_card_physically_removes_only_target() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let a = new_card(&mut conn, &board.id, &list.id, "A");
        let b = new_card(&mut conn, &board.id, &list.id, "B");
        delete_card(&mut conn, id_input(&a.id)).expect("软删除 A");
        assert_eq!(raw_card_count(&conn), 2);

        purge_card(&mut conn, id_input(&a.id)).expect("彻底删除 A");
        assert_eq!(raw_card_count(&conn), 1);
        assert!(get_trash(&conn).expect("回收站").is_empty());
        assert_eq!(ordered_titles(&conn, &list.id), vec!["B"]);
        assert_eq!(get_card(&conn, &b.id).expect("B").deleted_at, None);

        // 不存在的 id 静默成功。
        purge_card(&mut conn, id_input("不存在")).expect("静默成功");
    }

    #[test]
    fn empty_trash_removes_only_deleted_cards() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let a = new_card(&mut conn, &board.id, &list.id, "A");
        let b = new_card(&mut conn, &board.id, &list.id, "B");
        let c = new_card(&mut conn, &board.id, &list.id, "C");
        delete_card(&mut conn, id_input(&a.id)).expect("软删除 A");
        delete_card(&mut conn, id_input(&c.id)).expect("软删除 C");

        empty_trash(&mut conn).expect("清空回收站");
        assert_eq!(raw_card_count(&conn), 1);
        assert!(get_trash(&conn).expect("回收站").is_empty());
        assert_eq!(ordered_titles(&conn, &list.id), vec!["B"]);
        assert_eq!(get_card(&conn, &b.id).expect("B").deleted_at, None);
        assert_eq!(positions(&conn, &list.id), vec![0]);
        // 再次清空空回收站不报错。
        empty_trash(&mut conn).expect("空回收站再次清空");
    }

    #[test]
    fn delete_list_cascades_trashed_cards() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let todo = new_list(&mut conn, &board.id, "待办");
        let doing = new_list(&mut conn, &board.id, "进行中");
        let active = new_card(&mut conn, &board.id, &todo.id, "活动任务");
        let trashed = new_card(&mut conn, &board.id, &todo.id, "回收站任务");
        delete_card(&mut conn, id_input(&trashed.id)).expect("软删除");
        assert_eq!(raw_card_count(&conn), 2);

        delete_list(&mut conn, id_input(&todo.id)).expect("删除列表");
        // 活动卡片与回收站卡片都被外键级联物理删除。
        assert_eq!(raw_card_count(&conn), 0);
        assert!(get_trash(&conn).expect("回收站").is_empty());
        assert!(get_snapshot(&conn).expect("快照").cards.is_empty());
        assert_eq!(get_list(&conn, &doing.id).expect("列表").position, 0);
        let _ = active;
    }

    #[test]
    fn move_card_ignores_trashed_cards() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let _a = new_card(&mut conn, &board.id, &list.id, "A");
        let b = new_card(&mut conn, &board.id, &list.id, "B");
        let c = new_card(&mut conn, &board.id, &list.id, "C");
        delete_card(&mut conn, id_input(&b.id)).expect("软删除 B");
        assert_eq!(ordered_titles(&conn, &list.id), vec!["A", "C"]);

        let moved = move_card(
            &mut conn,
            MoveCardInput {
                card_id: c.id.clone(),
                to_list_id: list.id.clone(),
                to_index: 0,
            },
        )
        .expect("移动 C");
        assert_eq!(moved.deleted_at, None);
        assert_eq!(ordered_titles(&conn, &list.id), vec!["C", "A"]);
        assert_eq!(positions(&conn, &list.id), vec![0, 1]);
        let trash = get_trash(&conn).expect("回收站");
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, b.id);
    }

    #[test]
    fn active_card_commands_keep_deleted_at_null() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let todo = new_list(&mut conn, &board.id, "待办");
        let doing = new_list(&mut conn, &board.id, "进行中");
        let card = new_card(&mut conn, &board.id, &todo.id, "任务");
        assert_eq!(card.deleted_at, None);

        let updated = update_card(
            &mut conn,
            UpdateCardInput {
                id: card.id.clone(),
                patch: CardPatch {
                    title: Some("改名任务".to_string()),
                    ..Default::default()
                },
            },
        )
        .expect("更新任务");
        assert_eq!(updated.deleted_at, None);

        let moved = move_card(
            &mut conn,
            MoveCardInput {
                card_id: card.id.clone(),
                to_list_id: doing.id.clone(),
                to_index: 0,
            },
        )
        .expect("移动任务");
        assert_eq!(moved.deleted_at, None);
        assert_eq!(get_card(&conn, &card.id).expect("任务").deleted_at, None);
    }

    #[test]
    fn update_card_on_trashed_card_preserves_deleted_at() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let card = new_card(&mut conn, &board.id, &list.id, "回收站任务");
        delete_card(&mut conn, id_input(&card.id)).expect("软删除");
        let deleted_at = get_card(&conn, &card.id).expect("任务").deleted_at;

        let updated = update_card(
            &mut conn,
            UpdateCardInput {
                id: card.id.clone(),
                patch: CardPatch {
                    title: Some("回收站里改名".to_string()),
                    ..Default::default()
                },
            },
        )
        .expect("更新回收站任务");
        assert_eq!(updated.title, "回收站里改名");
        // 更新不会把任务从回收站里“救回来”，deleted_at 保持原值。
        assert_eq!(updated.deleted_at, deleted_at);
        assert!(get_snapshot(&conn)
            .expect("快照")
            .cards
            .iter()
            .all(|item| item.id != card.id));
        assert_eq!(get_trash(&conn).expect("回收站")[0].title, "回收站里改名");
    }

    #[test]
    fn inbox_items_are_listed_newest_first() {
        let mut conn = memory_db();
        add_inbox_item(
            &mut conn,
            AddInboxInput {
                content: "旧条目".to_string(),
            },
        )
        .expect("添加收件箱");
        std::thread::sleep(std::time::Duration::from_millis(3));
        add_inbox_item(
            &mut conn,
            AddInboxInput {
                content: "新条目".to_string(),
            },
        )
        .expect("添加收件箱");
        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.inbox.len(), 2);
        assert_eq!(snapshot.inbox[0].content, "新条目");
        assert_eq!(snapshot.inbox[1].content, "旧条目");

        delete_inbox_item(&mut conn, id_input(&snapshot.inbox[0].id)).expect("删除收件箱");
        assert_eq!(get_snapshot(&conn).expect("快照").inbox.len(), 1);
    }

    #[test]
    fn dependencies_persist_and_are_cleaned_on_soft_delete() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "依赖看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let a = new_card(&mut conn, &board.id, &list.id, "A");
        let b = new_card(&mut conn, &board.id, &list.id, "B");
        let c = new_card(&mut conn, &board.id, &list.id, "C");

        let saved = set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: c.id.clone(),
                depends_on: vec![a.id.clone(), b.id.clone()],
                relation_types: Vec::new(),
            },
        )
        .expect("设置依赖");
        assert_eq!(saved.len(), 2);

        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.dependencies.len(), 2);
        assert!(snapshot
            .dependencies
            .iter()
            .all(|dependency| dependency.card_id == c.id));

        // 整体替换为空。
        set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: c.id.clone(),
                depends_on: Vec::new(),
                relation_types: Vec::new(),
            },
        )
        .expect("清空依赖");
        assert!(get_dependencies(&conn).expect("依赖").is_empty());

        // 软删除前置任务 A：指向 A 的边被清理，避免任务被回收站任务阻塞。
        set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: c.id.clone(),
                depends_on: vec![a.id.clone()],
                relation_types: Vec::new(),
            },
        )
        .expect("重新设置依赖");
        delete_card(&mut conn, id_input(&a.id)).expect("删除前置任务");
        let snapshot = get_snapshot(&conn).expect("快照");
        assert!(snapshot.dependencies.is_empty());
        assert!(snapshot.cards.iter().any(|card| card.id == c.id));
    }

    #[test]
    fn dependencies_reject_cross_board_self_and_cycles() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板一");
        let list = new_list(&mut conn, &board.id, "待办");
        let a = new_card(&mut conn, &board.id, &list.id, "A");
        let b = new_card(&mut conn, &board.id, &list.id, "B");
        let other_board = new_board(&mut conn, "看板二");
        let other_list = new_list(&mut conn, &other_board.id, "待办");
        let other = new_card(&mut conn, &other_board.id, &other_list.id, "跨板任务");

        let err = set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: a.id.clone(),
                depends_on: vec![a.id.clone()],
                relation_types: Vec::new(),
            },
        )
        .expect_err("不能依赖自己");
        assert!(err.contains("自己"), "错误：{err}");

        // V0.12：跨看板关系已放开，不再报错。
        let saved = set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: a.id.clone(),
                depends_on: vec![other.id.clone()],
                relation_types: Vec::new(),
            },
        )
        .expect("允许跨看板关系");
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].relation_type, RelationType::Blocks);
        set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: a.id.clone(),
                depends_on: Vec::new(),
                relation_types: Vec::new(),
            },
        )
        .expect("清空关系");

        let err = set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: a.id.clone(),
                depends_on: vec!["c_missing".to_string()],
                relation_types: Vec::new(),
            },
        )
        .expect_err("不能依赖不存在任务");
        assert!(err.contains("不存在"), "错误：{err}");

        // B 依赖 A 合法；A 再依赖 B 形成环，应被拒绝。
        set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: b.id.clone(),
                depends_on: vec![a.id.clone()],
                relation_types: Vec::new(),
            },
        )
        .expect("B 依赖 A");
        let err = set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: a.id.clone(),
                depends_on: vec![b.id.clone()],
                relation_types: Vec::new(),
            },
        )
        .expect_err("循环依赖");
        assert!(err.contains("循环"), "错误：{err}");
    }

    #[test]
    fn relation_types_persist_and_only_blocks_detect_cycles() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "关系看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let a = new_card(&mut conn, &board.id, &list.id, "A");
        let b = new_card(&mut conn, &board.id, &list.id, "B");
        let c = new_card(&mut conn, &board.id, &list.id, "C");

        // A 与 B 互为 relates：这类关系不构成阻塞链，不应触发循环检测。
        set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: a.id.clone(),
                depends_on: vec![b.id.clone()],
                relation_types: vec![RelationType::Relates],
            },
        )
        .expect("A 关联 B");
        set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: b.id.clone(),
                depends_on: vec![a.id.clone()],
                relation_types: vec![RelationType::Relates],
            },
        )
        .expect("B 关联 A");

        let dependencies = get_dependencies(&conn).expect("关系");
        assert_eq!(dependencies.len(), 2);
        assert!(dependencies
            .iter()
            .all(|dependency| dependency.relation_type == RelationType::Relates));

        // blocks 类型仍然要检测循环。
        let saved = set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: a.id.clone(),
                depends_on: vec![c.id.clone()],
                relation_types: vec![RelationType::Blocks],
            },
        )
        .expect("A 前置 C");
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].relation_type, RelationType::Blocks);
        let err = set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: c.id.clone(),
                depends_on: vec![a.id.clone()],
                relation_types: vec![RelationType::Blocks],
            },
        )
        .expect_err("blocks 应检测出循环");
        assert!(err.contains("循环"), "错误：{err}");

        // 缺少类型时按 blocks 处理：换一个无环的目标验证缺省行为。
        set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: c.id.clone(),
                depends_on: vec![b.id.clone()],
                relation_types: Vec::new(),
            },
        )
        .expect("缺省类型按 blocks");
        let dependencies = get_dependencies(&conn).expect("关系");
        assert!(dependencies
            .iter()
            .filter(|dependency| dependency.card_id == c.id)
            .all(|dependency| dependency.relation_type == RelationType::Blocks));
    }

    #[test]
    fn board_sets_create_update_delete_and_board_membership() {
        let mut conn = memory_db();
        let first = new_board(&mut conn, "看板一");
        let second = new_board(&mut conn, "看板二");

        let created = create_board_set(
            &mut conn,
            NewBoardSetInput {
                title: "  产品总览  ".to_string(),
                description: Some("跨看板".to_string()),
                board_ids: vec![second.id.clone(), first.id.clone(), second.id.clone()],
            },
        )
        .expect("创建看板集");
        assert_eq!(created.title, "产品总览");
        assert_eq!(created.board_ids, vec![second.id.clone(), first.id.clone()]);
        assert_eq!(get_board_sets(&conn).expect("看板集").len(), 1);

        let updated = update_board_set(
            &mut conn,
            UpdateBoardSetInput {
                id: created.id.clone(),
                patch: BoardSetPatch {
                    title: Some("新标题".to_string()),
                    description: Some("新描述".to_string()),
                    board_ids: Some(vec![first.id.clone()]),
                },
            },
        )
        .expect("更新看板集");
        assert_eq!(updated.title, "新标题");
        assert_eq!(updated.description, "新描述");
        assert_eq!(updated.board_ids, vec![first.id.clone()]);

        // 删除成员看板时，看板集保留但成员被级联移除。
        delete_board(&mut conn, id_input(&first.id)).expect("删除看板");
        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.board_sets.len(), 1);
        assert!(snapshot.board_sets[0].board_ids.is_empty());

        delete_board_set(&mut conn, id_input(&created.id)).expect("删除看板集");
        assert!(get_board_sets(&conn).expect("看板集").is_empty());
    }

    #[test]
    fn board_sets_reject_unknown_board() {
        let mut conn = memory_db();
        let err = create_board_set(
            &mut conn,
            NewBoardSetInput {
                title: "坏集".to_string(),
                description: None,
                board_ids: vec!["b_missing".to_string()],
            },
        )
        .expect_err("不存在的看板应拒绝");
        assert!(err.contains("不存在"), "错误：{err}");
    }

    #[test]
    fn goal_tree_cards_and_status_update() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "目标看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let card = new_card(&mut conn, &board.id, &list.id, "关联任务");

        let parent = create_goal(
            &mut conn,
            NewGoalInput {
                title: "年度目标".to_string(),
                description: Some("公司级".to_string()),
                scope: Some(GoalScope::Company),
                status: None,
                start_date: None,
                due_date: None,
                manual_progress: Some(20),
                parent_id: None,
                card_ids: None,
            },
        )
        .expect("创建父目标");
        let child = create_goal(
            &mut conn,
            NewGoalInput {
                title: "子目标".to_string(),
                description: None,
                scope: Some(GoalScope::Personal),
                status: None,
                start_date: None,
                due_date: None,
                manual_progress: None,
                parent_id: Some(parent.id.clone()),
                card_ids: Some(vec![card.id.clone()]),
            },
        )
        .expect("创建子目标");
        assert_eq!(child.parent_id, Some(parent.id.clone()));
        assert_eq!(child.card_ids, vec![card.id.clone()]);
        assert_eq!(get_goals(&conn).expect("目标列表").len(), 2);

        let updated = update_goal(
            &mut conn,
            UpdateGoalInput {
                id: parent.id.clone(),
                patch: GoalPatch {
                    status: Some(GoalStatus::Completed),
                    manual_progress: Some(150),
                    ..Default::default()
                },
            },
        )
        .expect("更新目标");
        assert_eq!(updated.status, GoalStatus::Completed);
        assert_eq!(updated.manual_progress, 100);

        delete_goal(&mut conn, id_input(&parent.id)).expect("删除父目标");
        let goals = get_goals(&conn).expect("目标列表");
        assert_eq!(goals.len(), 1);
        assert_eq!(goals[0].parent_id, None);
    }

    #[test]
    fn goal_parent_cycle_is_rejected() {
        let mut conn = memory_db();
        let parent = create_goal(
            &mut conn,
            NewGoalInput {
                title: "父".to_string(),
                description: None,
                scope: None,
                status: None,
                start_date: None,
                due_date: None,
                manual_progress: None,
                parent_id: None,
                card_ids: None,
            },
        )
        .expect("创建父目标");
        let child = create_goal(
            &mut conn,
            NewGoalInput {
                title: "子".to_string(),
                description: None,
                scope: None,
                status: None,
                start_date: None,
                due_date: None,
                manual_progress: None,
                parent_id: Some(parent.id.clone()),
                card_ids: None,
            },
        )
        .expect("创建子目标");
        let err = update_goal(
            &mut conn,
            UpdateGoalInput {
                id: parent.id,
                patch: GoalPatch {
                    parent_id: Some(Some(child.id)),
                    ..Default::default()
                },
            },
        )
        .expect_err("父目标挂到子目标下应拒绝");
        assert!(err.contains("循环"), "错误：{err}");
    }

    #[test]
    fn project_roles_meta_and_isolation() {
        let mut conn = memory_db();
        let first = create_project(
            &mut conn,
            NewProjectInput {
                name: "项目A".to_string(),
                description: Some("描述".to_string()),
                color: Some("#2f6fd0".to_string()),
                starred: Some(true),
            },
        )
        .expect("创建项目A");
        let second = create_project(
            &mut conn,
            NewProjectInput {
                name: "项目B".to_string(),
                description: None,
                color: None,
                starred: None,
            },
        )
        .expect("创建项目B");
        assert_eq!(get_project_roles(&conn, &first.id).expect("角色").len(), 5);

        let role = create_project_role(
            &mut conn,
            NewProjectRoleInput {
                project_id: first.id.clone(),
                name: "产品".to_string(),
                color: Some("#b84a62".to_string()),
            },
        )
        .expect("创建自定义角色");
        let meta = create_project_meta(
            &mut conn,
            NewProjectMetaInput {
                project_id: first.id.clone(),
                name: "客户".to_string(),
                value: Some("某集团".to_string()),
            },
        )
        .expect("创建元数据");
        assert_eq!(meta.name, "客户");

        let member = create_team_member(
            &mut conn,
            NewTeamMemberInput {
                project_id: first.id.clone(),
                role_id: role.id.clone(),
                name: "张三".to_string(),
                joined_at: Some("2026-10-01".to_string()),
                note: None,
            },
        )
        .expect("创建成员");
        let cross_project_role = get_project_roles(&conn, &second.id).expect("项目B角色");
        let err = create_team_member(
            &mut conn,
            NewTeamMemberInput {
                project_id: first.id.clone(),
                role_id: cross_project_role[0].id.clone(),
                name: "李四".to_string(),
                joined_at: None,
                note: None,
            },
        )
        .expect_err("跨项目角色应拒绝");
        assert!(err.contains("角色不属于该项目"), "错误：{err}");

        let delete_err = delete_project_role(&mut conn, id_input(&role.id)).expect_err("使用中角色应拒绝删除");
        assert!(delete_err.contains("仍被项目成员使用"), "错误：{delete_err}");

        delete_project(&mut conn, id_input(&second.id)).expect("删除项目B");
        assert!(get_project(&conn, &second.id).is_err());
        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.projects.len(), 1);
        assert_eq!(snapshot.team_members.len(), 1);
        assert_eq!(snapshot.team_members[0].project_id, first.id);
        assert_eq!(snapshot.team_members[0].role_id, role.id);
        assert_eq!(snapshot.project_meta_fields[0].project_id, first.id);
        assert_eq!(snapshot.team_members[0].id, member.id);
    }

    #[test]
    fn member_tenures_support_multiple_join_leave_cycles() {
        let mut conn = memory_db();
        let project = create_project(
            &mut conn,
            NewProjectInput {
                name: "投入记录项目".to_string(),
                description: None,
                color: None,
                starred: None,
            },
        )
        .expect("创建项目");
        let roles = get_project_roles(&conn, &project.id).expect("项目角色");
        let member = create_team_member(
            &mut conn,
            NewTeamMemberInput {
                project_id: project.id.clone(),
                role_id: roles[0].id.clone(),
                name: "张三".to_string(),
                joined_at: Some("2026-01-10".to_string()),
                note: None,
            },
        )
        .expect("创建成员");
        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.member_tenures.len(), 1);
        assert_eq!(snapshot.member_tenures[0].started_at, "2026-01-10");
        assert_eq!(snapshot.member_tenures[0].ended_at, None);

        let released = update_team_member(
            &mut conn,
            UpdateTeamMemberInput {
                id: member.id.clone(),
                patch: TeamMemberPatch {
                    status: Some(MemberStatus::Released),
                    released_at: Some(Some("2026-03-01".to_string())),
                    ..Default::default()
                },
            },
        )
        .expect("释放成员");
        assert_eq!(released.status, MemberStatus::Released);
        assert_eq!(released.released_at.as_deref(), Some("2026-03-01"));
        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.member_tenures[0].ended_at.as_deref(), Some("2026-03-01"));

        let rejoined = update_team_member(
            &mut conn,
            UpdateTeamMemberInput {
                id: member.id.clone(),
                patch: TeamMemberPatch {
                    status: Some(MemberStatus::Active),
                    ..Default::default()
                },
            },
        )
        .expect("回归成员");
        assert_eq!(rejoined.status, MemberStatus::Active);
        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.member_tenures.len(), 2);
        assert_eq!(snapshot.member_tenures[1].ended_at, None);

        // 手动补一段更早的历史投入，允许不重叠的多个时间段。
        let past = create_tenure(
            &mut conn,
            NewTenureInput {
                member_id: member.id.clone(),
                started_at: "2026-01-01".to_string(),
                ended_at: Some("2026-01-05".to_string()),
                note: Some("补录".to_string()),
            },
        )
        .expect("补录历史段");
        assert_eq!(past.ended_at.as_deref(), Some("2026-01-05"));

        let overlap = create_tenure(
            &mut conn,
            NewTenureInput {
                member_id: member.id.clone(),
                started_at: "2026-02-01".to_string(),
                ended_at: Some("2026-02-10".to_string()),
                note: None,
            },
        )
        .expect_err("重叠时间段应拒绝");
        assert!(overlap.contains("重叠"), "错误：{overlap}");

        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.member_tenures.len(), 3);
        delete_tenure(&mut conn, id_input(&past.id)).expect("删除补录段");
        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.member_tenures.len(), 2);
    }

    #[test]
    fn team_members_overtime_and_performance_cascade() {
        let mut conn = memory_db();
        let project = create_project(
            &mut conn,
            NewProjectInput {
                name: "项目A".to_string(),
                description: None,
                color: None,
                starred: None,
            },
        )
        .expect("创建项目");
        let roles = get_project_roles(&conn, &project.id).expect("项目角色");
        let member = create_team_member(
            &mut conn,
            NewTeamMemberInput {
                project_id: project.id.clone(),
                role_id: roles[0].id.clone(),
                name: "张三".to_string(),
                joined_at: Some("2026-10-01".to_string()),
                note: Some("后端".to_string()),
            },
        )
        .expect("创建成员");
        let released = update_team_member(
            &mut conn,
            UpdateTeamMemberInput {
                id: member.id.clone(),
                patch: TeamMemberPatch {
                    status: Some(MemberStatus::Released),
                    released_at: Some(Some("2026-10-31".to_string())),
                    ..Default::default()
                },
            },
        )
        .expect("释放成员");
        assert_eq!(released.status, MemberStatus::Released);
        assert_eq!(released.released_at.as_deref(), Some("2026-10-31"));

        let overtime = create_overtime(
            &mut conn,
            NewOvertimeInput {
                member_id: member.id.clone(),
                date: "2026-10-31".to_string(),
                hours: 8.0,
                status: Some(OvertimeStatus::Done),
                absence_reason: None,
                note: Some("版本上线".to_string()),
            },
        )
        .expect("创建加班");
        assert_eq!(overtime.hours, 8.0);

        let performance = create_performance(
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
        assert_eq!(performance.points, 5);

        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.team_members.len(), 1);
        assert_eq!(snapshot.overtime_records.len(), 1);
        assert_eq!(snapshot.performance_records.len(), 1);

        delete_team_member(&mut conn, id_input(&member.id)).expect("删除成员");
        let snapshot = get_snapshot(&conn).expect("快照");
        assert!(snapshot.team_members.is_empty());
        assert!(snapshot.overtime_records.is_empty());
        assert!(snapshot.performance_records.is_empty());
    }

    // -----------------------------------------------------------------------
    // 请假记录（V0.16.0）
    // -----------------------------------------------------------------------

    /// 建项目 + 成员，供请假记录相关用例复用。
    fn leave_fixture(conn: &mut Connection) -> (Project, TeamMember) {
        let project = create_project(
            conn,
            NewProjectInput {
                name: "项目A".to_string(),
                description: None,
                color: None,
                starred: None,
            },
        )
        .expect("创建项目");
        let roles = get_project_roles(conn, &project.id).expect("项目角色");
        let member = create_team_member(
            conn,
            NewTeamMemberInput {
                project_id: project.id.clone(),
                role_id: roles[0].id.clone(),
                name: "张三".to_string(),
                joined_at: Some("2026-10-01".to_string()),
                note: None,
            },
        )
        .expect("创建成员");
        (project, member)
    }

    #[test]
    fn leave_records_crud_and_member_cascade() {
        let mut conn = memory_db();
        let (project, member) = leave_fixture(&mut conn);

        let leave = create_leave(
            &mut conn,
            NewLeaveInput {
                member_id: member.id.clone(),
                start_date: "2026-10-01".to_string(),
                end_date: "2026-10-03".to_string(),
                days: 3.5,
                leave_type: Some(LeaveType::Annual),
                reason: "家中有事".to_string(),
                note: Some("已同步".to_string()),
            },
        )
        .expect("创建请假");
        assert_eq!(leave.days, 3.5, "天数按用户输入原样保存");
        assert_eq!(leave.leave_type, LeaveType::Annual);
        assert_eq!(leave.project_id, project.id, "项目归属按成员推导");
        assert_eq!(leave.member_id, member.id);
        assert_eq!(leave.reason, "家中有事");

        // 改日期不会动天数：天数是用户手填的。
        let updated = update_leave(
            &mut conn,
            UpdateLeaveInput {
                id: leave.id.clone(),
                patch: LeavePatch {
                    start_date: Some("2026-11-01".to_string()),
                    end_date: Some("2026-11-05".to_string()),
                    ..Default::default()
                },
            },
        )
        .expect("修改请假日期");
        assert_eq!(updated.days, 3.5, "改日期不动天数");
        assert_eq!(updated.start_date, "2026-11-01");
        assert_eq!(updated.end_date, "2026-11-05");

        // 改天数按用户输入落库。
        let updated = update_leave(
            &mut conn,
            UpdateLeaveInput {
                id: leave.id.clone(),
                patch: LeavePatch {
                    days: Some(2.25),
                    ..Default::default()
                },
            },
        )
        .expect("修改请假期天数");
        assert_eq!(updated.days, 2.25);

        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.leave_records.len(), 1);
        assert_eq!(snapshot.leave_records[0].id, leave.id);
        assert_eq!(snapshot.leave_records[0].days, 2.25);

        // 删成员 → 请假记录级联删除。
        delete_team_member(&mut conn, id_input(&member.id)).expect("删除成员");
        let snapshot = get_snapshot(&conn).expect("快照");
        assert!(snapshot.team_members.is_empty());
        assert!(snapshot.leave_records.is_empty());
    }

    #[test]
    fn leave_records_reject_invalid_dates_reason_and_days() {
        let mut conn = memory_db();
        let (_project, member) = leave_fixture(&mut conn);

        // 结束日期早于开始日期：拒绝。
        let inverted = create_leave(
            &mut conn,
            NewLeaveInput {
                member_id: member.id.clone(),
                start_date: "2026-10-10".to_string(),
                end_date: "2026-10-01".to_string(),
                days: 1.0,
                leave_type: None,
                reason: "家中有事".to_string(),
                note: None,
            },
        )
        .expect_err("应拒绝倒置的日期区间");
        assert_eq!(inverted, "结束日期不能早于开始日期");

        // 事由为空：拒绝。
        let empty_reason = create_leave(
            &mut conn,
            NewLeaveInput {
                member_id: member.id.clone(),
                start_date: "2026-10-01".to_string(),
                end_date: "2026-10-02".to_string(),
                days: 1.0,
                leave_type: None,
                reason: "   ".to_string(),
                note: None,
            },
        )
        .expect_err("应拒绝空事由");
        assert_eq!(empty_reason, "请填写请假事由");

        // 事由过长：拒绝。
        let too_long = create_leave(
            &mut conn,
            NewLeaveInput {
                member_id: member.id.clone(),
                start_date: "2026-10-01".to_string(),
                end_date: "2026-10-02".to_string(),
                days: 1.0,
                leave_type: None,
                reason: "事".repeat(201),
                note: None,
            },
        )
        .expect_err("应拒绝过长事由");
        assert_eq!(too_long, "请假事由最多 200 字");

        // 天数 <= 0：拒绝。
        let zero_days = create_leave(
            &mut conn,
            NewLeaveInput {
                member_id: member.id.clone(),
                start_date: "2026-10-01".to_string(),
                end_date: "2026-10-02".to_string(),
                days: 0.0,
                leave_type: None,
                reason: "家中有事".to_string(),
                note: None,
            },
        )
        .expect_err("应拒绝非法天数");
        assert_eq!(zero_days, "请假天数必须大于 0");

        // 天数超过上限：拒绝。
        let too_many = create_leave(
            &mut conn,
            NewLeaveInput {
                member_id: member.id.clone(),
                start_date: "2026-10-01".to_string(),
                end_date: "2026-10-02".to_string(),
                days: 400.0,
                leave_type: None,
                reason: "家中有事".to_string(),
                note: None,
            },
        )
        .expect_err("应拒绝超限天数");
        assert_eq!(too_many, "请假天数不能超过 366 天");

        // 天数超过两位小数：拒绝。
        let too_precise = create_leave(
            &mut conn,
            NewLeaveInput {
                member_id: member.id.clone(),
                start_date: "2026-10-01".to_string(),
                end_date: "2026-10-02".to_string(),
                days: 1.234,
                leave_type: None,
                reason: "家中有事".to_string(),
                note: None,
            },
        )
        .expect_err("应拒绝多位小数的天数");
        assert_eq!(too_precise, "请假天数最多 2 位小数");

        assert!(get_leave_records(&conn).expect("请假列表").is_empty());
    }

    #[test]
    fn inclusive_day_count_matches_civil_calendar() {
        assert_eq!(inclusive_days_between("2026-10-01", "2026-10-01"), Some(1));
        assert_eq!(inclusive_days_between("2026-10-01", "2026-10-03"), Some(3));
        assert_eq!(inclusive_days_between("2026-10-31", "2026-11-01"), Some(2));
        assert_eq!(
            inclusive_days_between("2026-01-01", "2026-12-31"),
            Some(365)
        );
        assert_eq!(
            inclusive_days_between("2024-01-01", "2024-12-31"),
            Some(366),
            "闰年"
        );
        assert_eq!(inclusive_days_between("2026-02-28", "2026-03-01"), Some(2));
        assert_eq!(
            inclusive_days_between("2024-02-28", "2024-03-01"),
            Some(3),
            "闰日"
        );
        assert_eq!(inclusive_days_between("2025-12-31", "2026-01-01"), Some(2));
        assert_eq!(
            inclusive_days_between("2026-10-10", "2026-10-01"),
            None,
            "倒置区间"
        );
        assert_eq!(
            inclusive_days_between("2026-10-01", "2026-13-01"),
            None,
            "非法月份"
        );
        assert_eq!(
            inclusive_days_between("2026-02-30", "2026-03-05"),
            None,
            "非法日期"
        );
        assert_eq!(
            inclusive_days_between("not-a-date", "2026-03-05"),
            None,
            "非法格式"
        );
    }

    #[test]
    fn civil_date_conversion_round_trips() {
        // `days_from_civil` 与既有的 `civil_from_days` 必须互为逆运算。
        for offset in 0..1_500i64 {
            let days = 19_000 + offset;
            let (year, month, day) = civil_from_days(days);
            assert_eq!(
                days_from_civil(year, month as i64, day as i64),
                days,
                "第 {days} 天往返不一致"
            );
        }
    }

    // -----------------------------------------------------------------------
    // 周末加班未出勤（V0.13.2）
    // -----------------------------------------------------------------------

    #[test]
    fn overtime_absence_requires_reason_and_clears_on_status_change() {
        let mut conn = memory_db();
        let project = create_project(
            &mut conn,
            NewProjectInput {
                name: "项目B".to_string(),
                description: None,
                color: None,
                starred: None,
            },
        )
        .expect("创建项目");
        let roles = get_project_roles(&conn, &project.id).expect("项目角色");
        let member = create_team_member(
            &mut conn,
            NewTeamMemberInput {
                project_id: project.id.clone(),
                role_id: roles[0].id.clone(),
                name: "李四".to_string(),
                joined_at: Some("2026-10-01".to_string()),
                note: None,
            },
        )
        .expect("创建成员");

        // 未出勤没有原因：拒绝。
        let missing = create_overtime(
            &mut conn,
            NewOvertimeInput {
                member_id: member.id.clone(),
                date: "2026-10-31".to_string(),
                hours: 8.0,
                status: Some(OvertimeStatus::Absent),
                absence_reason: Some("   ".to_string()),
                note: None,
            },
        )
        .expect_err("未出勤必须填写原因");
        assert!(missing.contains("未出勤原因"), "错误：{missing}");

        // 超过 200 字：拒绝。
        let too_long = create_overtime(
            &mut conn,
            NewOvertimeInput {
                member_id: member.id.clone(),
                date: "2026-10-31".to_string(),
                hours: 8.0,
                status: Some(OvertimeStatus::Absent),
                absence_reason: Some("x".repeat(201)),
                note: None,
            },
        )
        .expect_err("未出勤原因不能超过 200 字");
        assert!(too_long.contains("200"), "错误：{too_long}");

        // 正常写入：原因 trim 后保存。
        let absent = create_overtime(
            &mut conn,
            NewOvertimeInput {
                member_id: member.id.clone(),
                date: "2026-10-31".to_string(),
                hours: 8.0,
                status: Some(OvertimeStatus::Absent),
                absence_reason: Some(" 临时发烧请假 ".to_string()),
                note: None,
            },
        )
        .expect("创建未出勤记录");
        assert_eq!(absent.status, OvertimeStatus::Absent);
        assert_eq!(absent.absence_reason, "临时发烧请假");
        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.overtime_records[0].absence_reason, "临时发烧请假");

        // 切回已出勤：原因清空。
        let done = update_overtime(
            &mut conn,
            UpdateOvertimeInput {
                id: absent.id.clone(),
                patch: OvertimePatch {
                    status: Some(OvertimeStatus::Done),
                    ..Default::default()
                },
            },
        )
        .expect("改回已出勤");
        assert_eq!(done.status, OvertimeStatus::Done);
        assert_eq!(done.absence_reason, "");

        // 再次标记未出勤但没有新原因：拒绝。
        let again = update_overtime(
            &mut conn,
            UpdateOvertimeInput {
                id: absent.id.clone(),
                patch: OvertimePatch {
                    status: Some(OvertimeStatus::Absent),
                    ..Default::default()
                },
            },
        )
        .expect_err("重新标记未出勤必须填写原因");
        assert!(again.contains("未出勤原因"), "错误：{again}");

        // 带上新原因：写入成功。
        let absent_again = update_overtime(
            &mut conn,
            UpdateOvertimeInput {
                id: absent.id.clone(),
                patch: OvertimePatch {
                    status: Some(OvertimeStatus::Absent),
                    absence_reason: Some("临时调休".to_string()),
                    ..Default::default()
                },
            },
        )
        .expect("重新标记未出勤");
        assert_eq!(absent_again.absence_reason, "临时调休");

        // 已出勤记录带未出勤原因时被清空，不残留脏字段。
        let done_record = update_overtime(
            &mut conn,
            UpdateOvertimeInput {
                id: absent.id.clone(),
                patch: OvertimePatch {
                    status: Some(OvertimeStatus::Done),
                    absence_reason: Some("残留原因".to_string()),
                    ..Default::default()
                },
            },
        )
        .expect("改回已出勤并清理原因");
        assert_eq!(done_record.absence_reason, "");
    }

    // -----------------------------------------------------------------------
    // 任务树（V0.14.0）
    // -----------------------------------------------------------------------

    fn new_subtask(
        conn: &mut Connection,
        board_id: &str,
        list_id: &str,
        title: &str,
        parent_id: &str,
    ) -> Card {
        create_card(
            conn,
            NewCardInput {
                board_id: board_id.to_string(),
                list_id: list_id.to_string(),
                title: title.to_string(),
                parent_card_id: Some(parent_id.to_string()),
                ..Default::default()
            },
        )
        .expect("创建子任务失败")
    }

    #[test]
    fn subtask_tree_create_move_and_validate() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let other = new_list(&mut conn, &board.id, "进行中");
        let parent = new_card(&mut conn, &board.id, &list.id, "父任务");
        let child = new_subtask(&mut conn, &board.id, &list.id, "子任务", &parent.id);
        let grand = new_subtask(&mut conn, &board.id, &list.id, "孙任务", &child.id);
        assert_eq!(child.parent_card_id.as_deref(), Some(parent.id.as_str()));

        move_card(
            &mut conn,
            MoveCardInput {
                card_id: parent.id.clone(),
                to_list_id: other.id.clone(),
                to_index: 0,
            },
        )
        .expect("移动父任务");

        let snapshot = get_snapshot(&conn).expect("快照");
        for id in [&child.id, &grand.id] {
            let item = snapshot
                .cards
                .iter()
                .find(|card| &card.id == id)
                .expect("子任务存在");
            assert_eq!(item.list_id, other.id, "子任务应跟随父任务列表");
        }

        let child_move = move_card(
            &mut conn,
            MoveCardInput {
                card_id: child.id.clone(),
                to_list_id: list.id.clone(),
                to_index: 0,
            },
        )
        .expect_err("子任务不能单独移动列表");
        assert!(child_move.contains("子任务"), "错误：{child_move}");

        let child_patch = update_card(
            &mut conn,
            UpdateCardInput {
                id: child.id.clone(),
                patch: CardPatch {
                    list_id: Some(list.id.clone()),
                    ..Default::default()
                },
            },
        )
        .expect_err("子任务不能通过 patch 换列表");
        assert!(child_patch.contains("子任务"), "错误：{child_patch}");

        let cross_board = new_board(&mut conn, "另一个看板");
        let cross_list = new_list(&mut conn, &cross_board.id, "待办");
        let cross = create_card(
            &mut conn,
            NewCardInput {
                board_id: cross_board.id.clone(),
                list_id: cross_list.id.clone(),
                title: "跨板子任务".to_string(),
                parent_card_id: Some(parent.id.clone()),
                ..Default::default()
            },
        )
        .expect_err("父任务不在同一看板应被拒绝");
        assert!(cross.contains("看板"), "错误：{cross}");

        let recurrence = crate::automation::create_recurrence(
            &mut conn,
            NewRecurrenceInput {
                card_id: child.id.clone(),
                frequency: RecurrenceFrequency::Daily,
                ..Default::default()
            },
        )
        .expect_err("子任务不能设置重复");
        assert!(recurrence.contains("子任务"), "错误：{recurrence}");
    }

    #[test]
    fn deleting_parent_trashes_and_restores_subtree() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "待办");
        let parent = new_card(&mut conn, &board.id, &list.id, "父任务");
        let child = new_subtask(&mut conn, &board.id, &list.id, "子任务", &parent.id);
        let grand = new_subtask(&mut conn, &board.id, &list.id, "孙任务", &child.id);
        let ids = [&parent.id, &child.id, &grand.id];

        delete_card(&mut conn, id_input(&parent.id)).expect("删除父任务");
        let snapshot = get_snapshot(&conn).expect("快照");
        for id in ids {
            assert!(
                !snapshot.cards.iter().any(|card| &card.id == id),
                "整树应进回收站"
            );
        }

        restore_card(&mut conn, id_input(&child.id)).expect("恢复子任务应连带父链与后代");
        let snapshot = get_snapshot(&conn).expect("快照");
        for id in ids {
            assert!(
                snapshot.cards.iter().any(|card| &card.id == id),
                "整树应恢复"
            );
        }

        delete_card(&mut conn, id_input(&parent.id)).expect("再次删除父任务");
        purge_card(&mut conn, id_input(&parent.id)).expect("彻底删除父任务");
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cards WHERE id IN (?1, ?2, ?3)",
                rusqlite::params![&parent.id, &child.id, &grand.id],
                |row| row.get(0),
            )
            .expect("统计剩余卡片");
        assert_eq!(remaining, 0, "彻底删除应级联整树");
    }

    // -----------------------------------------------------------------------
    // 自定义字段（V0.13.0）
    // -----------------------------------------------------------------------

    fn custom_field_option(id: &str, label: &str) -> CustomFieldOption {
        CustomFieldOption {
            id: id.to_string(),
            label: label.to_string(),
            color: "#0f766e".to_string(),
        }
    }

    fn new_custom_field(
        conn: &mut Connection,
        board_id: &str,
        name: &str,
        field_type: CustomFieldType,
        options: Vec<CustomFieldOption>,
    ) -> CustomField {
        create_custom_field(
            conn,
            NewCustomFieldInput {
                board_id: board_id.to_string(),
                name: name.to_string(),
                field_type,
                options,
            },
        )
        .expect("创建自定义字段失败")
    }

    fn field_value_input(
        field_id: &str,
        value_text: Option<&str>,
        value_number: Option<f64>,
    ) -> CardFieldValueInput {
        CardFieldValueInput {
            field_id: field_id.to_string(),
            value_text: value_text.map(|value| value.to_string()),
            value_number,
        }
    }

    fn set_field_values(
        conn: &mut Connection,
        card_id: &str,
        values: Vec<CardFieldValueInput>,
    ) -> DbResult<Vec<CardFieldValue>> {
        set_card_field_values(
            conn,
            SetCardFieldValuesInput {
                card_id: card_id.to_string(),
                values,
            },
        )
    }

    #[test]
    fn create_select_field_reads_back_options_in_order() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "优先级",
            CustomFieldType::Select,
            vec![
                custom_field_option("opt_high", "高"),
                custom_field_option("opt_low", "低"),
            ],
        );
        assert_eq!(field.field_type, CustomFieldType::Select);

        let fields = get_custom_fields(&conn, &board.id).expect("读取字段");
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].id, field.id);
        assert_eq!(fields[0].name, "优先级");
        assert_eq!(
            fields[0]
                .options
                .iter()
                .map(|option| option.id.clone())
                .collect::<Vec<_>>(),
            vec!["opt_high".to_string(), "opt_low".to_string()]
        );
        assert_eq!(fields[0].options[0].label, "高");
        assert_eq!(fields[0].options[1].color, "#0f766e");
    }

    #[test]
    fn create_number_field_keeps_options_empty() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "工时",
            CustomFieldType::Number,
            Vec::new(),
        );
        assert!(field.options.is_empty());
        let fields = get_custom_fields(&conn, &board.id).expect("读取字段");
        assert!(fields[0].options.is_empty());
    }

    #[test]
    fn duplicate_field_name_in_same_board_is_rejected() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        new_custom_field(
            &mut conn,
            &board.id,
            "优先级",
            CustomFieldType::Number,
            Vec::new(),
        );
        let error = create_custom_field(
            &mut conn,
            NewCustomFieldInput {
                board_id: board.id.clone(),
                name: " 优先级 ".to_string(),
                field_type: CustomFieldType::Number,
                options: Vec::new(),
            },
        )
        .expect_err("同看板内的同名字段应被拒绝");
        assert!(error.contains("该看板已存在同名字段"));
    }

    #[test]
    fn same_field_name_allowed_across_boards() {
        let mut conn = memory_db();
        let first = new_board(&mut conn, "看板 A");
        let second = new_board(&mut conn, "看板 B");
        new_custom_field(
            &mut conn,
            &first.id,
            "优先级",
            CustomFieldType::Number,
            Vec::new(),
        );
        let field = new_custom_field(
            &mut conn,
            &second.id,
            "优先级",
            CustomFieldType::Number,
            Vec::new(),
        );
        assert_eq!(field.board_id, second.id);
        assert_eq!(get_custom_fields(&conn, &first.id).expect("读取字段").len(), 1);
        assert_eq!(get_custom_fields(&conn, &second.id).expect("读取字段").len(), 1);
    }

    #[test]
    fn blank_field_name_falls_back_to_default() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "   ",
            CustomFieldType::Number,
            Vec::new(),
        );
        assert_eq!(field.name, "未命名字段");
    }

    #[test]
    fn select_field_requires_options() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let error = create_custom_field(
            &mut conn,
            NewCustomFieldInput {
                board_id: board.id.clone(),
                name: "优先级".to_string(),
                field_type: CustomFieldType::Select,
                options: Vec::new(),
            },
        )
        .expect_err("单选字段缺少选项应被拒绝");
        assert!(error.contains("至少需要一个选项"));
    }

    #[test]
    fn number_field_rejects_options() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let error = create_custom_field(
            &mut conn,
            NewCustomFieldInput {
                board_id: board.id.clone(),
                name: "工时".to_string(),
                field_type: CustomFieldType::Number,
                options: vec![custom_field_option("opt_high", "高")],
            },
        )
        .expect_err("数值字段带选项应被拒绝");
        assert!(error.contains("数值字段不支持选项"));
    }

    #[test]
    fn set_select_value_reads_back() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "列");
        let card = new_card(&mut conn, &board.id, &list.id, "任务");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "优先级",
            CustomFieldType::Select,
            vec![custom_field_option("opt_high", "高")],
        );
        let values = set_field_values(
            &mut conn,
            &card.id,
            vec![field_value_input(&field.id, Some("opt_high"), None)],
        )
        .expect("写入取值");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].value_text.as_deref(), Some("opt_high"));
        assert_eq!(values[0].value_number, None);

        let snapshot = get_snapshot(&conn).expect("快照");
        assert_eq!(snapshot.card_field_values.len(), 1);
        assert_eq!(snapshot.card_field_values[0].card_id, card.id);
    }

    #[test]
    fn set_number_value_reads_back() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "列");
        let card = new_card(&mut conn, &board.id, &list.id, "任务");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "工时",
            CustomFieldType::Number,
            Vec::new(),
        );
        let values = set_field_values(
            &mut conn,
            &card.id,
            vec![field_value_input(&field.id, None, Some(12.5))],
        )
        .expect("写入取值");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].value_number, Some(12.5));
        assert_eq!(values[0].value_text, None);
    }

    #[test]
    fn select_field_rejects_unknown_option() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "列");
        let card = new_card(&mut conn, &board.id, &list.id, "任务");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "优先级",
            CustomFieldType::Select,
            vec![custom_field_option("opt_high", "高")],
        );
        let error = set_field_values(
            &mut conn,
            &card.id,
            vec![field_value_input(&field.id, Some("opt_missing"), None)],
        )
        .expect_err("非法选项 id 应被拒绝");
        assert!(error.contains("选项不存在"));
    }

    #[test]
    fn number_field_rejects_non_finite_value() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "列");
        let card = new_card(&mut conn, &board.id, &list.id, "任务");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "工时",
            CustomFieldType::Number,
            Vec::new(),
        );
        for invalid in [f64::NAN, f64::INFINITY] {
            let error = set_field_values(
                &mut conn,
                &card.id,
                vec![field_value_input(&field.id, None, Some(invalid))],
            )
            .expect_err("非有限数应被拒绝");
            assert!(error.contains("有限数"));
        }
    }

    #[test]
    fn cross_board_field_value_is_rejected() {
        let mut conn = memory_db();
        let first = new_board(&mut conn, "看板 A");
        let second = new_board(&mut conn, "看板 B");
        let list = new_list(&mut conn, &first.id, "列 A");
        let card = new_card(&mut conn, &first.id, &list.id, "任务 A");
        let field = new_custom_field(
            &mut conn,
            &second.id,
            "工时",
            CustomFieldType::Number,
            Vec::new(),
        );
        let error = set_field_values(
            &mut conn,
            &card.id,
            vec![field_value_input(&field.id, None, Some(1.0))],
        )
        .expect_err("跨看板赋值应被拒绝");
        assert!(error.contains("不属于任务所在看板"));
    }

    #[test]
    fn duplicated_field_in_one_request_is_rejected() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "列");
        let card = new_card(&mut conn, &board.id, &list.id, "任务");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "优先级",
            CustomFieldType::Select,
            vec![custom_field_option("opt_high", "高")],
        );
        let error = set_field_values(
            &mut conn,
            &card.id,
            vec![
                field_value_input(&field.id, Some("opt_high"), None),
                field_value_input(&field.id, Some("opt_high"), None),
            ],
        )
        .expect_err("同一字段重复赋值应被拒绝");
        assert!(error.contains("重复赋值"));
    }

    #[test]
    fn removing_option_clears_matching_field_values() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "列");
        let keep_card = new_card(&mut conn, &board.id, &list.id, "任务 A");
        let drop_card = new_card(&mut conn, &board.id, &list.id, "任务 B");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "优先级",
            CustomFieldType::Select,
            vec![
                custom_field_option("opt_keep", "保留"),
                custom_field_option("opt_drop", "移除"),
            ],
        );
        set_field_values(
            &mut conn,
            &keep_card.id,
            vec![field_value_input(&field.id, Some("opt_keep"), None)],
        )
        .expect("写入取值");
        set_field_values(
            &mut conn,
            &drop_card.id,
            vec![field_value_input(&field.id, Some("opt_drop"), None)],
        )
        .expect("写入取值");

        let updated = update_custom_field(
            &mut conn,
            UpdateCustomFieldInput {
                id: field.id.clone(),
                patch: CustomFieldPatch {
                    name: None,
                    options: Some(vec![custom_field_option("opt_keep", "保留")]),
                    sort_order: None,
                },
            },
        )
        .expect("更新字段");
        assert_eq!(updated.options.len(), 1);

        let values = get_all_card_field_values(&conn).expect("读取字段值");
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].card_id, keep_card.id);
        assert_eq!(values[0].value_text.as_deref(), Some("opt_keep"));
    }

    #[test]
    fn deleting_field_removes_its_values() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "列");
        let card = new_card(&mut conn, &board.id, &list.id, "任务");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "优先级",
            CustomFieldType::Select,
            vec![custom_field_option("opt_high", "高")],
        );
        set_field_values(
            &mut conn,
            &card.id,
            vec![field_value_input(&field.id, Some("opt_high"), None)],
        )
        .expect("写入取值");

        delete_custom_field(&mut conn, id_input(&field.id)).expect("删除字段");

        assert!(get_all_card_field_values(&conn).expect("读取字段值").is_empty());
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM card_field_values", [], |row| row.get(0))
            .expect("统计字段值行");
        assert_eq!(orphans, 0);
    }

    // -----------------------------------------------------------------------
    // 保存的筛选视图（V0.13.1）
    // -----------------------------------------------------------------------

    fn new_saved_view(
        conn: &mut Connection,
        board_id: &str,
        name: &str,
        filters: SavedViewFilters,
        sort: SavedViewSort,
    ) -> SavedView {
        create_saved_view(
            conn,
            NewSavedViewInput {
                board_id: board_id.to_string(),
                name: name.to_string(),
                view_type: "board".to_string(),
                filters,
                sort,
            },
        )
        .expect("创建保存视图失败")
    }

    #[test]
    fn create_saved_view_persists_filters_and_sort() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let view = new_saved_view(
            &mut conn,
            &board.id,
            "本周重点",
            SavedViewFilters {
                keyword: "  发布 ".to_string(),
                status: "active".to_string(),
                priorities: vec![Priority::High],
                labels: vec!["研发".to_string()],
                field_filters: Vec::new(),
                blocked: true,
            },
            SavedViewSort {
                key: "created-desc".to_string(),
                direction: "desc".to_string(),
            },
        );
        assert!(!view.is_builtin);
        assert_eq!(view.filters.keyword, "发布");
        assert_eq!(view.filters.status, "active");
        assert_eq!(view.filters.priorities, vec![Priority::High]);
        assert_eq!(view.filters.labels, vec!["研发".to_string()]);
        assert!(view.filters.blocked);
        assert_eq!(view.sort.key, "created-desc");
        assert_eq!(view.sort.direction, "desc");

        let views = get_saved_views(&conn, &board.id).expect("读取视图");
        let saved = views
            .iter()
            .find(|item| item.id == view.id)
            .expect("视图应存在");
        assert_eq!(saved.filters, view.filters);
        assert_eq!(saved.sort, view.sort);
    }

    #[test]
    fn builtin_saved_views_are_created_for_new_board() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let views = get_saved_views(&conn, &board.id).expect("读取视图");
        assert_eq!(views.len(), 3);
        assert!(views.iter().all(|view| view.is_builtin));
        let names: Vec<&str> = views.iter().map(|view| view.name.as_str()).collect();
        assert_eq!(names, vec!["全部", "我的任务", "最近更新"]);
        let mine = views
            .iter()
            .find(|view| view.name == "我的任务")
            .expect("我的任务视图");
        assert_eq!(mine.filters.status, "active");
        let recent = views
            .iter()
            .find(|view| view.name == "最近更新")
            .expect("最近更新视图");
        assert_eq!(recent.sort.key, "updated-desc");
        assert_eq!(recent.sort.direction, "desc");
    }

    #[test]
    fn builtin_saved_views_cannot_be_deleted_or_renamed() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let views = get_saved_views(&conn, &board.id).expect("读取视图");
        let builtin = views[0].clone();
        let error = delete_saved_view(&mut conn, id_input(&builtin.id)).expect_err("内置视图不可删除");
        assert!(error.contains("内置视图不可删除"));
        let error = update_saved_view(
            &mut conn,
            UpdateSavedViewInput {
                id: builtin.id.clone(),
                patch: SavedViewPatch {
                    name: Some("改名".to_string()),
                    ..Default::default()
                },
            },
        )
        .expect_err("内置视图不可修改");
        assert!(error.contains("内置视图不可修改"));
    }

    #[test]
    fn saved_view_with_deleted_field_filter_degrades_gracefully() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "阶段",
            CustomFieldType::Select,
            vec![custom_field_option("opt_a", "甲")],
        );
        let view = new_saved_view(
            &mut conn,
            &board.id,
            "按阶段",
            SavedViewFilters {
                field_filters: vec![SavedViewFieldFilter {
                    field_id: field.id.clone(),
                    option_ids: vec!["opt_a".to_string()],
                    min: None,
                    max: None,
                }],
                ..Default::default()
            },
            SavedViewSort::default(),
        );
        // 字段被删除后，视图读取时忽略该条件而不是报错
        delete_custom_field(&mut conn, id_input(&field.id)).expect("删除字段");
        let views = get_saved_views(&conn, &board.id).expect("读取视图");
        let saved = views
            .iter()
            .find(|item| item.id == view.id)
            .expect("视图应存在");
        assert!(saved.filters.field_filters.is_empty());
    }

    #[test]
    fn saved_view_with_removed_option_filter_degrades_gracefully() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "阶段",
            CustomFieldType::Select,
            vec![
                custom_field_option("opt_a", "甲"),
                custom_field_option("opt_b", "乙"),
            ],
        );
        let view = new_saved_view(
            &mut conn,
            &board.id,
            "按阶段",
            SavedViewFilters {
                field_filters: vec![SavedViewFieldFilter {
                    field_id: field.id.clone(),
                    option_ids: vec!["opt_a".to_string(), "opt_b".to_string()],
                    min: None,
                    max: None,
                }],
                ..Default::default()
            },
            SavedViewSort::default(),
        );
        update_custom_field(
            &mut conn,
            UpdateCustomFieldInput {
                id: field.id.clone(),
                patch: CustomFieldPatch {
                    name: None,
                    options: Some(vec![custom_field_option("opt_a", "甲")]),
                    sort_order: None,
                },
            },
        )
        .expect("移除选项");
        let views = get_saved_views(&conn, &board.id).expect("读取视图");
        let saved = views
            .iter()
            .find(|item| item.id == view.id)
            .expect("视图应存在");
        assert_eq!(saved.filters.field_filters.len(), 1);
        assert_eq!(
            saved.filters.field_filters[0].option_ids,
            vec!["opt_a".to_string()]
        );
    }

    #[test]
    fn number_range_filter_is_preserved_as_saved() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "工时",
            CustomFieldType::Number,
            Vec::new(),
        );
        let view = new_saved_view(
            &mut conn,
            &board.id,
            "工时区间",
            SavedViewFilters {
                field_filters: vec![SavedViewFieldFilter {
                    field_id: field.id.clone(),
                    option_ids: Vec::new(),
                    min: Some(2.0),
                    max: Some(10.0),
                }],
                ..Default::default()
            },
            SavedViewSort::default(),
        );
        assert_eq!(view.filters.field_filters[0].min, Some(2.0));
        assert_eq!(view.filters.field_filters[0].max, Some(10.0));
    }

    #[test]
    fn saved_view_sort_is_normalized_like_frontend() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let view = new_saved_view(
            &mut conn,
            &board.id,
            "排序归一",
            SavedViewFilters::default(),
            SavedViewSort {
                key: "updatedAt".to_string(),
                direction: "desc".to_string(),
            },
        );
        assert_eq!(view.sort.key, "updated-desc");
        assert_eq!(view.sort.direction, "desc");

        let view = new_saved_view(
            &mut conn,
            &board.id,
            "排序归一 2",
            SavedViewFilters::default(),
            SavedViewSort {
                key: "due-asc".to_string(),
                direction: "desc".to_string(),
            },
        );
        assert_eq!(view.sort.key, "due-asc");
        assert_eq!(view.sort.direction, "asc");
    }

    #[test]
    fn blank_saved_view_name_is_rejected() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let error = create_saved_view(
            &mut conn,
            NewSavedViewInput {
                board_id: board.id.clone(),
                name: "   ".to_string(),
                view_type: String::new(),
                filters: SavedViewFilters::default(),
                sort: SavedViewSort::default(),
            },
        )
        .expect_err("空名称应被拒绝");
        assert!(error.contains("请先填写视图名称"));
    }

    #[test]
    fn duplicate_saved_view_name_in_same_board_is_rejected() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        new_saved_view(
            &mut conn,
            &board.id,
            "本周重点",
            SavedViewFilters::default(),
            SavedViewSort::default(),
        );
        let error = create_saved_view(
            &mut conn,
            NewSavedViewInput {
                board_id: board.id.clone(),
                name: " 本周重点 ".to_string(),
                view_type: String::new(),
                filters: SavedViewFilters::default(),
                sort: SavedViewSort::default(),
            },
        )
        .expect_err("同看板内的同名视图应被拒绝");
        assert!(error.contains("该看板已存在同名视图"));
    }

    #[test]
    fn saved_view_can_be_updated_and_deleted() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let view = new_saved_view(
            &mut conn,
            &board.id,
            "旧名",
            SavedViewFilters {
                status: "active".to_string(),
                ..Default::default()
            },
            SavedViewSort::default(),
        );
        let updated = update_saved_view(
            &mut conn,
            UpdateSavedViewInput {
                id: view.id.clone(),
                patch: SavedViewPatch {
                    name: Some("新名".to_string()),
                    view_type: Some("table".to_string()),
                    filters: Some(SavedViewFilters {
                        status: "completed".to_string(),
                        ..Default::default()
                    }),
                    sort: Some(SavedViewSort {
                        key: "created-desc".to_string(),
                        direction: "desc".to_string(),
                    }),
                },
            },
        )
        .expect("更新视图");
        assert_eq!(updated.name, "新名");
        assert_eq!(updated.view_type, "table");
        assert_eq!(updated.filters.status, "completed");
        assert_eq!(updated.sort.key, "created-desc");

        delete_saved_view(&mut conn, id_input(&view.id)).expect("删除视图");
        assert!(get_saved_views(&conn, &board.id)
            .expect("读取视图")
            .iter()
            .all(|item| item.id != view.id));
    }

    /// 锁定落库的 JSON 形态：前端按这套字段名读写，别随手改名。
    #[test]
    fn saved_view_json_shape_is_locked() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let field = new_custom_field(
            &mut conn,
            &board.id,
            "阶段",
            CustomFieldType::Select,
            vec![custom_field_option("opt_a", "甲")],
        );
        let view = new_saved_view(
            &mut conn,
            &board.id,
            "本周重点",
            SavedViewFilters {
                keyword: "发布".to_string(),
                status: "active".to_string(),
                priorities: vec![Priority::High],
                labels: vec!["研发".to_string()],
                field_filters: vec![SavedViewFieldFilter {
                    field_id: field.id.clone(),
                    option_ids: vec!["opt_a".to_string()],
                    min: None,
                    max: None,
                }],
                blocked: true,
            },
            SavedViewSort {
                key: "created-desc".to_string(),
                direction: "desc".to_string(),
            },
        );
        let filters_json: String = conn
            .query_row(
                "SELECT filters_json FROM saved_views WHERE id = ?1",
                [&view.id],
                |row| row.get(0),
            )
            .expect("读取筛选条件 JSON");
        let sort_json: String = conn
            .query_row(
                "SELECT sort_json FROM saved_views WHERE id = ?1",
                [&view.id],
                |row| row.get(0),
            )
            .expect("读取排序 JSON");
        assert_eq!(
            filters_json,
            format!(
                r#"{{"keyword":"发布","status":"active","priorities":["high"],"labels":["研发"],"fieldFilters":[{{"fieldId":"{}","optionIds":["opt_a"],"min":null,"max":null}}],"blocked":true}}"#,
                field.id
            )
        );
        assert_eq!(sort_json, r#"{"key":"created-desc","direction":"desc"}"#);
    }

    #[test]
    fn snapshot_includes_saved_views() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        new_saved_view(
            &mut conn,
            &board.id,
            "本周重点",
            SavedViewFilters::default(),
            SavedViewSort::default(),
        );
        let snapshot = get_snapshot(&conn).expect("快照");
        assert!(snapshot
            .saved_views
            .iter()
            .any(|view| view.name == "本周重点"));
        assert!(snapshot.saved_views.iter().any(|view| view.is_builtin));
    }

    #[test]
    fn clearing_value_removes_the_row() {
        let mut conn = memory_db();
        let board = new_board(&mut conn, "看板");
        let list = new_list(&mut conn, &board.id, "列");
        let card = new_card(&mut conn, &board.id, &list.id, "任务");
        let select_field = new_custom_field(
            &mut conn,
            &board.id,
            "优先级",
            CustomFieldType::Select,
            vec![custom_field_option("opt_high", "高")],
        );
        let number_field = new_custom_field(
            &mut conn,
            &board.id,
            "工时",
            CustomFieldType::Number,
            Vec::new(),
        );
        set_field_values(
            &mut conn,
            &card.id,
            vec![
                field_value_input(&select_field.id, Some("opt_high"), None),
                field_value_input(&number_field.id, None, Some(3.0)),
            ],
        )
        .expect("写入取值");
        assert_eq!(get_all_card_field_values(&conn).expect("读取字段值").len(), 2);

        let cleared = set_field_values(
            &mut conn,
            &card.id,
            vec![
                field_value_input(&select_field.id, None, None),
                field_value_input(&number_field.id, None, None),
            ],
        )
        .expect("清空取值");
        assert!(cleared.is_empty());
        assert!(get_all_card_field_values(&conn).expect("读取字段值").is_empty());
    }
}
