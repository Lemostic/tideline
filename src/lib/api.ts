/**
 * 数据访问层（Data Access Layer）
 *
 * 同一套接口有两个实现：
 * 1. Tauri 桌面端：通过 invoke 调用 Rust 侧 SQLite 命令；
 * 2. 浏览器（开发/预览）：用 localStorage 模拟，保证 UI 可独立调试。
 *
 * V0.1 的策略是「启动加载全量快照 + 写操作返回单条实体」，
 * 单用户本地场景下数据量小，逻辑简单且没有一致性问题。
 */
import { invoke } from '@tauri-apps/api/core';
import {
  backupFilename,
  createBackup,
  expandLegacySubtaskCards,
  parseBackup,
  serializeBackup,
  summarizeBackup,
  type LegacyCard,
} from './backup';
import { createId, nowISO } from './ids';
import {
  degradeSavedViewFieldFilters,
  normalizeSavedViewFilters,
  normalizeSavedViewSort,
} from './savedViews';
import { todayKey } from './date';
import { MAX_TASK_DEPTH } from './taskTree';
import {
  LEAVE_TYPE_KEYS,
  leaveSpanDays,
  normalizeOvertimeAbsenceReason,
  roundLeaveDays,
  validateLeaveInput,
  validateOvertimeAbsenceReason,
} from './team';
import {
  applyRuleActions,
  nextRecurrenceDateFor,
  validateRuleActions,
} from './automation';
import type {
  AutoStartInfo,
  AutomationRule,
  AutomationRulePatch,
  BackupExport,
  BackupSummary,
  Board,
  BoardView,
  BoardPatch,
  BoardSet,
  BoardSetPatch,
  Card,
  CardActivity,
  CardDependency,
  CardFieldValue,
  CardPatch,
  CreatedBoardWithLists,
  RelationType,
  Goal,
  GoalPatch,
  GoalScope,
  GoalStatus,
  ConvertInboxInput,
  CustomField,
  CustomFieldOption,
  CustomFieldPatch,
  CustomFieldType,
  IdInput,
  InboxItem,
  LeavePatch,
  LeaveRecord,
  LeaveType,
  List,
  ListPatch,
  MemberRole,
  MemberStatus,
  MemberTenure,
  MoveCardInput,
  NewAutomationRuleInput,
  NewBoardInput,
  NewBoardSetInput,
  NewBoardWithListsInput,
  NewCardInput,
  NewCustomFieldInput,
  NewGoalInput,
  NewLeaveInput,
  NewListInput,
  NewOvertimeInput,
  NewPerformanceInput,
  NewProjectInput,
  NewProjectMetaInput,
  NewProjectRoleInput,
  NewRecurrenceInput,
  NewTeamMemberInput,
  NewTenureInput,
  NotificationSettings,
  NotificationSettingsInput,
  PickedTextFile,
  OvertimePatch,
  OvertimeRecord,
  OvertimeStatus,
  PerformanceCategory,
  PerformancePatch,
  PerformanceRecord,
  Project,
  ProjectMetaField,
  ProjectMetaPatch,
  ProjectPatch,
  ProjectRole,
  ProjectRolePatch,
  Recurrence,
  RecurrencePatch,
  SavedView,
  SavedViewFilters,
  SavedViewPatch,
  SavedViewSort,
  SavedBinaryFile,
  SetCardFieldValuesInput,
  Snapshot,
  StorageInfo,
  LegacySubtask,
  TeamMember,
  TeamMemberPatch,
  TenurePatch,
  UsageApp,
  UsageAppIncludedInput,
  UsageOverview,
  UsageRangeInput,
  UsageSettings,
  UsageSettingsInput,
} from './types';

export interface TidelineApi {
  getSnapshot(): Promise<Snapshot>;
  createBoard(input: NewBoardInput): Promise<Board>;
  /** V0.15.0：一次性创建看板与它的看板列（Excel 导入用） */
  createBoardWithLists(input: NewBoardWithListsInput): Promise<CreatedBoardWithLists>;
  /** V0.15.0：保存二进制文件（导入模板）；桌面端弹出保存框，浏览器端触发下载 */
  saveBinaryFile(input: { fileName: string; base64: string }): Promise<SavedBinaryFile>;
  updateBoard(input: { id: string; patch: BoardPatch }): Promise<Board>;
  deleteBoard(input: IdInput): Promise<void>;
  createList(input: NewListInput): Promise<List>;
  updateList(input: { id: string; patch: ListPatch }): Promise<List>;
  deleteList(input: IdInput): Promise<void>;
  createCard(input: NewCardInput): Promise<Card>;
  updateCard(input: { id: string; patch: CardPatch }): Promise<Card>;
  deleteCard(input: IdInput): Promise<void>;
  moveCard(input: MoveCardInput): Promise<Card>;
  /** 回收站：软删除任务 */
  getTrash(): Promise<Card[]>;
  restoreCard(input: IdInput): Promise<Card>;
  purgeCard(input: IdInput): Promise<void>;
  emptyTrash(): Promise<void>;
  addInboxItem(input: { content: string }): Promise<InboxItem>;
  deleteInboxItem(input: IdInput): Promise<void>;
  convertInboxItem(input: ConvertInboxInput): Promise<Card>;
  /** 整体替换某张任务的关系列表（V0.4 起为前置任务，V0.12 起带类型） */
  setCardDependencies(input: {
    cardId: string;
    dependsOn: string[];
    relationTypes?: RelationType[];
  }): Promise<CardDependency[]>;
  /* ---------- 自定义字段（V0.13.0） ---------- */
  /** 新建自定义字段（按看板隔离） */
  createCustomField(input: NewCustomFieldInput): Promise<CustomField>;
  /** 修改自定义字段（改名、替换选项、调整排序） */
  updateCustomField(input: { id: string; patch: CustomFieldPatch }): Promise<CustomField>;
  /** 删除自定义字段（连带清理该字段的取值） */
  deleteCustomField(input: IdInput): Promise<void>;
  /** 设置某张任务在一组字段上的取值 */
  setCardFieldValues(input: SetCardFieldValuesInput): Promise<CardFieldValue[]>;
  /* ---------- 保存的筛选视图（V0.13.1） ---------- */
  /** 新建保存视图（按看板隔离） */
  createSavedView(input: {
    boardId: string;
    name: string;
    viewType?: BoardView;
    filters?: SavedViewFilters;
    sort?: SavedViewSort;
  }): Promise<SavedView>;
  /** 修改保存视图（改名 / 改筛选条件 / 改排序） */
  updateSavedView(input: { id: string; patch: SavedViewPatch }): Promise<SavedView>;
  /** 删除保存视图（内置视图不可删除） */
  deleteSavedView(input: IdInput): Promise<void>;
  /** 导出全量 JSON 备份（桌面端写入「文档」目录，浏览器端触发下载） */
  exportBackup(): Promise<BackupExport>;
  /** 用 JSON 备份替换全部数据（失败时不应修改原数据） */
  importBackup(json: string): Promise<BackupSummary>;
  /** 数据存储目录（V0.5） */
  getStorageInfo(): Promise<StorageInfo>;
  /** 原生文件夹选择框；取消返回 null */
  pickDataDirectory(): Promise<string | null>;
  /** 把数据库迁移到新目录并切换连接 */
  changeDataDirectory(path: string): Promise<StorageInfo>;
  /** 恢复默认应用数据目录 */
  resetDataDirectory(): Promise<StorageInfo>;
  /** 看板集（V0.5.4） */
  createBoardSet(input: NewBoardSetInput): Promise<BoardSet>;
  updateBoardSet(input: { id: string; patch: BoardSetPatch }): Promise<BoardSet>;
  deleteBoardSet(input: IdInput): Promise<void>;
  /** 目标（V0.6） */
  createGoal(input: NewGoalInput): Promise<Goal>;
  updateGoal(input: { id: string; patch: GoalPatch }): Promise<Goal>;
  deleteGoal(input: IdInput): Promise<void>;
  /** 在系统默认浏览器打开发布页（仅允许 GitHub 仓库地址） */
  openExternal(url: string): Promise<void>;
  /** 开机自动启动状态（V0.7.3） */
  getAutoStart(): Promise<AutoStartInfo>;
  setAutoStart(enabled: boolean): Promise<AutoStartInfo>;
  /** 项目组（V0.8） */
  createTeamMember(input: NewTeamMemberInput): Promise<TeamMember>;
  updateTeamMember(input: { id: string; patch: TeamMemberPatch }): Promise<TeamMember>;
  deleteTeamMember(input: IdInput): Promise<void>;
  createTenure(input: NewTenureInput): Promise<MemberTenure>;
  updateTenure(input: { id: string; patch: TenurePatch }): Promise<MemberTenure>;
  deleteTenure(input: IdInput): Promise<void>;
  createOvertime(input: NewOvertimeInput): Promise<OvertimeRecord>;
  updateOvertime(input: { id: string; patch: OvertimePatch }): Promise<OvertimeRecord>;
  deleteOvertime(input: IdInput): Promise<void>;
  createPerformance(input: NewPerformanceInput): Promise<PerformanceRecord>;
  updatePerformance(input: { id: string; patch: PerformancePatch }): Promise<PerformanceRecord>;
  deletePerformance(input: IdInput): Promise<void>;
  /** 请假记录（V0.16.0） */
  createLeave(input: NewLeaveInput): Promise<LeaveRecord>;
  updateLeave(input: { id: string; patch: LeavePatch }): Promise<LeaveRecord>;
  deleteLeave(input: IdInput): Promise<void>;
  /** 项目（V0.9） */
  createProject(input: NewProjectInput): Promise<Project>;
  updateProject(input: { id: string; patch: ProjectPatch }): Promise<Project>;
  deleteProject(input: IdInput): Promise<void>;
  createProjectMeta(input: NewProjectMetaInput): Promise<ProjectMetaField>;
  updateProjectMeta(input: { id: string; patch: ProjectMetaPatch }): Promise<ProjectMetaField>;
  deleteProjectMeta(input: IdInput): Promise<void>;
  createProjectRole(input: NewProjectRoleInput): Promise<ProjectRole>;
  updateProjectRole(input: { id: string; patch: ProjectRolePatch }): Promise<ProjectRole>;
  deleteProjectRole(input: IdInput): Promise<void>;
  /** 读取需求文档（V0.9）：桌面端走原生对话框，浏览器端用文件选择；取消返回 null */
  pickRequirementFile(): Promise<PickedTextFile | null>;
  /* ---------- 桌面软件使用统计（V0.10） ---------- */
  /** 区间使用统计总览（含每日趋势与应用排行） */
  getUsageOverview(input: UsageRangeInput): Promise<UsageOverview>;
  /** 已采集到的应用清单（含累计时长与纳入开关） */
  getUsageApps(): Promise<UsageApp[]>;
  /** 切换某个应用是否纳入统计 */
  setUsageAppIncluded(input: UsageAppIncludedInput): Promise<UsageApp>;
  /** 读取统计设置（暂停状态、空闲阈值） */
  getUsageSettings(): Promise<UsageSettings>;
  /** 更新统计设置 */
  setUsageSettings(input: UsageSettingsInput): Promise<UsageSettings>;
  /** 清空全部使用记录 */
  clearUsageRecords(): Promise<void>;
  /* ---------- 自动化与提醒（V0.11） ---------- */
  /** 某张任务的最近活动（倒序） */
  getCardActivity(input: IdInput): Promise<CardActivity[]>;
  /** 全部重复任务配置 */
  getRecurrences(): Promise<Recurrence[]>;
  /** 新建重复任务配置（同一张任务只保留一条） */
  createRecurrence(input: NewRecurrenceInput): Promise<Recurrence>;
  /** 修改重复任务配置 */
  updateRecurrence(input: { id: string; patch: RecurrencePatch }): Promise<Recurrence>;
  /** 删除重复任务配置 */
  deleteRecurrence(input: IdInput): Promise<void>;
  /** 全部本地规则 */
  getAutomationRules(): Promise<AutomationRule[]>;
  /** 新建本地规则（默认关闭，需逐条启用） */
  createAutomationRule(input: NewAutomationRuleInput): Promise<AutomationRule>;
  /** 修改本地规则 */
  updateAutomationRule(input: {
    id: string;
    patch: AutomationRulePatch;
  }): Promise<AutomationRule>;
  /** 删除本地规则 */
  deleteAutomationRule(input: IdInput): Promise<void>;
  /** 读取提醒设置 */
  getNotificationSettings(): Promise<NotificationSettings>;
  /** 更新提醒设置（只更新传入的字段） */
  setNotificationSettings(input: NotificationSettingsInput): Promise<NotificationSettings>;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Tauri 桌面端实现：命令名与 Rust `#[tauri::command]` 一一对应 */
const tauriApi: TidelineApi = {
  getSnapshot: () => invoke<Snapshot>('get_snapshot'),
  createBoard: (input) => invoke<Board>('create_board', { input }),
  createBoardWithLists: (input) =>
    invoke<CreatedBoardWithLists>('create_board_with_lists', { input }),
  saveBinaryFile: (input) => invoke<SavedBinaryFile>('save_binary_file', { input }),
  updateBoard: (input) => invoke<Board>('update_board', { input }),
  deleteBoard: (input) => invoke<void>('delete_board', { input }),
  createList: (input) => invoke<List>('create_list', { input }),
  updateList: (input) => invoke<List>('update_list', { input }),
  deleteList: (input) => invoke<void>('delete_list', { input }),
  createCard: (input) => invoke<Card>('create_card', { input }),
  updateCard: (input) => invoke<Card>('update_card', { input }),
  deleteCard: (input) => invoke<void>('delete_card', { input }),
  moveCard: (input) => invoke<Card>('move_card', { input }),
  getTrash: () => invoke<Card[]>('get_trash'),
  restoreCard: (input) => invoke<Card>('restore_card', { input }),
  purgeCard: (input) => invoke<void>('purge_card', { input }),
  emptyTrash: () => invoke<void>('empty_trash'),
  addInboxItem: (input) => invoke<InboxItem>('add_inbox_item', { input }),
  deleteInboxItem: (input) => invoke<void>('delete_inbox_item', { input }),
  convertInboxItem: (input) => invoke<Card>('convert_inbox_item', { input }),
  setCardDependencies: (input) =>
    invoke<CardDependency[]>('set_card_dependencies', { input }),
  createCustomField: (input) => invoke<CustomField>('create_custom_field', { input }),
  updateCustomField: (input) => invoke<CustomField>('update_custom_field', { input }),
  deleteCustomField: (input) => invoke<void>('delete_custom_field', { input }),
  setCardFieldValues: (input) =>
    invoke<CardFieldValue[]>('set_card_field_values', { input }),
  createSavedView: (input) => invoke<SavedView>('create_saved_view', { input }),
  updateSavedView: (input) => invoke<SavedView>('update_saved_view', { input }),
  deleteSavedView: (input) => invoke<void>('delete_saved_view', { input }),
  exportBackup: () => invoke<BackupExport>('export_backup'),
  importBackup: (json) => invoke<BackupSummary>('import_backup', { input: { json } }),
  getStorageInfo: () => invoke<StorageInfo>('get_storage_info'),
  pickDataDirectory: () => invoke<string | null>('pick_data_directory'),
  changeDataDirectory: (path) =>
    invoke<StorageInfo>('change_data_directory', { input: { path } }),
  resetDataDirectory: () => invoke<StorageInfo>('reset_data_directory'),
  createBoardSet: (input) => invoke<BoardSet>('create_board_set', { input }),
  updateBoardSet: (input) => invoke<BoardSet>('update_board_set', { input }),
  deleteBoardSet: (input) => invoke<void>('delete_board_set', { input }),
  createGoal: (input) => invoke<Goal>('create_goal', { input }),
  updateGoal: (input) => invoke<Goal>('update_goal', { input }),
  deleteGoal: (input) => invoke<void>('delete_goal', { input }),
  openExternal: (url) => invoke<void>('open_external', { url }),
  getAutoStart: () => invoke<AutoStartInfo>('get_autostart'),
  setAutoStart: (enabled) => invoke<AutoStartInfo>('set_autostart', { enabled }),
  createTeamMember: (input) => invoke<TeamMember>('create_team_member', { input }),
  updateTeamMember: (input) => invoke<TeamMember>('update_team_member', { input }),
  deleteTeamMember: (input) => invoke<void>('delete_team_member', { input }),
  createTenure: (input) => invoke<MemberTenure>('create_tenure', { input }),
  updateTenure: (input) => invoke<MemberTenure>('update_tenure', { input }),
  deleteTenure: (input) => invoke<void>('delete_tenure', { input }),
  createOvertime: (input) => invoke<OvertimeRecord>('create_overtime', { input }),
  updateOvertime: (input) => invoke<OvertimeRecord>('update_overtime', { input }),
  deleteOvertime: (input) => invoke<void>('delete_overtime', { input }),
  createPerformance: (input) => invoke<PerformanceRecord>('create_performance', { input }),
  updatePerformance: (input) => invoke<PerformanceRecord>('update_performance', { input }),
  deletePerformance: (input) => invoke<void>('delete_performance', { input }),
  createLeave: (input) => invoke<LeaveRecord>('create_leave', { input }),
  updateLeave: (input) => invoke<LeaveRecord>('update_leave', { input }),
  deleteLeave: (input) => invoke<void>('delete_leave', { input }),
  createProject: (input) => invoke<Project>('create_project', { input }),
  updateProject: (input) => invoke<Project>('update_project', { input }),
  deleteProject: (input) => invoke<void>('delete_project', { input }),
  createProjectMeta: (input) => invoke<ProjectMetaField>('create_project_meta', { input }),
  updateProjectMeta: (input) => invoke<ProjectMetaField>('update_project_meta', { input }),
  deleteProjectMeta: (input) => invoke<void>('delete_project_meta', { input }),
  createProjectRole: (input) => invoke<ProjectRole>('create_project_role', { input }),
  updateProjectRole: (input) => invoke<ProjectRole>('update_project_role', { input }),
  deleteProjectRole: (input) => invoke<void>('delete_project_role', { input }),
  pickRequirementFile: () => invoke<PickedTextFile | null>('pick_requirement_file'),
  getUsageOverview: (input) => invoke<UsageOverview>('get_usage_overview', { input }),
  getUsageApps: () => invoke<UsageApp[]>('get_usage_apps'),
  setUsageAppIncluded: (input) => invoke<UsageApp>('set_usage_app_included', { input }),
  getUsageSettings: () => invoke<UsageSettings>('get_usage_settings'),
  setUsageSettings: (input) => invoke<UsageSettings>('set_usage_settings', { input }),
  clearUsageRecords: () => invoke<void>('clear_usage_records'),
  getCardActivity: (input) => invoke<CardActivity[]>('get_card_activity', { input }),
  getRecurrences: () => invoke<Recurrence[]>('get_recurrences'),
  createRecurrence: (input) => invoke<Recurrence>('create_recurrence', { input }),
  updateRecurrence: (input) =>
    invoke<Recurrence>('update_recurrence', { id: input.id, patch: input.patch }),
  deleteRecurrence: (input) => invoke<void>('delete_recurrence', { input }),
  getAutomationRules: () => invoke<AutomationRule[]>('get_automation_rules'),
  createAutomationRule: (input) => invoke<AutomationRule>('create_automation_rule', { input }),
  updateAutomationRule: (input) =>
    invoke<AutomationRule>('update_automation_rule', { id: input.id, patch: input.patch }),
  deleteAutomationRule: (input) => invoke<void>('delete_automation_rule', { input }),
  getNotificationSettings: () => invoke<NotificationSettings>('get_notification_settings'),
  setNotificationSettings: (input) =>
    invoke<NotificationSettings>('set_notification_settings', { input }),
};

/** 浏览器降级实现：localStorage 单文件快照 */
const STORAGE_KEY = 'tideline.db.v1';

/** 浏览器端使用统计的本地存储 key（V0.10） */
const USAGE_STORAGE_KEY = 'tideline.usage.v1';

/** 浏览器端没有采样器，只保留统计设置与手动切换过的应用 */
interface LocalUsageStore {
  settings: UsageSettings;
  apps: UsageApp[];
}

/** 读取浏览器端的使用统计本地存储；数据损坏时回落到默认值 */
function loadLocalUsageStore(): LocalUsageStore {
  const fallback: LocalUsageStore = {
    settings: { paused: false, idleThresholdSeconds: 300, updatedAt: nowISO() },
    apps: [],
  };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<LocalUsageStore>;
    return {
      settings: { ...fallback.settings, ...(parsed.settings ?? {}) },
      apps: Array.isArray(parsed.apps) ? parsed.apps : [],
    };
  } catch {
    return fallback;
  }
}

