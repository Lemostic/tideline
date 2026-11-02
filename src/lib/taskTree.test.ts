import { describe, expect, it } from 'vitest';
import {
  breadcrumbOf,
  buildChildrenIndex,
  cardDepth,
  childrenOf,
  descendantsOf,
  isSubtask,
  MAX_TASK_DEPTH,
  rootCards,
  subtaskProgress,
} from './taskTree';
import type { Card } from './types';

const base = (
  id: string,
  parentCardId: string | null = null,
  completed = false,
  position = 0,
): Card => ({
  id,
  boardId: 'b1',
  listId: 'l1',
  parentCardId,
  title: id,
  description: '',
  dueDate: null,
  startDate: null,
  estimatedMinutes: null,
  actualMinutes: null,
  priority: null,
  accent: null,
  completed,
  deletedAt: null,
  labels: [],
  position,
  recurrenceId: null,
  generatedFromId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

describe('taskTree', () => {
  const cards = [
    base('a'),
    base('a1', 'a', false, 0),
    base('a11', 'a1', true, 0),
    base('a2', 'a', true, 1),
    base('b'),
  ];

  it('区分根任务与子任务，并按 position 排序', () => {
    expect(rootCards(cards).map((card) => card.id)).toEqual(['a', 'b']);
    expect(childrenOf(cards, 'a').map((card) => card.id)).toEqual(['a1', 'a2']);
    expect(isSubtask(cards[1])).toBe(true);
    expect(isSubtask(cards[0])).toBe(false);
  });

  it('按全部后代计算进度', () => {
    expect(descendantsOf(cards, 'a').map((card) => card.id)).toEqual(['a1', 'a11', 'a2']);
    expect(subtaskProgress(cards, 'a')).toMatchObject({ done: 2, total: 3, percent: 67 });
    expect(subtaskProgress(cards, 'a1')).toMatchObject({ done: 1, total: 1, percent: 100 });
    expect(subtaskProgress(cards, 'b')).toMatchObject({ done: 0, total: 0, percent: 0 });
  });

  it('面包屑从根到当前，深度正确', () => {
    expect(breadcrumbOf(cards, 'a11').map((card) => card.id)).toEqual(['a', 'a1', 'a11']);
    expect(cardDepth(cards, 'a11')).toBe(2);
    expect(cardDepth(cards, 'a')).toBe(0);
    expect(breadcrumbOf(cards, 'missing')).toEqual([]);
  });

  it('建立子任务索引', () => {
    const index = buildChildrenIndex(cards);
    expect((index.get(null) ?? []).map((card) => card.id)).toEqual(['a', 'b']);
    expect((index.get('a') ?? []).map((card) => card.id)).toEqual(['a1', 'a2']);
  });

  it('容忍环数据且不无限循环', () => {
    const cyclic = [base('x', 'y'), base('y', 'x')];
    expect(() => breadcrumbOf(cyclic, 'x')).not.toThrow();
    expect(() => descendantsOf(cyclic, 'x')).not.toThrow();
    expect(breadcrumbOf(cyclic, 'x').length).toBeLessThanOrEqual(MAX_TASK_DEPTH + 1);
  });
});
