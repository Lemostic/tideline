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
  parseBackup,
  serializeBackup,
  summarizeBackup,
} from './backup';
import { createId, nowISO } from './ids';
import type {
  BackupExport,
  BackupSummary,
  Board,
  BoardPatch,
  Card,
  CardDependency,
  CardPatch,
  ConvertInboxInput,
  IdInput,
  InboxItem,
  List,
  ListPatch,
  MoveCardInput,
  NewBoardInput,
  NewCardInput,
  NewListInput,
  Snapshot,
  StorageInfo,
  Subtask,
} from './types';

export interface TidelineApi {
  getSnapshot(): Promise<Snapshot>;
  createBoard(input: NewBoardInput): Promise<Board>;
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
  /** 整体替换某张任务的前置任务（V0.4） */
  setCardDependencies(input: { cardId: string; dependsOn: string[] }): Promise<CardDependency[]>;
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
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Tauri 桌面端实现：命令名与 Rust `#[tauri::command]` 一一对应 */
const tauriApi: TidelineApi = {
  getSnapshot: () => invoke<Snapshot>('get_snapshot'),
  createBoard: (input) => invoke<Board>('create_board', { input }),
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
  exportBackup: () => invoke<BackupExport>('export_backup'),
  importBackup: (json) => invoke<BackupSummary>('import_backup', { input: { json } }),
  getStorageInfo: () => invoke<StorageInfo>('get_storage_info'),
  pickDataDirectory: () => invoke<string | null>('pick_data_directory'),
  changeDataDirectory: (path) =>
    invoke<StorageInfo>('change_data_directory', { input: { path } }),
  resetDataDirectory: () => invoke<StorageInfo>('reset_data_directory'),
};

/** 浏览器降级实现：localStorage 单文件快照 */
const STORAGE_KEY = 'tideline.db.v1';

interface LocalDb extends Snapshot {}

/**
 * 兼容 V0.1 写入的旧数据：补齐 V0.2 新增的 startDate / labels / subtasks。
 * SQLite 侧由 Rust 迁移完成，这里处理浏览器 localStorage。
 */
function normalizeCard(raw: Card): Card {
  const subtasks: Subtask[] = Array.isArray(raw.subtasks)
    ? raw.subtasks
        .filter((item): item is Subtask => Boolean(item) && typeof item.title === 'string')
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
    startDate: raw.startDate ?? null,
    deletedAt: raw.deletedAt ?? null,
    labels,
    subtasks,
  };
}