/** 写入浏览器端的使用统计本地存储；隐私模式写入失败时静默忽略 */
function saveLocalUsageStore(store: LocalUsageStore): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* 忽略写入失败，页面按空数据展示 */
  }
}

const DEFAULT_PROJECT_ROLES: ReadonlyArray<{ name: string; color: string }> = [
  { name: '开发', color: '#2f6fd0' },
  { name: '测试', color: '#9a6512' },
  { name: '需求', color: '#0f766e' },
  { name: '设计', color: '#5a48c9' },
  { name: '其他', color: '#64748b' },
];

/** 浏览器端本地库：快照 + 活动日志 + 提醒设置（后两项不进备份） */
interface LocalDb extends Snapshot {
  cardActivity: CardActivity[];
  notificationSettings?: NotificationSettings;
}

/**
 * 兼容 V0.1 写入的旧数据：补齐 V0.2 新增的 startDate / labels / subtasks。
 * SQLite 侧由 Rust 迁移完成，这里处理浏览器 localStorage。
 */
function validateCardMinutes(values: { estimatedMinutes?: number | null; actualMinutes?: number | null }) {
  for (const field of ['estimatedMinutes', 'actualMinutes'] as const) {
    const minutes = values[field];
    if (minutes !== undefined && minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 0)) {
      throw new Error(`${field} 必须是非负整数分钟`);
    }
  }
}

function normalizeCard(raw: LegacyCard): LegacyCard {
  const subtasks: LegacySubtask[] = Array.isArray(raw.subtasks)
    ? raw.subtasks
        .filter((item): item is LegacySubtask => Boolean(item) && typeof item.title === 'string')
        .map((item) => ({
          id: typeof item.id === 'string' && item.id ? item.id : createId('s'),
          title: item.title,
          done: Boolean(item.done),
        }))
    : [];
  const labels = Array.isArray(raw.labels)
    ? raw.labels.filter((label): label is string => typeof label === 'string' && label.trim() !== '')
    : [];
  return {
    ...raw,
    parentCardId: typeof raw.parentCardId === 'string' ? raw.parentCardId : null,
    startDate: raw.startDate ?? null,
    estimatedMinutes: raw.estimatedMinutes ?? null,
    actualMinutes: raw.actualMinutes ?? null,
    deletedAt: raw.deletedAt ?? null,
    accent: raw.accent ?? null,
    labels,
    subtasks,
    recurrenceId: raw.recurrenceId ?? null,
    generatedFromId: raw.generatedFromId ?? null,
  };
}

/* ---------- 浏览器端自动化数据（V0.11） ---------- */

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  dueEnabled: false,
  overdueEnabled: false,
  dailySummaryEnabled: false,
  dailySummaryTime: '09:00',
  leadDays: 1,
  updatedAt: '',
};

/** 补齐浏览器端可能缺失的自动化字段 */
function normalizeRecurrence(raw: Recurrence): Recurrence {
  return {
    ...raw,
    frequency: raw.frequency ?? 'daily',
    intervalValue: typeof raw.intervalValue === 'number' ? raw.intervalValue : 1,
    weekdays: Array.isArray(raw.weekdays)
      ? raw.weekdays.filter((day): day is number => typeof day === 'number')
      : [],
    nextDueDate: raw.nextDueDate ?? null,
    enabled: Boolean(raw.enabled),
  };
}

function normalizeAutomationRule(raw: AutomationRule): AutomationRule {
  return {
    ...raw,
    name: typeof raw.name === 'string' ? raw.name : '',
    trigger: raw.trigger === 'complete' ? 'complete' : 'move_to_list',
    listId: raw.listId ?? null,
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    enabled: Boolean(raw.enabled),
    lastError: typeof raw.lastError === 'string' ? raw.lastError : '',
  };
}

function normalizeActivity(raw: CardActivity): CardActivity {
  return {
    ...raw,
    eventType: typeof raw.eventType === 'string' ? raw.eventType : 'updated',
    field: typeof raw.field === 'string' ? raw.field : '',
    oldValue: typeof raw.oldValue === 'string' ? raw.oldValue : '',
    newValue: typeof raw.newValue === 'string' ? raw.newValue : '',
  };
}

/** 追加一条活动日志；浏览器端只保留最近 500 条，避免快照无限膨胀 */
function pushActivity(db: LocalDb, activity: {
  cardId: string;
  eventType: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
}): void {
  db.cardActivity.unshift({
    id: createId('a'),
    cardId: activity.cardId,
    eventType: activity.eventType,
    field: activity.field ?? '',
    oldValue: activity.oldValue ?? '',
    newValue: activity.newValue ?? '',
    createdAt: nowISO(),
  });
  if (db.cardActivity.length > 500) db.cardActivity.length = 500;
}

/** 比较任务新旧值，把真正变化的字段写进活动日志 */
function recordLocalCardChanges(db: LocalDb, old: Card, next: Card): void {
  const push = (field: string, oldValue: string, newValue: string) => {
    pushActivity(db, { cardId: next.id, eventType: 'updated', field, oldValue, newValue });
  };
  if (old.title !== next.title) push('title', old.title, next.title);
  if (old.description !== next.description) push('description', old.description, next.description);
  if (old.listId !== next.listId) push('listId', old.listId, next.listId);
  if (old.completed !== next.completed) {
    push('completed', String(old.completed), String(next.completed));
  }
  if (old.dueDate !== next.dueDate) push('dueDate', old.dueDate ?? '', next.dueDate ?? '');
  if (old.startDate !== next.startDate) {
    push('startDate', old.startDate ?? '', next.startDate ?? '');
  }
  if (old.priority !== next.priority) push('priority', old.priority ?? '', next.priority ?? '');
  if (old.accent !== next.accent) push('accent', old.accent ?? '', next.accent ?? '');
  if (old.labels.join(',') !== next.labels.join(',')) {
    push('labels', old.labels.join(','), next.labels.join(','));
  }
}

/**
 * 执行匹配的本地规则，把结果写回任务。
 *
 * 与 Rust 侧 `automation::run_rules` 保持同一语义：只跑启用的规则、
 * 多条规则依次叠加、失败只记录到 `lastError` 不影响主流程。
 */
