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

use std::collections::HashMap;
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

const BOARD_COLUMNS: &str = "id, title, description, color, starred, created_at, updated_at";
const LIST_COLUMNS: &str = "id, board_id, title, position, created_at";
const CARD_COLUMNS: &str = "id, board_id, list_id, title, description, due_date, start_date, priority, completed, labels, subtasks, position, deleted_at, created_at, updated_at";
const INBOX_COLUMNS: &str = "id, content, created_at";

fn row_to_board(row: &Row<'_>) -> rusqlite::Result<Board> {
    let color: String = row.get("color")?;
    Ok(Board {
        id: row.get("id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        color: BoardColor::from_db(&color),
        starred: row.get::<_, i64>("starred")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_list(row: &Row<'_>) -> rusqlite::Result<List> {
    Ok(List {
        id: row.get("id")?,
        board_id: row.get("board_id")?,
        title: row.get("title")?,
        position: row.get("position")?,
        created_at: row.get("created_at")?,
    })
}

fn row_to_card(row: &Row<'_>) -> rusqlite::Result<Card> {
    let priority: Option<String> = row.get("priority")?;
    let labels: String = row.get("labels")?;
    let subtasks: String = row.get("subtasks")?;
    Ok(Card {
        id: row.get("id")?,
        board_id: row.get("board_id")?,
        list_id: row.get("list_id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        due_date: row.get("due_date")?,
        start_date: row.get("start_date")?,
        priority: priority.as_deref().and_then(Priority::from_db),
        completed: row.get::<_, i64>("completed")? != 0,
        labels: labels_from_json(&labels),
        subtasks: subtasks_from_json(&subtasks),
        position: row.get("position")?,
        deleted_at: row.get("deleted_at")?,
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
                "SELECT id FROM cards WHERE list_id = ?1 AND deleted_at IS NULL \
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

/// 全部任务依赖边（V0.4）。
pub fn get_dependencies(conn: &Connection) -> DbResult<Vec<CardDependency>> {
    let mut statement = conn
        .prepare(
            "SELECT card_id, depends_on_card_id FROM card_dependencies \
             ORDER BY card_id ASC, depends_on_card_id ASC",
        )
        .map_err(db_err)?;
    let rows = statement
        .query_map([], |row| {
            Ok(CardDependency {
                card_id: row.get(0)?,
                depends_on_card_id: row.get(1)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
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

/// 整体替换某张任务的前置任务列表（V0.4）。
///
/// 约束：只能依赖同一看板内的活动任务；不能依赖自己；不能形成循环。
pub fn set_card_dependencies(
    conn: &mut Connection,
    input: SetDependenciesInput,
) -> DbResult<Vec<CardDependency>> {
    let tx = conn.transaction().map_err(db_err)?;
    let card = get_card(&tx, &input.card_id)?;
    if card.deleted_at.is_some() {
        return Err("回收站中的任务不能设置前置任务".to_string());
    }

    let mut depends_on = Vec::new();
    for id in input.depends_on {
        if id == card.id {
            return Err("任务不能依赖自己".to_string());
        }
        if !depends_on.contains(&id) {
            depends_on.push(id);
        }
    }

    for id in &depends_on {
        let blocker = get_card(&tx, id)
            .map_err(|_| format!("前置任务不存在：{id}"))?;
        if blocker.deleted_at.is_some() {
            return Err(format!("前置任务「{}」在回收站中", blocker.title));
        }
        if blocker.board_id != card.board_id {
            return Err("只能依赖同一看板内的任务".to_string());
        }
    }

    // 构建该看板的依赖图（先移除当前任务的旧边，再检查新边是否成环）。
    let mut edges: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut statement = tx
            .prepare(
                "SELECT d.card_id, d.depends_on_card_id \
                 FROM card_dependencies d JOIN cards c ON c.id = d.card_id \
                 WHERE c.board_id = ?1",
            )
            .map_err(db_err)?;
        let rows = statement
            .query_map([&card.board_id], |row| {
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
    edges.insert(card.id.clone(), depends_on.clone());
    for blocker in &depends_on {
        if dependency_reaches(&edges, blocker, &card.id) {
            return Err("前置任务形成了循环依赖".to_string());
        }
    }

    tx.execute(
        "DELETE FROM card_dependencies WHERE card_id = ?1",
        [&card.id],
    )
    .map_err(db_err)?;
    for id in &depends_on {
        tx.execute(
            "INSERT INTO card_dependencies (card_id, depends_on_card_id) VALUES (?1, ?2)",
            params![&card.id, id],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)?;

    Ok(depends_on
        .into_iter()
        .map(|depends_on_card_id| CardDependency {
            card_id: card.id.clone(),
            depends_on_card_id,
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
    tx.commit().map_err(db_err)?;
    Ok(board)
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
    board.updated_at = now_iso();
    tx.execute(
        "UPDATE boards SET title = ?1, description = ?2, color = ?3, starred = ?4, updated_at = ?5 \
         WHERE id = ?6",
        params![
            &board.title,
            &board.description,
            board.color.as_str(),
            board.starred as i64,
            &board.updated_at,
            &board.id,
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
        position,
        created_at: now_iso(),
    };
    tx.execute(
        "INSERT INTO lists (id, board_id, title, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            &list.id,
            &list.board_id,
            &list.title,
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
    tx.execute(
        "UPDATE lists SET title = ?1 WHERE id = ?2",
        params![&list.title, &list.id],
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

pub fn create_card(conn: &mut Connection, input: NewCardInput) -> DbResult<Card> {
    let tx = conn.transaction().map_err(db_err)?;
    get_list(&tx, &input.list_id)?;
    let position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM cards \
             WHERE list_id = ?1 AND deleted_at IS NULL",
            [&input.list_id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    let now = now_iso();
    let card = Card {
        id: create_id("c"),
        board_id: input.board_id,
        list_id: input.list_id,
        title: fallback_trimmed(&input.title, "未命名任务"),
        description: trimmed_or_empty(input.description),
        due_date: input.due_date,
        start_date: input.start_date,
        priority: input.priority,
        completed: false,
        deleted_at: None,
        labels: input.labels.unwrap_or_default(),
        subtasks: input.subtasks.unwrap_or_default(),
        position,
        created_at: now.clone(),
        updated_at: now,
    };
    let labels_json = labels_to_json(&card.labels)?;
    let subtasks_json = subtasks_to_json(&card.subtasks)?;
    tx.execute(
        "INSERT INTO cards \
         (id, board_id, list_id, title, description, due_date, start_date, priority, completed, \
         labels, subtasks, position, deleted_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13, ?14)",
        params![
            &card.id,
            &card.board_id,
            &card.list_id,
            &card.title,
            &card.description,
            &card.due_date,
            &card.start_date,
            card.priority.map(Priority::as_str),
            card.completed as i64,
            &labels_json,
            &subtasks_json,
            card.position,
            &card.created_at,
            &card.updated_at,
        ],
    )
    .map_err(db_err)?;
    touch_board(&tx, &card.board_id)?;
    tx.commit().map_err(db_err)?;
    Ok(card)
}

pub fn update_card(conn: &mut Connection, input: UpdateCardInput) -> DbResult<Card> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut card = get_card(&tx, &input.id)?;
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
    if let Some(priority) = input.patch.priority {
        card.priority = priority;
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
            normalize_card_positions(&tx, &old_list_id)?;
            card.position = tx
                .query_row(
                    "SELECT COUNT(*) FROM cards WHERE list_id = ?1 AND id != ?2 \
                     AND deleted_at IS NULL",
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
         priority = ?5, completed = ?6, labels = ?7, subtasks = ?8, position = ?9, \
         updated_at = ?10 WHERE id = ?11",
        params![
            &card.title,
            &card.description,
            &card.due_date,
            &card.start_date,
            card.priority.map(Priority::as_str),
            card.completed as i64,
            &labels_json,
            &subtasks_json,
            card.position,
            &card.updated_at,
            &card.id,
        ],
    )
    .map_err(db_err)?;
    touch_board(&tx, &card.board_id)?;
    tx.commit().map_err(db_err)?;
    Ok(card)
}

pub fn delete_card(conn: &mut Connection, input: IdInput) -> DbResult<()> {
    let tx = conn.transaction().map_err(db_err)?;
    let card = get_card(&tx, &input.id)?;
    // 软删除：放进回收站，物理行保留；重复删除是无操作（对齐 localApi）。
    if card.deleted_at.is_none() {
        let now = now_iso();
        tx.execute(
            "UPDATE cards SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![&now, &card.id],
        )
        .map_err(db_err)?;
        // 删除任务后，指向它的依赖边一并移除，避免其他任务被一个已不存在的任务阻塞。
        tx.execute(
            "DELETE FROM card_dependencies WHERE card_id = ?1 OR depends_on_card_id = ?1",
            [&card.id],
        )
        .map_err(db_err)?;
        normalize_card_positions(&tx, &card.list_id)?;
        touch_board(&tx, &card.board_id)?;
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
    let position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM cards \
             WHERE list_id = ?1 AND deleted_at IS NULL",
            [&card.list_id],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    let now = now_iso();
    card.deleted_at = None;
    card.position = position;
    card.updated_at = now;
    tx.execute(
        "UPDATE cards SET deleted_at = NULL, position = ?1, updated_at = ?2 WHERE id = ?3",
        params![card.position, &card.updated_at, &card.id],
    )
    .map_err(db_err)?;
    touch_board(&tx, &card.board_id)?;
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
    let target = get_list(&tx, &input.to_list_id)?;
    if target.board_id != card.board_id {
        return Err("不能跨看板移动任务".to_string());
    }
    let old_list_id = card.list_id.clone();
    // 目标列表内除自身外的**活动**卡片，按 position 升序（回收站卡片不参与排序）。
    let mut ids: Vec<String> = {
        let mut statement = tx
            .prepare(
                "SELECT id FROM cards WHERE list_id = ?1 AND id != ?2 AND deleted_at IS NULL \
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
    if old_list_id != card.list_id {
        normalize_card_positions(&tx, &old_list_id)?;
    }
    touch_board(&tx, &card.board_id)?;
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
        title,
        description,
        due_date: None,
        start_date: None,
        priority: None,
        completed: false,
        deleted_at: None,
        labels: Vec::new(),
        subtasks: Vec::new(),
        position,
        created_at: now.clone(),
        updated_at: now,
    };
    let labels_json = labels_to_json(&card.labels)?;
    let subtasks_json = subtasks_to_json(&card.subtasks)?;
    tx.execute(
        "INSERT INTO cards \
         (id, board_id, list_id, title, description, due_date, start_date, priority, completed, \
         labels, subtasks, position, deleted_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6, ?7, ?8, ?9, NULL, ?10, ?11)",
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
        for expected in ["boards", "lists", "cards", "inbox_items"] {
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
            },
        )
        .expect_err("不能依赖自己");
        assert!(err.contains("自己"), "错误：{err}");

        let err = set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: a.id.clone(),
                depends_on: vec![other.id.clone()],
            },
        )
        .expect_err("不能跨看板");
        assert!(err.contains("同一看板"), "错误：{err}");

        let err = set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: a.id.clone(),
                depends_on: vec!["c_missing".to_string()],
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
            },
        )
        .expect("B 依赖 A");
        let err = set_card_dependencies(
            &mut conn,
            SetDependenciesInput {
                card_id: a.id.clone(),
                depends_on: vec![b.id.clone()],
            },
        )
        .expect_err("循环依赖");
        assert!(err.contains("循环"), "错误：{err}");
    }
}