function loadLocalDb(): LocalDb {
  if (typeof localStorage === 'undefined') {
    return { boards: [], lists: [], cards: [], inbox: [], dependencies: [] };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { boards: [], lists: [], cards: [], inbox: [], dependencies: [] };
    const parsed = JSON.parse(raw) as Partial<LocalDb>;
    return {
      boards: Array.isArray(parsed.boards) ? parsed.boards : [],
      lists: Array.isArray(parsed.lists) ? parsed.lists : [],
      cards: Array.isArray(parsed.cards) ? parsed.cards.map(normalizeCard) : [],
      inbox: Array.isArray(parsed.inbox) ? parsed.inbox : [],
      dependencies: Array.isArray(parsed.dependencies)
        ? parsed.dependencies.filter(
            (item): item is CardDependency =>
              Boolean(item) &&
              typeof item.cardId === 'string' &&
              typeof item.dependsOnCardId === 'string',
          )
        : [],
    };
  } catch {
    return { boards: [], lists: [], cards: [], inbox: [], dependencies: [] };
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
    .filter((c) => c.listId === listId && !c.deletedAt)
    .sort((a, b) => a.position - b.position)
    .forEach((card, index) => {
      card.position = index;
    });
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
      createdAt: now,
      updatedAt: now,
    };
    db.boards.push(board);
    saveLocalDb(db);
    return board;
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
    pruneDependencies(db, removedCardIds);
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
    normalizeListPositions(db, list.boardId);
    touchBoard(db, list.boardId);
    saveLocalDb(db);
  },

  async createCard(input) {
    const db = loadLocalDb();
    requireList(db, input.listId);
    const siblings = db.cards.filter((c) => c.listId === input.listId && !c.deletedAt);
    const now = nowISO();
    const card: Card = {
      id: createId('c'),
      boardId: input.boardId,
      listId: input.listId,
      title: input.title.trim() || '未命名任务',
      description: input.description?.trim() ?? '',
      dueDate: input.dueDate ?? null,
      startDate: input.startDate ?? null,
      priority: input.priority ?? null,
      completed: false,
      deletedAt: null,
      labels: input.labels ? [...input.labels] : [],
      subtasks: input.subtasks ? input.subtasks.map((item) => ({ ...item })) : [],
      position: siblings.length ? Math.max(...siblings.map((c) => c.position)) + 1 : 0,
      createdAt: now,
      updatedAt: now,
    };
    db.cards.push(card);
    touchBoard(db, input.boardId);
    saveLocalDb(db);
    return card;
  },

  async updateCard({ id, patch }) {
    const db = loadLocalDb();
    const card = requireCard(db, id);
    if (patch.title !== undefined) card.title = patch.title.trim() || '未命名任务';
    if (patch.description !== undefined) card.description = patch.description;
    if (patch.dueDate !== undefined) card.dueDate = patch.dueDate;
    if (patch.startDate !== undefined) card.startDate = patch.startDate;
    if (patch.priority !== undefined) card.priority = patch.priority;
    if (patch.completed !== undefined) card.completed = patch.completed;
    if (patch.labels !== undefined) card.labels = [...patch.labels];
    if (patch.subtasks !== undefined) card.subtasks = patch.subtasks.map((item) => ({ ...item }));
    if (patch.listId !== undefined && patch.listId !== card.listId) {
      const targetList = requireList(db, patch.listId);
      if (targetList.boardId !== card.boardId) throw new Error('不能跨看板移动任务');
      const oldListId = card.listId;
      card.listId = patch.listId;
      normalizePositions(db, oldListId);
      card.position = db.cards.filter(
        (c) => c.listId === card.listId && c.id !== card.id && !c.deletedAt,
      ).length;
    }
    card.updatedAt = nowISO();
    touchBoard(db, card.boardId);
    saveLocalDb(db);
    return card;
  },

  async deleteCard({ id }) {
    const db = loadLocalDb();
    const card = requireCard(db, id);
    if (card.deletedAt) return;
    card.deletedAt = nowISO();
    card.updatedAt = card.deletedAt;
    pruneDependencies(db, new Set([card.id]));
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
    card.deletedAt = null;
    const activeSiblings = db.cards.filter(
      (c) => c.listId === card.listId && c.id !== card.id && !c.deletedAt,
    );
    card.position = activeSiblings.length
      ? Math.max(...activeSiblings.map((c) => c.position)) + 1
      : 0;
    card.updatedAt = nowISO();
    touchBoard(db, card.boardId);
    saveLocalDb(db);
    return card;
  },

  async purgeCard({ id }) {
    const db = loadLocalDb();
    db.cards = db.cards.filter((card) => card.id !== id);
    pruneDependencies(db, new Set([id]));
    saveLocalDb(db);
  },

  async emptyTrash() {
    const db = loadLocalDb();
    const removed = new Set(db.cards.filter((card) => card.deletedAt).map((card) => card.id));
    db.cards = db.cards.filter((card) => !card.deletedAt);
    pruneDependencies(db, removed);
    saveLocalDb(db);
  },

  async moveCard({ cardId, toListId, toIndex }) {
    const db = loadLocalDb();
    const card = requireCard(db, cardId);
    const targetList = requireList(db, toListId);
    if (targetList.boardId !== card.boardId) throw new Error('不能跨看板移动任务');
    const oldListId = card.listId;
    const targetCards = db.cards
      .filter((c) => c.listId === toListId && c.id !== cardId && !c.deletedAt)
      .sort((a, b) => a.position - b.position);
    const index = Math.max(0, Math.min(toIndex, targetCards.length));
    targetCards.splice(index, 0, card);
    card.listId = toListId;
    targetCards.forEach((c, i) => {
      c.position = i;
    });
    if (oldListId !== toListId) {
      normalizePositions(db, oldListId);
    }
    card.updatedAt = nowISO();
    touchBoard(db, card.boardId);
    saveLocalDb(db);
    return card;
  },

  async setCardDependencies({ cardId, dependsOn }) {
    const db = loadLocalDb();
    const card = requireCard(db, cardId);
    if (card.deletedAt) throw new Error('回收站中的任务不能设置前置任务');
    const blockers: string[] = [];
    for (const id of dependsOn) {
      if (id === card.id) throw new Error('任务不能依赖自己');
      if (blockers.includes(id)) continue;
      const blocker = requireCard(db, id);
      if (blocker.deletedAt) throw new Error(`前置任务「${blocker.title}」在回收站中`);
      if (blocker.boardId !== card.boardId) throw new Error('只能依赖同一看板内的任务');
      blockers.push(id);
    }

    const edges = new Map<string, string[]>();
    for (const dependency of db.dependencies) {
      if (dependency.cardId === card.id) continue;
      const list = edges.get(dependency.cardId) ?? [];
      list.push(dependency.dependsOnCardId);
      edges.set(dependency.cardId, list);
    }
    edges.set(card.id, blockers);
    for (const blocker of blockers) {
      if (dependencyReaches(edges, blocker, card.id)) {
        throw new Error('前置任务形成了循环依赖');
      }
    }

    db.dependencies = db.dependencies.filter((dependency) => dependency.cardId !== card.id);
    for (const blocker of blockers) {
      db.dependencies.push({ cardId: card.id, dependsOnCardId: blocker });
    }
    saveLocalDb(db);
    return blockers.map((dependsOnCardId) => ({ cardId: card.id, dependsOnCardId }));
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
      title: item.content.split('\n')[0].slice(0, 80) || '未命名任务',
      description: item.content.includes('\n') ? item.content : '',
      dueDate: null,
      startDate: null,
      priority: null,
      completed: false,
      deletedAt: null,
      labels: [],
      subtasks: [],
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
};

export const api: TidelineApi = isTauri() ? tauriApi : localApi;

/** 浏览器端开发辅助：清空 localStorage 数据（仅调试用） */
export function resetLocalData(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('tideline.seeded');
  }
}
