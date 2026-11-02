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
    #[serde(default)]
    pub label_colors: std::collections::HashMap<String, BoardColor>,
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
/// 子任务清单项（V0.1）：V0.14.0 起子任务是真实卡片（`parent_card_id`），
/// 该结构仅保留给旧数据库/旧备份迁移使用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    pub id: String,
    pub title: String,
    pub done: bool,
}

/// 任务树技术层级上限：防止脏数据/异常备份构造超深任务链。
pub const MAX_TASK_DEPTH: usize = 100;

/// 重复频率（V0.11）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecurrenceFrequency {
    /// 每天
    Daily,
    /// 每周（按 `weekdays` 指定的星期，0=周日）
    Weekly,
    /// 每月（目标日不存在时收敛到当月最后一天）
    Monthly,
    /// 自定义间隔天数
    Interval,
}

impl Default for RecurrenceFrequency {
    fn default() -> Self {
        Self::Daily
    }
}

impl RecurrenceFrequency {
    pub fn as_str(&self) -> &'static str {        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
            Self::Interval => "interval",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw {
            "weekly" => Self::Weekly,
            "monthly" => Self::Monthly,
            "interval" => Self::Interval,
            _ => Self::Daily,
        }
    }
}

/// 规则触发方式（V0.11）：只支持移动到指定列与完成任务两种。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleTrigger {
    /// 任务被移动到指定列表
    MoveToList,
    /// 任务从未完成变为已完成
    Complete,
}

impl Default for RuleTrigger {
    fn default() -> Self {
        Self::MoveToList
    }
}

impl RuleTrigger {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MoveToList => "move_to_list",
            Self::Complete => "complete",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw {
            "complete" => Self::Complete,
            _ => Self::MoveToList,
        }
    }
}

/// 规则动作类型（V0.11）：固定的有限集合，不支持任意脚本。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleActionKind {
    /// 把截止日期设为「触发当天 + N 天」；N = 负数表示往前推
    SetDueDateOffset,
    /// 清除截止日期
    ClearDueDate,
    /// 设置优先级
    SetPriority,
    /// 追加标签（已存在则跳过）
    AddLabels,
    /// 追加子任务（标题相同则跳过）
    AppendSubtasks,
}

/// 一条规则动作（V0.11）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleAction {
    pub kind: RuleActionKind,
    /// 偏移天数（`set_due_date_offset`）
    #[serde(default)]
    pub offset_days: i64,
    /// 优先级（`set_priority`）
    #[serde(default)]
    pub priority: Option<Priority>,
    /// 标签（`add_labels`）
    #[serde(default)]
    pub labels: Vec<String>,
    /// 子任务标题（`append_subtasks`）
    #[serde(default)]
    pub subtasks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub board_id: String,
    pub list_id: String,
    /// V0.14.0：父任务 id；None 表示主任务（任务树的根）。
    #[serde(default)]
    pub parent_card_id: Option<String>,
    pub title: String,
    pub description: String,
    pub due_date: Option<String>,
    /// 甘特视图的起始日期（YYYY-MM-DD），null 表示未排期。
    pub start_date: Option<String>,
    /// V0.12：预估与实际工时（分钟）；旧备份缺少字段时保持未填写。
    #[serde(default)]
    pub estimated_minutes: Option<i64>,
    #[serde(default)]
    pub actual_minutes: Option<i64>,
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
    /// V0.11：所属重复配置 id；非空表示这张任务由重复任务滚动而来。
    #[serde(default)]
    pub recurrence_id: Option<String>,
    /// V0.11：生成这张任务的上一次任务 id。
    #[serde(default)]
    pub generated_from_id: Option<String>,
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

/// 任务关系类型（V0.12）。
///
/// `Blocks` 沿用 V0.4 的前置语义：被指向的任务未完成时，本任务处于被阻塞状态，
/// 并参与循环依赖检测。`Relates` 与 `Duplicates` 只表达关联，不产生阻塞。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationType {
    /// 前置阻塞：目标未完成则本任务被阻塞
    Blocks,
    /// 相关联
    Relates,
    /// 重复：目标与本任务是同一件事
    Duplicates,
}

impl RelationType {
    /// 数据库存储值；旧数据缺省按 `blocks` 处理。
    pub fn as_str(&self) -> &'static str {
        match self {
            RelationType::Blocks => "blocks",
            RelationType::Relates => "relates",
            RelationType::Duplicates => "duplicates",
        }
    }

    /// 从数据库字符串解析；未知值按 `blocks` 兜底。
    pub fn from_str_lossy(value: &str) -> RelationType {
        match value {
            "relates" => RelationType::Relates,
            "duplicates" => RelationType::Duplicates,
            _ => RelationType::Blocks,
        }
    }

    /// 是否参与阻塞判定与循环依赖检测。
    pub fn is_blocking(&self) -> bool {
        matches!(self, RelationType::Blocks)
    }
}