function runLocalRules(
  db: LocalDb,
  card: Card,
  trigger: AutomationRule['trigger'],
): void {
  const today = todayKey();
  const matching = db.automationRules.filter(
    (rule) =>
      rule.enabled &&
      rule.trigger === trigger &&
      (trigger !== 'move_to_list' || rule.listId === card.listId),
  );
  if (matching.length === 0) return;

  let labels = [...card.labels];
  let priority = card.priority;

  for (const rule of matching) {
    const error = validateRuleActions(rule.actions);
    if (error) {
      rule.lastError = error;
      continue;
    }
    const outcome = applyRuleActions({ ...card, labels, priority }, rule.actions, today);
    const patch = outcome.patch;
    try {
      if (patch.dueDate !== undefined) card.dueDate = patch.dueDate;
      if (patch.priority !== undefined) card.priority = patch.priority;
      if (patch.labels !== undefined) labels = patch.labels;
      card.labels = labels;
      priority = card.priority;
      if (patch.dueDate !== undefined) {
        pushActivity(db, {
          cardId: card.id,
          eventType: 'updated',
          field: 'dueDate',
          newValue: patch.dueDate ?? '',
        });
      }
      if (patch.priority !== undefined) {
        pushActivity(db, {
          cardId: card.id,
          eventType: 'updated',
          field: 'priority',
          newValue: patch.priority ?? '',
        });
      }
      if (patch.labels !== undefined) {
        pushActivity(db, {
          cardId: card.id,
          eventType: 'updated',
          field: 'labels',
          newValue: patch.labels.join(','),
        });
      }
      if (outcome.subtaskTitles.length > 0) {
        for (const title of outcome.subtaskTitles) {
          appendLocalSubtaskCard(db, card, title);
        }
        pushActivity(db, {
          cardId: card.id,
          eventType: 'updated',
          field: 'subtasks',
          newValue: outcome.subtaskTitles.join(','),
        });
      }
      rule.lastError = '';
    } catch (cause) {
      rule.lastError = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

/** V0.14.0：规则「追加子任务」创建真实子任务卡片（同名未删除子任务跳过）。 */
function appendLocalSubtaskCard(db: LocalDb, parent: Card, title: string): void {
  if (localCardDepth(db, parent.id) + 1 > MAX_TASK_DEPTH) {
    throw new Error('任务层级过深');
  }
  if (
    db.cards.some(
      (card) =>
        card.parentCardId === parent.id && !card.deletedAt && card.title === title,
    )
  ) {
    return;
  }
  const now = nowISO();
  const siblings = db.cards.filter(
    (card) => card.parentCardId === parent.id && !card.deletedAt,
  );
  db.cards.push({
    id: createId('c'),
    boardId: parent.boardId,
    listId: parent.listId,
    parentCardId: parent.id,
    title,
    description: '',
    dueDate: null,
    startDate: null,
    estimatedMinutes: null,
    actualMinutes: null,
    priority: null,
    accent: null,
    completed: false,
    deletedAt: null,
    labels: [],
    position: siblings.length
      ? Math.max(...siblings.map((card) => card.position)) + 1
      : 0,
    recurrenceId: null,
    generatedFromId: null,
    createdAt: now,
    updatedAt: now,
  });
  touchBoard(db, parent.boardId);
}

/**
 * 浏览器端滚动重复任务：克隆原任务生成下一次未完成任务。
 *
 * 幂等性由 `generatedFromId` 保证：同一张任务只会被生成一次。
 */
function rollLocalRecurrence(db: LocalDb, card: Card): Card | null {
  if (card.parentCardId) return null;
  const recurrence = db.recurrences.find(
    (item) => item.cardId === card.id || item.id === card.recurrenceId,
  );
  if (!recurrence || !recurrence.enabled) return null;
  if (db.cards.some((item) => item.generatedFromId === card.id)) return null;

  const base = recurrence.nextDueDate ?? card.dueDate ?? todayKey();
  const generatedDue = recurrence.nextDueDate ?? nextRecurrenceDateFor(recurrence, base) ?? base;
  const followingDue = nextRecurrenceDateFor(recurrence, generatedDue);

  const now = nowISO();
  const siblings = db.cards.filter((c) => c.listId === card.listId && !c.deletedAt);
  const generated: Card = {
    ...card,
    id: createId('c'),
    completed: false,
    deletedAt: null,
    actualMinutes: null,
    dueDate: generatedDue,
    startDate: null,
    labels: [...card.labels],
    position: siblings.length ? Math.max(...siblings.map((c) => c.position)) + 1 : 0,
    recurrenceId: recurrence.id,
    generatedFromId: card.id,
    createdAt: now,
    updatedAt: now,
  };
  db.cards.push(generated);
  recurrence.nextDueDate = followingDue;
  recurrence.updatedAt = now;
  pushActivity(db, {
    cardId: generated.id,
    eventType: 'recurrence',
    oldValue: '',
    newValue: card.id,
  });
  return generated;
}

function normalizeGoalScope(value: unknown): GoalScope {
  return value === 'company' || value === 'personal' ? value : 'team';
}

function normalizeGoalStatus(value: unknown): GoalStatus {
  return value === 'completed' || value === 'archived' ? value : 'active';
}

function clampProgress(value: unknown): number {
  const numeric = typeof value === 'number' ? value : 0;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function normalizeMemberRole(value: unknown): MemberRole {
  return value === 'dev' || value === 'test' || value === 'requirements' || value === 'design'
    ? value
    : 'other';
}

function normalizeMemberStatus(value: unknown): MemberStatus {
  return value === 'released' ? 'released' : 'active';
}

function normalizeOvertimeStatus(value: unknown): OvertimeStatus {
  if (value === 'done' || value === 'absent') return value;
  return 'planned';
}

function normalizePerformanceCategory(value: unknown): PerformanceCategory {
  return value === 'delivery' || value === 'quality' || value === 'collaboration'
    ? value
    : 'other';
}

const LEAVE_TYPES: readonly string[] = LEAVE_TYPE_KEYS;

function normalizeLeaveType(value: unknown): LeaveType {
  return typeof value === 'string' && LEAVE_TYPES.includes(value) ? (value as LeaveType) : 'other';
}

/** V0.16.1：请假只做记录，天数由人工填写，写库前统一四舍五入到两位。 */
function normalizeLeaveDays(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? roundLeaveDays(value) : fallback;
}

function loadLocalDb(): LocalDb {
  if (typeof localStorage === 'undefined') {
    return {
      boards: [],
      lists: [],
      cards: [],
      inbox: [],
      dependencies: [],
      boardSets: [],
      goals: [],
      teamMembers: [],
      overtimeRecords: [],
      performanceRecords: [],
      leaveRecords: [],
      memberTenures: [],
      projects: [],
      projectMetaFields: [],
      projectRoles: [],
      recurrences: [],
      automationRules: [],
      customFields: [],
      cardFieldValues: [],
      savedViews: [],
      cardActivity: [],
    };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        boards: [],
        lists: [],
        cards: [],
        inbox: [],
        dependencies: [],
        boardSets: [],
        goals: [],
        teamMembers: [],
        overtimeRecords: [],
        performanceRecords: [],
        leaveRecords: [],
        memberTenures: [],
        projects: [],
        projectMetaFields: [],
        projectRoles: [],
      recurrences: [],
      automationRules: [],
      customFields: [],
      cardFieldValues: [],
      savedViews: [],
      cardActivity: [],
      };
    }
    const parsed = JSON.parse(raw) as Partial<LocalDb>;
    const db: LocalDb = {
      boards: Array.isArray(parsed.boards)
        ? parsed.boards.map((board) => ({ ...board, labelColors: board.labelColors ?? {} }))
        : [],
      lists: Array.isArray(parsed.lists)
        ? parsed.lists.map((list) => ({
            ...list,
            color: list.color ?? 'slate',
            wipLimit: typeof list.wipLimit === 'number' ? list.wipLimit : null,
          }))
        : [],
      cards: Array.isArray(parsed.cards) ? parsed.cards.map(normalizeCard) : [],
      inbox: Array.isArray(parsed.inbox) ? parsed.inbox : [],
      dependencies: Array.isArray(parsed.dependencies)
        ? parsed.dependencies
            .filter(
              (item): item is CardDependency =>
                Boolean(item) &&
                typeof item.cardId === 'string' &&
                typeof item.dependsOnCardId === 'string',
            )
            // V0.12：旧备份没有关系类型字段，按「前置」处理。
            .map((item) => ({
              ...item,
              relationType: item.relationType ?? 'blocks',
            }))
        : [],
      boardSets: Array.isArray(parsed.boardSets)
        ? parsed.boardSets
            .filter(
              (item): item is BoardSet =>
                Boolean(item) &&
                typeof item.id === 'string' &&
                typeof item.title === 'string' &&
                Array.isArray(item.boardIds),
            )
            .map((item) => ({
              ...item,
              description: typeof item.description === 'string' ? item.description : '',
              boardIds: item.boardIds.filter((id): id is string => typeof id === 'string'),
            }))
        : [],
      goals: Array.isArray(parsed.goals)
        ? parsed.goals
            .filter(
              (item): item is Goal =>
                Boolean(item) &&
                typeof item.id === 'string' &&
                typeof item.title === 'string',
            )
            .map((item) => ({
              ...item,
              description: typeof item.description === 'string' ? item.description : '',
              scope: normalizeGoalScope(item.scope),
              status: normalizeGoalStatus(item.status),
              startDate: typeof item.startDate === 'string' ? item.startDate : null,
              dueDate: typeof item.dueDate === 'string' ? item.dueDate : null,
              manualProgress: clampProgress(item.manualProgress),
              parentId: typeof item.parentId === 'string' ? item.parentId : null,
              cardIds: Array.isArray(item.cardIds)
                ? item.cardIds.filter((id): id is string => typeof id === 'string')
                : [],
              position: typeof item.position === 'number' ? item.position : 0,
            }))
        : [],
      teamMembers: Array.isArray(parsed.teamMembers)
        ? parsed.teamMembers
            .filter(
              (item): item is TeamMember =>
                Boolean(item) && typeof item.id === 'string' && typeof item.name === 'string',
            )
            .map((item) => ({
              ...item,
              projectId: typeof item.projectId === 'string' ? item.projectId : '',
              roleId: typeof item.roleId === 'string' ? item.roleId : '',
              role: normalizeMemberRole(item.role),
              status: normalizeMemberStatus(item.status),
              joinedAt: typeof item.joinedAt === 'string' ? item.joinedAt : '',
              releasedAt: typeof item.releasedAt === 'string' ? item.releasedAt : null,
              note: typeof item.note === 'string' ? item.note : '',
            }))
        : [],
      overtimeRecords: Array.isArray(parsed.overtimeRecords)
        ? parsed.overtimeRecords
            .filter(
              (item): item is OvertimeRecord =>
                Boolean(item) && typeof item.id === 'string' && typeof item.memberId === 'string',
            )
            .map((item) => {
              const status = normalizeOvertimeStatus(item.status);
              return {
                ...item,
                projectId: typeof item.projectId === 'string' ? item.projectId : '',
                date: typeof item.date === 'string' ? item.date : '',
                hours: typeof item.hours === 'number' ? item.hours : 0,
                status,
                absenceReason: normalizeOvertimeAbsenceReason(
                  status,
                  typeof item.absenceReason === 'string' ? item.absenceReason : '',
                ),
                note: typeof item.note === 'string' ? item.note : '',
              };
            })
        : [],
      performanceRecords: Array.isArray(parsed.performanceRecords)
        ? parsed.performanceRecords
            .filter(
              (item): item is PerformanceRecord =>
                Boolean(item) && typeof item.id === 'string' && typeof item.memberId === 'string',
            )
            .map((item) => ({
              ...item,
              projectId: typeof item.projectId === 'string' ? item.projectId : '',
              date: typeof item.date === 'string' ? item.date : '',
              points: typeof item.points === 'number' ? item.points : 0,
              reason: typeof item.reason === 'string' ? item.reason : '',
              category: normalizePerformanceCategory(item.category),
              note: typeof item.note === 'string' ? item.note : '',
            }))
        : [],
      leaveRecords: Array.isArray(parsed.leaveRecords)
        ? parsed.leaveRecords
            .filter(
              (item): item is LeaveRecord =>
                Boolean(item) && typeof item.id === 'string' && typeof item.memberId === 'string',
            )
            .map((item) => {
              const startDate = typeof item.startDate === 'string' ? item.startDate : '';
              const endDate = typeof item.endDate === 'string' ? item.endDate : '';
              const now = nowISO();
              // 显式构造：V0.16.1 去掉了审批状态，旧数据里的 status 不再带进快照。
              const record: LeaveRecord = {
                id: item.id,
                projectId: typeof item.projectId === 'string' ? item.projectId : '',
                memberId: item.memberId,
                startDate,
                endDate,
                // V0.16.1：天数改为人工填写，旧数据缺 days 时按区间自然日补齐。
                days: normalizeLeaveDays(item.days, leaveSpanDays(startDate, endDate)),
                leaveType: normalizeLeaveType(item.leaveType),
                reason: typeof item.reason === 'string' ? item.reason : '',
                note: typeof item.note === 'string' ? item.note : '',
                createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
                updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : now,
              };
              return record;
            })
        : [],
      memberTenures: Array.isArray(parsed.memberTenures)
        ? parsed.memberTenures
            .filter(
              (item): item is MemberTenure =>
                Boolean(item) &&
                typeof item.id === 'string' &&
                typeof item.memberId === 'string' &&
                typeof item.projectId === 'string',
            )
            .map((item) => ({
              ...item,
              startedAt: typeof item.startedAt === 'string' ? item.startedAt : '',
              endedAt: typeof item.endedAt === 'string' ? item.endedAt : null,
              note: typeof item.note === 'string' ? item.note : '',
            }))
        : [],
      projects: Array.isArray(parsed.projects)
        ? parsed.projects
            .filter(
              (item): item is Project =>
                Boolean(item) && typeof item.id === 'string' && typeof item.name === 'string',
            )
            .map((item) => ({
              ...item,
              description: typeof item.description === 'string' ? item.description : '',
              color: typeof item.color === 'string' ? item.color : '#0f766e',
              status: item.status === 'archived' ? 'archived' : 'active',
              starred: Boolean(item.starred),
            }))
        : [],
      projectMetaFields: Array.isArray(parsed.projectMetaFields)
        ? parsed.projectMetaFields
            .filter(
              (item): item is ProjectMetaField =>
                Boolean(item) && typeof item.id === 'string' && typeof item.projectId === 'string',
            )
            .map((item) => ({
              ...item,
              name: typeof item.name === 'string' ? item.name : '',
              value: typeof item.value === 'string' ? item.value : '',
              position: typeof item.position === 'number' ? item.position : 0,
            }))
        : [],
      projectRoles: Array.isArray(parsed.projectRoles)
        ? parsed.projectRoles
            .filter(
              (item): item is ProjectRole =>
                Boolean(item) && typeof item.id === 'string' && typeof item.projectId === 'string',
            )
            .map((item) => ({
              ...item,
              name: typeof item.name === 'string' ? item.name : '',
              color: typeof item.color === 'string' ? item.color : '#64748b',
              position: typeof item.position === 'number' ? item.position : 0,
            }))
        : [],
      recurrences: Array.isArray(parsed.recurrences)
        ? parsed.recurrences
            .filter(
              (item): item is Recurrence =>
                Boolean(item) && typeof item.id === 'string' && typeof item.cardId === 'string',
            )
            .map(normalizeRecurrence)
        : [],
      automationRules: Array.isArray(parsed.automationRules)
        ? parsed.automationRules
            .filter(
              (item): item is AutomationRule =>
                Boolean(item) && typeof item.id === 'string' && typeof item.name === 'string',
            )
            .map(normalizeAutomationRule)
        : [],
      customFields: Array.isArray(parsed.customFields)
        ? parsed.customFields
            .filter(
              (item): item is CustomField =>
                Boolean(item) &&
                typeof item.id === 'string' &&
                typeof item.boardId === 'string' &&
                (item.fieldType === 'select' || item.fieldType === 'number'),
            )
            .map((item) => ({
              ...item,
              name: typeof item.name === 'string' ? item.name : '未命名字段',
              options: Array.isArray(item.options)
                ? item.options.filter(
                    (option): option is CustomFieldOption =>
                      Boolean(option) && typeof option.id === 'string',
                  )
                : [],
              sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : 0,
            }))
        : [],
      cardFieldValues: Array.isArray(parsed.cardFieldValues)
        ? parsed.cardFieldValues
            .filter(
              (item): item is CardFieldValue =>
                Boolean(item) &&
                typeof item.cardId === 'string' &&
                typeof item.fieldId === 'string',
            )
            .map((item) => ({
              ...item,
              valueText: typeof item.valueText === 'string' ? item.valueText : null,
              valueNumber:
                typeof item.valueNumber === 'number' && Number.isFinite(item.valueNumber)
                  ? item.valueNumber
                  : null,
            }))
        : [],
      savedViews: Array.isArray(parsed.savedViews)
        ? parsed.savedViews
            .filter(
              (item): item is SavedView =>
                Boolean(item) &&
                typeof item.id === 'string' &&
                typeof item.boardId === 'string',
            )
            .map((item) => ({
              ...item,
              name: typeof item.name === 'string' ? item.name : '未命名视图',
              viewType: item.viewType ?? 'board',
              filters: normalizeSavedViewFilters(item.filters),
              sort: normalizeSavedViewSort(item.sort),
              isBuiltin: item.isBuiltin === true,
            }))
        : [],
      cardActivity: Array.isArray(parsed.cardActivity)
        ? parsed.cardActivity
            .filter(
              (item): item is CardActivity =>
                Boolean(item) &&
                typeof item.id === 'string' &&
                typeof item.cardId === 'string',
            )
            .map(normalizeActivity)
        : [],
    };
    // 旧数据没有保存视图：给每个看板补齐内置视图（与 Rust 侧迁移同一套语义）
    db.cards = expandLegacySubtaskCards(db.cards as LegacyCard[]);
    for (const board of db.boards) ensureLocalBuiltinSavedViews(db, board.id);
    return db;
  } catch {
    return {
      boards: [],
      lists: [],
      cards: [],
      inbox: [],
      dependencies: [],
      boardSets: [],
      goals: [],
      teamMembers: [],
      overtimeRecords: [],
      performanceRecords: [],
      leaveRecords: [],
      memberTenures: [],
      projects: [],
      projectMetaFields: [],
      projectRoles: [],
      recurrences: [],
      automationRules: [],
      customFields: [],
      cardFieldValues: [],
      savedViews: [],
      cardActivity: [],
    };
  }
}

function saveLocalDb(db: LocalDb): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function touchBoard(db: LocalDb, boardId: string): void {
  const board = db.boards.find((b) => b.id === boardId);
  if (board) board.updatedAt = nowISO();
}

// 回收站里的任务不参与顺序归一化
function normalizePositions(db: LocalDb, listId: string): void {
  db.cards
    .filter((c) => c.listId === listId && c.parentCardId === null && !c.deletedAt)
    .sort((a, b) => a.position - b.position)
    .forEach((card, index) => {
      card.position = index;
    });
}

/** V0.14.0：递归子树 id（含自身）。 */
function cardSubtreeIds(db: LocalDb, rootId: string): string[] {
  const children = new Map<string, Card[]>();
  for (const card of db.cards) {
    if (!card.parentCardId) continue;
    const bucket = children.get(card.parentCardId) ?? [];
    bucket.push(card);
    children.set(card.parentCardId, bucket);
  }
  const ids = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const child of children.get(id) ?? []) {
      ids.push(child.id);
      queue.push(child.id);
    }
  }
  return ids;
}

