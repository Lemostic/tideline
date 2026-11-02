/**
 * 潮线 tideline — 领域模型
 *
 * 数据全部落在一个本地 SQLite 文件中（浏览器环境降级为 localStorage），
 * 前后端共享同一套模型定义，字段命名统一使用 camelCase。
 */

export type Priority = 'low' | 'medium' | 'high';

/** 看板主题色，同时用于列表左侧色条与看板封面 */
export type BoardColor =
  | 'blue'
  | 'amber'
  | 'coral'
  | 'green'
  | 'violet'
  | 'rose'
  | 'teal'
  | 'slate';

export interface Board {
  id: string;
  title: string;
  description: string;
  color: BoardColor;
  starred: boolean;
  /** Per-board label color overrides; absent labels use a stable hashed palette color. */
  labelColors?: Record<string, BoardColor>;
  createdAt: string;
  updatedAt: string;
}

export interface List {
  id: string;
  boardId: string;
  title: string;
  /** 列主题色（V0.7） */
  color: BoardColor;
  /** 在制品上限；null 表示不限制 */
  wipLimit: number | null;
  /** 同一看板内的排序序号，从 0 递增 */
  position: number;
  createdAt: string;
}

/** 任务内的子任务（清单项），存在 cards.subtasks 的 JSON 里 */
export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Card {
  id: string;
  boardId: string;
  listId: string;
  title: string;
  description: string;
  /** YYYY-MM-DD，仅日期，不含时区；null 表示无截止日期 */
  dueDate: string | null;
  /** YYYY-MM-DD，甘特视图的起始日期；null 表示未排期 */
  startDate: string | null;
  /** V0.12：预估与实际工时（分钟）；null 表示尚未填写 */
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  priority: Priority | null;
  /** 卡片强调色（V0.7）；null / undefined 使用默认卡片样式 */
  accent?: BoardColor | null;
  completed: boolean;
  /** 软删除时间；非 null 表示在回收站中，正常快照不会返回这些任务 */
  deletedAt: string | null;
  /** 自由标签，例如「研发」「高风险」 */
  labels: string[];
  /** 子任务清单，进度由完成数 / 总数派生 */
  subtasks: Subtask[];
  /** 同一列表内的排序序号，从 0 递增 */
  position: number;
  /** V0.11：所属重复配置 id；非空表示这张任务由重复任务滚动而来 */
  recurrenceId?: string | null;
  /** V0.11：生成这张任务的上一次任务 id */
  generatedFromId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InboxItem {
  id: string;
  content: string;
  createdAt: string;
}

/** 启动时一次性拉取的全量快照（本地单用户，数据量小） */
export interface Snapshot {
  boards: Board[];
  lists: List[];
  cards: Card[];
  inbox: InboxItem[];
  /** 任务依赖边（V0.4）：cardId 依赖 dependsOnCardId */
  dependencies: CardDependency[];
  /** 看板集（V0.5.4）：多板汇总 */
  boardSets: BoardSet[];
  /** 目标（V0.6）：目标树与任务关联 */
  goals: Goal[];
  /** 项目组（V0.8） */
  teamMembers: TeamMember[];
  overtimeRecords: OvertimeRecord[];
  performanceRecords: PerformanceRecord[];
  /** 成员投入时间段（V0.8.3） */
  memberTenures: MemberTenure[];
  /** 项目（V0.9） */
  projects: Project[];
  projectMetaFields: ProjectMetaField[];
  projectRoles: ProjectRole[];
  /** 重复任务配置（V0.11） */
  recurrences: Recurrence[];
  /** 本地规则（V0.11） */
  automationRules: AutomationRule[];
  /** 自定义字段定义（V0.13.0），按看板隔离 */
  customFields: CustomField[];
  /** 任务在自定义字段上的取值（V0.13.0） */
  cardFieldValues: CardFieldValue[];
  /** 保存的筛选视图（V0.13.1），按看板隔离 */
  savedViews: SavedView[];
}

/**
 * 任务关系类型（V0.12）。
 *
 * `blocks` 沿用 V0.4 的前置语义：被指向的任务未完成时，本任务处于被阻塞状态，
 * 并参与循环依赖检测。`relates` 与 `duplicates` 只表达关联，不产生阻塞。
 */
export type RelationType = 'blocks' | 'relates' | 'duplicates';

/** 关系类型的中文标签与说明，供界面展示。 */
export const RELATION_META: ReadonlyArray<{
  key: RelationType;
  label: string;
  hint: string;
}> = [
  { key: 'blocks', label: '前置', hint: '目标未完成时本任务被阻塞' },
  { key: 'relates', label: '相关', hint: '两件事有关联，互不阻塞' },
  { key: 'duplicates', label: '重复', hint: '与目标是同一件事' },
];

export function relationMeta(type: RelationType): (typeof RELATION_META)[number] {
  return RELATION_META.find((item) => item.key === type) ?? RELATION_META[0];
}

/** 是否是阻塞型关系（只有阻塞型参与循环依赖检测与「被阻塞」判定）。 */
export function isBlockingRelation(type: RelationType | undefined): boolean {
  return (type ?? 'blocks') === 'blocks';
}

/** 任务关系（V0.4 起为依赖，V0.12 起带类型）：`cardId` 与 `dependsOnCardId` 的关系。 */
export interface CardDependency {
  cardId: string;
  dependsOnCardId: string;
  /** V0.12 新增；旧备份缺少该字段时按 `blocks` 处理。 */
  relationType?: RelationType;
}

/* ---------- 自定义字段（V0.13.0） ---------- */

/** 自定义字段类型：只做单选下拉与数值两类，其余类型明确不做 */
export type CustomFieldType = 'select' | 'number';

/** 自定义字段的一个选项 */
export interface CustomFieldOption {
  /** 选项稳定 id：改标签不改 id，保证已有任务的值不失效 */
  id: string;
  label: string;
  /** 十六进制颜色，例如 #0f766e */
  color: string;
}

/** 自定义字段定义，按看板隔离 */
export interface CustomField {
  id: string;
  boardId: string;
  name: string;
  fieldType: CustomFieldType;
  /** 仅 select 类型有选项；number 类型恒为空数组 */
  options: CustomFieldOption[];
  /** 同一看板内的展示顺序 */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 任务在某个自定义字段上的取值 */
export interface CardFieldValue {
  cardId: string;
  fieldId: string;
  /** select 字段存选项 id；number 字段恒为 null */
  valueText: string | null;
  /** number 字段存数字；select 字段恒为 null */
  valueNumber: number | null;
}

export interface NewCustomFieldInput {
  boardId: string;
  name: string;
  fieldType: CustomFieldType;
  /** select 类型必填且至少一项；number 类型必须为空 */
  options?: CustomFieldOption[];
}

export type CustomFieldPatch = Partial<
  Pick<CustomField, 'name' | 'options' | 'sortOrder'>
>;

export interface CardFieldValueInput {
  fieldId: string;
  /** select 字段存选项 id；number 字段存数字；两者都为 null 表示清空 */
  valueText?: string | null;
  valueNumber?: number | null;
}

export interface SetCardFieldValuesInput {
  cardId: string;
  values: CardFieldValueInput[];
}

/** 字段类型的中文标签与说明，供界面展示 */
export const CUSTOM_FIELD_TYPE_META: ReadonlyArray<{
  key: CustomFieldType;
  label: string;
  hint: string;
}> = [
  { key: 'select', label: '单选下拉', hint: '从一组固定选项里选一个' },
  { key: 'number', label: '数值', hint: '填数字，适合评分、计数与工时' },
];

export function customFieldTypeMeta(
  type: CustomFieldType,
): (typeof CUSTOM_FIELD_TYPE_META)[number] {
  return CUSTOM_FIELD_TYPE_META.find((item) => item.key === type) ?? CUSTOM_FIELD_TYPE_META[0];
}

/* ---------- 保存的筛选视图（V0.13.1） ---------- */

/** 筛选状态分段：全部 / 未完成 / 已完成 */
export type FilterStatus = 'all' | 'active' | 'completed';

/** 看板排序键：表格视图与保存视图共用同一套标识 */
export type BoardSortKey =
  | 'due-asc'
  | 'due-desc'
  | 'priority'
  | 'created-desc'
  | 'created-asc'
  | 'updated-desc';

/** 排序方向 */
export type SortDirection = 'asc' | 'desc';

/** 表格视图与保存视图共用的排序选项 */
export const BOARD_SORT_OPTIONS: ReadonlyArray<{ key: BoardSortKey; label: string }> = [
  { key: 'due-asc', label: '默认排序' },
  { key: 'due-desc', label: '截止日期 · 最远' },
  { key: 'priority', label: '优先级 · 高到低' },
  { key: 'created-desc', label: '创建时间 · 最新' },
  { key: 'created-asc', label: '创建时间 · 最早' },
  { key: 'updated-desc', label: '更新时间 · 最新' },
];

/** 保存视图里针对自定义字段的筛选条件 */
export interface SavedViewFieldFilter {
  /** 自定义字段 id */
  fieldId: string;
  /** 单选字段：命中的选项 id 集合（空 = 不限） */
  optionIds: string[];
  /** 数值字段：区间下限（null = 不限） */
  min: number | null;
  /** 数值字段：区间上限（null = 不限） */
  max: number | null;
}

/** 保存视图的筛选条件：与看板筛选条同一套语义 */
export interface SavedViewFilters {
  keyword: string;
  status: FilterStatus;
  priorities: Priority[];
  labels: string[];
  /** 自定义字段筛选条件 */
  fieldFilters: SavedViewFieldFilter[];
  /** 只看被阻塞的任务 */
  blocked: boolean;
}

/** 保存视图的排序方式：筛选与排序必须一起存，切回来才不会排序错乱 */
export interface SavedViewSort {
  key: BoardSortKey;
  direction: SortDirection;
}

/** 保存的筛选视图（按看板隔离） */
export interface SavedView {
  id: string;
  boardId: string;
  name: string;
  /** 视图类型：切回该视图时一并切到对应看板视图 */
  viewType: BoardView;
  filters: SavedViewFilters;
  sort: SavedViewSort;
  /** 内置视图不可删除、不可改名 */
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 新建保存视图的入参 */
export interface NewSavedViewInput {
  boardId: string;
  name: string;
  viewType?: BoardView;
  filters?: SavedViewFilters;
  sort?: SavedViewSort;
}

/** 修改保存视图的入参：字段缺失 = 保持原值 */
export type SavedViewPatch = Partial<
  Pick<SavedView, 'name' | 'viewType' | 'filters' | 'sort'>
>;

/** 更新保存视图的入参 */
export interface UpdateSavedViewInput {
  id: string;
  patch: SavedViewPatch;
}

/** 看板集（V0.5.4）：把多个看板聚合成一张跨看板汇总表 */
export interface BoardSet {
  id: string;
  title: string;
  description: string;
  /** 成员看板 id，顺序即展示顺序 */
  boardIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NewBoardSetInput {
  title: string;
  description?: string;
  boardIds?: string[];
}

export type BoardSetPatch = Partial<Pick<BoardSet, 'title' | 'description' | 'boardIds'>>;

export type GoalScope = 'company' | 'team' | 'personal';
export type GoalStatus = 'active' | 'completed' | 'archived';

/** 目标（V0.6）：可嵌套子目标；有关联任务时进度按任务完成度自动计算 */
export interface Goal {
  id: string;
  title: string;
  description: string;
  scope: GoalScope;
  status: GoalStatus;
  startDate: string | null;
  dueDate: string | null;
  /** 无关联任务、无子目标时使用的手动进度 0–100 */
  manualProgress: number;
  parentId: string | null;
  /** 关联任务 id，顺序即展示顺序 */
  cardIds: string[];
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewGoalInput {
  title: string;
  description?: string;
  scope?: GoalScope;
  status?: GoalStatus;
  startDate?: string | null;
  dueDate?: string | null;
  manualProgress?: number;
  parentId?: string | null;
  cardIds?: string[];
}

export type GoalPatch = Partial<
  Pick<
    Goal,
    | 'title'
    | 'description'
    | 'scope'
    | 'status'
    | 'startDate'
    | 'dueDate'
    | 'manualProgress'
    | 'parentId'
    | 'cardIds'
  >
>;

/** 项目组角色（V0.8 旧枚举，仅兼容旧备份；新 UI 使用项目自定义角色） */
export type MemberRole = 'dev' | 'test' | 'requirements' | 'design' | 'other';
export type MemberStatus = 'active' | 'released';
/** V0.13.2：排班 / 已出勤 / 未出勤（未出勤需填写原因） */
export type OvertimeStatus = 'planned' | 'done' | 'absent';
export type PerformanceCategory = 'delivery' | 'quality' | 'collaboration' | 'other';

export interface Project {
  id: string;
  name: string;
  description: string;
  /** 项目卡片强调色，十六进制 */
  color: string;
  status: 'active' | 'archived';
  starred: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMetaField {
  id: string;
  projectId: string;
  name: string;
  value: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRole {
  id: string;
  projectId: string;
  name: string;
  color: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  id: string;
  /** 所属项目（V0.9） */
  projectId: string;
  /** 项目自定义角色 id（V0.9） */
  roleId: string;
  name: string;
  /** 旧版枚举角色，仅兼容旧备份 */
  role: MemberRole;
  status: MemberStatus;
  joinedAt: string;
  releasedAt: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** 成员投入时间段（V0.8.3）：可多次入组/出组，每段独立可编辑。 */
export interface MemberTenure {
  id: string;
  memberId: string;
  projectId: string;
  startedAt: string;
  /** null 表示当前仍在组 */
  endedAt: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewTenureInput {
  memberId: string;
  startedAt: string;
  endedAt?: string | null;
  note?: string;
}

export type TenurePatch = Partial<Pick<MemberTenure, 'startedAt' | 'endedAt' | 'note'>>;

export interface OvertimeRecord {
  id: string;
  projectId: string;
  memberId: string;
  date: string;
  hours: number;
  status: OvertimeStatus;
  /** V0.13.2：未出勤原因，仅 status='absent' 时有值（1–200 字） */
  absenceReason: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface PerformanceRecord {
  id: string;
  projectId: string;
  memberId: string;
  date: string;
  /** 正数加分，负数减分 */
  points: number;
  reason: string;
  category: PerformanceCategory;
  note: string;
  createdAt: string;
}

export interface NewTeamMemberInput {
  projectId: string;
  roleId: string;
  name: string;
  joinedAt?: string;
  note?: string;
}

export type TeamMemberPatch = Partial<
  Pick<TeamMember, 'name' | 'roleId' | 'status' | 'joinedAt' | 'releasedAt' | 'note'>
>;

export interface NewProjectInput {
  name: string;
  description?: string;
  color?: string;
  starred?: boolean;
}

export type ProjectPatch = Partial<
  Pick<Project, 'name' | 'description' | 'color' | 'status' | 'starred'>
>;

export interface NewProjectMetaInput {
  projectId: string;
  name: string;
  value?: string;
}

export type ProjectMetaPatch = Partial<Pick<ProjectMetaField, 'name' | 'value'>>;

export interface NewProjectRoleInput {
  projectId: string;
  name: string;
  color?: string;
}

export type ProjectRolePatch = Partial<Pick<ProjectRole, 'name' | 'color'>>;

export interface NewOvertimeInput {
  memberId: string;
  date: string;
  hours: number;
  status?: OvertimeStatus;
  absenceReason?: string;
  note?: string;
}

export type OvertimePatch = Partial<
  Pick<OvertimeRecord, 'memberId' | 'date' | 'hours' | 'status' | 'absenceReason' | 'note'>
>;

export interface NewPerformanceInput {
  memberId: string;
  date: string;
  points: number;
  reason: string;
  category?: PerformanceCategory;
  note?: string;
}

export type PerformancePatch = Partial<
  Pick<PerformanceRecord, 'memberId' | 'date' | 'points' | 'reason' | 'category' | 'note'>
>;

export type BoardPatch = Partial<
  Pick<Board, 'title' | 'description' | 'color' | 'starred' | 'labelColors'>
>;

export type ListPatch = Partial<Pick<List, 'title' | 'color' | 'wipLimit'>>;

export type CardPatch = Partial<
  Pick<
    Card,
    | 'title'
    | 'description'
    | 'dueDate'
    | 'startDate'
    | 'estimatedMinutes'
    | 'actualMinutes'
    | 'priority'
    | 'accent'
    | 'completed'
    | 'listId'
    | 'labels'
    | 'subtasks'
  >
>;

export interface NewBoardInput {
  title: string;
  description?: string;
  color?: BoardColor;
}

export interface NewListInput {
  boardId: string;
  title: string;
  color?: BoardColor;
  wipLimit?: number | null;
}

export interface NewCardInput {
  boardId: string;
  listId: string;
  title: string;
  description?: string;
  dueDate?: string | null;
  startDate?: string | null;
  estimatedMinutes?: number | null;
  actualMinutes?: number | null;
  priority?: Priority | null;
  accent?: BoardColor | null;
  labels?: string[];
  subtasks?: Subtask[];
}

export interface MoveCardInput {
  cardId: string;
  toListId: string;
  /** 目标列表内的落点下标，越界时由后端收敛到末尾 */
  toIndex: number;
}

export interface IdInput {
  id: string;
}

/** 从磁盘读取的需求文档（V0.9）：文件名 + 全文内容 */
export interface PickedTextFile {
  name: string;
  content: string;
}

export interface ConvertInboxInput {
  id: string;
  boardId: string;
  listId?: string;
}

export interface SetDependenciesInput {
  cardId: string;
  /** 关系目标 id 列表；类型由 `relationTypes` 中同序元素给出。 */
  dependsOn: string[];
  /** 与 `dependsOn` 一一对应的关系类型；缺省或长度不足时按 `blocks` 处理。 */
  relationTypes?: RelationType[];
}

/** 模板中心的数据结构：模板是创建看板的一份“菜谱”，不是数据库实体 */
export interface BoardTemplate {
  id: string;
  name: string;
  summary: string;
  category: TemplateCategory;
  color: BoardColor;
  /** 用简短 emoji 充当模板封面图标，避免离线加载图片 */
  emoji: string;
  lists: Array<{
    title: string;
    cards: string[];
  }>;
}

export type TemplateCategory =
  | 'hot'
  | 'collab'
  | 'content'
  | 'product'
  | 'personal';

export interface TemplateCategoryMeta {
  key: TemplateCategory | 'all';
  label: string;
}

/** 备份 / 恢复（V0.4）：与 Rust `BackupFile` / `src/lib/backup.ts` 保持一致 */
export interface BackupFile {
  app: 'tideline';
  formatVersion: 1;
  exportedAt: string;
  boards: Board[];
  lists: List[];
  /** 包含回收站里的软删除任务（deletedAt 非空） */
  cards: Card[];
  inbox: InboxItem[];
  /** V0.4 新增；旧备份没有该字段时按空依赖处理 */
  dependencies: CardDependency[];
  /** V0.5.4 新增；旧备份没有该字段时按空看板集处理 */
  boardSets: BoardSet[];
  /** V0.6 新增；旧备份没有该字段时按空目标处理 */
  goals: Goal[];
  /** V0.8 新增；旧备份没有该字段时按空项目组处理 */
  teamMembers: TeamMember[];
  overtimeRecords: OvertimeRecord[];
  performanceRecords: PerformanceRecord[];
  memberTenures: MemberTenure[];
  /** V0.9 新增；旧备份没有该字段时按空项目处理，恢复时兼容迁移 */
  projects: Project[];
  projectMetaFields: ProjectMetaField[];
  projectRoles: ProjectRole[];
  /** V0.11 新增；旧备份没有该字段时按空重复配置处理 */
  recurrences: Recurrence[];
  /** V0.11 新增；旧备份没有该字段时按空规则处理 */
  automationRules: AutomationRule[];
  /** V0.11 新增；旧备份没有该字段时按空活动日志处理 */
  cardActivity: CardActivity[];
  /** V0.13.0 新增；旧备份没有该字段时按空自定义字段处理 */
  customFields: CustomField[];
  /** V0.13.0 新增；旧备份没有该字段时按空字段值处理 */
  cardFieldValues: CardFieldValue[];
  /** V0.13.1 新增；旧备份没有该字段时按空保存视图处理 */
  savedViews: SavedView[];
}

export interface BackupSummary {
  boards: number;
  lists: number;
  cards: number;
  trashed: number;
  inbox: number;
  dependencies: number;
  boardSets: number;
  goals: number;
  teamMembers: number;
  overtimeRecords: number;
  performanceRecords: number;
  memberTenures: number;
  projects: number;
  projectMetaFields: number;
  projectRoles: number;
  recurrences: number;
  automationRules: number;
  cardActivity: number;
  customFields: number;
  cardFieldValues: number;
  savedViews: number;
}

export interface BackupExport {
  /** 备份文件写入位置；浏览器端为下载文件名说明 */
  path: string;
  summary: BackupSummary;
}

/** 数据存储目录信息（V0.5） */
export interface StorageInfo {
  dataDir: string;
  dbPath: string;
  defaultDir: string;
  isCustom: boolean;
  /** 浏览器 localStorage 模式为 false */
  editable: boolean;
}

/** 开机自动启动状态（V0.7.3） */
export interface AutoStartInfo {
  /** 浏览器开发模式为 false */
  supported: boolean;
  enabled: boolean;
}

/** 看板内可切换的视图，V0.2 起看板 / 表格 / 甘特已实现，日历待 V0.3 */
export type BoardView = 'board' | 'table' | 'gantt' | 'calendar';

export const BOARD_COLORS: ReadonlyArray<{
  key: BoardColor;
  label: string;
  value: string;
}> = [
  { key: 'blue', label: '海蓝', value: '#4c8dff' },
  { key: 'teal', label: '青碧', value: '#0f9e8e' },
  { key: 'green', label: '苔绿', value: '#3fae6d' },
  { key: 'amber', label: '暖沙', value: '#e9a23b' },
  { key: 'coral', label: '珊瑚', value: '#ff7a59' },
  { key: 'rose', label: '玫瑰', value: '#e5638d' },
  { key: 'violet', label: '紫藤', value: '#8e7cff' },
  { key: 'slate', label: '岩灰', value: '#7b8794' },
];

export function boardColorValue(color: BoardColor): string {
  return BOARD_COLORS.find((c) => c.key === color)?.value ?? '#4c8dff';
}

export const PRIORITY_META: ReadonlyArray<{
  key: Priority;
  label: string;
  color: string;
}> = [
  { key: 'high', label: '高', color: '#e5533d' },
  { key: 'medium', label: '中', color: '#e9a23b' },
  { key: 'low', label: '低', color: '#4c8dff' },
];

/* ---------- 桌面软件使用统计（V0.10） ---------- */

/** 被统计到的桌面应用（累计口径，非区间口径） */
export interface UsageApp {
  /** 应用唯一键（桌面端按可执行文件路径归一化） */
  appKey: string;
  appName: string;
  exePath: string;
  /** 是否纳入统计 */
  included: boolean;
  /** 全时段累计使用时长（秒） */
  totalSeconds: number;
  /** 首次出现时间（ISO 字符串） */
  firstSeen: string;
  /** 最近一次出现时间（ISO 字符串） */
  lastSeen: string;
}

/** 使用统计设置 */
export interface UsageSettings {
  /** 是否暂停采样 */
  paused: boolean;
  /** 空闲判定阈值（秒），低于该时长的片段视为空闲不计入 */
  idleThresholdSeconds: number;
  /** 最近一次修改时间（ISO 字符串） */
  updatedAt: string;
}

/** 区间内单个应用的时长与占比 */
export interface UsageAppStat {
  appKey: string;
  appName: string;
  seconds: number;
  /** 占比，0~1 之间的小数 */
  share: number;
}

/** 区间内某一天的时长 */
export interface UsageDailyStat {
  /** YYYY-MM-DD（本地时区） */
  day: string;
  seconds: number;
}

/** 某个区间的使用统计总览 */
export interface UsageOverview {
  rangeFrom: string;
  rangeTo: string;
  totalSeconds: number;
  trackedApps: number;
  apps: UsageAppStat[];
  daily: UsageDailyStat[];
}

/** 查询区间的入参（from / to 均为 YYYY-MM-DD，可只传其一） */
export interface UsageRangeInput {
  from?: string;
  to?: string;
}

/** 切换某个应用是否纳入统计 */
export interface UsageAppIncludedInput {
  appKey: string;
  included: boolean;
}

/** 更新使用统计设置的入参 */
export interface UsageSettingsInput {
  paused?: boolean;
  idleThresholdSeconds?: number;
}

/* ---------- 自动化与提醒（V0.11） ---------- */

/** 重复频率 */
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'interval';

/** 重复任务配置：一张任务最多挂一条 */
export interface Recurrence {
  id: string;
  /** 触发滚动的任务 id */
  cardId: string;
  frequency: RecurrenceFrequency;
  /** 自定义间隔天数（interval 使用，其它频率为 1） */
  intervalValue: number;
  /** 每周重复时指定的星期（0=周日 … 6=周六） */
  weekdays: number[];
  /** 下一次到期日期 YYYY-MM-DD */
  nextDueDate: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewRecurrenceInput {
  cardId: string;
  frequency: RecurrenceFrequency;
  intervalValue?: number;
  weekdays?: number[];
  nextDueDate?: string | null;
}

export type RecurrencePatch = Partial<
  Pick<
    Recurrence,
    'frequency' | 'intervalValue' | 'weekdays' | 'nextDueDate' | 'enabled'
  >
>;

/** 规则触发方式：只支持移动到指定列与完成任务 */
export type RuleTrigger = 'move_to_list' | 'complete';

/** 规则动作类型：固定的有限集合，不支持任意脚本 */
export type RuleActionKind =
  | 'set_due_date_offset'
  | 'clear_due_date'
  | 'set_priority'
  | 'add_labels'
  | 'append_subtasks';

/** 一条规则动作 */
export interface RuleAction {
  kind: RuleActionKind;
  /** 偏移天数（set_due_date_offset） */
  offsetDays?: number;
  /** 优先级（set_priority） */
  priority?: Priority | null;
  /** 标签（add_labels） */
  labels?: string[];
  /** 子任务标题（append_subtasks） */
  subtasks?: string[];
}

/** 本地规则：触发条件 + 声明式动作，默认关闭 */
export interface AutomationRule {
  id: string;
  name: string;
  trigger: RuleTrigger;
  /** move_to_list 触发时命中的列表 id */
  listId: string | null;
  actions: RuleAction[];
  enabled: boolean;
  /** 最近一次执行失败的可读原因；成功时为空串 */
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewAutomationRuleInput {
  name: string;
  trigger: RuleTrigger;
  listId?: string | null;
  actions: RuleAction[];
  enabled?: boolean;
}

export type AutomationRulePatch = Partial<
  Pick<AutomationRule, 'name' | 'trigger' | 'listId' | 'actions' | 'enabled'>
>;

/** 任务活动日志条目 */
export interface CardActivity {
  id: string;
  cardId: string;
  /** created / updated / moved / completed / deleted / restored / recurrence */
  eventType: string;
  /** 变化字段名；事件级动作为空串 */
  field: string;
  oldValue: string;
  newValue: string;
  createdAt: string;
}

/** 提醒设置：全部默认关闭 */
export interface NotificationSettings {
  dueEnabled: boolean;
  overdueEnabled: boolean;
  dailySummaryEnabled: boolean;
  /** 每日摘要时间 HH:MM */
  dailySummaryTime: string;
  /** 提前几天算「即将到期」 */
  leadDays: number;
  updatedAt: string;
}

export interface NotificationSettingsInput {
  dueEnabled?: boolean;
  overdueEnabled?: boolean;
  dailySummaryEnabled?: boolean;
  dailySummaryTime?: string;
  leadDays?: number;
}