impl Default for RelationType {
    fn default() -> Self {
        RelationType::Blocks
    }
}

/// 任务关系（V0.4 起为依赖，V0.12 起带类型）：`card_id` 与 `depends_on_card_id` 的关系。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDependency {
    pub card_id: String,
    pub depends_on_card_id: String,
    /// V0.12 新增；旧备份缺少该字段时按 `blocks` 处理。
    #[serde(default)]
    pub relation_type: RelationType,
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
    /// V0.13.2：排了班但未出勤，必须填写 `absence_reason`。
    Absent,
}

impl OvertimeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Done => "done",
            Self::Absent => "absent",
        }
    }

    pub fn from_db(raw: &str) -> Self {
        match raw {
            "done" => Self::Done,
            "absent" => Self::Absent,
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

/// 成员投入时间段（V0.8.3）：同一成员可多次入组/出组，每段独立记录起止日期。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberTenure {
    pub id: String,
    pub member_id: String,
    pub project_id: String,
    pub started_at: String,
    /// None 表示当前仍在组（开放段）。
    pub ended_at: Option<String>,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 周末加班记录：planned=排班，done=已出勤，absent=未出勤（带原因）。
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
    /// V0.13.2：未出勤原因；仅 status=absent 时非空，旧备份缺省为空串。
    #[serde(default)]
    pub absence_reason: String,
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

// ---------------------------------------------------------------------------
// 自定义字段（V0.13.0）
// ---------------------------------------------------------------------------

/// 自定义字段类型（V0.13.0）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CustomFieldType {
    /// 单选下拉：值是选项 id
    Select,
    /// 数值
    Number,
}

impl CustomFieldType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Select => "select",
            Self::Number => "number",
        }
    }

    /// 从数据库文本还原类型；遇到脏数据返回 `None`，由调用方兜底。
    pub fn from_db(raw: &str) -> Option<Self> {
        match raw {
            "select" => Some(Self::Select),
            "number" => Some(Self::Number),
            _ => None,
        }
    }
}

/// 自定义字段的一个选项
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFieldOption {
    pub id: String,
    pub label: String,
    /// 十六进制颜色，例如 "#0f766e"
    pub color: String,
}

/// 自定义字段定义（按看板隔离）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomField {
    pub id: String,
    pub board_id: String,
    pub name: String,
    pub field_type: CustomFieldType,
    /// 仅 select 类型有选项；number 类型恒为空数组
    pub options: Vec<CustomFieldOption>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 某张任务在某个字段上的取值
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFieldValue {
    pub card_id: String,
    pub field_id: String,
    /// select 字段存选项 id；number 字段恒为 null
    pub value_text: Option<String>,
    /// number 字段存数字；select 字段恒为 null
    pub value_number: Option<f64>,
}

// ---------------------------------------------------------------------------
// 保存的筛选视图（V0.13.1）
// ---------------------------------------------------------------------------

/// 保存视图里针对自定义字段的筛选条件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedViewFieldFilter {
    /// 自定义字段 id
    pub field_id: String,
    /// 单选字段：命中的选项 id 集合（空 = 不限）
    #[serde(default)]
    pub option_ids: Vec<String>,
    /// 数值字段：区间下限（null = 不限）
    #[serde(default)]
    pub min: Option<f64>,
    /// 数值字段：区间上限（null = 不限）
    #[serde(default)]
    pub max: Option<f64>,
}

/// 保存视图的筛选条件：与看板筛选条同一套语义，再叠加自定义字段与关系筛选。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedViewFilters {
    #[serde(default)]
    pub keyword: String,
    /// all / active / completed
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub priorities: Vec<Priority>,
    #[serde(default)]
    pub labels: Vec<String>,
    /// 自定义字段筛选条件
    #[serde(default)]
    pub field_filters: Vec<SavedViewFieldFilter>,
    /// 只看被阻塞的任务（只认 V0.12 的 blocks 关系）
    #[serde(default)]
    pub blocked: bool,
}

/// 保存视图的排序方式：筛选与排序必须一起存，否则切回来会排序错乱。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedViewSort {
    /// 排序键，沿用表格视图的排序标识（如 due-asc / created-desc）
    #[serde(default)]
    pub key: String,
    /// asc / desc；缺省按 asc 处理
    #[serde(default)]
    pub direction: String,
}

