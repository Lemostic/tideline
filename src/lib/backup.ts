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
  Card,
  InboxItem,
  List,
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
}

export function summarizeBackup(backup: Pick<BackupFile, 'boards' | 'lists' | 'cards' | 'inbox'>): BackupSummary {
  return {
    boards: backup.boards.length,
    lists: backup.lists.length,
    cards: backup.cards.length,
    trashed: backup.cards.filter((card) => card.deletedAt !== null).length,
    inbox: backup.inbox.length,
  };
}

/** 用当前全量数据（含回收站）生成备份对象。 */
export function createBackup(data: BackupData): BackupFile {
  return {
    app: BACKUP_APP,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    boards: data.boards,
    lists: data.lists,
    cards: data.cards,
    inbox: data.inbox,
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
  const lists = requireArray(raw.lists, 'lists') as List[];
  const cards = requireArray(raw.cards, 'cards') as Card[];
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
  }

  const inboxIds = new Set<string>();
  for (const item of inbox) {
    if (!isRecord(item)) throw new Error('备份中的收件箱数据格式不正确');
    const id = requireString(item.id, 'inbox[].id');
    if (inboxIds.has(id)) throw new Error(`备份中存在重复的收件箱条目 id：${id}`);
    inboxIds.add(id);
  }

  return {
    app: BACKUP_APP,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date().toISOString(),
    boards,
    lists,
    cards,
    inbox,
  };
}