/** V0.14.0：主任务移动列表时同步整棵子树。 */
function syncLocalSubtreeList(db: LocalDb, rootId: string, listId: string): void {
  for (const id of cardSubtreeIds(db, rootId)) {
    const card = db.cards.find((item) => item.id === id);
    if (card) card.listId = listId;
  }
}

/** V0.14.0：沿父链计算深度（主任务为 0），并拒绝断链/成环。 */
function localCardDepth(db: LocalDb, cardId: string): number {
  let depth = 0;
  const seen = new Set<string>();
  let current = db.cards.find((item) => item.id === cardId);
  while (current?.parentCardId) {
    if (seen.has(current.parentCardId)) throw new Error('父任务存在循环');
    seen.add(current.parentCardId);
    depth += 1;
    if (depth > MAX_TASK_DEPTH) throw new Error('任务层级过深');
    current = db.cards.find((item) => item.id === current?.parentCardId);
    if (!current) throw new Error('父任务不存在');
  }
  return depth;
}

function normalizeListPositions(db: LocalDb, boardId: string): void {
  db.lists
    .filter((l) => l.boardId === boardId)
    .sort((a, b) => a.position - b.position)
    .forEach((list, index) => {
      list.position = index;
    });
}

function requireBoard(db: LocalDb, id: string): Board {
  const board = db.boards.find((b) => b.id === id);
  if (!board) throw new Error(`看板不存在：${id}`);
  return board;
}

function requireList(db: LocalDb, id: string): List {
  const list = db.lists.find((l) => l.id === id);
  if (!list) throw new Error(`列表不存在：${id}`);
  return list;
}

function requireCard(db: LocalDb, id: string): Card {
  const card = db.cards.find((c) => c.id === id);
  if (!card) throw new Error(`任务不存在：${id}`);
  return card;
}

function requireBoardSet(db: LocalDb, id: string): BoardSet {
  const set = db.boardSets.find((item) => item.id === id);
  if (!set) throw new Error(`看板集不存在：${id}`);
  return set;
}

function normalizeBoardSetBoardIds(db: LocalDb, boardIds: string[]): string[] {
  const unique: string[] = [];
  for (const id of boardIds) {
    if (unique.includes(id)) continue;
    requireBoard(db, id);
    unique.push(id);
  }
  return unique;
}

function requireGoal(db: LocalDb, id: string): Goal {
  const goal = db.goals.find((item) => item.id === id);
  if (!goal) throw new Error(`目标不存在：${id}`);
  return goal;
}

function todayLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`;
}

function requireTeamMember(db: LocalDb, id: string): TeamMember {
  const member = db.teamMembers.find((item) => item.id === id);
  if (!member) throw new Error(`项目成员不存在：${id}`);
  return member;
}

function syncLocalMemberTenures(db: LocalDb, memberId: string): void {
  const member = db.teamMembers.find((item) => item.id === memberId);
  if (!member) return;
  const tenures = db.memberTenures
    .filter((item) => item.memberId === memberId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (tenures.length === 0) {
    member.status = 'released';
    member.releasedAt = member.releasedAt ?? todayLocalDate();
    member.updatedAt = nowISO();
    return;
  }
  member.joinedAt = tenures[0].startedAt;
  const open = tenures.find((item) => item.endedAt === null);
  member.status = open ? 'active' : 'released';
  member.releasedAt = open
    ? null
    : tenures
        .map((item) => item.endedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
  member.updatedAt = nowISO();
}

function validateLocalTenure(
  db: LocalDb,
  memberId: string,
  startedAt: string,
  endedAt: string | null,
  excludeId?: string,
): void {
  if (!startedAt.trim()) throw new Error('入组日期不能为空');
  if (endedAt && endedAt < startedAt) throw new Error('出组日期不能早于入组日期');
  const newEnd = endedAt ?? '9999-12-31';
  for (const existing of db.memberTenures) {
    if (existing.memberId !== memberId || existing.id === excludeId) continue;
    if (!endedAt && !existing.endedAt) {
      throw new Error('该成员已有一段未结束的投入记录，请先填写出组日期');
    }
    const oldEnd = existing.endedAt ?? '9999-12-31';
    if (startedAt < oldEnd && existing.startedAt < newEnd) {
      throw new Error(
        `时间段与已有记录（${existing.startedAt} 至 ${existing.endedAt ?? '至今'}）重叠`,
      );
    }
  }
}

function requireProject(db: LocalDb, id: string): Project {
  const project = db.projects.find((item) => item.id === id);
  if (!project) throw new Error(`项目不存在：${id}`);
  return project;
}

function requireProjectRole(db: LocalDb, projectId: string, roleId: string): ProjectRole {
  const role = db.projectRoles.find((item) => item.id === roleId);
  if (!role || role.projectId !== projectId) throw new Error('角色不属于该项目');
  return role;
}

function normalizeGoalCardIds(db: LocalDb, cardIds: string[]): string[] {
  const unique: string[] = [];
  for (const id of cardIds) {
    if (unique.includes(id)) continue;
    requireCard(db, id);
    unique.push(id);
  }
  return unique;
}

function validateGoalParent(
  db: LocalDb,
  goalId: string | null,
  parentId: string | null,
): string | null {
  if (!parentId) return null;
  if (goalId && parentId === goalId) throw new Error('目标不能把自己设为父目标');
  let current: string | null = parentId;
  let guard = 0;
  while (current) {
    if (goalId && current === goalId) throw new Error('目标层级不能形成循环');
    guard += 1;
    if (guard > 100) throw new Error('目标层级过深，已停止保存');
    const parent = db.goals.find((item) => item.id === current);
    if (!parent) throw new Error(`父目标不存在：${current}`);
    current = parent.parentId;
  }
  return parentId;
}

/** 彻底删除任务时同步清理目标关联（软删除保留关联，恢复后仍可回写进度）。 */
function pruneGoalCards(db: LocalDb, removedCardIds: Set<string>): void {
  if (removedCardIds.size === 0) return;
  db.goals = db.goals.map((goal) => ({
    ...goal,
    cardIds: goal.cardIds.filter((cardId) => !removedCardIds.has(cardId)),
  }));
}

/** 删除任务时同步清理依赖边（两个方向），避免引用已不存在的任务。 */
function pruneDependencies(db: LocalDb, removedCardIds: Set<string>): void {
  if (removedCardIds.size === 0) {
    db.dependencies = [];
    return;
  }
  db.dependencies = db.dependencies.filter(
    (dependency) =>
      !removedCardIds.has(dependency.cardId) &&
      !removedCardIds.has(dependency.dependsOnCardId),
  );
}

/** 沿依赖边判断 `from` 是否能到达 `target`，用于本地拒绝循环依赖。 */
function dependencyReaches(
  edges: Map<string, string[]>,
  from: string,
  target: string,
): boolean {
  const stack = [from];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(edges.get(current) ?? []));
  }
  return false;
}

/** 规整自定义字段的选项列表：单选至少一项，数值字段不允许带选项。 */
function normalizeLocalFieldOptions(
  fieldType: CustomFieldType,
  raw: CustomFieldOption[],
): CustomFieldOption[] {
  if (fieldType === 'number') {
    if (raw.length > 0) throw new Error('数值字段不支持选项');
    return [];
  }
  const options: CustomFieldOption[] = [];
  for (const option of raw) {
    const id = option.id.trim();
    if (!id) continue;
    if (options.some((item) => item.id === id)) continue;
    options.push({
      id,
      label: option.label.trim() || id,
      color: option.color.trim() || '#64748b',
    });
  }
  if (options.length === 0) throw new Error('单选字段至少需要一个选项');
  return options;
}

function requireCustomField(db: LocalDb, id: string): CustomField {
  const field = db.customFields.find((item) => item.id === id);
  if (!field) throw new Error('自定义字段不存在：' + id);
  return field;
}

/* ---------- 保存的筛选视图（V0.13.1） ---------- */

/** 内置视图的标识与名称：id 固定，重复补齐不会产生重复行。 */
const LOCAL_BUILTIN_SAVED_VIEWS: ReadonlyArray<{
  key: string;
  name: string;
  filters: SavedViewFilters;
  sort: SavedViewSort;
}> = [
  {
    key: 'all',
    name: '全部',
    filters: {
      keyword: '',
      status: 'all',
      priorities: [],
      labels: [],
      fieldFilters: [],
      blocked: false,
    },
    sort: { key: 'due-asc', direction: 'asc' },
  },
  {
    key: 'mine',
    name: '我的任务',
    filters: {
      keyword: '',
      status: 'active',
      priorities: [],
      labels: [],
      fieldFilters: [],
      blocked: false,
    },
    sort: { key: 'due-asc', direction: 'asc' },
  },
  {
    key: 'recent',
    name: '最近更新',
    filters: {
      keyword: '',
      status: 'all',
      priorities: [],
      labels: [],
      fieldFilters: [],
      blocked: false,
    },
    sort: { key: 'updated-desc', direction: 'desc' },
  },
];

function requireSavedView(db: LocalDb, id: string): SavedView {
  const view = db.savedViews.find((item) => item.id === id);
  if (!view) throw new Error('保存视图不存在：' + id);
  return view;
}

/**
 * 字段或选项被删除后，视图里指向它们的条件自动降级：字段没了就丢掉整条条件，
 * 选项没了就去掉那个选项 id。读视图与写视图都走这里，保证两边行为一致。
 */
function degradeLocalSavedViewFilters(db: LocalDb, filters: SavedViewFilters): SavedViewFilters {
  return degradeSavedViewFieldFilters(filters, db.customFields);
}

/** 给某个看板补齐内置视图（幂等）。 */
function ensureLocalBuiltinSavedViews(db: LocalDb, boardId: string): void {
  const now = nowISO();
  for (const item of LOCAL_BUILTIN_SAVED_VIEWS) {
    const id = 'sv_builtin_' + boardId + '_' + item.key;
    if (db.savedViews.some((view) => view.id === id)) continue;
    db.savedViews.push({
      id,
      boardId,
      name: item.name,
      viewType: 'board',
      filters: { ...item.filters },
      sort: { ...item.sort },
      isBuiltin: true,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** 清理已删除任务残留的字段取值，避免留下孤儿行。 */
function pruneCardFieldValues(db: LocalDb, removedCardIds: Set<string>): void {
  db.cardFieldValues = db.cardFieldValues.filter(
    (value) => !removedCardIds.has(value.cardId),
  );
}

const localApi: TidelineApi = {
  async getSnapshot() {
    const db = loadLocalDb();
    return {
      boards: [...db.boards].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      lists: [...db.lists].sort((a, b) => a.position - b.position),
      cards: [...db.cards]
        .filter((card) => !card.deletedAt)
        .sort((a, b) => a.position - b.position),
      inbox: [...db.inbox].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      dependencies: [...db.dependencies].sort((a, b) =>
        `${a.cardId}:${a.dependsOnCardId}`.localeCompare(`${b.cardId}:${b.dependsOnCardId}`),
      ),
      boardSets: [...db.boardSets].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
      goals: [...db.goals].sort(
        (a, b) => a.position - b.position || a.id.localeCompare(b.id),
      ),
      teamMembers: [...db.teamMembers].sort(
        (a, b) => a.status.localeCompare(b.status) || a.joinedAt.localeCompare(b.joinedAt),
      ),
      overtimeRecords: [...db.overtimeRecords].sort((a, b) => b.date.localeCompare(a.date)),
      performanceRecords: [...db.performanceRecords].sort((a, b) =>
        b.date.localeCompare(a.date),
      ),
      leaveRecords: [...db.leaveRecords].sort(
        (a, b) => b.startDate.localeCompare(a.startDate) || b.createdAt.localeCompare(a.createdAt),
      ),
      memberTenures: [...db.memberTenures].sort(
        (a, b) => a.projectId.localeCompare(b.projectId) || a.startedAt.localeCompare(b.startedAt),
      ),
      projects: [...db.projects].sort(
        (a, b) =>
          Number(b.starred) - Number(a.starred) ||
          a.status.localeCompare(b.status) ||
          b.updatedAt.localeCompare(a.updatedAt),
      ),
      projectMetaFields: [...db.projectMetaFields].sort(
        (a, b) => a.projectId.localeCompare(b.projectId) || a.position - b.position,
      ),
      projectRoles: [...db.projectRoles].sort(
        (a, b) => a.projectId.localeCompare(b.projectId) || a.position - b.position,
      ),
      recurrences: [...db.recurrences].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
      automationRules: [...db.automationRules].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
      customFields: [...db.customFields].sort(
        (a, b) =>
          a.boardId.localeCompare(b.boardId) ||
          a.sortOrder - b.sortOrder ||
          a.createdAt.localeCompare(b.createdAt),
      ),
      cardFieldValues: [...db.cardFieldValues].sort((a, b) =>
        `${a.cardId}:${a.fieldId}`.localeCompare(`${b.cardId}:${b.fieldId}`),
      ),
      savedViews: [...db.savedViews]
        .sort((a, b) =>
          a.boardId.localeCompare(b.boardId) || a.createdAt.localeCompare(b.createdAt),
        )
        .map((view) => ({
          ...view,
          filters: degradeSavedViewFieldFilters(view.filters, db.customFields),
        })),
    };
  },

  async createBoard(input) {
    const db = loadLocalDb();
    const now = nowISO();
    const board: Board = {
      id: createId('b'),
      title: input.title.trim() || '未命名看板',
      description: input.description?.trim() ?? '',
      color: input.color ?? 'blue',
      starred: false,
      labelColors: {},
      createdAt: now,
      updatedAt: now,
    };
    db.boards.push(board);
    // 新看板同步补齐内置保存视图（与 Rust 侧 create_board 保持一致）
    ensureLocalBuiltinSavedViews(db, board.id);
    saveLocalDb(db);
    return board;
  },

  // V0.15.0：一次性创建看板与看板列（Excel 导入用）
  async createBoardWithLists(input) {
    const db = loadLocalDb();
    const now = nowISO();
    const board: Board = {
      id: createId('b'),
      title: input.title.trim() || '未命名看板',
      description: input.description?.trim() ?? '',
      color: input.color ?? 'blue',
      starred: false,
      labelColors: {},
      createdAt: now,
      updatedAt: now,
    };
    db.boards.push(board);
    ensureLocalBuiltinSavedViews(db, board.id);

    // 看板列：去空、去重、保序；一条都没有时补一条「待办」
    const titles: string[] = [];
    for (const title of input.listTitles) {
      const trimmed = title.trim();
      if (!trimmed || titles.includes(trimmed)) continue;
      titles.push(trimmed);
    }
    if (titles.length === 0) titles.push('待办');

    const lists: List[] = titles.map((title, index) => {
      const list: List = {
        id: createId('l'),
        boardId: board.id,
        title,
        color: 'slate',
        wipLimit: null,
        position: index,
        createdAt: now,
      };
      db.lists.push(list);
      return list;
    });

    saveLocalDb(db);
    return { board, lists };
  },

  // V0.15.0：浏览器模式没有原生保存框，直接触发下载
  async saveBinaryFile(input) {
    const binary = atob(input.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = input.fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { path: input.fileName };
  },

  async updateBoard({ id, patch }) {
    const db = loadLocalDb();
    const board = requireBoard(db, id);
    Object.assign(board, patch, { updatedAt: nowISO() });
    saveLocalDb(db);
    return board;
  },

  async deleteBoard({ id }) {
    const db = loadLocalDb();
    const removedCardIds = new Set(
      db.cards.filter((card) => card.boardId === id).map((card) => card.id),
    );
    db.boards = db.boards.filter((b) => b.id !== id);
    const removedListIds = new Set(db.lists.filter((l) => l.boardId === id).map((l) => l.id));
    db.lists = db.lists.filter((l) => l.boardId !== id);
    db.cards = db.cards.filter((c) => !removedListIds.has(c.listId) && c.boardId !== id);
    db.boardSets = db.boardSets.map((set) =>
      set.boardIds.includes(id)
        ? {
            ...set,
            boardIds: set.boardIds.filter((boardId) => boardId !== id),
            updatedAt: nowISO(),
          }
        : set,
    );
    db.goals = db.goals.map((goal) => ({
      ...goal,
      cardIds: goal.cardIds.filter((cardId) => !removedCardIds.has(cardId)),
    }));
    pruneDependencies(db, removedCardIds);
    pruneCardFieldValues(db, removedCardIds);
    saveLocalDb(db);
  },

  async createList(input) {
    const db = loadLocalDb();
    requireBoard(db, input.boardId);
    const siblings = db.lists.filter((l) => l.boardId === input.boardId);
    const list: List = {
      id: createId('l'),
      boardId: input.boardId,
      title: input.title.trim() || '未命名列表',
      color: input.color ?? 'slate',
      wipLimit: input.wipLimit && input.wipLimit > 0 ? input.wipLimit : null,
      position: siblings.length ? Math.max(...siblings.map((l) => l.position)) + 1 : 0,
      createdAt: nowISO(),
    };
    db.lists.push(list);
    touchBoard(db, input.boardId);
    saveLocalDb(db);
    return list;
  },

  async updateList({ id, patch }) {
    const db = loadLocalDb();
    const list = requireList(db, id);
    if (patch.title !== undefined) list.title = patch.title.trim() || '未命名列表';
    if (patch.color !== undefined) list.color = patch.color;
    if (patch.wipLimit !== undefined) {
      list.wipLimit = patch.wipLimit && patch.wipLimit > 0 ? patch.wipLimit : null;
    }
    touchBoard(db, list.boardId);
    saveLocalDb(db);
    return list;
  },

  async deleteList({ id }) {
    const db = loadLocalDb();
    const list = requireList(db, id);
    const removedCardIds = new Set(
      db.cards.filter((card) => card.listId === id).map((card) => card.id),
    );
    db.lists = db.lists.filter((l) => l.id !== id);
    db.cards = db.cards.filter((c) => c.listId !== id);
    pruneDependencies(db, removedCardIds);
    pruneCardFieldValues(db, removedCardIds);
    normalizeListPositions(db, list.boardId);
    touchBoard(db, list.boardId);
    saveLocalDb(db);
  },

  async createCard(input) {
    validateCardMinutes(input);
    const db = loadLocalDb();
    requireList(db, input.listId);
    const parentCardId = input.parentCardId ?? null;
    if (parentCardId) {
      const parent = requireCard(db, parentCardId);
      if (parent.boardId !== input.boardId) {
        throw new Error('子任务必须与父任务在同一看板');
      }
      if (parent.listId !== input.listId) {
        throw new Error('子任务必须跟随父任务列表');
      }
      if (parent.deletedAt) {
        throw new Error('父任务在回收站中，不能添加子任务');
      }
      if (localCardDepth(db, parentCardId) + 1 > MAX_TASK_DEPTH) {
        throw new Error('任务层级过深');
      }
    }
    const siblings = db.cards.filter(
      (c) => c.listId === input.listId && !c.deletedAt && c.parentCardId === parentCardId,
    );
    const now = nowISO();
    const card: Card = {
      id: createId('c'),
      boardId: input.boardId,
      listId: input.listId,
      parentCardId,
      title: input.title.trim() || '未命名任务',
      description: input.description?.trim() ?? '',
      dueDate: input.dueDate ?? null,
      startDate: input.startDate ?? null,
      estimatedMinutes: input.estimatedMinutes ?? null,
      actualMinutes: input.actualMinutes ?? null,
      priority: input.priority ?? null,
      accent: input.accent ?? null,
      completed: false,
      deletedAt: null,
      labels: input.labels ? [...input.labels] : [],
      position: siblings.length ? Math.max(...siblings.map((c) => c.position)) + 1 : 0,
      recurrenceId: null,
      generatedFromId: null,
      createdAt: now,
      updatedAt: now,
    };
    db.cards.push(card);
    pushActivity(db, { cardId: card.id, eventType: 'created' });
    touchBoard(db, input.boardId);
    saveLocalDb(db);
    return card;
  },

  async updateCard({ id, patch }) {
    validateCardMinutes(patch);
    const db = loadLocalDb();
    const card = requireCard(db, id);
    const previous = { ...card, labels: [...card.labels] };
    if (patch.title !== undefined) card.title = patch.title.trim() || '未命名任务';
    if (patch.description !== undefined) card.description = patch.description;
    if (patch.dueDate !== undefined) card.dueDate = patch.dueDate;
    if (patch.startDate !== undefined) card.startDate = patch.startDate;
    if (patch.estimatedMinutes !== undefined) card.estimatedMinutes = patch.estimatedMinutes;
    if (patch.actualMinutes !== undefined) card.actualMinutes = patch.actualMinutes;
    if (patch.priority !== undefined) card.priority = patch.priority;
    if (patch.accent !== undefined) card.accent = patch.accent;
    if (patch.completed !== undefined) card.completed = patch.completed;
    if (patch.labels !== undefined) card.labels = [...patch.labels];
    if (card.parentCardId && patch.listId !== undefined && patch.listId !== card.listId) {
      throw new Error('子任务不能单独移动列表');
    }
    if (patch.listId !== undefined && patch.listId !== card.listId) {
      const targetList = requireList(db, patch.listId);
      if (targetList.boardId !== card.boardId) throw new Error('不能跨看板移动任务');
      const oldListId = card.listId;
      card.listId = patch.listId;
      // 主任务移动列表时，整棵子树一起跟随。
      syncLocalSubtreeList(db, card.id, card.listId);
      normalizePositions(db, oldListId);
      card.position = db.cards.filter(
        (c) =>
          c.listId === card.listId &&
          c.id !== card.id &&
          c.parentCardId === null &&
          !c.deletedAt,
      ).length;
    }
    card.updatedAt = nowISO();
    recordLocalCardChanges(db, previous, card);

    const becameComplete = !previous.completed && card.completed;
    if (becameComplete) {
      pushActivity(db, { cardId: card.id, eventType: 'completed' });
      runLocalRules(db, card, 'complete');
      rollLocalRecurrence(db, card);
    }
    if (patch.listId !== undefined && patch.listId !== previous.listId) {
      pushActivity(db, { cardId: card.id, eventType: 'moved' });
      runLocalRules(db, card, 'move_to_list');
    }
    touchBoard(db, card.boardId);
    saveLocalDb(db);
    return card;
  },

  async deleteCard({ id }) {
    const db = loadLocalDb();
    const card = requireCard(db, id);
    if (card.deletedAt) return;
    const now = nowISO();
    const ids = cardSubtreeIds(db, card.id);
    for (const subtreeId of ids) {
      const item = requireCard(db, subtreeId);
      if (item.deletedAt) continue;
      item.deletedAt = now;
      item.updatedAt = now;
    }
    pushActivity(db, { cardId: card.id, eventType: 'deleted' });
    pruneDependencies(db, new Set(ids));
    pruneCardFieldValues(db, new Set(ids));
    normalizePositions(db, card.listId);
    touchBoard(db, card.boardId);
    saveLocalDb(db);
  },

  async getTrash() {
    const db = loadLocalDb();
    return [...db.cards]
      .filter((card) => card.deletedAt)
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  },

  async restoreCard({ id }) {
    const db = loadLocalDb();
    const card = requireCard(db, id);
    if (!card.deletedAt) return card;
    requireBoard(db, card.boardId);
    requireList(db, card.listId);
    const now = nowISO();
    // 先恢复仍被删除的祖先链（根 → 父），避免子任务悬空。
    const ancestors: Card[] = [];
    let cursor = card.parentCardId;
    while (cursor) {
      const parent = db.cards.find((item) => item.id === cursor);
      if (!parent) throw new Error('父任务不存在');
      ancestors.unshift(parent);
      cursor = parent.parentCardId;
    }
    for (const ancestor of ancestors) {
      if (!ancestor.deletedAt) continue;
      ancestor.deletedAt = null;
      ancestor.updatedAt = now;
      pushActivity(db, { cardId: ancestor.id, eventType: 'restored' });
      touchBoard(db, ancestor.boardId);
    }
    const siblings = db.cards.filter(
      (item) =>
        item.listId === card.listId &&
        item.id !== card.id &&
        item.parentCardId === card.parentCardId &&
        !item.deletedAt,
    );
    card.position = siblings.length
      ? Math.max(...siblings.map((item) => item.position)) + 1
      : 0;
    for (const subtreeId of cardSubtreeIds(db, card.id)) {
      const item = requireCard(db, subtreeId);
      if (!item.deletedAt) continue;
      item.deletedAt = null;
      item.updatedAt = now;
    }
    card.updatedAt = now;
    pushActivity(db, { cardId: card.id, eventType: 'restored' });
    touchBoard(db, card.boardId);
    saveLocalDb(db);
    return card;
  },

  async purgeCard({ id }) {
    const db = loadLocalDb();
    const ids = new Set(cardSubtreeIds(db, id));
    db.cards = db.cards.filter((card) => !ids.has(card.id));
    pruneDependencies(db, ids);
    pruneCardFieldValues(db, ids);
    pruneGoalCards(db, ids);
    saveLocalDb(db);
  },

  async emptyTrash() {
    const db = loadLocalDb();
    const removed = new Set(db.cards.filter((card) => card.deletedAt).map((card) => card.id));
    db.cards = db.cards.filter((card) => !card.deletedAt);
    pruneDependencies(db, removed);
    pruneGoalCards(db, removed);
    saveLocalDb(db);
  },

  async moveCard({ cardId, toListId, toIndex }) {
    const db = loadLocalDb();
    const card = requireCard(db, cardId);
    if (card.parentCardId) throw new Error('子任务不能单独移动列表');
    const targetList = requireList(db, toListId);
    if (targetList.boardId !== card.boardId) throw new Error('不能跨看板移动任务');
    const oldListId = card.listId;
    const targetCards = db.cards
      .filter(
        (c) =>
          c.listId === toListId &&
          c.id !== cardId &&
          c.parentCardId === null &&
          !c.deletedAt,
      )
      .sort((a, b) => a.position - b.position);
    const index = Math.max(0, Math.min(toIndex, targetCards.length));
    targetCards.splice(index, 0, card);
    card.listId = toListId;
    targetCards.forEach((c, i) => {
      c.position = i;
    });
    syncLocalSubtreeList(db, card.id, toListId);
    if (oldListId !== toListId) {
      normalizePositions(db, oldListId);
      pushActivity(db, { cardId: card.id, eventType: 'moved' });
      runLocalRules(db, card, 'move_to_list');
    }
    touchBoard(db, card.boardId);
    saveLocalDb(db);
    return card;
  },

  async setCardDependencies({ cardId, dependsOn, relationTypes }) {
    const db = loadLocalDb();
    const card = requireCard(db, cardId);
    if (card.deletedAt) throw new Error('回收站中的任务不能设置关系');
    // 目标 id 与关系类型一一对应；缺省类型按 blocks 处理。
    const relations: Array<{ id: string; type: RelationType }> = [];
    for (const [index, id] of dependsOn.entries()) {
      if (id === card.id) throw new Error('任务不能关联自己');
      if (relations.some((item) => item.id === id)) continue;
      const target = requireCard(db, id);
      if (target.deletedAt) throw new Error(`关联任务「${target.title}」在回收站中`);
      relations.push({ id, type: relationTypes?.[index] ?? 'blocks' });
    }

    // 只有 blocks 关系参与循环依赖检测。
    const blocking = relations.filter((item) => item.type === 'blocks').map((item) => item.id);
    const edges = new Map<string, string[]>();
    for (const dependency of db.dependencies) {
      if (dependency.cardId === card.id) continue;
      if ((dependency.relationType ?? 'blocks') !== 'blocks') continue;
      const list = edges.get(dependency.cardId) ?? [];
      list.push(dependency.dependsOnCardId);
      edges.set(dependency.cardId, list);
    }
    edges.set(card.id, blocking);
    for (const blocker of blocking) {
      if (dependencyReaches(edges, blocker, card.id)) {
        throw new Error('前置任务形成了循环依赖');
      }
    }

    db.dependencies = db.dependencies.filter((dependency) => dependency.cardId !== card.id);
    for (const relation of relations) {
      db.dependencies.push({
        cardId: card.id,
        dependsOnCardId: relation.id,
        relationType: relation.type,
      });
    }
    saveLocalDb(db);
    return relations.map((relation) => ({
      cardId: card.id,
      dependsOnCardId: relation.id,
      relationType: relation.type,
    }));
  },

  /* ---------- 自定义字段（V0.13.0） ---------- */

  async createCustomField(input) {
    const db = loadLocalDb();
    requireBoard(db, input.boardId);
    const name = input.name.trim() || '未命名字段';
    if (db.customFields.some((f) => f.boardId === input.boardId && f.name === name)) {
      throw new Error('该看板已存在同名字段');
    }
    const options = normalizeLocalFieldOptions(input.fieldType, input.options ?? []);
    const now = nowISO();
    const field: CustomField = {
      id: createId('cf'),
      boardId: input.boardId,
      name,
      fieldType: input.fieldType,
      options,
      sortOrder: db.customFields.filter((f) => f.boardId === input.boardId).length,
      createdAt: now,
      updatedAt: now,
    };
    db.customFields.push(field);
    touchBoard(db, input.boardId);
    saveLocalDb(db);
    return field;
  },

  async updateCustomField({ id, patch }) {
    const db = loadLocalDb();
    const field = requireCustomField(db, id);
    if (patch.name !== undefined) {
      const name = patch.name.trim() || '未命名字段';
      if (
        db.customFields.some(
          (item) => item.id !== id && item.boardId === field.boardId && item.name === name,
        )
      ) {
        throw new Error('该看板已存在同名字段');
      }
      field.name = name;
    }
    if (patch.options !== undefined) {
      const options = normalizeLocalFieldOptions(field.fieldType, patch.options);
      const kept = new Set(options.map((option) => option.id));
      // 被移除的选项不再合法，指向它们的取值一并清理
      db.cardFieldValues = db.cardFieldValues.filter(
        (value) =>
          value.fieldId !== field.id ||
          value.valueText === null ||
          kept.has(value.valueText),
      );
      field.options = options;
    }
    if (patch.sortOrder !== undefined) field.sortOrder = patch.sortOrder;
    field.updatedAt = nowISO();
    touchBoard(db, field.boardId);
    saveLocalDb(db);
    return field;
  },

  async deleteCustomField({ id }) {
    const db = loadLocalDb();
    const field = requireCustomField(db, id);
    db.cardFieldValues = db.cardFieldValues.filter((value) => value.fieldId !== field.id);
    db.customFields = db.customFields.filter((item) => item.id !== field.id);
    touchBoard(db, field.boardId);
    saveLocalDb(db);
  },

  async setCardFieldValues({ cardId, values }) {
    const db = loadLocalDb();
    const card = requireCard(db, cardId);
    if (card.deletedAt) throw new Error('回收站中的任务不能设置字段值');
    const seen = new Set<string>();
    for (const item of values) {
      if (seen.has(item.fieldId)) throw new Error('同一字段不能重复赋值');
      seen.add(item.fieldId);
      const field = requireCustomField(db, item.fieldId);
      if (field.boardId !== card.boardId) throw new Error('不能给其它看板的任务设置字段值');
      const hasText = item.valueText !== undefined && item.valueText !== null;
      const hasNumber = item.valueNumber !== undefined && item.valueNumber !== null;
      if (field.fieldType === 'select') {
        if (hasNumber) throw new Error('单选字段只能保存选项');
        if (hasText && !field.options.some((option) => option.id === item.valueText)) {
          throw new Error('选项不存在：' + item.valueText);
        }
      } else if (field.fieldType === 'number') {
        if (hasText) throw new Error('数值字段只能保存数字');
        if (hasNumber && !Number.isFinite(item.valueNumber as number)) {
          throw new Error('数值字段必须是有限数字');
        }
      }
    }
    for (const item of values) {
      db.cardFieldValues = db.cardFieldValues.filter(
        (value) => !(value.cardId === card.id && value.fieldId === item.fieldId),
      );
      const hasText = item.valueText !== undefined && item.valueText !== null;
      const hasNumber = item.valueNumber !== undefined && item.valueNumber !== null;
      if (!hasText && !hasNumber) continue;
      db.cardFieldValues.push({
        cardId: card.id,
        fieldId: item.fieldId,
        valueText: hasText ? (item.valueText as string) : null,
        valueNumber: hasNumber ? (item.valueNumber as number) : null,
      });
    }
    touchBoard(db, card.boardId);
    saveLocalDb(db);
    return db.cardFieldValues.filter((value) => value.cardId === card.id);
  },

  /* ---------- 保存的筛选视图（V0.13.1） ---------- */

  async createSavedView({ boardId, name, viewType, filters, sort }) {
    const db = loadLocalDb();
    requireBoard(db, boardId);
    const trimmed = name.trim();
    if (!trimmed) throw new Error('请先填写视图名称');
    if (db.savedViews.some((view) => view.boardId === boardId && view.name === trimmed)) {
      throw new Error('该看板已存在同名视图');
    }
    const now = nowISO();
    const view: SavedView = {
      id: createId('sv'),
      boardId,
      name: trimmed,
      viewType: viewType ?? 'board',
      filters: degradeLocalSavedViewFilters(db, normalizeSavedViewFilters(filters)),
      sort: normalizeSavedViewSort(sort),
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    };
    db.savedViews.push(view);
    touchBoard(db, boardId);
    saveLocalDb(db);
    return view;
  },

  async updateSavedView({ id, patch }) {
    const db = loadLocalDb();
    const view = requireSavedView(db, id);
    if (view.isBuiltin) throw new Error('内置视图不可修改');
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw new Error('请先填写视图名称');
      if (
        db.savedViews.some(
          (item) =>
            item.id !== id && item.boardId === view.boardId && item.name === trimmed,
        )
      ) {
        throw new Error('该看板已存在同名视图');
      }
      view.name = trimmed;
    }
    if (patch.viewType !== undefined) view.viewType = patch.viewType;
    if (patch.filters !== undefined) {
      view.filters = degradeLocalSavedViewFilters(
        db,
        normalizeSavedViewFilters(patch.filters),
      );
    }
    if (patch.sort !== undefined) view.sort = normalizeSavedViewSort(patch.sort);
    view.updatedAt = nowISO();
    touchBoard(db, view.boardId);
    saveLocalDb(db);
    return view;
  },

  async deleteSavedView({ id }) {
    const db = loadLocalDb();
    const view = requireSavedView(db, id);
    if (view.isBuiltin) throw new Error('内置视图不可删除');
    db.savedViews = db.savedViews.filter((item) => item.id !== id);
    touchBoard(db, view.boardId);
    saveLocalDb(db);
  },

  async addInboxItem({ content }) {
    const db = loadLocalDb();
    const item: InboxItem = {
      id: createId('i'),
      content: content.trim(),
      createdAt: nowISO(),
    };
    db.inbox.push(item);
    saveLocalDb(db);
    return item;
  },

  async deleteInboxItem({ id }) {
    const db = loadLocalDb();
    db.inbox = db.inbox.filter((item) => item.id !== id);
    saveLocalDb(db);
  },

  async convertInboxItem({ id, boardId, listId }) {
    const db = loadLocalDb();
    const item = db.inbox.find((i) => i.id === id);
    if (!item) throw new Error('收件箱条目不存在');
    requireBoard(db, boardId);
    let targetListId = listId;
    if (!targetListId) {
      const firstList = db.lists
        .filter((l) => l.boardId === boardId)
        .sort((a, b) => a.position - b.position)[0];
      if (!firstList) throw new Error('看板还没有列表，请先添加列表');
      targetListId = firstList.id;
    }
    requireList(db, targetListId);
    const now = nowISO();
    const card: Card = {
      id: createId('c'),
      boardId,
      listId: targetListId,
      parentCardId: null,
      title: item.content.split('\n')[0].slice(0, 80) || '未命名任务',
      description: item.content.includes('\n') ? item.content : '',
      dueDate: null,
      startDate: null,
      estimatedMinutes: null,
      actualMinutes: null,
      priority: null,
      accent: null,
      completed: false,
      deletedAt: null,
      labels: [],
      position: db.cards.filter((c) => c.listId === targetListId).length,
      createdAt: now,
      updatedAt: now,
    };
    db.cards.push(card);
    db.inbox = db.inbox.filter((i) => i.id !== id);
    touchBoard(db, boardId);
    saveLocalDb(db);
    return card;
  },

  async exportBackup() {
    const db = loadLocalDb();
    const backup = createBackup(db);
    const json = serializeBackup(backup);
    const filename = backupFilename();
    if (typeof document !== 'undefined' && typeof URL !== 'undefined') {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return { path: filename, summary: summarizeBackup(backup) };
  },

  async importBackup(json) {
    const backup = parseBackup(json);
    saveLocalDb({
      boards: backup.boards,
      lists: backup.lists,
      cards: backup.cards,
      inbox: backup.inbox,
      dependencies: backup.dependencies,
      boardSets: backup.boardSets,
      goals: backup.goals,
      teamMembers: backup.teamMembers,
      overtimeRecords: backup.overtimeRecords,
      performanceRecords: backup.performanceRecords,
      leaveRecords: backup.leaveRecords,
      memberTenures: backup.memberTenures,
      projects: backup.projects,
      projectMetaFields: backup.projectMetaFields,
      projectRoles: backup.projectRoles,
      recurrences: backup.recurrences,
      automationRules: backup.automationRules,
      cardActivity: backup.cardActivity,
      customFields: backup.customFields,
      cardFieldValues: backup.cardFieldValues,
      savedViews: backup.savedViews,
      notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
    });
    return summarizeBackup(backup);
  },

  async getStorageInfo() {
    return {
      dataDir: 'localStorage',
      dbPath: 'localStorage · tideline.db.v1（浏览器开发模式）',
      defaultDir: '',
      isCustom: false,
      editable: false,
    };
  },

  async pickDataDirectory() {
    return null;
  },

  async changeDataDirectory() {
    throw new Error('浏览器开发模式不支持自定义数据目录，请在桌面端设置');
  },

  async resetDataDirectory() {
    throw new Error('浏览器开发模式不支持自定义数据目录，请在桌面端设置');
  },

  async createBoardSet(input) {
    const db = loadLocalDb();
    const now = nowISO();
    const set: BoardSet = {
      id: createId('s'),
      title: input.title.trim() || '未命名看板集',
      description: input.description?.trim() ?? '',
      boardIds: normalizeBoardSetBoardIds(db, input.boardIds ?? []),
      createdAt: now,
      updatedAt: now,
    };
    db.boardSets.push(set);
    saveLocalDb(db);
    return set;
  },

  async updateBoardSet({ id, patch }) {
    const db = loadLocalDb();
    const set = requireBoardSet(db, id);
    if (patch.title !== undefined) set.title = patch.title.trim() || '未命名看板集';
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.boardIds !== undefined) {
      set.boardIds = normalizeBoardSetBoardIds(db, patch.boardIds);
    }
    set.updatedAt = nowISO();
    saveLocalDb(db);
    return set;
  },

  async deleteBoardSet({ id }) {
    const db = loadLocalDb();
    db.boardSets = db.boardSets.filter((set) => set.id !== id);
    saveLocalDb(db);
  },

  async createGoal(input) {
    const db = loadLocalDb();
    const now = nowISO();
    const parentId = validateGoalParent(db, null, input.parentId ?? null);
    const goal: Goal = {
      id: createId('g'),
      title: input.title.trim() || '未命名目标',
      description: input.description?.trim() ?? '',
      scope: normalizeGoalScope(input.scope),
      status: normalizeGoalStatus(input.status),
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      manualProgress: clampProgress(input.manualProgress),
      parentId,
      cardIds: normalizeGoalCardIds(db, input.cardIds ?? []),
      position: db.goals.reduce((max, item) => Math.max(max, item.position), -1) + 1,
      createdAt: now,
      updatedAt: now,
    };
    db.goals.push(goal);
    saveLocalDb(db);
    return goal;
  },

  async updateGoal({ id, patch }) {
    const db = loadLocalDb();
    const goal = requireGoal(db, id);
    if (patch.title !== undefined) goal.title = patch.title.trim() || '未命名目标';
    if (patch.description !== undefined) goal.description = patch.description;
    if (patch.scope !== undefined) goal.scope = normalizeGoalScope(patch.scope);
    if (patch.status !== undefined) goal.status = normalizeGoalStatus(patch.status);
    if (patch.startDate !== undefined) goal.startDate = patch.startDate;
    if (patch.dueDate !== undefined) goal.dueDate = patch.dueDate;
    if (patch.manualProgress !== undefined) goal.manualProgress = clampProgress(patch.manualProgress);
    if (patch.parentId !== undefined) {
      goal.parentId = validateGoalParent(db, goal.id, patch.parentId);
    }
    if (patch.cardIds !== undefined) {
      goal.cardIds = normalizeGoalCardIds(db, patch.cardIds);
    }
    goal.updatedAt = nowISO();
    saveLocalDb(db);
    return goal;
  },

  async deleteGoal({ id }) {
    const db = loadLocalDb();
    const now = nowISO();
    db.goals = db.goals.filter((goal) => goal.id !== id);
    db.goals = db.goals.map((goal) =>
      goal.parentId === id ? { ...goal, parentId: null, updatedAt: now } : goal,
    );
    saveLocalDb(db);
  },

  async openExternal(url) {
    if (!url.startsWith('https://github.com/Lemostic/tideline')) {
      throw new Error('只允许打开发布页链接');
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  async createTeamMember(input) {
    const db = loadLocalDb();
    requireProject(db, input.projectId);
    requireProjectRole(db, input.projectId, input.roleId);
    const now = nowISO();
    const member: TeamMember = {
      id: createId('m'),
      projectId: input.projectId,
      roleId: input.roleId,
      name: input.name.trim() || '未命名成员',
      role: 'other',
      status: 'active',
      joinedAt: input.joinedAt?.trim() || todayLocalDate(),
      releasedAt: null,
      note: input.note ?? '',
      createdAt: now,
      updatedAt: now,
    };
    db.teamMembers.push(member);
    db.memberTenures.push({
      id: createId('mt'),
      memberId: member.id,
      projectId: member.projectId,
      startedAt: member.joinedAt,
      endedAt: null,
      note: '首次入组',
      createdAt: now,
      updatedAt: now,
    });
    saveLocalDb(db);
    return member;
  },

  async updateTeamMember({ id, patch }) {
    const db = loadLocalDb();
    const member = requireTeamMember(db, id);
    const oldStatus = member.status;
    if (patch.name !== undefined) member.name = patch.name.trim() || '未命名成员';
    if (patch.roleId !== undefined) {
      requireProjectRole(db, member.projectId, patch.roleId);
      member.roleId = patch.roleId;
    }
    if (patch.status !== undefined) member.status = normalizeMemberStatus(patch.status);
    if (patch.joinedAt !== undefined && patch.joinedAt.trim()) member.joinedAt = patch.joinedAt;
    if (patch.releasedAt !== undefined) member.releasedAt = patch.releasedAt || null;
    if (patch.note !== undefined) member.note = patch.note;
    if (patch.status !== undefined && patch.status !== oldStatus) {
      if (member.status === 'released') {
        const end = member.releasedAt || todayLocalDate();
        db.memberTenures = db.memberTenures.map((tenure) =>
          tenure.memberId === id && tenure.endedAt === null
            ? { ...tenure, endedAt: end, updatedAt: nowISO() }
            : tenure,
        );
      } else if (member.status === 'active') {
        const hasOpen = db.memberTenures.some(
          (tenure) => tenure.memberId === id && tenure.endedAt === null,
        );
        if (!hasOpen) {
          const now = nowISO();
          db.memberTenures.push({
            id: createId('mt'),
            memberId: id,
            projectId: member.projectId,
            startedAt: todayLocalDate(),
            endedAt: null,
            note: '回归项目',
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      syncLocalMemberTenures(db, id);
    }
    member.updatedAt = nowISO();
    saveLocalDb(db);
    return member;
  },

  async deleteTeamMember({ id }) {
    const db = loadLocalDb();
    db.teamMembers = db.teamMembers.filter((member) => member.id !== id);
    db.memberTenures = db.memberTenures.filter((tenure) => tenure.memberId !== id);
    db.overtimeRecords = db.overtimeRecords.filter((record) => record.memberId !== id);
    db.performanceRecords = db.performanceRecords.filter((record) => record.memberId !== id);
    db.leaveRecords = db.leaveRecords.filter((record) => record.memberId !== id);
    saveLocalDb(db);
  },

  async createTenure(input) {
    const db = loadLocalDb();
    const member = requireTeamMember(db, input.memberId);
    const startedAt = input.startedAt.trim() || todayLocalDate();
    const endedAt = input.endedAt?.trim() || null;
    validateLocalTenure(db, input.memberId, startedAt, endedAt);
    const now = nowISO();
    const tenure: MemberTenure = {
      id: createId('mt'),
      memberId: input.memberId,
      projectId: member.projectId,
      startedAt,
      endedAt,
      note: input.note ?? '',
      createdAt: now,
      updatedAt: now,
    };
    db.memberTenures.push(tenure);
    syncLocalMemberTenures(db, input.memberId);
    saveLocalDb(db);
    return tenure;
  },

  async updateTenure({ id, patch }) {
    const db = loadLocalDb();
    const tenure = db.memberTenures.find((item) => item.id === id);
    if (!tenure) throw new Error(`投入时间段不存在：${id}`);
    if (patch.startedAt !== undefined) tenure.startedAt = patch.startedAt.trim() || tenure.startedAt;
    if (patch.endedAt !== undefined) tenure.endedAt = patch.endedAt || null;
    if (patch.note !== undefined) tenure.note = patch.note;
    validateLocalTenure(db, tenure.memberId, tenure.startedAt, tenure.endedAt, id);
    tenure.updatedAt = nowISO();
    syncLocalMemberTenures(db, tenure.memberId);
    saveLocalDb(db);
    return tenure;
  },

  async deleteTenure({ id }) {
    const db = loadLocalDb();
    const tenure = db.memberTenures.find((item) => item.id === id);
    if (!tenure) throw new Error(`投入时间段不存在：${id}`);
    db.memberTenures = db.memberTenures.filter((item) => item.id !== id);
    syncLocalMemberTenures(db, tenure.memberId);
    saveLocalDb(db);
  },

  async createOvertime(input) {
    const db = loadLocalDb();
    const member = requireTeamMember(db, input.memberId);
    if (!Number.isFinite(input.hours) || input.hours <= 0) {
      throw new Error('加班时长必须大于 0');
    }
    const status = normalizeOvertimeStatus(input.status);
    const absenceError = validateOvertimeAbsenceReason(status, input.absenceReason ?? '');
    if (absenceError) throw new Error(absenceError);
    const now = nowISO();
    const record: OvertimeRecord = {
      id: createId('ot'),
      projectId: member.projectId,
      memberId: input.memberId,
      date: input.date || todayLocalDate(),
      hours: Math.round(input.hours * 10) / 10,
      status,
      absenceReason: normalizeOvertimeAbsenceReason(status, input.absenceReason ?? ''),
      note: input.note ?? '',
      createdAt: now,
      updatedAt: now,
    };
    db.overtimeRecords.push(record);
    saveLocalDb(db);
    return record;
  },

  async updateOvertime({ id, patch }) {
    const db = loadLocalDb();
    const record = db.overtimeRecords.find((item) => item.id === id);
    if (!record) throw new Error(`加班记录不存在：${id}`);
    const nextStatus = patch.status !== undefined ? normalizeOvertimeStatus(patch.status) : record.status;
    const nextReason =
      patch.absenceReason !== undefined ? patch.absenceReason : record.absenceReason;
    const absenceError = validateOvertimeAbsenceReason(nextStatus, nextReason);
    if (absenceError) throw new Error(absenceError);
    if (patch.memberId !== undefined) {
      const member = requireTeamMember(db, patch.memberId);
      record.projectId = member.projectId;
      record.memberId = patch.memberId;
    }
    if (patch.date !== undefined && patch.date.trim()) record.date = patch.date;
    if (patch.hours !== undefined) {
      if (!Number.isFinite(patch.hours) || patch.hours <= 0) {
        throw new Error('加班时长必须大于 0');
      }
      record.hours = Math.round(patch.hours * 10) / 10;
    }
    record.status = nextStatus;
    record.absenceReason = normalizeOvertimeAbsenceReason(nextStatus, nextReason);
    if (patch.note !== undefined) record.note = patch.note;
    record.updatedAt = nowISO();
    saveLocalDb(db);
    return record;
  },

  async deleteOvertime({ id }) {
    const db = loadLocalDb();
    db.overtimeRecords = db.overtimeRecords.filter((record) => record.id !== id);
    saveLocalDb(db);
  },

  async createPerformance(input) {
    const db = loadLocalDb();
    const member = requireTeamMember(db, input.memberId);
    if (!Number.isFinite(input.points) || input.points === 0) {
      throw new Error('绩效分值不能为 0');
    }
    const record: PerformanceRecord = {
      id: createId('pf'),
      projectId: member.projectId,
      memberId: input.memberId,
      date: input.date || todayLocalDate(),
      points: Math.max(-100, Math.min(100, Math.round(input.points))),
      reason: input.reason.trim() || '绩效记录',
      category: normalizePerformanceCategory(input.category),
      note: input.note ?? '',
      createdAt: nowISO(),
    };
    db.performanceRecords.push(record);
    saveLocalDb(db);
    return record;
  },

  async updatePerformance({ id, patch }) {
    const db = loadLocalDb();
    const record = db.performanceRecords.find((item) => item.id === id);
    if (!record) throw new Error(`绩效记录不存在：${id}`);
    if (patch.memberId !== undefined) {
      const member = requireTeamMember(db, patch.memberId);
      record.projectId = member.projectId;
      record.memberId = patch.memberId;
    }
    if (patch.date !== undefined && patch.date.trim()) record.date = patch.date;
    if (patch.points !== undefined) {
      if (!Number.isFinite(patch.points) || patch.points === 0) {
        throw new Error('绩效分值不能为 0');
      }
      record.points = Math.max(-100, Math.min(100, Math.round(patch.points)));
    }
    if (patch.reason !== undefined) record.reason = patch.reason.trim() || '绩效记录';
    if (patch.category !== undefined) record.category = normalizePerformanceCategory(patch.category);
    if (patch.note !== undefined) record.note = patch.note;
    saveLocalDb(db);
    return record;
  },

  async deletePerformance({ id }) {
    const db = loadLocalDb();
    db.performanceRecords = db.performanceRecords.filter((record) => record.id !== id);
    saveLocalDb(db);
  },

  async createLeave(input) {
    const db = loadLocalDb();
    const member = requireTeamMember(db, input.memberId);
    const startDate = input.startDate.trim();
    const endDate = input.endDate.trim();
    const reason = input.reason?.trim() ?? '';
    // 先按原始值校验（保留「超过两位小数」的拒绝），再归一化后落库。
    const error = validateLeaveInput(startDate, endDate, input.days, reason);
    if (error) throw new Error(error);
    const days = roundLeaveDays(input.days);
    const now = nowISO();
    const record: LeaveRecord = {
      id: createId('lv'),
      projectId: member.projectId,
      memberId: input.memberId,
      startDate,
      endDate,
      days,
      leaveType: normalizeLeaveType(input.leaveType),
      reason,
      note: input.note ?? '',
      createdAt: now,
      updatedAt: now,
    };
    db.leaveRecords.push(record);
    saveLocalDb(db);
    return record;
  },

  async updateLeave({ id, patch }) {
    const db = loadLocalDb();
    const record = db.leaveRecords.find((item) => item.id === id);
    if (!record) throw new Error(`请假记录不存在：${id}`);
    if (patch.memberId !== undefined) {
      const member = requireTeamMember(db, patch.memberId);
      record.projectId = member.projectId;
      record.memberId = patch.memberId;
    }
    const startDate = patch.startDate !== undefined ? patch.startDate.trim() : record.startDate;
    const endDate = patch.endDate !== undefined ? patch.endDate.trim() : record.endDate;
    const rawDays = patch.days !== undefined ? patch.days : record.days;
    const reason = patch.reason !== undefined ? patch.reason.trim() : record.reason;
    const error = validateLeaveInput(startDate, endDate, rawDays, reason);
    if (error) throw new Error(error);
    record.startDate = startDate;
    record.endDate = endDate;
    record.days = roundLeaveDays(rawDays);
    if (patch.leaveType !== undefined) record.leaveType = normalizeLeaveType(patch.leaveType);
    record.reason = reason;
    if (patch.note !== undefined) record.note = patch.note;
    record.updatedAt = nowISO();
    saveLocalDb(db);
    return record;
  },

  async deleteLeave({ id }) {
    const db = loadLocalDb();
    db.leaveRecords = db.leaveRecords.filter((record) => record.id !== id);
    saveLocalDb(db);
  },

  async createProject(input) {
    const db = loadLocalDb();
    const now = nowISO();
    const project: Project = {
      id: createId('p'),
      name: input.name.trim() || '未命名项目',
      description: input.description ?? '',
      color: input.color?.trim() || '#0f766e',
      status: 'active',
      starred: input.starred ?? false,
      createdAt: now,
      updatedAt: now,
    };
    db.projects.push(project);
    DEFAULT_PROJECT_ROLES.forEach((role, position) => {
      db.projectRoles.push({
        id: createId('pr'),
        projectId: project.id,
        name: role.name,
        color: role.color,
        position,
        createdAt: now,
        updatedAt: now,
      });
    });
    saveLocalDb(db);
    return project;
  },

  async updateProject({ id, patch }) {
    const db = loadLocalDb();
    const project = requireProject(db, id);
    if (patch.name !== undefined) project.name = patch.name.trim() || '未命名项目';
    if (patch.description !== undefined) project.description = patch.description;
    if (patch.color !== undefined) project.color = patch.color.trim() || '#0f766e';
    if (patch.status !== undefined) project.status = patch.status;
    if (patch.starred !== undefined) project.starred = patch.starred;
    project.updatedAt = nowISO();
    saveLocalDb(db);
    return project;
  },

  async deleteProject({ id }) {
    const db = loadLocalDb();
    db.projects = db.projects.filter((project) => project.id !== id);
    db.projectRoles = db.projectRoles.filter((role) => role.projectId !== id);
    db.projectMetaFields = db.projectMetaFields.filter((field) => field.projectId !== id);
    db.teamMembers = db.teamMembers.filter((member) => member.projectId !== id);
    db.overtimeRecords = db.overtimeRecords.filter((record) => record.projectId !== id);
    db.performanceRecords = db.performanceRecords.filter((record) => record.projectId !== id);
    db.leaveRecords = db.leaveRecords.filter((record) => record.projectId !== id);
    saveLocalDb(db);
  },

  async createProjectMeta(input) {
    const db = loadLocalDb();
    requireProject(db, input.projectId);
    const now = nowISO();
    const field: ProjectMetaField = {
      id: createId('pm'),
      projectId: input.projectId,
      name: input.name.trim() || '未命名字段',
      value: input.value ?? '',
      position: db.projectMetaFields.filter((item) => item.projectId === input.projectId).length,
      createdAt: now,
      updatedAt: now,
    };
    db.projectMetaFields.push(field);
    saveLocalDb(db);
    return field;
  },

  async updateProjectMeta({ id, patch }) {
    const db = loadLocalDb();
    const field = db.projectMetaFields.find((item) => item.id === id);
    if (!field) throw new Error(`项目元数据不存在：${id}`);
    if (patch.name !== undefined) field.name = patch.name.trim() || '未命名字段';
    if (patch.value !== undefined) field.value = patch.value;
    field.updatedAt = nowISO();
    saveLocalDb(db);
    return field;
  },

  async deleteProjectMeta({ id }) {
    const db = loadLocalDb();
    db.projectMetaFields = db.projectMetaFields.filter((item) => item.id !== id);
    saveLocalDb(db);
  },

  async createProjectRole(input) {
    const db = loadLocalDb();
    requireProject(db, input.projectId);
    const now = nowISO();
    const role: ProjectRole = {
      id: createId('pr'),
      projectId: input.projectId,
      name: input.name.trim() || '未命名角色',
      color: input.color?.trim() || '#64748b',
      position: db.projectRoles.filter((item) => item.projectId === input.projectId).length,
      createdAt: now,
      updatedAt: now,
    };
    db.projectRoles.push(role);
    saveLocalDb(db);
    return role;
  },

  async updateProjectRole({ id, patch }) {
    const db = loadLocalDb();
    const role = db.projectRoles.find((item) => item.id === id);
    if (!role) throw new Error(`项目角色不存在：${id}`);
    if (patch.name !== undefined) role.name = patch.name.trim() || '未命名角色';
    if (patch.color !== undefined) role.color = patch.color.trim() || '#64748b';
    role.updatedAt = nowISO();
    saveLocalDb(db);
    return role;
  },

  async deleteProjectRole({ id }) {
    const db = loadLocalDb();
    const role = db.projectRoles.find((item) => item.id === id);
    if (!role) throw new Error(`项目角色不存在：${id}`);
    if (db.teamMembers.some((member) => member.roleId === id)) {
      throw new Error('该角色仍被项目成员使用，请先调整成员角色');
    }
    db.projectRoles = db.projectRoles.filter((item) => item.id !== id);
    saveLocalDb(db);
  },

  async getAutoStart() {
    return { supported: false, enabled: false };
  },

  async setAutoStart() {
    throw new Error('浏览器开发模式不支持开机自动启动，请使用桌面安装版');
  },

  async pickRequirementFile() {
    return pickLocalTextFile();
  },

  async getUsageOverview(input) {
    // 浏览器端没有采样器，只回一个空结构（默认区间为今天）
    const today = todayKey();
    return {
      rangeFrom: input.from || today,
      rangeTo: input.to || today,
      totalSeconds: 0,
      trackedApps: 0,
      apps: [],
      daily: [],
    };
  },

  async getUsageApps() {
    // 浏览器端无法采集前台应用，应用清单恒为空
    return [];
  },

  async setUsageAppIncluded(input) {
    const store = loadLocalUsageStore();
    const existing = store.apps.find((item) => item.appKey === input.appKey);
    const now = nowISO();
    const app: UsageApp = existing
      ? { ...existing, included: input.included }
      : {
          appKey: input.appKey,
          appName: input.appKey,
          exePath: '',
          included: input.included,
          totalSeconds: 0,
          firstSeen: now,
          lastSeen: now,
        };
    store.apps = [...store.apps.filter((item) => item.appKey !== input.appKey), app];
    saveLocalUsageStore(store);
    return app;
  },

  async getUsageSettings() {
    return loadLocalUsageStore().settings;
  },

  async setUsageSettings(input) {
    const store = loadLocalUsageStore();
    const settings: UsageSettings = {
      paused: input.paused ?? store.settings.paused,
      idleThresholdSeconds: input.idleThresholdSeconds ?? store.settings.idleThresholdSeconds,
      updatedAt: nowISO(),
    };
    store.settings = settings;
    saveLocalUsageStore(store);
    return settings;
  },

  async clearUsageRecords() {
    // 浏览器端没有采样记录，清空即清掉手动切换过的应用，设置保留
    const store = loadLocalUsageStore();
    store.apps = [];
    saveLocalUsageStore(store);
  },

  /* ---------- 自动化与提醒（V0.11） ---------- */

  async getCardActivity({ id }) {
    const db = loadLocalDb();
    return db.cardActivity
      .filter((item) => item.cardId === id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  },

  async getRecurrences() {
    const db = loadLocalDb();
    return [...db.recurrences].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  },

  async createRecurrence(input) {
    const db = loadLocalDb();
    const card = requireCard(db, input.cardId);
    if (card.deletedAt) throw new Error('回收站中的任务不能设置重复');
    const intervalValue =
      input.frequency === 'interval' ? Math.max(1, Math.floor(input.intervalValue ?? 1)) : 1;
    const weekdays =
      input.frequency === 'weekly'
        ? (input.weekdays ?? []).filter((day) => day >= 0 && day <= 6)
        : [];
    if (input.frequency === 'weekly' && weekdays.length === 0) {
      throw new Error('每周重复至少要选择一个星期');
    }
    const base = input.nextDueDate ?? card.dueDate ?? todayKey();
    const now = nowISO();
    const recurrence: Recurrence = {
      id: createId('r'),
      cardId: input.cardId,
      frequency: input.frequency,
      intervalValue,
      weekdays,
      nextDueDate: nextRecurrenceDateFor(
        { frequency: input.frequency, intervalValue, weekdays },
        base,
      ),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    db.recurrences = db.recurrences.filter((item) => item.cardId !== input.cardId);
    db.recurrences.push(recurrence);
    card.recurrenceId = recurrence.id;
    saveLocalDb(db);
    return recurrence;
  },

  async updateRecurrence({ id, patch }) {
    const db = loadLocalDb();
    const recurrence = db.recurrences.find((item) => item.id === id);
    if (!recurrence) throw new Error(`重复配置不存在：${id}`);
    if (patch.frequency !== undefined) {
      recurrence.frequency = patch.frequency;
      if (patch.frequency !== 'interval') recurrence.intervalValue = 1;
      if (patch.frequency !== 'weekly') recurrence.weekdays = [];
    }
    if (patch.intervalValue !== undefined) {
      recurrence.intervalValue =
        recurrence.frequency === 'interval' ? Math.max(1, Math.floor(patch.intervalValue)) : 1;
    }
    if (patch.weekdays !== undefined) {
      recurrence.weekdays = patch.weekdays.filter((day) => day >= 0 && day <= 6);
    }
    if (recurrence.frequency === 'weekly' && recurrence.weekdays.length === 0) {
      throw new Error('每周重复至少要选择一个星期');
    }
    if (patch.nextDueDate !== undefined) recurrence.nextDueDate = patch.nextDueDate;
    if (patch.enabled !== undefined) recurrence.enabled = patch.enabled;
    recurrence.updatedAt = nowISO();
    saveLocalDb(db);
    return recurrence;
  },

  async deleteRecurrence({ id }) {
    const db = loadLocalDb();
    db.recurrences = db.recurrences.filter((item) => item.id !== id);
    for (const card of db.cards) {
      if (card.recurrenceId === id) card.recurrenceId = null;
    }
    saveLocalDb(db);
  },

  async getAutomationRules() {
    const db = loadLocalDb();
    return [...db.automationRules].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  },

  async createAutomationRule(input) {
    const db = loadLocalDb();
    const error = validateRuleActions(input.actions);
    if (error) throw new Error(error);
    if (input.trigger === 'move_to_list' && !input.listId) {
      throw new Error('移动触发需要选择一个目标列表');
    }
    const now = nowISO();
    const rule: AutomationRule = {
      id: createId('au'),
      name: input.name.trim() || '未命名规则',
      trigger: input.trigger,
      listId: input.trigger === 'move_to_list' ? (input.listId ?? null) : null,
      actions: input.actions.map((action) => ({ ...action })),
      // 自动化默认关闭，需要用户逐条启用
      enabled: input.enabled ?? false,
      lastError: '',
      createdAt: now,
      updatedAt: now,
    };
    db.automationRules.push(rule);
    saveLocalDb(db);
    return rule;
  },

  async updateAutomationRule({ id, patch }) {
    const db = loadLocalDb();
    const rule = db.automationRules.find((item) => item.id === id);
    if (!rule) throw new Error(`规则不存在：${id}`);
    if (patch.name !== undefined) rule.name = patch.name.trim() || '未命名规则';
    if (patch.trigger !== undefined) rule.trigger = patch.trigger;
    if (patch.listId !== undefined) rule.listId = patch.listId;
    if (patch.actions !== undefined) {
      const error = validateRuleActions(patch.actions);
      if (error) throw new Error(error);
      rule.actions = patch.actions.map((action) => ({ ...action }));
    }
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    if (rule.trigger === 'move_to_list' && !rule.listId) {
      throw new Error('移动触发需要选择一个目标列表');
    }
    rule.updatedAt = nowISO();
    saveLocalDb(db);
    return rule;
  },

  async deleteAutomationRule({ id }) {
    const db = loadLocalDb();
    db.automationRules = db.automationRules.filter((item) => item.id !== id);
    saveLocalDb(db);
  },

  async getNotificationSettings() {
    const db = loadLocalDb();
    const stored = (db as LocalDb & { notificationSettings?: NotificationSettings })
      .notificationSettings;
    return { ...DEFAULT_NOTIFICATION_SETTINGS, ...(stored ?? {}) };
  },

  async setNotificationSettings(input) {
    const db = loadLocalDb();
    const current = await localApi.getNotificationSettings();
    const next: NotificationSettings = {
      dueEnabled: input.dueEnabled ?? current.dueEnabled,
      overdueEnabled: input.overdueEnabled ?? current.overdueEnabled,
      dailySummaryEnabled: input.dailySummaryEnabled ?? current.dailySummaryEnabled,
      dailySummaryTime: input.dailySummaryTime ?? current.dailySummaryTime,
      leadDays: input.leadDays ?? current.leadDays,
      updatedAt: nowISO(),
    };
    if (!/^\d{2}:\d{2}$/.test(next.dailySummaryTime)) {
      throw new Error('每日摘要时间格式应为 HH:MM');
    }
    if (!Number.isInteger(next.leadDays) || next.leadDays < 0 || next.leadDays > 30) {
      throw new Error('提前天数应为 0 到 30 之间的整数');
    }
    (db as LocalDb & { notificationSettings?: NotificationSettings }).notificationSettings = next;
    saveLocalDb(db);
    return next;
  },
};

/**
 * 浏览器开发态的需求文档读取：用隐藏的 file input 选文件并读出文本。
 * 用户取消时返回 null；读取失败同样返回 null，由界面提示。
 */
function pickLocalTextFile(): Promise<PickedTextFile | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.txt,text/plain,text/markdown';
    input.style.display = 'none';
    let settled = false;

    const finish = (value: PickedTextFile | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      file
        .text()
        .then((content) => finish({ name: file.name, content }))
        .catch(() => finish(null));
    });
    input.addEventListener('cancel', () => finish(null));

    document.body.appendChild(input);
    input.click();
  });
}

export const api: TidelineApi = isTauri() ? tauriApi : localApi;

/** 浏览器端开发辅助：清空 localStorage 数据（仅调试用） */
export function resetLocalData(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('tideline.seeded');
    localStorage.removeItem(USAGE_STORAGE_KEY);
  }
}
