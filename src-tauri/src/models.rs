//! 领域模型：与前端 `src/lib/types.ts` 一一对应。
//!
//! 所有结构体都使用 `#[serde(rename_all = "camelCase")]`，保证 `invoke` 返回的
//! JSON 字段名与前端 TypeScript 类型完全一致（`boardId`、`dueDate`、`createdAt`…）。

use serde::{Deserialize, Deserializer, Serialize};

/// 看板主题色，与前端 `BoardColor` 同一组取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoardColor {
    Blue,
    Amber,
    Coral,
    Green,
    Violet,
    Rose,
    Teal,
    Slate,
}

impl BoardColor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blue => "blue",
            Self::Amber => "amber",
            Self::Coral => "coral",
            Self::Green => "green",
            Self::Violet => "violet",
            Self::Rose => "rose",
            Self::Teal => "teal",
            Self::Slate => "slate",
        }
    }

    /// 从数据库文本还原；未知值兜底为蓝色，避免历史数据导致整块看板不可用。
    pub fn from_db(raw: &str) -> Self {
        match raw {
            "amber" => Self::Amber,
            "coral" => Self::Coral,
            "green" => Self::Green,
            "violet" => Self::Violet,
            "rose" => Self::Rose,
            "teal" => Self::Teal,
            "slate" => Self::Slate,
            _ => Self::Blue,
        }
    }
}

/// 卡片优先级，与前端 `Priority` 一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Medium,
    High,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    pub fn from_db(raw: &str) -> Option<Self> {
        match raw {
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            _ => None,
        }
    }
}

/// 目标层级（V0.6）：公司 / 团队 / 个人。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalScope {
    Company,
    Team,
    Personal,
}

impl GoalScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Company => "company",
            Self::Team => "team",
            Self::Personal => "personal",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw {
            "company" => Self::Company,
            "personal" => Self::Personal,
            _ => Self::Team,
        }
    }
}

/// 目标状态（V0.6）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalStatus {
    Active,
    Completed,
    Archived,
}

impl GoalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Completed => "completed",
            Self::Archived => "archived",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw {
            "completed" => Self::Completed,
            "archived" => Self::Archived,
            _ => Self::Active,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub title: String,
    pub description: String,
    pub color: BoardColor,
    pub starred: bool,
    pub created_at: String,
    pub updated_at: String,
}

fn default_list_color() -> BoardColor {
    BoardColor::Slate
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct List {    pub id: String,
    pub board_id: String,
    pub title: String,
    /// 列主题色（V0.7）
    #[serde(default = "default_list_color")]
    pub color: BoardColor,
    /// 在制品上限；None 表示不限制
    #[serde(default)]
    pub wip_limit: Option<i64>,
    pub position: i64,
    pub created_at: String,
}

/// 任务内的子任务（清单项），在数据库里以 JSON 文本存在 `cards.subtasks`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    pub id: String,
    pub title: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub board_id: String,
    pub list_id: String,
    pub title: String,
    pub description: String,
    pub due_date: Option<String>,
    /// 甘特视图的起始日期（YYYY-MM-DD），null 表示未排期。
    pub start_date: Option<String>,
    pub priority: Option<Priority>,
    /// 卡片强调色（V0.7），None 时使用默认卡片样式
    pub accent: Option<BoardColor>,
    pub completed: bool,
    /// 软删除时间；非 null 表示在回收站，`get_snapshot` 不会返回这些任务。
    pub deleted_at: Option<String>,
    /// 自由标签，数据库里存 JSON 数组文本。
    pub labels: Vec<String>,
    /// 子任务清单，数据库里存 JSON 数组文本。
    pub subtasks: Vec<Subtask>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub content: String,
    pub created_at: String,
}

/// 任务依赖（V0.4）：`card_id` 依赖 `depends_on_card_id`（前置任务）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDependency {
    pub card_id: String,
    pub depends_on_card_id: String,
}

/// 看板集（V0.5.4）：把多个看板聚合成一张跨看板汇总表。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSet {
    pub id: String,
    pub title: String,
    pub description: String,
    /// 成员看板 id，顺序即展示顺序；看板删除后由外键级联移除。
    pub board_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 目标（V0.6）：可嵌套子目标，可选关联任务；进度由任务/子目标自动回写。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub title: String,
    pub description: String,
    pub scope: GoalScope,
    pub status: GoalStatus,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    /// 无关联任务、无子目标时使用的手动进度（0–100）。
    pub manual_progress: i64,
    pub parent_id: Option<String>,
    /// 关联任务 id，顺序即展示顺序；任务删除后由外键级联移除。
    pub card_ids: Vec<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 项目组角色（V0.8）：开发 / 测试 / 需求 / 设计 / 其他。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemberRole {
    Dev,
    Test,
    Requirements,
    Design,
    Other,
}

