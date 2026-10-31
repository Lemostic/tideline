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
}

/** 任务依赖（V0.4）：`cardId` 被 `dependsOnCardId` 阻塞 */
export interface CardDependency {
  cardId: string;
  dependsOnCardId: string;
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
export type OvertimeStatus = 'planned' | 'done';
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
  note?: string;
}

export type OvertimePatch = Partial<
  Pick<OvertimeRecord, 'memberId' | 'date' | 'hours' | 'status' | 'note'>
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
  Pick<Board, 'title' | 'description' | 'color' | 'starred'>
>;

export type ListPatch = Partial<Pick<List, 'title' | 'color' | 'wipLimit'>>;

export type CardPatch = Partial<
  Pick<
    Card,
    | 'title'
    | 'description'
    | 'dueDate'
    | 'startDate'
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

export interface ConvertInboxInput {
  id: string;
  boardId: string;
  listId?: string;
}

export interface SetDependenciesInput {
  cardId: string;
  dependsOn: string[];
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
