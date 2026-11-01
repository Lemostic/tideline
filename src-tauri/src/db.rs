//! SQLite 连接管理：数据库文件位于 `app_data_dir/tideline.db`。
//!
//! 启动时开启 WAL 与外键约束，并幂等建表；表结构中的外键配合 `ON DELETE CASCADE`
//! 实现「删看板 → 删列表 → 删任务」的级联，position 由数据访问层维护。
//!
//! V0.2 起任务表新增 `start_date / labels / subtasks` 三列，V0.3 再新增 `deleted_at`
//! 软删除列：新库直接按最新结构建表，旧库（V0.1 / V0.2 已有用户数据）在启动时按列存在性
//! 做幂等 `ALTER TABLE` 迁移，不重建表。V0.4 新增 `card_dependencies` 依赖表。
//! 迁移完成后写入 `PRAGMA user_version = 11`。
//!
//! V0.10 新增「桌面软件使用统计」三张表：`usage_apps`（应用清单与勾选状态）、
//! `usage_daily`（按日聚合的使用秒数）、`usage_settings`（暂停开关与空闲阈值）。
//! 这三张表不建外键：应用清单与统计数据互相独立，清空统计记录不会影响应用清单。

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
    label_colors TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lists (
    id         TEXT PRIMARY KEY NOT NULL,
    board_id   TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT 'slate',
    wip_limit  INTEGER,
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
    estimated_minutes INTEGER CHECK (estimated_minutes >= 0),
    actual_minutes INTEGER CHECK (actual_minutes >= 0),
    priority    TEXT CHECK (priority IN ('low', 'medium', 'high') OR priority IS NULL),
    accent      TEXT,
    completed   INTEGER NOT NULL DEFAULT 0,
    labels      TEXT NOT NULL DEFAULT '[]',
    subtasks    TEXT NOT NULL DEFAULT '[]',
    position    INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    recurrence_id      TEXT,
    generated_from_id  TEXT,
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

CREATE TABLE IF NOT EXISTS goals (
    id              TEXT PRIMARY KEY NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    scope           TEXT NOT NULL DEFAULT 'team',
    status          TEXT NOT NULL DEFAULT 'active',
    start_date      TEXT,
    due_date        TEXT,
    manual_progress INTEGER NOT NULL DEFAULT 0,
    parent_id       TEXT REFERENCES goals (id) ON DELETE SET NULL,
    position        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_cards (
    goal_id  TEXT NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
    card_id  TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (goal_id, card_id)
);

CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#0f766e',
    status      TEXT NOT NULL DEFAULT 'active',
    starred     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_meta_fields (
    id         TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    value      TEXT NOT NULL DEFAULT '',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_roles (
    id         TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#64748b',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
    id          TEXT PRIMARY KEY NOT NULL,
    project_id  TEXT REFERENCES projects (id) ON DELETE CASCADE,
    role_id     TEXT REFERENCES project_roles (id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'other',
    status      TEXT NOT NULL DEFAULT 'active',
    joined_at   TEXT NOT NULL,
    released_at TEXT,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS overtime_records (
    id         TEXT PRIMARY KEY NOT NULL,
    project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
    member_id  TEXT NOT NULL REFERENCES team_members (id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    hours      REAL NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'planned',
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_tenures (
    id         TEXT PRIMARY KEY NOT NULL,
    member_id  TEXT NOT NULL REFERENCES team_members (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS performance_records (
    id         TEXT PRIMARY KEY NOT NULL,
    project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
    member_id  TEXT NOT NULL REFERENCES team_members (id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    points     INTEGER NOT NULL DEFAULT 0,
    reason     TEXT NOT NULL,
    category   TEXT NOT NULL DEFAULT 'other',
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

-- V0.10 桌面软件使用统计：应用清单（app_key 为 exe 文件名去 .exe 后的小写形式）
CREATE TABLE IF NOT EXISTS usage_apps (
    app_key    TEXT PRIMARY KEY NOT NULL,
    app_name   TEXT NOT NULL,
    exe_path   TEXT NOT NULL DEFAULT '',
    included   INTEGER NOT NULL DEFAULT 1,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL
);

-- V0.10 使用秒数按「应用 + 本地日期」聚合，PK 保证同一天重复写入只会累加
CREATE TABLE IF NOT EXISTS usage_daily (
    app_key TEXT NOT NULL,
    day     TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (app_key, day)
);

-- V0.10 统计设置：固定单行 id = 1
CREATE TABLE IF NOT EXISTS usage_settings (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    paused         INTEGER NOT NULL DEFAULT 0,
    idle_threshold INTEGER NOT NULL DEFAULT 300,
    updated_at     TEXT NOT NULL
);

-- V0.11 重复任务配置：一张任务最多挂一条重复配置
CREATE TABLE IF NOT EXISTS recurrences (
    id             TEXT PRIMARY KEY NOT NULL,
    card_id        TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    frequency      TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'interval')),
    interval_value INTEGER NOT NULL DEFAULT 1,
    weekdays       TEXT NOT NULL DEFAULT '[]',
    next_due_date  TEXT,
    enabled        INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

-- V0.11 重复生成记录：完成事件幂等保护，重试不会重复生成下一次任务
CREATE TABLE IF NOT EXISTS recurrence_runs (
    recurrence_id      TEXT NOT NULL REFERENCES recurrences (id) ON DELETE CASCADE,
    completed_card_id  TEXT NOT NULL,
    generated_card_id  TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    PRIMARY KEY (recurrence_id, completed_card_id)
);

-- V0.11 本地规则：移动到指定列 / 完成任务时执行声明式动作
CREATE TABLE IF NOT EXISTS automation_rules (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    trigger     TEXT NOT NULL CHECK (trigger IN ('move_to_list', 'complete')),
    list_id     TEXT,
    actions     TEXT NOT NULL DEFAULT '[]',
    enabled     INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- V0.11 活动日志：记录任务字段变化
CREATE TABLE IF NOT EXISTS card_activity (
    id         TEXT PRIMARY KEY NOT NULL,
    card_id    TEXT NOT NULL,
    event_type TEXT NOT NULL,
    field      TEXT NOT NULL DEFAULT '',
    old_value  TEXT NOT NULL DEFAULT '',
    new_value  TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

-- V0.11 提醒设置：固定单行 id = 1
CREATE TABLE IF NOT EXISTS notification_settings (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    due_enabled          INTEGER NOT NULL DEFAULT 0,
    overdue_enabled      INTEGER NOT NULL DEFAULT 0,
    daily_summary_enabled INTEGER NOT NULL DEFAULT 0,
    daily_summary_time   TEXT NOT NULL DEFAULT '09:00',
    lead_days            INTEGER NOT NULL DEFAULT 1,
    updated_at           TEXT NOT NULL
);

-- V0.11 通知投递记录：保证同一天同一条提醒只发一次
CREATE TABLE IF NOT EXISTS notification_deliveries (
    kind         TEXT NOT NULL,
    day          TEXT NOT NULL,
    card_id      TEXT NOT NULL DEFAULT '',
    delivered_at TEXT NOT NULL,
    PRIMARY KEY (kind, day, card_id)
);

CREATE INDEX IF NOT EXISTS idx_lists_board_position ON lists (board_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_list_position ON cards (list_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_board ON cards (board_id);
CREATE INDEX IF NOT EXISTS idx_cards_due_date ON cards (due_date);
CREATE INDEX IF NOT EXISTS idx_inbox_created_at ON inbox_items (created_at);
CREATE INDEX IF NOT EXISTS idx_card_dependencies_depends_on ON card_dependencies (depends_on_card_id);
CREATE INDEX IF NOT EXISTS idx_board_set_boards_board ON board_set_boards (board_id);
CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals (parent_id);
CREATE INDEX IF NOT EXISTS idx_goal_cards_card ON goal_cards (card_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
CREATE INDEX IF NOT EXISTS idx_project_meta_project ON project_meta_fields (project_id, position);
CREATE INDEX IF NOT EXISTS idx_project_roles_project ON project_roles (project_id, position);
CREATE INDEX IF NOT EXISTS idx_team_members_status ON team_members (status);
CREATE INDEX IF NOT EXISTS idx_member_tenures_member ON member_tenures (member_id, started_at);
CREATE INDEX IF NOT EXISTS idx_member_tenures_project ON member_tenures (project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_overtime_member_date ON overtime_records (member_id, date);
CREATE INDEX IF NOT EXISTS idx_performance_member_date ON performance_records (member_id, date);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily (day);
CREATE INDEX IF NOT EXISTS idx_recurrences_card ON recurrences (card_id);
CREATE INDEX IF NOT EXISTS idx_automation_rules_trigger ON automation_rules (trigger, enabled);
CREATE INDEX IF NOT EXISTS idx_card_activity_card ON card_activity (card_id, created_at DESC);
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
const SCHEMA_VERSION: i64 = 14;

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
    ("accent", "ALTER TABLE cards ADD COLUMN accent TEXT"),
    ("estimated_minutes", "ALTER TABLE cards ADD COLUMN estimated_minutes INTEGER CHECK (estimated_minutes >= 0)"),
    ("actual_minutes", "ALTER TABLE cards ADD COLUMN actual_minutes INTEGER CHECK (actual_minutes >= 0)"),
    // V0.11 自动化：重复任务配置与「由哪条重复配置生成」的溯源字段
    ("recurrence_id", "ALTER TABLE cards ADD COLUMN recurrence_id TEXT"),
    (
        "generated_from_id",
        "ALTER TABLE cards ADD COLUMN generated_from_id TEXT",
    ),
];

const LIST_COLUMN_MIGRATIONS: &[(&str, &str)] = &[
    (
        "color",
        "ALTER TABLE lists ADD COLUMN color TEXT NOT NULL DEFAULT 'slate'",
    ),
    ("wip_limit", "ALTER TABLE lists ADD COLUMN wip_limit INTEGER"),
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
    if !table_columns(connection, "boards")?.iter().any(|name| name == "label_colors") {
        connection.execute_batch("ALTER TABLE boards ADD COLUMN label_colors TEXT NOT NULL DEFAULT '{}'")
            .map_err(|error| format!("迁移 boards.label_colors 失败：{error}"))?;
    }
    let existing_lists = table_columns(connection, "lists")?;
    for (column, statement) in LIST_COLUMN_MIGRATIONS {
        if existing_lists.iter().any(|name| name == column) {
            continue;
        }
        connection.execute_batch(statement).map_err(|error| {
            format!("迁移 lists.{column} 失败（请先备份数据库后重试）：{error}")
        })?;
    }
    for (table, column, statement) in [
        (
            "team_members",
            "project_id",
            "ALTER TABLE team_members ADD COLUMN project_id TEXT",
        ),
        (
            "team_members",
            "role_id",
            "ALTER TABLE team_members ADD COLUMN role_id TEXT",
        ),
        (
            "overtime_records",
            "project_id",
            "ALTER TABLE overtime_records ADD COLUMN project_id TEXT",
        ),
        (
            "performance_records",
            "project_id",
            "ALTER TABLE performance_records ADD COLUMN project_id TEXT",
        ),
    ] {
        let existing_columns = table_columns(connection, table)?;
        if existing_columns.iter().any(|name| name == column) {
            continue;
        }
        connection.execute_batch(statement).map_err(|error| {
            format!("迁移 {table}.{column} 失败（请先备份数据库后重试）：{error}")
        })?;
    }
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                 id          TEXT PRIMARY KEY NOT NULL,
                 name        TEXT NOT NULL,
                 description TEXT NOT NULL DEFAULT '',
                 color       TEXT NOT NULL DEFAULT '#0f766e',
                 status      TEXT NOT NULL DEFAULT 'active',
                 starred     INTEGER NOT NULL DEFAULT 0,
                 created_at  TEXT NOT NULL,
                 updated_at  TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS project_meta_fields (
                 id         TEXT PRIMARY KEY NOT NULL,
                 project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
                 name       TEXT NOT NULL,
                 value      TEXT NOT NULL DEFAULT '',
                 position   INTEGER NOT NULL DEFAULT 0,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS project_roles (
                 id         TEXT PRIMARY KEY NOT NULL,
                 project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
                 name       TEXT NOT NULL,
                 color      TEXT NOT NULL DEFAULT '#64748b',
                 position   INTEGER NOT NULL DEFAULT 0,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS member_tenures (
                 id         TEXT PRIMARY KEY NOT NULL,
                 member_id  TEXT NOT NULL REFERENCES team_members (id) ON DELETE CASCADE,
                 project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
                 started_at TEXT NOT NULL,
                 ended_at   TEXT,
                 note       TEXT NOT NULL DEFAULT '',
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
             CREATE INDEX IF NOT EXISTS idx_project_meta_project ON project_meta_fields (project_id, position);
             CREATE INDEX IF NOT EXISTS idx_project_roles_project ON project_roles (project_id, position);
             CREATE INDEX IF NOT EXISTS idx_team_members_project ON team_members (project_id);
             CREATE INDEX IF NOT EXISTS idx_member_tenures_member ON member_tenures (member_id, started_at);
             CREATE INDEX IF NOT EXISTS idx_member_tenures_project ON member_tenures (project_id, started_at);
             CREATE INDEX IF NOT EXISTS idx_overtime_project_date ON overtime_records (project_id, date);
             CREATE INDEX IF NOT EXISTS idx_performance_project_date ON performance_records (project_id, date);
             CREATE INDEX IF NOT EXISTS idx_cards_deleted_at ON cards (deleted_at);
             CREATE INDEX IF NOT EXISTS idx_card_dependencies_depends_on ON card_dependencies (depends_on_card_id);
             CREATE INDEX IF NOT EXISTS idx_board_set_boards_board ON board_set_boards (board_id);
             CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals (parent_id);
             CREATE INDEX IF NOT EXISTS idx_goal_cards_card ON goal_cards (card_id);",
        )
        .map_err(|error| format!("创建项目/角色/元数据表失败：{error}"))?;
    migrate_legacy_team_projects(connection)?;
    backfill_member_tenures(connection)?;
    ensure_usage_settings(connection)?;
    ensure_notification_settings(connection)?;
    connection
        .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
        .map_err(|error| format!("写入 user_version 失败：{error}"))?;
    Ok(())
}

/// V0.11：保证 `notification_settings` 始终存在 id = 1 的单行默认设置。
///
/// 所有提醒默认关闭；重复执行不会覆盖用户已保存的设置。
fn ensure_notification_settings(connection: &Connection) -> Result<(), String> {
    let stamp: String = connection
        .query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取迁移时间失败：{error}"))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO notification_settings \
             (id, due_enabled, overdue_enabled, daily_summary_enabled, daily_summary_time, \
              lead_days, updated_at) \
             VALUES (1, 0, 0, 0, '09:00', 1, ?1)",
            [&stamp],
        )
        .map_err(|error| format!("初始化提醒设置失败：{error}"))?;
    Ok(())
}

/// V0.10：保证 `usage_settings` 始终存在 id = 1 的单行默认设置。
///
/// 设置表用 `CHECK (id = 1)` 保证只有一行，缺失时补一条默认记录：
/// 不暂停、空闲阈值 300 秒。重复执行不会覆盖用户已保存的设置。
fn ensure_usage_settings(connection: &Connection) -> Result<(), String> {
    let stamp: String = connection
        .query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取迁移时间失败：{error}"))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO usage_settings (id, paused, idle_threshold, updated_at) \
             VALUES (1, 0, 300, ?1)",
            [&stamp],
        )
        .map_err(|error| format!("初始化使用统计设置失败：{error}"))?;
    Ok(())
}

/// V0.8.3：成员历史投入时间段表为空时，用成员的 joined_at / released_at 补首段。
/// 已是多段记录的用户不会被重复补段。
fn backfill_member_tenures(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO member_tenures \
             (id, member_id, project_id, started_at, ended_at, note, created_at, updated_at) \
             SELECT 'mt_mig_' || id, id, project_id, \
                    COALESCE(NULLIF(joined_at, ''), date('now')), \
                    CASE WHEN status = 'released' THEN COALESCE(NULLIF(released_at, ''), joined_at) ELSE NULL END, \
                    '由历史成员记录迁移', created_at, updated_at \
             FROM team_members \
             WHERE project_id IS NOT NULL AND project_id <> '' \
               AND NOT EXISTS (SELECT 1 FROM member_tenures WHERE member_tenures.member_id = team_members.id)",
            [],
        )
        .map_err(|error| format!("迁移成员投入时间段失败：{error}"))?;
    Ok(())
}

/// V0.8 → V0.9：旧团队数据没有项目维度。若存在旧成员，则创建一个「默认项目」，
/// 补默认角色与成员归属、加班/绩效归属，保证升级不丢历史记录。
fn migrate_legacy_team_projects(connection: &Connection) -> Result<(), String> {
    let missing: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM team_members WHERE project_id IS NULL OR project_id = ''",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查旧项目成员失败：{error}"))?;
    if missing == 0 {
        return Ok(());
    }
    let stamp: String = connection
        .query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取迁移时间失败：{error}"))?;
    let default_project = "p_default";
    connection
        .execute(
            "INSERT OR IGNORE INTO projects \
             (id, name, description, color, status, starred, created_at, updated_at) \
             VALUES (?1, '默认项目', '由 V0.8 项目组数据自动迁移', '#0f766e', 'active', 0, ?2, ?2)",
            rusqlite::params![default_project, &stamp],
        )
        .map_err(|error| format!("创建默认项目失败：{error}"))?;
    let roles = [
        ("pr_default_dev", "开发", "#2f6fd0"),
        ("pr_default_test", "测试", "#9a6512"),
        ("pr_default_requirements", "需求", "#0f766e"),
        ("pr_default_design", "设计", "#5a48c9"),
        ("pr_default_other", "其他", "#64748b"),
    ];
    for (id, name, color) in roles {
        connection
            .execute(
                "INSERT OR IGNORE INTO project_roles \
                 (id, project_id, name, color, position, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
                rusqlite::params![id, default_project, name, color, &stamp],
            )
            .map_err(|error| format!("创建默认角色失败：{error}"))?;
    }
    connection
        .execute_batch(
            "UPDATE team_members SET project_id = 'p_default' \
                 WHERE project_id IS NULL OR project_id = '';
             UPDATE team_members SET role_id = CASE role
                 WHEN 'dev' THEN 'pr_default_dev'
                 WHEN 'test' THEN 'pr_default_test'
                 WHEN 'requirements' THEN 'pr_default_requirements'
                 WHEN 'design' THEN 'pr_default_design'
                 ELSE 'pr_default_other' END
                 WHERE role_id IS NULL OR role_id = '';
             UPDATE overtime_records SET project_id = COALESCE(
                 (SELECT project_id FROM team_members WHERE team_members.id = overtime_records.member_id),
                 'p_default')
                 WHERE project_id IS NULL OR project_id = '';
             UPDATE performance_records SET project_id = COALESCE(
                 (SELECT project_id FROM team_members WHERE team_members.id = performance_records.member_id),
                 'p_default')
                 WHERE project_id IS NULL OR project_id = '';",
        )
        .map_err(|error| format!("迁移旧项目成员归属失败：{error}"))?;
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
            "recurrence_id",
            "generated_from_id",
            "estimated_minutes",
            "actual_minutes",
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

    /// V0.11 新增的自动化表应存在，且提醒设置默认一行且全部关闭。
    #[test]
    fn new_database_has_automation_tables() {
        let connection = open_in_memory().expect("内存数据库应可初始化");
        for table in [
            "recurrences",
            "recurrence_runs",
            "automation_rules",
            "card_activity",
            "notification_settings",
            "notification_deliveries",
        ] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("查询表是否存在");
            assert_eq!(count, 1, "新库缺少表 {table}");
        }
        let (due, overdue, summary): (i64, i64, i64) = connection
            .query_row(
                "SELECT due_enabled, overdue_enabled, daily_summary_enabled \
                 FROM notification_settings WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("读取提醒设置默认值");
        assert_eq!((due, overdue, summary), (0, 0, 0), "提醒默认应全部关闭");
    }

    /// V0.11 迁移：旧库缺列时幂等补齐，且不丢用户数据。
    #[test]
    fn v11_database_migrates_to_v12_without_losing_cards() {
        let connection = Connection::open_in_memory().expect("内存数据库应可初始化");
        connection
            .execute_batch(V01_SCHEMA)
            .expect("创建 V0.1 表结构");
        connection
            .execute(
                "INSERT INTO boards (id, title, description, color, starred, created_at, updated_at) \
                 VALUES ('b_1', '旧看板', '', 'blue', 0, '2026-01-01T00:00:00.000Z', \
                 '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("插入旧看板");
        connection
            .execute(
                "INSERT INTO lists (id, board_id, title, position, created_at) \
                 VALUES ('l_1', 'b_1', '待办', 0, '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("插入旧列表");
        connection
            .execute(
                "INSERT INTO cards (id, board_id, list_id, title, description, due_date, priority, \
                 completed, position, created_at, updated_at) \
                 VALUES ('c_1', 'b_1', 'l_1', '旧任务', '', '2026-02-01', NULL, 0, 0, \
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("插入旧任务");

        init(&connection).expect("迁移旧库");

        let columns = table_columns(&connection, "cards").expect("读取 cards 列名");
        assert!(columns.iter().any(|name| name == "recurrence_id"));
        assert!(columns.iter().any(|name| name == "generated_from_id"));

        let title: String = connection
            .query_row("SELECT title FROM cards WHERE id = 'c_1'", [], |row| {
                row.get(0)
            })
            .expect("读取迁移后的任务");
        assert_eq!(title, "旧任务");

        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("读取 user_version");
        assert_eq!(version, SCHEMA_VERSION);

        // 幂等：重复迁移不报错，也不丢数据。
        init(&connection).expect("重复迁移");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .expect("统计任务数");
        assert_eq!(count, 1);
    }

    #[test]
    fn legacy_boards_gain_empty_label_colors_without_losing_data() {
        let connection = Connection::open_in_memory().expect("memory database");
        let old_schema = SCHEMA.replace("    label_colors TEXT NOT NULL DEFAULT '{}',\n", "");
        connection.execute_batch(&old_schema).expect("create old schema");
        connection.execute("INSERT INTO boards (id, title, created_at, updated_at) VALUES ('b', 'board', 'now', 'now')", [])
            .expect("seed old board");
        migrate_schema(&connection).expect("migrate label colors");
        migrate_schema(&connection).expect("idempotent migration");
        let (title, colors): (String, String) = connection.query_row(
            "SELECT title, label_colors FROM boards WHERE id = 'b'", [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).expect("read migrated board");
        assert_eq!((title.as_str(), colors.as_str()), ("board", "{}"));
    }

    #[test]
    fn v12_cards_gain_nullable_minutes_without_losing_existing_values() {
        let connection = Connection::open_in_memory().expect("memory database");
        let v12_schema = SCHEMA.replace(
            "    estimated_minutes INTEGER CHECK (estimated_minutes >= 0),\n    actual_minutes INTEGER CHECK (actual_minutes >= 0),\n",
            "",
        );
        connection.execute_batch(&v12_schema).expect("create v12 schema");
        connection.execute_batch(
            "INSERT INTO boards (id, title, created_at, updated_at) VALUES ('b', 'board', 'now', 'now');
             INSERT INTO lists (id, board_id, title, created_at) VALUES ('l', 'b', 'list', 'now');
             INSERT INTO cards (id, board_id, list_id, title, created_at, updated_at)
                 VALUES ('c', 'b', 'l', 'card', 'now', 'now');
             PRAGMA user_version = 12;"
        ).expect("seed v12 card");
        migrate_schema(&connection).expect("migrate to v14");
        let values: (String, Option<i64>, Option<i64>) = connection.query_row(
            "SELECT title, estimated_minutes, actual_minutes FROM cards WHERE id = 'c'", [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).expect("read migrated card");
        assert_eq!(values, ("card".to_string(), None, None));
        connection.execute("UPDATE cards SET estimated_minutes = 55, actual_minutes = 22 WHERE id = 'c'", [])
            .expect("set minutes");
        migrate_schema(&connection).expect("idempotent migration");
        let minutes: (Option<i64>, Option<i64>) = connection.query_row(
            "SELECT estimated_minutes, actual_minutes FROM cards WHERE id = 'c'", [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).expect("read preserved minutes");
        assert_eq!(minutes, (Some(55), Some(22)));
        assert_eq!(connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
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
        for expected in ["start_date", "labels", "subtasks", "deleted_at", "estimated_minutes", "actual_minutes"] {
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

    #[test]
    fn v08_team_member_moves_into_default_project() {
        let connection = open_in_memory().expect("内存库");
        connection
            .execute(
                "INSERT INTO team_members \
                 (id, name, role, status, joined_at, released_at, note, created_at, updated_at) \
                 VALUES ('m_old', '旧成员', 'dev', 'active', '2026-09-01', NULL, '', \
                         '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')",
                [],
            )
            .expect("插入 V0.8 成员");
        migrate_legacy_team_projects(&connection).expect("迁移旧项目组");
        backfill_member_tenures(&connection).expect("补历史投入段");
        let project_id: String = connection
            .query_row(
                "SELECT project_id FROM team_members WHERE id = 'm_old'",
                [],
                |row| row.get(0),
            )
            .expect("读取项目归属");
        assert_eq!(project_id, "p_default");
        let role_id: String = connection
            .query_row(
                "SELECT role_id FROM team_members WHERE id = 'm_old'",
                [],
                |row| row.get(0),
            )
            .expect("读取角色");
        assert_eq!(role_id, "pr_default_dev");
        let role_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM project_roles WHERE project_id = 'p_default'",
                [],
                |row| row.get(0),
            )
            .expect("默认角色数");
        assert_eq!(role_count, 5);
        let tenure_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM member_tenures WHERE member_id = 'm_old'",
                [],
                |row| row.get(0),
            )
            .expect("历史投入段数");
        assert_eq!(tenure_count, 1);
    }
}
