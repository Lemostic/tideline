import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  backupFilename,
  createBackup,
  parseBackup,
  summarizeBackup,
} from './backup';
import type { Board, Card, InboxItem, List } from './types';

const board: Board = {
  id: 'b_1',
  title: '看板',
  description: '简介',
  color: 'blue',
  starred: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const list: List = {
  id: 'l_1',
  boardId: 'b_1',
  title: '待办',
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'c_1',
    boardId: 'b_1',
    listId: 'l_1',
    title: '任务',
    description: '',
    dueDate: null,
    startDate: null,
    priority: null,
    completed: false,
    deletedAt: null,
    labels: [],
    subtasks: [],
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const inbox: InboxItem[] = [
  { id: 'i_1', content: '想法', createdAt: '2026-01-01T00:00:00.000Z' },
];

const validBackup = () =>
  createBackup({
    boards: [board],
    lists: [list],
    cards: [card(), card({ id: 'c_2', deletedAt: '2026-02-01T00:00:00.000Z' })],
    inbox,
    dependencies: [{ cardId: 'c_2', dependsOnCardId: 'c_1' }],
    boardSets: [],
  });

describe('backup helpers', () => {
  it('创建备份时统计活动任务、回收站任务与依赖', () => {
    const summary = summarizeBackup(validBackup());
    expect(summary).toEqual({
      boards: 1,
      lists: 1,
      cards: 2,
      trashed: 1,
      inbox: 1,
      dependencies: 1,
      boardSets: 0,
    });
  });

  it('解析合法备份并保留回收站字段', () => {
    const backup = parseBackup(JSON.stringify(validBackup()));
    expect(backup.app).toBe('tideline');
    expect(backup.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(backup.cards).toHaveLength(2);
    expect(backup.cards[1].deletedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('拒绝非潮线备份、错误版本和非法 JSON', () => {
    expect(() => parseBackup('not json')).toThrow('有效的 JSON');
    expect(() =>
      parseBackup(JSON.stringify({ ...validBackup(), app: 'other' })),
    ).toThrow('不是潮线');
    expect(() =>
      parseBackup(JSON.stringify({ ...validBackup(), formatVersion: 9 })),
    ).toThrow('不受支持');
  });

  it('拒绝重复 id 与引用不存在的列表', () => {
    const backup = validBackup();
    expect(() => parseBackup(JSON.stringify({ ...backup, cards: [backup.cards[0], backup.cards[0]] }))).toThrow(
      '重复的任务 id',
    );
    expect(() =>
      parseBackup(
        JSON.stringify({
          ...backup,
          cards: [{ ...backup.cards[0], listId: 'l_missing' }],
        }),
      ),
    ).toThrow('不存在的列表');
  });

  it('备份文件名可安全用于 Windows', () => {
    const name = backupFilename(new Date('2026-10-30T12:34:56.789Z'));
    expect(name).toBe('tideline-backup-2026-10-30T12-34-56-789Z.json');
    expect(name).not.toMatch(/[:\\/]/);
  });
});
