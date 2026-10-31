/**
 * 备份文件（V0.4）的构造、解析与校验。
 *
 * 浏览器端 localStorage 与桌面端 Rust 共用同一份 JSON 契约：
 * `{ app, formatVersion: 1, exportedAt, boards, lists, cards, inbox }`
 * cards 包含回收站任务（deletedAt 非空），恢复时整体替换。
 */
import type {
  BackupFile,
  BackupSummary,
  Board,
  BoardSet,
  Card,
  CardDependency,
  Goal,
  InboxItem,
  List,
  OvertimeRecord,
  PerformanceRecord,
  Project,
  ProjectMetaField,
  ProjectRole,
  TeamMember,
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
  projects: Project[];
  projectMetaFields: ProjectMetaField[];
  projectRoles: ProjectRole[];
}

export function summarizeBackup(
  backup: Pick<
    BackupFile,
    'boards' | 'lists' | 'cards' | 'inbox' | 'dependencies' | 'boardSets' | 'goals' |
      'teamMembers' | 'overtimeRecords' | 'performanceRecords' | 'projects' |
      'projectMetaFields' | 'projectRoles'
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
    projects: backup.projects.length,
    projectMetaFields: backup.projectMetaFields.length,
    projectRoles: backup.projectRoles.length,
  };
}

/** 用当前全量数据（含回收站、依赖、看板集与目标）生成备份对象。 */
export function createBackup(data: BackupData): BackupFile {
  return {
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
    projects: data.projects,
    projectMetaFields: data.projectMetaFields,
    projectRoles: data.projectRoles,
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

  const boards = requireArray(raw.boards, 'boards') as Board[];
  const lists = (requireArray(raw.lists, 'lists') as List[]).map((list) => ({
    ...list,
    color: list.color ?? 'slate',
    wipLimit: typeof list.wipLimit === 'number' ? list.wipLimit : null,
  }));
  const cards = (requireArray(raw.cards, 'cards') as Card[]).map((card) => ({
    ...card,
    accent: card.accent ?? null,
  }));
  const inbox = requireArray(raw.inbox, 'inbox') as InboxItem[];

  const boardIds = new Set<string>();
  for (const board of boards) {
    if (!isRecord(board)) throw new Error('备份中的看板数据格式不正确');
    const id = requireString(board.id, 'boards[].id');
    if (boardIds.has(id)) throw new Error(`备份中存在重复的看板 id：${id}`);
    boardIds.add(id);
    requireString(board.title ?? '', 'boards[].title');
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
  const cardBoard = new Map<string, string>();
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
    cardBoard.set(id, boardId);
    requireString(card.title ?? '', 'cards[].title');
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
    if (cardBoard.get(cardId) !== cardBoard.get(dependsOnCardId)) {
      throw new Error('备份中存在跨看板的任务依赖');
    }
    dependencies.push({ cardId, dependsOnCardId });
    const bucket = dependencyEdges.get(cardId) ?? [];
    bucket.push(dependsOnCardId);
    dependencyEdges.set(cardId, bucket);
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
    overtimeRecords.push({
      id,
      projectId,
      memberId,
      date: requireString(item.date, 'overtimeRecords[].date'),
      hours,
      status: item.status === 'done' ? 'done' : 'planned',
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
    projects,
    projectMetaFields,
    projectRoles,
  };
}