/// 保存的筛选视图（按看板隔离）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    pub id: String,
    pub board_id: String,
    pub name: String,
    /// 视图类型：board / table / gantt / calendar
    pub view_type: String,
    pub filters: SavedViewFilters,
    pub sort: SavedViewSort,
    /// 内置视图不可删除、不可改名
    pub is_builtin: bool,
    pub created_at: String,
    pub updated_at: String,
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
    /// 成员投入时间段（V0.8.3）。
    #[serde(default)]
    pub member_tenures: Vec<MemberTenure>,
    /// 项目（V0.9）。
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub project_meta_fields: Vec<ProjectMetaField>,
    #[serde(default)]
    pub project_roles: Vec<ProjectRole>,
    /// 重复任务配置（V0.11）。
    #[serde(default)]
    pub recurrences: Vec<Recurrence>,
    /// 本地规则（V0.11）。
    #[serde(default)]
    pub automation_rules: Vec<AutomationRule>,
    /// 自定义字段定义（V0.13.0）。
    #[serde(default)]
    pub custom_fields: Vec<CustomField>,
    /// 任务在自定义字段上的取值（V0.13.0）。
    #[serde(default)]
    pub card_field_values: Vec<CardFieldValue>,
    /// 保存的筛选视图（V0.13.1）。
    #[serde(default)]
    pub saved_views: Vec<SavedView>,
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
    /// V0.8.3 新增。
    #[serde(default)]
    pub member_tenures: Vec<MemberTenure>,
    /// V0.9 新增。
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub project_meta_fields: Vec<ProjectMetaField>,
    #[serde(default)]
    pub project_roles: Vec<ProjectRole>,
    /// V0.11 新增；旧备份没有该字段时按空重复配置处理。
    #[serde(default)]
    pub recurrences: Vec<Recurrence>,
    /// V0.11 新增；旧备份没有该字段时按空规则处理。
    #[serde(default)]
    pub automation_rules: Vec<AutomationRule>,
    /// V0.11 新增；旧备份没有该字段时按空活动日志处理。
    #[serde(default)]
    pub card_activity: Vec<CardActivity>,
    /// V0.13.0 新增；旧备份没有该字段时按空自定义字段处理。
    #[serde(default)]
    pub custom_fields: Vec<CustomField>,
    /// V0.13.0 新增；旧备份没有该字段时按空字段值处理。
    #[serde(default)]
    pub card_field_values: Vec<CardFieldValue>,
    /// V0.13.1 新增；旧备份没有该字段时按空保存视图处理。
    #[serde(default)]
    pub saved_views: Vec<SavedView>,
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
    pub member_tenures: usize,
    #[serde(default)]
    pub projects: usize,
    #[serde(default)]
    pub project_meta_fields: usize,
    #[serde(default)]
    pub project_roles: usize,
    /// V0.11 新增。
    #[serde(default)]
    pub recurrences: usize,
    #[serde(default)]
    pub automation_rules: usize,
    #[serde(default)]
    pub card_activity: usize,
    /// V0.13.0 新增。
    #[serde(default)]
    pub custom_fields: usize,
    /// V0.13.0 新增。
    #[serde(default)]
    pub card_field_values: usize,
    /// V0.13.1 新增。
    #[serde(default)]
    pub saved_views: usize,
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
    #[serde(default)]
    pub label_colors: Option<std::collections::HashMap<String, BoardColor>>,
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
    /// V0.14.0：父任务 id；提供时创建子任务（必须与父任务同看板、同列表）。
    #[serde(default)]
    pub parent_card_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub estimated_minutes: Option<i64>,
    #[serde(default)]
    pub actual_minutes: Option<i64>,
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
    pub estimated_minutes: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub actual_minutes: Option<Option<i64>>,
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

/// 整体替换某张任务的关系列表（V0.12）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDependenciesInput {
    pub card_id: String,
    /// 关系目标 id 列表；每条关系的类型由 `relations` 中同序元素给出。
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// 与 `depends_on` 一一对应的关系类型；缺省或长度不足时按 `blocks` 处理。
    #[serde(default)]
    pub relation_types: Vec<RelationType>,
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
pub struct NewTenureInput {
    pub member_id: String,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TenurePatch {
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub ended_at: Option<Option<String>>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTenureInput {
    pub id: String,
    pub patch: TenurePatch,
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
    pub absence_reason: Option<String>,
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
    pub absence_reason: Option<String>,
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

/// 新建自定义字段的入参（V0.13.0）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCustomFieldInput {
    pub board_id: String,
    pub name: String,
    pub field_type: CustomFieldType,
    /// select 类型必填且至少一项；number 类型必须为空
    #[serde(default)]
    pub options: Vec<CustomFieldOption>,
}

/// 修改自定义字段的入参（V0.13.0）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFieldPatch {
    #[serde(default)]
    pub name: Option<String>,
    /// 传入则整体替换选项列表
    #[serde(default)]
    pub options: Option<Vec<CustomFieldOption>>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

/// 更新自定义字段的入参（V0.13.0）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCustomFieldInput {
    pub id: String,
    pub patch: CustomFieldPatch,
}

/// 设置某张任务在一组字段上的取值；同一字段只保留一个值（V0.13.0）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCardFieldValuesInput {
    pub card_id: String,
    pub values: Vec<CardFieldValueInput>,
}

