/**
 * 备份文件（V0.4）的构造、解析与校验。
 *
 * 浏览器端 localStorage 与桌面端 Rust 共用同一份 JSON 契约：
 * `{ app, formatVersion: 1, exportedAt, boards, lists, cards, inbox }`
 * cards 包含回收站任务（deletedAt 非空），恢复时整体替换。
 */
import { normalizeSavedViewFilters, normalizeSavedViewSort } from './savedViews';
import { MAX_TASK_DEPTH } from './taskTree';
import {
  normalizeOvertimeAbsenceReason,
  validateOvertimeAbsenceReason,
} from './team';
import type {
  AutomationRule,
  BackupFile,
  BackupSummary,
  Board,
  BoardSet,
  BoardView,
  Card,
  CardActivity,
  CardDependency,
  CardFieldValue,
  CustomField,
  CustomFieldOption,
  CustomFieldType,
  Goal,
  InboxItem,
  List,
  OvertimeRecord,
  OvertimeStatus,
  LegacySubtask,
  PerformanceRecord,
  Project,
  ProjectMetaField,
  ProjectRole,
  Recurrence,
  RelationType,
  SavedView,
  SavedViewFilters,
  SavedViewSort,
  TeamMember,
  MemberTenure,
} from './types';

export const BACKUP_APP = 'tideline';
export const BACKUP_FORMAT_VERSION = 1;
/** 与 Rust 命令保持相同的上限，避免误选超大文件 */
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

export interface BackupData {
  boards: Board[];
  lists: List[];
  cards: Card[];
  inbox: InboxItem[];
  dependencies: CardDependency[];
  boardSets: BoardSet[];
  goals: Goal[];
  teamMembers: TeamMember[];
  overtimeRecords: OvertimeRecord[];
  performanceRecords: PerformanceRecord[];
  memberTenures: MemberTenure[];
  projects: Project[];
  projectMetaFields: ProjectMetaField[];
  projectRoles: ProjectRole[];
  /** V0.11 新增 */
  recurrences: Recurrence[];
  automationRules: AutomationRule[];
  cardActivity: CardActivity[];
  /** V0.13.0 新增 */
  customFields: CustomField[];
  cardFieldValues: CardFieldValue[];
  savedViews: SavedView[];
}

export function summarizeBackup(
  backup: Pick<
    BackupFile,
    'boards' | 'lists' | 'cards' | 'inbox' | 'dependencies' | 'boardSets' | 'goals' |
      'teamMembers' | 'overtimeRecords' | 'performanceRecords' | 'memberTenures' | 'projects' |
      'projectMetaFields' | 'projectRoles' | 'recurrences' | 'automationRules' | 'cardActivity' |
      'customFields' | 'cardFieldValues' | 'savedViews'
  >,
): BackupSummary {
  return {
    boards: backup.boards.length,
    lists: backup.lists.length,
    cards: backup.cards.length,
    trashed: backup.cards.filter((card) => card.deletedAt !== null).length,
    inbox: backup.inbox.length,
    dependencies: backup.dependencies.length,
    boardSets: backup.boardSets.length,
    goals: backup.goals.length,
    teamMembers: backup.teamMembers.length,
    overtimeRecords: backup.overtimeRecords.length,
    performanceRecords: backup.performanceRecords.length,
    memberTenures: backup.memberTenures.length,
    projects: backup.projects.length,
    projectMetaFields: backup.projectMetaFields.length,
    projectRoles: backup.projectRoles.length,
    recurrences: backup.recurrences.length,
    automationRules: backup.automationRules.length,
    cardActivity: backup.cardActivity.length,
    customFields: backup.customFields.length,
    cardFieldValues: backup.cardFieldValues.length,
    savedViews: backup.savedViews.length,
  };
}

/** 旧版备份卡片的形状：额外带 `subtasks` JSON，V0.14.0 起解析时展开为真实卡片。 */
export type LegacyCard = Card & { subtasks?: LegacySubtask[] };

/**
 * V0.14.0：把旧 `cards[].subtasks` 清单展开为真实子卡片。
 *
 * 与桌面端迁移等价：保留标题、完成状态与顺序；子卡片继承父任务的看板/列表/
 * 删除状态；id 冲突时追加序号后缀；父任务 `subtasks` 清空。
 */
export function expandLegacySubtaskCards(cards: LegacyCard[]): Card[] {
  const existing = new Set(cards.map((card) => card.id));
  const result: Card[] = [];
  for (const card of cards) {
    const { subtasks } = card;
    const legacy = Array.isArray(subtasks) ? subtasks : [];
    const base: Card = {
      ...card,
      parentCardId: typeof card.parentCardId === 'string' ? card.parentCardId : null,
    };
    delete (base as LegacyCard).subtasks;
    const parent = base;
    result.push(parent);
    legacy.forEach((subtask, index) => {
      let id = `sub_${card.id}_${index}`;
      let suffix = 1;
      while (existing.has(id)) {
        id = `sub_${card.id}_${index}_${suffix}`;
        suffix += 1;
      }
      existing.add(id);
      result.push({
        ...parent,
        id,
        parentCardId: card.id,
        title: String(subtask?.title ?? ''),
        completed: Boolean(subtask?.done),
        description: '',
        dueDate: null,
        startDate: null,
        estimatedMinutes: null,
        actualMinutes: null,
        priority: null,
        accent: null,
        deletedAt: parent.deletedAt,
        labels: [],
        position: index,
        recurrenceId: null,
        generatedFromId: null,
        createdAt: parent.updatedAt,
        updatedAt: parent.updatedAt,
      });
    });
  }
  return result;
}