impl MemberRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Test => "test",
            Self::Requirements => "requirements",
            Self::Design => "design",
            Self::Other => "other",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw {
            "dev" => Self::Dev,
            "test" => Self::Test,
            "requirements" => Self::Requirements,
            "design" => Self::Design,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemberStatus {
    Active,
    Released,
}

impl MemberStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Released => "released",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw {
            "released" => Self::Released,
            _ => Self::Active,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OvertimeStatus {
    Planned,
    Done,
}

impl OvertimeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Done => "done",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw {
            "done" => Self::Done,
            _ => Self::Planned,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PerformanceCategory {
    Delivery,
    Quality,
    Collaboration,
    Other,
}

impl PerformanceCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Delivery => "delivery",
            Self::Quality => "quality",
            Self::Collaboration => "collaboration",
            Self::Other => "other",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw {
            "delivery" => Self::Delivery,
            "quality" => Self::Quality,
            "collaboration" => Self::Collaboration,
            _ => Self::Other,
        }
    }
}

/// 项目状态（V0.9）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectStatus {
    Active,
    Archived,
}

impl ProjectStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw {
            "archived" => Self::Archived,
            _ => Self::Active,
        }
    }
}

/// 项目（V0.9）：本地可建多个项目，像看板一样维护名称、描述、颜色、星标与状态。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub status: ProjectStatus,
    pub starred: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 项目自定义元数据字段（V0.9）：每个项目可添加任意名称/值。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetaField {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub value: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 项目自定义角色（V0.9）：每个项目可维护自己的角色名称与颜色。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRole {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 项目组成员（V0.8 / V0.9）：归属某个项目，使用该项目的自定义角色。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub id: String,
    /// V0.9 新增；旧备份没有时由恢复逻辑归入默认项目。
    #[serde(default)]
    pub project_id: String,
    /// 自定义角色 id；旧备份没有时按旧枚举角色映射到默认角色。
    #[serde(default)]
    pub role_id: String,
    pub name: String,
    /// 旧版枚举角色，仅用于旧数据迁移/旧备份兼容，新 UI 使用 role_id。
    pub role: MemberRole,
    pub status: MemberStatus,
    pub joined_at: String,
    pub released_at: Option<String>,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 周末加班记录：planned=排班，done=已发生。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OvertimeRecord {
    pub id: String,
    /// V0.9 新增，按项目隔离统计。
    #[serde(default)]
    pub project_id: String,
    pub member_id: String,
    pub date: String,
    pub hours: f64,
    pub status: OvertimeStatus,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 绩效加减分记录：points 正数为加分、负数为减分。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceRecord {
    pub id: String,
    /// V0.9 新增，按项目隔离统计。
    #[serde(default)]
    pub project_id: String,
    pub member_id: String,
    pub date: String,
    pub points: i64,
    pub reason: String,
    pub category: PerformanceCategory,
    pub note: String,
    pub created_at: String,
}

/// 启动时一次性拉取的全量快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub boards: Vec<Board>,
    pub lists: Vec<List>,
    pub cards: Vec<Card>,
    pub inbox: Vec<InboxItem>,
    /// 任务依赖边（V0.4），只包含仍存在的任务。
    #[serde(default)]
    pub dependencies: Vec<CardDependency>,
    /// 看板集（V0.5.4）。
    #[serde(default)]
    pub board_sets: Vec<BoardSet>,
    /// 目标（V0.6）。
    #[serde(default)]
    pub goals: Vec<Goal>,
    /// 项目组成员（V0.8 / V0.9）。
    #[serde(default)]
    pub team_members: Vec<TeamMember>,
    /// 周末加班记录（V0.8 / V0.9）。
    #[serde(default)]
    pub overtime_records: Vec<OvertimeRecord>,
    /// 绩效加减分（V0.8 / V0.9）。
    #[serde(default)]
    pub performance_records: Vec<PerformanceRecord>,
    /// 项目（V0.9）。
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub project_meta_fields: Vec<ProjectMetaField>,
    #[serde(default)]
    pub project_roles: Vec<ProjectRole>,
}

// ---------------------------------------------------------------------------
// 备份 / 恢复（V0.4）
// ---------------------------------------------------------------------------

/// 导出的备份文件格式。`cards` 包含回收站里的任务（`deletedAt` 非空），
/// 因此恢复后回收站内容也能完整保留。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub app: String,
    pub format_version: u32,
    pub exported_at: String,
    pub boards: Vec<Board>,
    pub lists: Vec<List>,
    pub cards: Vec<Card>,
    pub inbox: Vec<InboxItem>,
    /// V0.4 新增；旧备份没有该字段时按空依赖处理。
    #[serde(default)]
    pub dependencies: Vec<CardDependency>,
    /// V0.5.4 新增；旧备份没有该字段时按空看板集处理。
    #[serde(default)]
    pub board_sets: Vec<BoardSet>,
    /// V0.6 新增；旧备份没有该字段时按空目标处理。
    #[serde(default)]
    pub goals: Vec<Goal>,
    /// V0.8 新增。
    #[serde(default)]
    pub team_members: Vec<TeamMember>,
    #[serde(default)]
    pub overtime_records: Vec<OvertimeRecord>,
    #[serde(default)]
    pub performance_records: Vec<PerformanceRecord>,
    /// V0.9 新增。
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub project_meta_fields: Vec<ProjectMetaField>,
    #[serde(default)]
    pub project_roles: Vec<ProjectRole>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub boards: usize,
    pub lists: usize,
    pub cards: usize,
    pub trashed: usize,
    pub inbox: usize,
    #[serde(default)]
    pub dependencies: usize,
    #[serde(default)]
    pub board_sets: usize,
    #[serde(default)]
    pub goals: usize,
    #[serde(default)]
    pub team_members: usize,
    #[serde(default)]
    pub overtime_records: usize,
    #[serde(default)]
    pub performance_records: usize,
    #[serde(default)]
    pub projects: usize,
    #[serde(default)]
    pub project_meta_fields: usize,
    #[serde(default)]
    pub project_roles: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExport {
    /// 备份文件写入的绝对路径（桌面端导出到「文档」目录）。
    pub path: String,
    pub summary: BackupSummary,
}

// ---------------------------------------------------------------------------
// 命令入参
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBoardInput {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<BoardColor>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<BoardColor>,
    #[serde(default)]
    pub starred: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBoardInput {
    pub id: String,
    pub patch: BoardPatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewListInput {
    pub board_id: String,
    pub title: String,
    #[serde(default)]
    pub color: Option<BoardColor>,
    #[serde(default)]
    pub wip_limit: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub color: Option<BoardColor>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub wip_limit: Option<Option<i64>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateListInput {
    pub id: String,
    pub patch: ListPatch,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCardInput {
    pub board_id: String,
    pub list_id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub priority: Option<Priority>,
    #[serde(default)]
    pub accent: Option<BoardColor>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub subtasks: Option<Vec<Subtask>>,
}

/// 把「字段缺失」与「显式 null」区分开：
/// - 字段缺失 → `None`（保持原值，对应前端 `patch.dueDate === undefined`）
/// - 显式 null → `Some(None)`（清空，对应前端 `patch.dueDate === null`）
fn deserialize_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub due_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub start_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub priority: Option<Option<Priority>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub accent: Option<Option<BoardColor>>,
    #[serde(default)]
    pub completed: Option<bool>,
    #[serde(default)]
    pub list_id: Option<String>,
    /// 标签数组：字段缺失=保持原值，传数组=整体替换。
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    /// 子任务数组：字段缺失=保持原值，传数组=整体替换。
    #[serde(default)]
    pub subtasks: Option<Vec<Subtask>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCardInput {
    pub id: String,
    pub patch: CardPatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveCardInput {
    pub card_id: String,
    pub to_list_id: String,
    pub to_index: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdInput {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddInboxInput {
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertInboxInput {
    pub id: String,
    pub board_id: String,
    #[serde(default)]
    pub list_id: Option<String>,
}

/// 从前端上传的备份文件内容（JSON 文本）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBackupInput {
    pub json: String,
}

/// 设置某张任务的前置任务（整体替换）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDependenciesInput {
    pub card_id: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

/// 切换数据存储目录。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDataDirInput {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBoardSetInput {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub board_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSetPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// 传数组时整体替换成员看板。
    #[serde(default)]
    pub board_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBoardSetInput {
    pub id: String,
    pub patch: BoardSetPatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewGoalInput {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub scope: Option<GoalScope>,
    #[serde(default)]
    pub status: Option<GoalStatus>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub manual_progress: Option<i64>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub card_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub scope: Option<GoalScope>,
    #[serde(default)]
    pub status: Option<GoalStatus>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub start_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub due_date: Option<Option<String>>,
    #[serde(default)]
    pub manual_progress: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub parent_id: Option<Option<String>>,
    /// 传数组时整体替换关联任务。
    #[serde(default)]
    pub card_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGoalInput {
    pub id: String,
    pub patch: GoalPatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub starred: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub status: Option<ProjectStatus>,
    #[serde(default)]
    pub starred: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectInput {
    pub id: String,
    pub patch: ProjectPatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProjectMetaInput {
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetaPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectMetaInput {
    pub id: String,
    pub patch: ProjectMetaPatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProjectRoleInput {
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRolePatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectRoleInput {
    pub id: String,
    pub patch: ProjectRolePatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTeamMemberInput {
    pub project_id: String,
    pub role_id: String,
    pub name: String,
    #[serde(default)]
    pub joined_at: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub role_id: Option<String>,
    #[serde(default)]
    pub status: Option<MemberStatus>,
    #[serde(default)]
    pub joined_at: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub released_at: Option<Option<String>>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTeamMemberInput {
    pub id: String,
    pub patch: TeamMemberPatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewOvertimeInput {
    pub member_id: String,
    pub date: String,
    pub hours: f64,
    #[serde(default)]
    pub status: Option<OvertimeStatus>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OvertimePatch {
    #[serde(default)]
    pub member_id: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub hours: Option<f64>,
    #[serde(default)]
    pub status: Option<OvertimeStatus>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOvertimeInput {
    pub id: String,
    pub patch: OvertimePatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPerformanceInput {
    pub member_id: String,
    pub date: String,
    pub points: i64,
    pub reason: String,
    #[serde(default)]
    pub category: Option<PerformanceCategory>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformancePatch {
    #[serde(default)]
    pub member_id: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub points: Option<i64>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub category: Option<PerformanceCategory>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePerformanceInput {
    pub id: String,
    pub patch: PerformancePatch,
}

// ---------------------------------------------------------------------------
// 单元测试：锁定与前端 TypeScript 契约一致的 JSON 形态
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_card() -> Card {
        Card {
            id: "c_1".to_string(),
            board_id: "b_1".to_string(),
            list_id: "l_1".to_string(),
            title: "任务".to_string(),
            description: "".to_string(),
            due_date: Some("2026-01-10".to_string()),
            start_date: Some("2026-02-01".to_string()),
            priority: Some(Priority::High),
            accent: None,
            completed: false,
            deleted_at: None,
            labels: vec!["研发".to_string()],
            subtasks: vec![Subtask {
                id: "s1".to_string(),
                title: "步骤".to_string(),
                done: true,
            }],
            position: 0,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn card_serializes_v02_fields_as_camel_case() {
        let json = serde_json::to_value(sample_card()).expect("序列化卡片");
        assert_eq!(json["startDate"], serde_json::json!("2026-02-01"));
        assert_eq!(json["labels"], serde_json::json!(["研发"]));
        assert_eq!(
            json["subtasks"],
            serde_json::json!([{ "id": "s1", "title": "步骤", "done": true }])
        );
        // V0.1 已有字段名保持不变
        assert_eq!(json["dueDate"], serde_json::json!("2026-01-10"));
        assert!(json.get("start_date").is_none());

        // V0.3 回收站字段：未删除时 deletedAt 为 null，且字段必须存在。
        assert_eq!(json["deletedAt"], serde_json::Value::Null);
        let mut deleted = sample_card();
        deleted.deleted_at = Some("2026-03-01T08:00:00.000Z".to_string());
        let deleted_json = serde_json::to_value(deleted).expect("序列化回收站卡片");
        assert_eq!(
            deleted_json["deletedAt"],
            serde_json::json!("2026-03-01T08:00:00.000Z")
        );
    }

    #[test]
    fn card_patch_distinguishes_missing_from_null() {
        let missing: CardPatch = serde_json::from_str("{}").expect("空 patch");
        assert_eq!(missing.start_date, None);
        assert_eq!(missing.labels, None);
        assert_eq!(missing.subtasks, None);

        let cleared: CardPatch = serde_json::from_str(r#"{"startDate": null}"#).expect("显式 null");
        assert_eq!(cleared.start_date, Some(None));

        let replaced: CardPatch = serde_json::from_str(
            r#"{"startDate": "2026-02-01", "labels": ["研发"], "subtasks": [{"id": "s1", "title": "步骤", "done": true}]}"#,
        )
        .expect("数组整体替换");
        assert_eq!(replaced.start_date, Some(Some("2026-02-01".to_string())));
        assert_eq!(replaced.labels, Some(vec!["研发".to_string()]));
        assert_eq!(
            replaced.subtasks,
            Some(vec![Subtask {
                id: "s1".to_string(),
                title: "步骤".to_string(),
                done: true,
            }])
        );
    }

    #[test]
    fn new_card_input_defaults_missing_v02_fields() {
        let input: NewCardInput =
            serde_json::from_str(r#"{"boardId":"b","listId":"l","title":"任务"}"#)
                .expect("最小输入");
        assert_eq!(input.start_date, None);
        assert_eq!(input.labels, None);
        assert_eq!(input.subtasks, None);

        let input: NewCardInput = serde_json::from_str(
            r#"{"boardId":"b","listId":"l","title":"任务","startDate":null,"labels":[],"subtasks":[]}"#,
        )
        .expect("显式空值输入");
        assert_eq!(input.start_date, None);
        assert_eq!(input.labels, Some(Vec::new()));
        assert_eq!(input.subtasks, Some(Vec::new()));
    }
}