/// 单个字段取值的入参（V0.13.0）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFieldValueInput {
    pub field_id: String,
    /// select 字段存选项 id，number 字段存数字；两者都为 null 表示清空该字段
    pub value_text: Option<String>,
    pub value_number: Option<f64>,
}

/// 新建保存视图的入参（V0.13.1）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSavedViewInput {
    pub board_id: String,
    pub name: String,
    /// 视图类型：board / table / gantt / calendar，缺省看板视图
    #[serde(default)]
    pub view_type: String,
    #[serde(default)]
    pub filters: SavedViewFilters,
    #[serde(default)]
    pub sort: SavedViewSort,
}

/// 修改保存视图的入参（V0.13.1）：字段缺失 = 保持原值。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedViewPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub view_type: Option<String>,
    #[serde(default)]
    pub filters: Option<SavedViewFilters>,
    #[serde(default)]
    pub sort: Option<SavedViewSort>,
}

/// 更新保存视图的入参（V0.13.1）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSavedViewInput {
    pub id: String,
    pub patch: SavedViewPatch,
}

/// 从磁盘读取的需求文档（V0.9）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedTextFile {
    /// 文件名，用于界面回显
    pub name: String,
    /// 全文内容
    pub content: String,
}

// ---------------------------------------------------------------------------
// 桌面软件使用统计（V0.10）
// ---------------------------------------------------------------------------

/// 已发现的应用（V0.10）：`app_key` 是 exe 文件名去 `.exe` 后的小写形式，
/// 例如 `C:\Program Files\...\chrome.exe` → `chrome`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageApp {
    pub app_key: String,
    /// 展示名：去掉 `.exe` 的原始文件名（保留原始大小写）
    pub app_name: String,
    pub exe_path: String,
    /// 用户是否勾选纳入统计
    pub included: bool,
    /// 全时段累计使用秒数（不受查询区间影响）
    pub total_seconds: i64,
    pub first_seen: String,
    pub last_seen: String,
}

/// 使用统计设置（V0.10）：暂停开关 + 空闲阈值（秒）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSettings {
    pub paused: bool,
    pub idle_threshold_seconds: i64,
    pub updated_at: String,
}

/// 区间内单个应用的统计（V0.10）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAppStat {
    pub app_key: String,
    pub app_name: String,
    pub seconds: i64,
    /// 占区间总时长的比例（0..=1），总时长为 0 时为 0
    pub share: f64,
}

/// 区间内某一天的总使用时长（V0.10）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDailyStat {
    /// 本地日期 `YYYY-MM-DD`
    pub day: String,
    pub seconds: i64,
}

/// 使用统计总览（V0.10）：区间闭区间 `[from, to]`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageOverview {
    pub range_from: String,
    pub range_to: String,
    pub total_seconds: i64,
    /// 区间内有使用记录（秒数 > 0）的已勾选应用数量
    pub tracked_apps: i64,
    /// 各应用统计，按秒数降序
    pub apps: Vec<UsageAppStat>,
    /// 逐日统计（缺失日期补 0），按日期升序
    pub daily: Vec<UsageDailyStat>,
}

/// 查询区间（V0.10）：`from` / `to` 缺省时按「今天」处理。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRangeInput {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
}

/// 切换某个应用是否纳入统计（V0.10）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAppIncludedInput {
    pub app_key: String,
    pub included: bool,
}

/// 更新使用统计设置（V0.10）：只更新传入的字段。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSettingsInput {
    #[serde(default)]
    pub paused: Option<bool>,
    #[serde(default)]
    pub idle_threshold_seconds: Option<i64>,
}

// ---------------------------------------------------------------------------
// 自动化与提醒（V0.11）
// ---------------------------------------------------------------------------