/** 用当前全量数据（含回收站、依赖、看板集与目标）生成备份对象。 */
export function createBackup(data: BackupData): BackupFile {  return {
    app: BACKUP_APP,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    boards: data.boards,
    lists: data.lists,
    cards: data.cards,
    inbox: data.inbox,
    dependencies: data.dependencies,
    boardSets: data.boardSets,
    goals: data.goals,
    teamMembers: data.teamMembers,
    overtimeRecords: data.overtimeRecords,
    performanceRecords: data.performanceRecords,
    memberTenures: data.memberTenures,
    projects: data.projects,
    projectMetaFields: data.projectMetaFields,
    projectRoles: data.projectRoles,
    recurrences: data.recurrences,
    automationRules: data.automationRules,
    cardActivity: data.cardActivity,
    customFields: data.customFields,
    cardFieldValues: data.cardFieldValues,
    savedViews: data.savedViews,
  };
}

export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

export function backupFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `tideline-backup-${stamp}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`备份文件缺少有效字段：${field}`);
  }
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`备份文件字段 ${field} 必须是数组`);
  return value;
}

/** 依赖图是否含环（DFS 三色标记）。 */
function dependencyGraphHasCycle(edges: Map<string, string[]>): boolean {
  const states = new Map<string, 1 | 2>();
  const visit = (node: string): boolean => {
    const state = states.get(node);
    if (state === 1) return true;
    if (state === 2) return false;
    states.set(node, 1);
    for (const next of edges.get(node) ?? []) {
      if (visit(next)) return true;
    }
    states.set(node, 2);
    return false;
  };
  for (const node of edges.keys()) {
    if (visit(node)) return true;
  }
  return false;
}

/**
 * 解析并校验备份 JSON。校验规则与 Rust `backup::validate` 对齐：
 * 字段形态、id 唯一性、看板/列表/任务引用关系。
 */
export function parseBackup(text: string): BackupFile {
  if (text.length > MAX_BACKUP_BYTES) {
    throw new Error('备份文件超过 100MB，已拒绝导入');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('备份文件不是有效的 JSON');
  }
  if (!isRecord(raw)) throw new Error('备份文件不是 JSON 对象');
  if (raw.app !== BACKUP_APP) {
    throw new Error('这不是潮线 tideline 的备份文件（app 字段不匹配）');
  }
  if (raw.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `备份格式版本 ${String(raw.formatVersion)} 不受支持，当前仅支持版本 ${BACKUP_FORMAT_VERSION}`,
    );
  }

  const boards = (requireArray(raw.boards, 'boards') as Board[]).map((board) => ({
    ...board,
    labelColors: board.labelColors ?? {},
  }));
  const lists = (requireArray(raw.lists, 'lists') as List[]).map((list) => ({
    ...list,
    color: list.color ?? 'slate',
    wipLimit: typeof list.wipLimit === 'number' ? list.wipLimit : null,
  }));
  const parsedCards = (requireArray(raw.cards, 'cards') as Card[]).map((card) => ({
    ...card,
    parentCardId:
      typeof card.parentCardId === 'string' ? card.parentCardId : null,
    accent: card.accent ?? null,
    estimatedMinutes: card.estimatedMinutes ?? null,
    actualMinutes: card.actualMinutes ?? null,
  }));
  // V0.14.0：旧备份的 subtasks JSON 展开为真实子卡片。
  const cards = expandLegacySubtaskCards(parsedCards);
  const inbox = requireArray(raw.inbox, 'inbox') as InboxItem[];

  const boardIds = new Set<string>();
  for (const board of boards) {
    if (!isRecord(board)) throw new Error('备份中的看板数据格式不正确');
    const id = requireString(board.id, 'boards[].id');
    if (boardIds.has(id)) throw new Error(`备份中存在重复的看板 id：${id}`);
    boardIds.add(id);
    requireString(board.title ?? '', 'boards[].title');
    if (!isRecord(board.labelColors) || Object.values(board.labelColors).some(
      (color) => !['blue', 'amber', 'coral', 'green', 'violet', 'rose', 'teal', 'slate'].includes(String(color)),
    )) {
      throw new Error('备份中的标签颜色格式不正确');
    }
  }

  const listBoard = new Map<string, string>();
  for (const list of lists) {
    if (!isRecord(list)) throw new Error('备份中的列表数据格式不正确');
    const id = requireString(list.id, 'lists[].id');
    const boardId = requireString(list.boardId, 'lists[].boardId');
    if (listBoard.has(id)) throw new Error(`备份中存在重复的列表 id：${id}`);
    if (!boardIds.has(boardId)) throw new Error(`列表「${String(list.title)}」引用了不存在的看板`);
    listBoard.set(id, boardId);
  }

  const cardIds = new Set<string>();
  for (const card of cards) {
    if (!isRecord(card)) throw new Error('备份中的任务数据格式不正确');
    const id = requireString(card.id, 'cards[].id');
    const boardId = requireString(card.boardId, 'cards[].boardId');
    const listId = requireString(card.listId, 'cards[].listId');
    if (cardIds.has(id)) throw new Error(`备份中存在重复的任务 id：${id}`);
    if (!boardIds.has(boardId)) throw new Error(`任务「${String(card.title)}」引用了不存在的看板`);
    const owner = listBoard.get(listId);
    if (!owner) throw new Error(`任务「${String(card.title)}」引用了不存在的列表`);
    if (owner !== boardId) throw new Error(`任务「${String(card.title)}」的列表与看板不一致`);
    cardIds.add(id);
    requireString(card.title ?? '', 'cards[].title');
    for (const field of ['estimatedMinutes', 'actualMinutes'] as const) {
      const minutes = card[field];
      if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 0)) {
        throw new Error(`备份中的 ${field} 必须是非负整数或 null`);
      }
    }
  }

  // V0.14.0：任务树父链校验（存在、同看板、无自指/环、深度上限）。
  const cardById = new Map(cards.map((card) => [card.id, card]));
  for (const card of cards) {
    if (!card.parentCardId) continue;
    const parent = cardById.get(card.parentCardId);
    if (!parent) {
      throw new Error(`任务「${card.title}」的父任务不存在：${card.parentCardId}`);
    }
    if (parent.id === card.id) {
      throw new Error('备份中存在任务把自己当作父任务的脏数据');
    }
    if (parent.boardId !== card.boardId) {
      throw new Error(`子任务「${card.title}」与父任务不在同一看板`);
    }
    if (parent.listId !== card.listId) {
      throw new Error(`子任务「${card.title}」必须跟随父任务的列表`);
    }
    let depth = 0;
    let current: Card | undefined = card;
    const seen = new Set<string>();
    while (current?.parentCardId) {
      if (seen.has(current.id)) {
        throw new Error(`任务「${card.title}」的父任务存在循环`);
      }
      seen.add(current.id);
      depth += 1;
      if (depth > MAX_TASK_DEPTH) {
        throw new Error(`任务「${card.title}」的层级过深`);
      }
      current = cardById.get(current.parentCardId);
    }
  }

  // 依赖字段是 V0.4 新增的，旧备份（V0.4.0）没有该字段时按空数组处理。
  const rawDependencies = raw.dependencies === undefined ? [] : requireArray(raw.dependencies, 'dependencies');
  const dependencies: CardDependency[] = [];
  const dependencyEdges = new Map<string, string[]>();
  for (const item of rawDependencies) {
    if (!isRecord(item)) throw new Error('备份中的任务依赖格式不正确');
    const cardId = requireString(item.cardId, 'dependencies[].cardId');
    const dependsOnCardId = requireString(
      item.dependsOnCardId,
      'dependencies[].dependsOnCardId',
    );
    if (cardId === dependsOnCardId) throw new Error('备份中存在任务依赖自己的数据');
    if (!cardIds.has(cardId)) throw new Error(`依赖引用了不存在的任务：${cardId}`);
    if (!cardIds.has(dependsOnCardId)) {
      throw new Error(`依赖引用了不存在的前置任务：${dependsOnCardId}`);
    }
    // V0.12：关系带类型，旧备份缺少该字段时按「前置」处理；
    // 只有前置关系参与循环检测，跨看板关系不再拒绝。
    const rawType = item.relationType;
    const relationType: RelationType =
      rawType === undefined || rawType === null ? 'blocks' : (rawType as RelationType);
    if (relationType !== 'blocks' && relationType !== 'relates' && relationType !== 'duplicates') {
      throw new Error(`备份中存在未知的关系类型：${String(rawType)}`);
    }
    dependencies.push({ cardId, dependsOnCardId, relationType });
    if (relationType === 'blocks') {
      const bucket = dependencyEdges.get(cardId) ?? [];
      bucket.push(dependsOnCardId);
      dependencyEdges.set(cardId, bucket);
    }
  }
  if (dependencyGraphHasCycle(dependencyEdges)) {
    throw new Error('备份中的任务依赖存在循环');
  }

  const inboxIds = new Set<string>();
  for (const item of inbox) {
    if (!isRecord(item)) throw new Error('备份中的收件箱数据格式不正确');
    const id = requireString(item.id, 'inbox[].id');
    if (inboxIds.has(id)) throw new Error(`备份中存在重复的收件箱条目 id：${id}`);
    inboxIds.add(id);
  }

  // 看板集是 V0.5.4 新增的；旧备份没有该字段时按空数组处理。
  const rawBoardSets =
    raw.boardSets === undefined ? [] : requireArray(raw.boardSets, 'boardSets');
  const boardSets: BoardSet[] = [];
  const boardSetIds = new Set<string>();
  for (const item of rawBoardSets) {
    if (!isRecord(item)) throw new Error('备份中的看板集格式不正确');
    const id = requireString(item.id, 'boardSets[].id');
    if (boardSetIds.has(id)) throw new Error(`备份中存在重复的看板集 id：${id}`);
    boardSetIds.add(id);
    const title = requireString(item.title, 'boardSets[].title');
    const memberIds = requireArray(item.boardIds, 'boardSets[].boardIds');
    const seenMembers = new Set<string>();
    const normalizedMembers: string[] = [];
    for (const member of memberIds) {
      if (typeof member !== 'string' || member.trim() === '') {
        throw new Error(`看板集「${title}」的成员看板 id 不正确`);
      }
      if (seenMembers.has(member)) throw new Error(`看板集「${title}」中存在重复的看板`);
      if (!boardIds.has(member)) {
        throw new Error(`看板集「${title}」引用了不存在的看板`);
      }
      seenMembers.add(member);
      normalizedMembers.push(member);
    }
    boardSets.push({
      id,
      title,
      description: typeof item.description === 'string' ? item.description : '',
      boardIds: normalizedMembers,
      createdAt:
        typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt:
        typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }

  // 目标是 V0.6 新增的；旧备份没有该字段时按空数组处理。
  const rawGoals = raw.goals === undefined ? [] : requireArray(raw.goals, 'goals');
  const goals: Goal[] = [];
  const goalIds = new Set<string>();
  for (const item of rawGoals) {
    if (!isRecord(item)) throw new Error('备份中的目标格式不正确');
    const id = requireString(item.id, 'goals[].id');
    if (goalIds.has(id)) throw new Error(`备份中存在重复的目标 id：${id}`);
    goalIds.add(id);
    const title = requireString(item.title, 'goals[].title');
    const scope =
      item.scope === 'company' || item.scope === 'personal' || item.scope === 'team'
        ? item.scope
        : 'team';
    const status =
      item.status === 'active' || item.status === 'completed' || item.status === 'archived'
        ? item.status
        : 'active';
    const manualProgress =
      typeof item.manualProgress === 'number' && Number.isFinite(item.manualProgress)
        ? Math.min(100, Math.max(0, Math.round(item.manualProgress)))
        : 0;
    const rawCardIds = item.cardIds === undefined ? [] : requireArray(item.cardIds, 'goals[].cardIds');
    const linked = new Set<string>();
    const cardIds: string[] = [];
    for (const cardId of rawCardIds) {
      if (typeof cardId !== 'string' || cardId.trim() === '') {
        throw new Error(`目标「${title}」的关联任务 id 不正确`);
      }
      if (!cards.some((card) => card.id === cardId)) {
        throw new Error(`目标「${title}」关联了不存在的任务`);
      }
      if (linked.has(cardId)) throw new Error(`目标「${title}」中存在重复的关联任务`);
      linked.add(cardId);
      cardIds.push(cardId);
    }
    goals.push({
      id,
      title,
      description: typeof item.description === 'string' ? item.description : '',
      scope,
      status,
      startDate: typeof item.startDate === 'string' ? item.startDate : null,
      dueDate: typeof item.dueDate === 'string' ? item.dueDate : null,
      manualProgress,
      parentId: typeof item.parentId === 'string' ? item.parentId : null,
      cardIds,
      position: typeof item.position === 'number' ? item.position : goals.length,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }
  for (const goal of goals) {
    if (goal.parentId === null) continue;
    if (!goalIds.has(goal.parentId)) {
      throw new Error(`目标「${goal.title}」引用了不存在的父目标`);
    }
    let current: string | null = goal.parentId;
    let guard = 0;
    while (current) {
      if (current === goal.id) throw new Error('备份中的目标层级存在循环');
      guard += 1;
      if (guard > 100) throw new Error('备份中的目标层级过深');
      current = goals.find((item) => item.id === current)?.parentId ?? null;
    }
  }

  // 项目是 V0.9 新增的；旧备份按空数组处理，并在有旧团队数据时补默认项目。
  const rawProjects = raw.projects === undefined ? [] : requireArray(raw.projects, 'projects');
  const projects: Project[] = [];
  const projectIds = new Set<string>();
  for (const item of rawProjects) {
    if (!isRecord(item)) throw new Error('备份中的项目格式不正确');
    const id = requireString(item.id, 'projects[].id');
    if (projectIds.has(id)) throw new Error(`备份中存在重复的项目 id：${id}`);
    projectIds.add(id);
    projects.push({
      id,
      name: requireString(item.name, 'projects[].name'),
      description: typeof item.description === 'string' ? item.description : '',
      color: typeof item.color === 'string' ? item.color : '#0f766e',
      status: item.status === 'archived' ? 'archived' : 'active',
      starred: Boolean(item.starred),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }

  const rawProjectRoles =
    raw.projectRoles === undefined ? [] : requireArray(raw.projectRoles, 'projectRoles');
  const projectRoles: ProjectRole[] = [];
  const roleIds = new Set<string>();
  for (const item of rawProjectRoles) {
    if (!isRecord(item)) throw new Error('备份中的项目角色格式不正确');
    const id = requireString(item.id, 'projectRoles[].id');
    if (roleIds.has(id)) throw new Error(`备份中存在重复的项目角色 id：${id}`);
    roleIds.add(id);
    const projectId = requireString(item.projectId, 'projectRoles[].projectId');
    if (!projectIds.has(projectId)) throw new Error('项目角色引用了不存在的项目');
    projectRoles.push({
      id,
      projectId,
      name: requireString(item.name, 'projectRoles[].name'),
      color: typeof item.color === 'string' ? item.color : '#64748b',
      position: typeof item.position === 'number' ? item.position : projectRoles.length,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }

  const rawProjectMeta =
    raw.projectMetaFields === undefined
      ? []
      : requireArray(raw.projectMetaFields, 'projectMetaFields');
  const projectMetaFields: ProjectMetaField[] = [];
  const metaIds = new Set<string>();
  for (const item of rawProjectMeta) {
    if (!isRecord(item)) throw new Error('备份中的项目元数据格式不正确');
    const id = requireString(item.id, 'projectMetaFields[].id');
    if (metaIds.has(id)) throw new Error(`备份中存在重复的项目元数据 id：${id}`);
    metaIds.add(id);
    const projectId = requireString(item.projectId, 'projectMetaFields[].projectId');
    if (!projectIds.has(projectId)) throw new Error('项目元数据引用了不存在的项目');
    projectMetaFields.push({
      id,
      projectId,
      name: requireString(item.name, 'projectMetaFields[].name'),
      value: typeof item.value === 'string' ? item.value : '',
      position: typeof item.position === 'number' ? item.position : projectMetaFields.length,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }

  // 旧备份没有项目：为旧团队数据补一个默认项目与默认角色。
  const legacyMembersRaw =
    raw.teamMembers === undefined ? [] : requireArray(raw.teamMembers, 'teamMembers');
  let fallbackProjectId = projects[0]?.id ?? '';
  if (projects.length === 0 && legacyMembersRaw.length > 0) {
    const now = new Date().toISOString();
    fallbackProjectId = 'p_default';
    projects.push({
      id: fallbackProjectId,
      name: '默认项目',
      description: '由旧版项目组数据自动迁移',
      color: '#0f766e',
      status: 'active',
      starred: false,
      createdAt: now,
      updatedAt: now,
    });
    projectIds.add(fallbackProjectId);
    [
      ['开发', '#2f6fd0'],
      ['测试', '#9a6512'],
      ['需求', '#0f766e'],
      ['设计', '#5a48c9'],
      ['其他', '#64748b'],
    ].forEach(([name, color], index) => {
      projectRoles.push({
        id: `pr_default_${index}`,
        projectId: fallbackProjectId,
        name,
        color,
        position: index,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  const legacyRoleName = (role: unknown): string => {
    if (role === 'dev') return '开发';
    if (role === 'test') return '测试';
    if (role === 'requirements') return '需求';
    if (role === 'design') return '设计';
    return '其他';
  };
  const findRoleForMember = (projectId: string, roleId: unknown, legacyRole: unknown) => {
    const preferredName = legacyRoleName(legacyRole);
    return (
      projectRoles.find((role) => role.id === roleId && role.projectId === projectId) ??
      projectRoles.find((role) => role.projectId === projectId && role.name === preferredName) ??
      projectRoles.find((role) => role.projectId === projectId)
    );
  };

  // 项目组是 V0.8 新增的；旧备份按空数组处理。
  const rawTeamMembers = legacyMembersRaw;
  const teamMembers: TeamMember[] = [];
  const memberIds = new Set<string>();
  for (const item of rawTeamMembers) {
    if (!isRecord(item)) throw new Error('备份中的项目成员格式不正确');
    const id = requireString(item.id, 'teamMembers[].id');
    if (memberIds.has(id)) throw new Error(`备份中存在重复的项目成员 id：${id}`);
    memberIds.add(id);
    const memberName = requireString(item.name, 'teamMembers[].name');
    const projectId =
      typeof item.projectId === 'string' && projectIds.has(item.projectId)
        ? item.projectId
        : fallbackProjectId;
    if (!projectId) throw new Error('项目成员没有归属项目');
    const role = findRoleForMember(projectId, item.roleId, item.role);
    if (!role) throw new Error(`项目成员「${memberName}」没有可用角色`);
    teamMembers.push({
      id,
      projectId,
      roleId: role.id,
      name: memberName,
      role:
        item.role === 'dev' || item.role === 'test' || item.role === 'requirements' || item.role === 'design'
          ? item.role
          : 'other',
      status: item.status === 'released' ? 'released' : 'active',
      joinedAt: typeof item.joinedAt === 'string' ? item.joinedAt : '',
      releasedAt: typeof item.releasedAt === 'string' ? item.releasedAt : null,
      note: typeof item.note === 'string' ? item.note : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }

  const memberProjectById = new Map(teamMembers.map((member) => [member.id, member.projectId]));

  const rawTenures =
    raw.memberTenures === undefined ? [] : requireArray(raw.memberTenures, 'memberTenures');
  const memberTenures: MemberTenure[] = [];
  const tenureIds = new Set<string>();
  for (const item of rawTenures) {
    if (!isRecord(item)) throw new Error('备份中的投入时间段格式不正确');
    const id = requireString(item.id, 'memberTenures[].id');
    if (tenureIds.has(id)) throw new Error(`备份中存在重复的投入时间段 id：${id}`);
    tenureIds.add(id);
    const memberId = requireString(item.memberId, 'memberTenures[].memberId');
    const projectId = memberProjectById.get(memberId);
    if (!projectId) throw new Error('投入时间段引用了不存在的项目成员');
    const startedAt = requireString(item.startedAt, 'memberTenures[].startedAt');
    const endedAt = typeof item.endedAt === 'string' ? item.endedAt : null;
    if (endedAt && endedAt < startedAt) throw new Error('备份中的投入时间段结束日期无效');
    memberTenures.push({
      id,
      memberId,
      projectId,
      startedAt,
      endedAt,
      note: typeof item.note === 'string' ? item.note : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }
  // 旧备份没有时间段：用成员入组/出组字段补一段。
  for (const member of teamMembers) {
    if (memberTenures.some((tenure) => tenure.memberId === member.id)) continue;
    memberTenures.push({
      id: `mt_bak_${member.id}`,
      memberId: member.id,
      projectId: member.projectId,
      startedAt: member.joinedAt || new Date().toISOString().slice(0, 10),
      endedAt:
        member.status === 'released'
          ? member.releasedAt || member.joinedAt || new Date().toISOString().slice(0, 10)
          : null,
      note: '由旧备份成员记录补全',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const rawOvertime =
    raw.overtimeRecords === undefined ? [] : requireArray(raw.overtimeRecords, 'overtimeRecords');
  const overtimeRecords: OvertimeRecord[] = [];
  const overtimeIds = new Set<string>();
  for (const item of rawOvertime) {
    if (!isRecord(item)) throw new Error('备份中的加班记录格式不正确');
    const id = requireString(item.id, 'overtimeRecords[].id');
    if (overtimeIds.has(id)) throw new Error(`备份中存在重复的加班记录 id：${id}`);
    overtimeIds.add(id);
    const memberId = requireString(item.memberId, 'overtimeRecords[].memberId');
    if (!memberIds.has(memberId)) throw new Error('加班记录引用了不存在的项目成员');
    const projectId =
      typeof item.projectId === 'string' && projectIds.has(item.projectId)
        ? item.projectId
        : (memberProjectById.get(memberId) ?? fallbackProjectId);
    if (!projectIds.has(projectId)) throw new Error('加班记录引用了不存在的项目');
    const hours = typeof item.hours === 'number' ? item.hours : 0;
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('备份中的加班时长无效');
    const status: OvertimeStatus =
      item.status === 'done' || item.status === 'absent' ? item.status : 'planned';
    const absenceReason = typeof item.absenceReason === 'string' ? item.absenceReason : '';
    const absenceError = validateOvertimeAbsenceReason(status, absenceReason);
    if (absenceError) throw new Error(`备份中的未出勤记录不完整：${absenceError}`);
    if (status !== 'absent' && absenceReason.trim()) {
      throw new Error('备份中的非未出勤记录不应包含未出勤原因');
    }
    overtimeRecords.push({
      id,
      projectId,
      memberId,
      date: requireString(item.date, 'overtimeRecords[].date'),
      hours,
      status,
      absenceReason: normalizeOvertimeAbsenceReason(status, absenceReason),
      note: typeof item.note === 'string' ? item.note : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }

  const rawPerformance =
    raw.performanceRecords === undefined
      ? []
      : requireArray(raw.performanceRecords, 'performanceRecords');
  const performanceRecords: PerformanceRecord[] = [];
  const performanceIds = new Set<string>();
  for (const item of rawPerformance) {
    if (!isRecord(item)) throw new Error('备份中的绩效记录格式不正确');
    const id = requireString(item.id, 'performanceRecords[].id');
    if (performanceIds.has(id)) throw new Error(`备份中存在重复的绩效记录 id：${id}`);
    performanceIds.add(id);
    const memberId = requireString(item.memberId, 'performanceRecords[].memberId');
    if (!memberIds.has(memberId)) throw new Error('绩效记录引用了不存在的项目成员');
    const projectId =
      typeof item.projectId === 'string' && projectIds.has(item.projectId)
        ? item.projectId
        : (memberProjectById.get(memberId) ?? fallbackProjectId);
    if (!projectIds.has(projectId)) throw new Error('绩效记录引用了不存在的项目');
    const points = typeof item.points === 'number' ? Math.round(item.points) : 0;
    if (points === 0) throw new Error('备份中的绩效分值不能为 0');
    performanceRecords.push({
      id,
      projectId,
      memberId,
      date: requireString(item.date, 'performanceRecords[].date'),
      points,
      reason: requireString(item.reason, 'performanceRecords[].reason'),
      category:
        item.category === 'delivery' || item.category === 'quality' || item.category === 'collaboration'
          ? item.category
          : 'other',
      note: typeof item.note === 'string' ? item.note : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    });
  }

  // V0.11 新增的三组数据，旧备份没有这些字段时按空数组处理。
  const rawRecurrences = raw.recurrences === undefined ? [] : requireArray(raw.recurrences, 'recurrences');
  const recurrences: Recurrence[] = [];
  const recurrenceIds = new Set<string>();
  for (const item of rawRecurrences) {
    if (!isRecord(item)) throw new Error('备份中的重复任务配置格式不正确');
    const id = requireString(item.id, 'recurrences[].id');
    if (recurrenceIds.has(id)) throw new Error(`备份中存在重复的重复配置 id：${id}`);
    recurrenceIds.add(id);
    const cardId = requireString(item.cardId, 'recurrences[].cardId');
    if (!cardIds.has(cardId)) throw new Error(`重复配置引用了不存在的任务：${cardId}`);
    const frequency =
      item.frequency === 'weekly' || item.frequency === 'monthly' || item.frequency === 'interval'
        ? item.frequency
        : 'daily';
    recurrences.push({
      id,
      cardId,
      frequency,
      intervalValue: typeof item.intervalValue === 'number' ? Math.max(1, Math.floor(item.intervalValue)) : 1,
      weekdays: Array.isArray(item.weekdays)
        ? item.weekdays.filter((day): day is number => typeof day === 'number' && day >= 0 && day <= 6)
        : [],
      nextDueDate: typeof item.nextDueDate === 'string' ? item.nextDueDate : null,
      enabled: item.enabled !== false,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }

  const rawRules = raw.automationRules === undefined ? [] : requireArray(raw.automationRules, 'automationRules');
  const automationRules: AutomationRule[] = [];
  const ruleIds = new Set<string>();
  for (const item of rawRules) {
    if (!isRecord(item)) throw new Error('备份中的本地规则格式不正确');
    const id = requireString(item.id, 'automationRules[].id');
    if (ruleIds.has(id)) throw new Error(`备份中存在重复的规则 id：${id}`);
    ruleIds.add(id);
    const trigger = item.trigger === 'complete' ? 'complete' : 'move_to_list';
    const listId = typeof item.listId === 'string' ? item.listId : null;
    if (trigger === 'move_to_list' && listId && !listBoard.has(listId)) {
      throw new Error(`本地规则引用了不存在的列表：${listId}`);
    }
    automationRules.push({
      id,
      name: typeof item.name === 'string' ? item.name : '',
      trigger,
      listId,
      actions: Array.isArray(item.actions) ? (item.actions as AutomationRule['actions']) : [],
      enabled: item.enabled === true,
      lastError: '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }

  const rawActivity = raw.cardActivity === undefined ? [] : requireArray(raw.cardActivity, 'cardActivity');
  const cardActivity: CardActivity[] = [];
  const activityIds = new Set<string>();
  for (const item of rawActivity) {
    if (!isRecord(item)) throw new Error('备份中的活动日志格式不正确');
    const id = requireString(item.id, 'cardActivity[].id');
    if (activityIds.has(id)) throw new Error(`备份中存在重复的活动日志 id：${id}`);
    activityIds.add(id);
    const cardId = requireString(item.cardId, 'cardActivity[].cardId');
    if (!cardIds.has(cardId)) throw new Error(`活动日志引用了不存在的任务：${cardId}`);
    cardActivity.push({
      id,
      cardId,
      eventType: typeof item.eventType === 'string' ? item.eventType : 'updated',
      field: typeof item.field === 'string' ? item.field : '',
      oldValue: typeof item.oldValue === 'string' ? item.oldValue : '',
      newValue: typeof item.newValue === 'string' ? item.newValue : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    });
  }

  // V0.13.0 新增的自定义字段；旧备份没有这两项时按空数组处理。
  const rawCustomFields =
    raw.customFields === undefined ? [] : requireArray(raw.customFields, 'customFields');
  const customFields: CustomField[] = [];
  const customFieldIds = new Set<string>();
  const customFieldNames = new Set<string>();
  for (const item of rawCustomFields) {
    if (!isRecord(item)) throw new Error('备份中的自定义字段格式不正确');
    const id = requireString(item.id, 'customFields[].id');
    if (customFieldIds.has(id)) throw new Error(`备份中存在重复的自定义字段 id：${id}`);
    customFieldIds.add(id);
    const boardId = requireString(item.boardId, 'customFields[].boardId');
    if (!boardIds.has(boardId)) throw new Error('自定义字段引用了不存在的看板');
    const name = requireString(item.name, 'customFields[].name');
    const nameKey = boardId + '::' + name;
    if (customFieldNames.has(nameKey)) throw new Error(`看板内存在同名的自定义字段：${name}`);
    customFieldNames.add(nameKey);
    const fieldType: CustomFieldType = item.fieldType === 'number' ? 'number' : 'select';
    const rawOptions =
      item.options === undefined ? [] : requireArray(item.options, 'customFields[].options');
    const options: CustomFieldOption[] = [];
    const optionIds = new Set<string>();
    for (const rawOption of rawOptions) {
      if (!isRecord(rawOption)) throw new Error('备份中的自定义字段选项格式不正确');
      const optionId = requireString(rawOption.id, 'customFields[].options[].id');
      if (optionIds.has(optionId)) {
        throw new Error(`自定义字段「${name}」中存在重复的选项 id`);
      }
      optionIds.add(optionId);
      options.push({
        id: optionId,
        label:
          typeof rawOption.label === 'string' && rawOption.label.trim() !== ''
            ? rawOption.label
            : optionId,
        color:
          typeof rawOption.color === 'string' && rawOption.color.trim() !== ''
            ? rawOption.color
            : '#64748b',
      });
    }
    if (fieldType === 'number' && options.length > 0) {
      throw new Error(`数值字段「${name}」不应带选项`);
    }
    if (fieldType === 'select' && options.length === 0) {
      throw new Error(`单选字段「${name}」至少需要一个选项`);
    }
    customFields.push({
      id,
      boardId,
      name,
      fieldType,
      options,
      sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : customFields.length,
      createdAt:
        typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt:
        typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }

  const rawFieldValues =
    raw.cardFieldValues === undefined ? [] : requireArray(raw.cardFieldValues, 'cardFieldValues');
  const cardFieldValues: CardFieldValue[] = [];
  const fieldValueKeys = new Set<string>();
  const fieldById = new Map(customFields.map((field) => [field.id, field]));
  for (const item of rawFieldValues) {
    if (!isRecord(item)) throw new Error('备份中的自定义字段值格式不正确');
    const cardId = requireString(item.cardId, 'cardFieldValues[].cardId');
    const fieldId = requireString(item.fieldId, 'cardFieldValues[].fieldId');
    if (!cardIds.has(cardId)) throw new Error(`字段值引用了不存在的任务：${cardId}`);
    const field = fieldById.get(fieldId);
    if (!field) throw new Error(`字段值引用了不存在的自定义字段：${fieldId}`);
    const owner = cards.find((card) => card.id === cardId);
    if (owner && owner.boardId !== field.boardId) {
      throw new Error(`字段值引用了其它看板的任务：${cardId}`);
    }
    const key = cardId + '::' + fieldId;
    if (fieldValueKeys.has(key)) throw new Error('同一个任务的同一个字段存在重复取值');
    fieldValueKeys.add(key);
    const valueText = typeof item.valueText === 'string' ? item.valueText : null;
    const valueNumber =
      typeof item.valueNumber === 'number' && Number.isFinite(item.valueNumber)
        ? item.valueNumber
        : null;
    if (field.fieldType === 'select') {
      if (valueNumber !== null) throw new Error(`单选字段「${field.name}」的取值不能是数字`);
      if (valueText !== null && !field.options.some((option) => option.id === valueText)) {
        throw new Error(`单选字段「${field.name}」的取值指向了不存在的选项`);
      }
    } else {
      if (valueText !== null) throw new Error(`数值字段「${field.name}」的取值不能是文本`);
    }
    if (valueText === null && valueNumber === null) continue;
    cardFieldValues.push({ cardId, fieldId, valueText, valueNumber });
  }

  // V0.13.1 新增的保存视图；旧备份没有这一项时按空数组处理。
  const rawSavedViews =
    raw.savedViews === undefined ? [] : requireArray(raw.savedViews, 'savedViews');
  const savedViews: SavedView[] = [];
  const savedViewIds = new Set<string>();
  const savedViewNames = new Map<string, Set<string>>();
  for (const item of rawSavedViews) {
    if (!isRecord(item)) throw new Error('备份中的保存视图格式不正确');
    const id = requireString(item.id, 'savedViews[].id');
    if (savedViewIds.has(id)) throw new Error('备份中存在重复的保存视图 id：' + id);
    savedViewIds.add(id);
    const name = requireString(item.name, 'savedViews[].name');
    const boardId = requireString(item.boardId, 'savedViews[].boardId');
    if (!boardIds.has(boardId)) {
      throw new Error('保存视图「' + name + '」引用了不存在的看板');
    }
    const names = savedViewNames.get(boardId) ?? new Set<string>();
    if (names.has(name.trim())) throw new Error('看板中存在同名的保存视图：' + name);
    names.add(name.trim());
    savedViewNames.set(boardId, names);
    const viewType = typeof item.viewType === 'string' ? item.viewType.trim() : '';
    if (!viewType) throw new Error('保存视图「' + name + '」缺少视图类型');
    // 字段筛选必须指向本备份里真实存在的字段与选项，否则整份备份视为损坏
    const filters = normalizeSavedViewFilters(item.filters as Partial<SavedViewFilters>);
    for (const filter of filters.fieldFilters) {
      const field = fieldById.get(filter.fieldId);
      if (!field) {
        throw new Error(
          '保存视图「' + name + '」引用了不存在的自定义字段：' + filter.fieldId,
        );
      }
      if (field.boardId !== boardId) {
        throw new Error(
          '保存视图「' + name + '」引用了其它看板的自定义字段：' + filter.fieldId,
        );
      }
      if (filter.optionIds.length > 0) {
        const valid = new Set(field.options.map((option) => option.id));
        for (const optionId of filter.optionIds) {
          if (!valid.has(optionId)) {
            throw new Error('保存视图「' + name + '」引用了不存在的选项：' + optionId);
          }
        }
      }
    }
    savedViews.push({
      id,
      boardId,
      name,
      viewType: viewType as BoardView,
      filters,
      sort: normalizeSavedViewSort(item.sort as Partial<SavedViewSort>),
      isBuiltin: item.isBuiltin === true,
      createdAt:
        typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt:
        typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }


  return {
    app: BACKUP_APP,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date().toISOString(),
    boards,
    lists,
    cards,
    inbox,
    dependencies,
    boardSets,
    goals,
    teamMembers,
    overtimeRecords,
    performanceRecords,
    memberTenures,
    projects,
    projectMetaFields,
    projectRoles,
    recurrences,
    automationRules,
    cardActivity,
    customFields,
    cardFieldValues,
    savedViews,
  };
}
