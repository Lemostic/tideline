//! SQLite 连接管理：数据库文件位于 `app_data_dir/tideline.db`。
//!
//! 启动时开启 WAL 与外键约束，并幂等建表；表结构中的外键配合 `ON DELETE CASCADE`
//! 实现「删看板 → 删列表 → 删任务」的级联，position 由数据访问层维护。
//!
//! V0.2 起任务表新增 `start_date / labels / subtasks` 三列，V0.3 再新增 `deleted_at`
//! 软删除列：新库直接按最新结构建表，旧库（V0.1 / V0.2 已有用户数据）在启动时按列存在性
//! 做幂等 `ALTER TABLE` 迁移，不重建表。V0.4 新增 `card_dependencies` 依赖表。
//! 迁移完成后写入 `PRAGMA user_version = 4`。

use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

/// 由 Tauri 以 `State` 形式托管的数据库句柄。
///
/// rusqlite 的 `Connection` 不是 `Sync`，包一层 `Mutex` 后即可安全放进 Tauri 状态；
/// 内部用 `Option` 保存连接，切换自定义数据目录时可以短暂移除后重新打开。
pub struct Db(Mutex<Option<Connection>>);

impl Db {
    pub fn new(connection: Connection) -> Self {
        Self(Mutex::new(Some(connection)))
    }

    pub fn lock(&self) -> Result<DbGuard<'_>, String> {
        let guard = self
            .0
            .lock()
            .map_err(|_| "数据库连接繁忙，请稍后重试".to_string())?;
        if guard.is_none() {
            return Err("正在切换数据目录，请稍后重试".to_string());
        }
        Ok(DbGuard(guard))
    }

    /// 取出连接（用于切换数据目录）；取出后其它命令会收到「正在切换」错误。
    pub fn take(&self) -> Result<Connection, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "数据库连接繁忙，请稍后重试".to_string())?;
        guard
            .take()
            .ok_or_else(|| "正在切换数据目录，请稍后重试".to_string())
    }

    /// 放回一个已打开的新连接。
    pub fn put(&self, connection: Connection) -> Result<(), String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "数据库连接繁忙，请稍后重试".to_string())?;
        *guard = Some(connection);
        Ok(())
    }
}

/// 对 `Option<Connection>` 的轻量 guard：Deref 到 Connection，
/// 让 20 多个命令保持原来的 `&conn` / `&mut conn` 写法不变。
pub struct DbGuard<'a>(MutexGuard<'a, Option<Connection>>);

impl Deref for DbGuard<'_> {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        self.0
            .as_ref()
            .expect("数据库连接在命令执行期间不应为空")
    }
}

impl DerefMut for DbGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0
            .as_mut()
            .expect("数据库连接在命令执行期间不应为空")
    }
}