/// 重复任务配置（V0.11）：一张任务最多挂一条配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recurrence {
    pub id: String,
    /// 触发滚动的任务 id
    pub card_id: String,
    pub frequency: RecurrenceFrequency,
    /// 自定义间隔天数（`interval` 使用，其它频率为 1）
    pub interval_value: i64,
    /// 每周重复时指定的星期（0=周日 … 6=周六）
    pub weekdays: Vec<i64>,
    /// 下一次到期日期 `YYYY-MM-DD`
    pub next_due_date: Option<String>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 新建重复配置的入参（V0.11）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRecurrenceInput {
    pub card_id: String,
    pub frequency: RecurrenceFrequency,
    #[serde(default)]
    pub interval_value: Option<i64>,
    #[serde(default)]
    pub weekdays: Option<Vec<i64>>,
    /// 字段缺失=按任务截止日期推算，显式 null=不预填。
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub next_due_date: Option<Option<String>>,
}

/// 修改重复配置的入参（V0.11）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurrencePatch {
    #[serde(default)]
    pub frequency: Option<RecurrenceFrequency>,
    #[serde(default)]
    pub interval_value: Option<i64>,
    #[serde(default)]
    pub weekdays: Option<Vec<i64>>,
    /// 字段缺失=保持原值，显式 null=清空下一次到期日期。
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub next_due_date: Option<Option<String>>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// 本地规则（V0.11）：触发条件 + 声明式动作，默认关闭。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRule {
    pub id: String,
    pub name: String,
    pub trigger: RuleTrigger,
    /// `move_to_list` 触发时命中的列表 id
    pub list_id: Option<String>,
    pub actions: Vec<RuleAction>,
    pub enabled: bool,
    /// 最近一次执行失败的可读原因；成功时为空串
    pub last_error: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 新建规则的入参（V0.11）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAutomationRuleInput {
    pub name: String,
    pub trigger: RuleTrigger,
    #[serde(default)]
    pub list_id: Option<String>,
    #[serde(default)]
    pub actions: Vec<RuleAction>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// 修改规则的入参（V0.11）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRulePatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub trigger: Option<RuleTrigger>,
    /// 字段缺失=保持原值，显式 null=清空目标列表。
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub list_id: Option<Option<String>>,
    #[serde(default)]
    pub actions: Option<Vec<RuleAction>>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// 任务活动日志条目（V0.11）：记录字段变化。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardActivity {
    pub id: String,
    pub card_id: String,
    /// `created` / `updated` / `moved` / `completed` / `deleted` / `restored` / `recurrence`
    pub event_type: String,
    /// 变化字段名；事件级动作为空串
    pub field: String,
    pub old_value: String,
    pub new_value: String,
    pub created_at: String,
}

/// 提醒设置（V0.11）：固定单行，全部默认关闭。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    /// 到期提醒
    pub due_enabled: bool,
    /// 逾期提醒
    pub overdue_enabled: bool,
    /// 每日摘要
    pub daily_summary_enabled: bool,
    /// 每日摘要时间 `HH:MM`
    pub daily_summary_time: String,
    /// 提前几天算「即将到期」
    pub lead_days: i64,
    pub updated_at: String,
}

/// 更新提醒设置的入参（V0.11）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettingsInput {
    #[serde(default)]
    pub due_enabled: Option<bool>,
    #[serde(default)]
    pub overdue_enabled: Option<bool>,
    #[serde(default)]
    pub daily_summary_enabled: Option<bool>,
    #[serde(default)]
    pub daily_summary_time: Option<String>,
    #[serde(default)]
    pub lead_days: Option<i64>,
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
            parent_card_id: None,
            title: "任务".to_string(),
            description: "".to_string(),
            due_date: Some("2026-01-10".to_string()),
            start_date: Some("2026-02-01".to_string()),
            estimated_minutes: None,
            actual_minutes: None,
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
            recurrence_id: None,
            generated_from_id: None,
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
    fn task_minutes_use_camel_case_and_nullable_patch_semantics() {
        let mut card = sample_card();
        card.estimated_minutes = Some(90);
        card.actual_minutes = Some(0);
        let value = serde_json::to_value(card).expect("serialize task minutes");
        assert_eq!(value["estimatedMinutes"], 90);
        assert_eq!(value["actualMinutes"], 0);
        let missing: CardPatch = serde_json::from_str("{}").expect("missing fields");
        assert_eq!((missing.estimated_minutes, missing.actual_minutes), (None, None));
        let patch: CardPatch = serde_json::from_str(r#"{"estimatedMinutes":null,"actualMinutes":0}"#)
            .expect("nullable patch");
        assert_eq!((patch.estimated_minutes, patch.actual_minutes), (Some(None), Some(Some(0))));
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