/// 建表语句：幂等，便于 V0.1 直接 `CREATE TABLE IF NOT EXISTS`。
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS boards (
    id          TEXT PRIMARY KEY NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT 'blue',
    starred     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lists (
    id         TEXT PRIMARY KEY NOT NULL,
    board_id   TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
    id          TEXT PRIMARY KEY NOT NULL,
    board_id    TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    list_id     TEXT NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_date    TEXT,
    start_date  TEXT,
    priority    TEXT CHECK (priority IN ('low', 'medium', 'high') OR priority IS NULL),
    completed   INTEGER NOT NULL DEFAULT 0,
    labels      TEXT NOT NULL DEFAULT '[]',
    subtasks    TEXT NOT NULL DEFAULT '[]',
    position    INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_items (
    id         TEXT PRIMARY KEY NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_dependencies (
    card_id            TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    depends_on_card_id TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, depends_on_card_id)
);

CREATE TABLE IF NOT EXISTS board_sets (
    id          TEXT PRIMARY KEY NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_set_boards (
    set_id   TEXT NOT NULL REFERENCES board_sets (id) ON DELETE CASCADE,
    board_id TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (set_id, board_id)
);

CREATE INDEX IF NOT EXISTS idx_lists_board_position ON lists (board_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_list_position ON cards (list_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_board ON cards (board_id);
CREATE INDEX IF NOT EXISTS idx_cards_due_date ON cards (due_date);
CREATE INDEX IF NOT EXISTS idx_inbox_created_at ON inbox_items (created_at);
CREATE INDEX IF NOT EXISTS idx_card_dependencies_depends_on ON card_dependencies (depends_on_card_id);
CREATE INDEX IF NOT EXISTS idx_board_set_boards_board ON board_set_boards (board_id);
"#;

/// 打开磁盘数据库（生产路径）。
pub fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    init(&connection)?;
    Ok(connection)
}

/// 打开内存数据库（单元测试专用）。
#[cfg(test)]
pub fn open_in_memory() -> Result<Connection, String> {
    let connection = Connection::open_in_memory().map_err(|error| error.to_string())?;
    init(&connection)?;
    Ok(connection)
}

fn init(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(SCHEMA)
        .map_err(|error| error.to_string())?;
    migrate_schema(connection)?;
    Ok(())
}

/// 当前 schema 版本，写入 `PRAGMA user_version` 便于排查用户库结构。
const SCHEMA_VERSION: i64 = 5;

/// 任务表历史演进新增列：列名 → 旧库迁移用的 `ALTER TABLE` 语句。
///
/// `CREATE TABLE IF NOT EXISTS` 只对空库生效；已有用户的 cards 表不会被改写，
/// 因此需要按列存在性逐列补齐（可重复执行，失败会带回具体列名）：
/// - V0.2：start_date / labels / subtasks
/// - V0.3：deleted_at（回收站软删除）
const CARD_COLUMN_MIGRATIONS: &[(&str, &str)] = &[
    ("start_date", "ALTER TABLE cards ADD COLUMN start_date TEXT"),
    (
        "labels",
        "ALTER TABLE cards ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'",
    ),
    (
        "subtasks",
        "ALTER TABLE cards ADD COLUMN subtasks TEXT NOT NULL DEFAULT '[]'",
    ),
    ("deleted_at", "ALTER TABLE cards ADD COLUMN deleted_at TEXT"),
];

/// 幂等迁移：缺哪列补哪列，不重建表、不丢用户数据。
///
/// 注意 `cards(deleted_at)` 索引必须放在补列之后：旧库在 `CREATE TABLE IF NOT EXISTS`
/// 阶段还没有 deleted_at 列，提前建索引会直接报错。
fn migrate_schema(connection: &Connection) -> Result<(), String> {
    let existing = table_columns(connection, "cards")?;
    for (column, statement) in CARD_COLUMN_MIGRATIONS {
        if existing.iter().any(|name| name == column) {
            continue;
        }
        connection.execute_batch(statement).map_err(|error| {
            format!("迁移 cards.{column} 失败（请先备份数据库后重试）：{error}")
        })?;
    }
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_cards_deleted_at ON cards (deleted_at);
             CREATE TABLE IF NOT EXISTS card_dependencies (
                 card_id            TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
                 depends_on_card_id TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
                 PRIMARY KEY (card_id, depends_on_card_id)
             );
             CREATE INDEX IF NOT EXISTS idx_card_dependencies_depends_on
                 ON card_dependencies (depends_on_card_id);
             CREATE TABLE IF NOT EXISTS board_sets (
                 id          TEXT PRIMARY KEY NOT NULL,
                 title       TEXT NOT NULL,
                 description TEXT NOT NULL DEFAULT '',
                 created_at  TEXT NOT NULL,
                 updated_at  TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS board_set_boards (
                 set_id   TEXT NOT NULL REFERENCES board_sets (id) ON DELETE CASCADE,
                 board_id TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
                 position INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY (set_id, board_id)
             );
             CREATE INDEX IF NOT EXISTS idx_board_set_boards_board
                 ON board_set_boards (board_id);",
        )
        .map_err(|error| format!("创建任务依赖/看板集表失败：{error}"))?;
    connection
        .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
        .map_err(|error| format!("写入 user_version 失败：{error}"))?;
    Ok(())
}

/// 读取某张表的列名（`PRAGMA table_info` 的第 2 列）。
fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("读取 {table} 表结构失败：{error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("读取 {table} 表结构失败：{error}"))?;
    rows.collect::<rusqlite::Result<Vec<String>>>()
        .map_err(|error| format!("读取 {table} 表结构失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_db_has_foreign_keys_enabled() {
        let connection = open_in_memory().expect("内存数据库应可初始化");
        let enabled: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("读取 foreign_keys pragma");
        assert_eq!(enabled, 1);
    }

    #[test]
    fn file_database_uses_wal_mode() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("tideline-wal-test-{stamp}.db"));
        let connection = open(&path).expect("磁盘数据库应可初始化");
        let mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("读取 journal_mode pragma");
        assert_eq!(mode.to_lowercase(), "wal");
        drop(connection);
        remove_db_files(&path);
    }

    #[test]
    fn new_database_has_latest_columns_and_version() {
        let connection = open_in_memory().expect("内存数据库应可初始化");
        let columns = table_columns(&connection, "cards").expect("读取 cards 列名");
        for expected in [
            "due_date",
            "start_date",
            "priority",
            "labels",
            "subtasks",
            "position",
            "deleted_at",
        ] {
            assert!(
                columns.iter().any(|name| name == expected),
                "新库 cards 缺少列 {expected}"
            );
        }
        let indexes: Vec<String> = {
            let mut statement = connection
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cards'",
                )
                .expect("查询 cards 索引");
            let rows = statement
                .query_map([], |row| row.get(0))
                .expect("读取索引名");
            rows.collect::<rusqlite::Result<_>>().expect("收集索引名")
        };
        assert!(indexes.iter().any(|name| name == "idx_cards_deleted_at"));
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("读取 user_version");
        assert_eq!(version, SCHEMA_VERSION);
    }

    /// V0.1 的表结构（cards 还没有 start_date / labels / subtasks），用于迁移测试。
    const V01_SCHEMA: &str = r#"
CREATE TABLE boards (
    id          TEXT PRIMARY KEY NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT 'blue',
    starred     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE lists (
    id         TEXT PRIMARY KEY NOT NULL,
    board_id   TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE cards (
    id          TEXT PRIMARY KEY NOT NULL,
    board_id    TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    list_id     TEXT NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_date    TEXT,
    priority    TEXT,
    completed   INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
"#;

    /// V0.2 的表结构（cards 已有 start_date / labels / subtasks，但还没有 deleted_at）。
    const V02_SCHEMA: &str = r#"
CREATE TABLE boards (
    id          TEXT PRIMARY KEY NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT 'blue',
    starred     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE lists (
    id         TEXT PRIMARY KEY NOT NULL,
    board_id   TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE cards (
    id          TEXT PRIMARY KEY NOT NULL,
    board_id    TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    list_id     TEXT NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_date    TEXT,
    start_date  TEXT,
    priority    TEXT,
    completed   INTEGER NOT NULL DEFAULT 0,
    labels      TEXT NOT NULL DEFAULT '[]',
    subtasks    TEXT NOT NULL DEFAULT '[]',
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
"#;

    fn temp_db_path(prefix: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间")
            .as_nanos();
        std::env::temp_dir().join(format!("tideline-{prefix}-{stamp}.db"))
    }

    fn remove_db_files(path: &std::path::Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn old_v01_database_is_migrated_in_place() {
        let path = temp_db_path("migrate");
        {
            let raw = rusqlite::Connection::open(&path).expect("创建 V0.1 旧库");
            raw.execute_batch(V01_SCHEMA).expect("写入 V0.1 表结构");
            raw.execute(
                "INSERT INTO boards (id, title, description, color, starred, created_at, updated_at) \
                 VALUES ('b_1', '旧看板', '', 'blue', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("插入旧看板");
            raw.execute(
                "INSERT INTO lists (id, board_id, title, position, created_at) \
                 VALUES ('l_1', 'b_1', '待办', 0, '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("插入旧列表");
            raw.execute(
                "INSERT INTO cards \
                 (id, board_id, list_id, title, description, due_date, priority, completed, position, created_at, updated_at) \
                 VALUES ('c_1', 'b_1', 'l_1', '旧任务', '旧描述', '2026-01-05', 'high', 0, 0, \
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("插入旧任务");
        }

        // 首次 open：执行幂等迁移，旧数据保留。
        let connection = open(&path).expect("打开并迁移旧库");
        let columns = table_columns(&connection, "cards").expect("读取迁移后的列名");
        for expected in ["start_date", "labels", "subtasks", "deleted_at"] {
            assert!(
                columns.iter().any(|name| name == expected),
                "迁移后 cards 缺少列 {expected}"
            );
        }
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("读取 user_version");
        assert_eq!(version, SCHEMA_VERSION);
        let (title, description, due_date, labels, subtasks, start_date, deleted_at): (
            String,
            String,
            Option<String>,
            String,
            String,
            Option<String>,
            Option<String>,
        ) = connection
            .query_row(
                "SELECT title, description, due_date, labels, subtasks, start_date, deleted_at \
                 FROM cards WHERE id = 'c_1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .expect("读取迁移后的任务");
        assert_eq!(title, "旧任务");
        assert_eq!(description, "旧描述");
        assert_eq!(due_date.as_deref(), Some("2026-01-05"));
        assert_eq!(labels, "[]");
        assert_eq!(subtasks, "[]");
        assert_eq!(start_date, None);
        assert_eq!(deleted_at, None);
        drop(connection);

        // 再次 open：迁移可重复执行，不重建表、不丢数据。
        let connection = open(&path).expect("重复打开旧库");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .expect("统计任务");
        assert_eq!(count, 1);
        let title: String = connection
            .query_row("SELECT title FROM cards WHERE id = 'c_1'", [], |row| {
                row.get(0)
            })
            .expect("读取旧任务标题");
        assert_eq!(title, "旧任务");
        drop(connection);
        remove_db_files(&path);
    }

    #[test]
    fn old_v02_database_is_migrated_in_place() {
        let path = temp_db_path("migrate-v02");
        {
            let raw = rusqlite::Connection::open(&path).expect("创建 V0.2 旧库");
            raw.execute_batch(V02_SCHEMA).expect("写入 V0.2 表结构");
            raw.execute(
                "INSERT INTO boards (id, title, description, color, starred, created_at, updated_at) \
                 VALUES ('b_1', 'V0.2 看板', '', 'blue', 0, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')",
                [],
            )
            .expect("插入旧看板");
            raw.execute(
                "INSERT INTO lists (id, board_id, title, position, created_at) \
                 VALUES ('l_1', 'b_1', '待办', 0, '2026-02-01T00:00:00.000Z')",
                [],
            )
            .expect("插入旧列表");
            raw.execute(
                r#"INSERT INTO cards
                 (id, board_id, list_id, title, description, due_date, start_date, priority,
                  completed, labels, subtasks, position, created_at, updated_at)
                 VALUES ('c_1', 'b_1', 'l_1', 'V0.2 任务', '', NULL, '2026-02-01', 'high',
                         0, '["研发"]', '[{"id":"s_1","title":"步骤","done":true}]', 0,
                         '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')"#,
                [],
            )
            .expect("插入旧任务");
        }

        let connection = open(&path).expect("打开并迁移 V0.2 旧库");
        let columns = table_columns(&connection, "cards").expect("读取迁移后的列名");
        assert!(
            columns.iter().any(|name| name == "deleted_at"),
            "迁移后 cards 缺少列 deleted_at"
        );
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("读取 user_version");
        assert_eq!(version, SCHEMA_VERSION);
        let (title, start_date, labels, subtasks, deleted_at): (
            String,
            Option<String>,
            String,
            String,
            Option<String>,
        ) = connection
            .query_row(
                "SELECT title, start_date, labels, subtasks, deleted_at FROM cards WHERE id = 'c_1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("读取迁移后的 V0.2 任务");
        assert_eq!(title, "V0.2 任务");
        assert_eq!(start_date.as_deref(), Some("2026-02-01"));
        assert_eq!(labels, r#"["研发"]"#);
        assert_eq!(subtasks, r#"[{"id":"s_1","title":"步骤","done":true}]"#);
        assert_eq!(deleted_at, None);
        drop(connection);

        // 再次 open：迁移幂等。
        let connection = open(&path).expect("重复打开 V0.2 旧库");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .expect("统计任务");
        assert_eq!(count, 1);
        drop(connection);
        remove_db_files(&path);
    }
}
