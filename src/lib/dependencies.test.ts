import { describe, expect, it } from 'vitest';
import {
  blockerIds,
  blockersFor,
  dependencyCandidates,
  dependentIds,
  isBlocked,
} from './dependencies';
import type { Card, CardDependency } from './types';

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    boardId: 'b_1',
    listId: 'l_1',
    title: id,
    description: '',
    dueDate: null,
    startDate: null,
    estimatedMinutes: null,
    actualMinutes: null,
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

const cards = [card('a'), card('b'), card('c'), card('d', { boardId: 'b_2' })];
const dependencies: CardDependency[] = [
  { cardId: 'c', dependsOnCardId: 'a' },
  { cardId: 'c', dependsOnCardId: 'b' },
];

describe('task dependencies', () => {
  it('列出前置任务并判断是否被未完成的前置阻塞', () => {
    expect(blockerIds('c', dependencies)).toEqual(['a', 'b']);
    expect(blockersFor('c', dependencies, cards).map((item) => item.id)).toEqual(['a', 'b']);
    expect(isBlocked('c', dependencies, cards)).toBe(true);
    expect(isBlocked('a', dependencies, cards)).toBe(false);
  });

  it('前置任务全部完成即解除阻塞', () => {
    const done = cards.map((item) => (item.id === 'a' ? { ...item, completed: true } : item));
    expect(isBlocked('c', dependencies, done)).toBe(true);
    const allDone = done.map((item) => (item.id === 'b' ? { ...item, completed: true } : item));
    expect(isBlocked('c', dependencies, allDone)).toBe(false);
  });

  it('计算直接/间接依赖自己的任务', () => {
    const chain: CardDependency[] = [
      { cardId: 'b', dependsOnCardId: 'a' },
      { cardId: 'c', dependsOnCardId: 'b' },
    ];
    expect([...dependentIds('a', chain)].sort()).toEqual(['b', 'c']);
    expect([...dependentIds('c', chain)]).toEqual([]);
  });

  it('候选前置任务排除自己、跨看板、已添加和依赖自己的任务', () => {
    const candidates = dependencyCandidates(cards[0], cards, dependencies).map((item) => item.id);
    expect(candidates).toEqual(['b']);
    expect(candidates).not.toContain('c');
    expect(candidates).not.toContain('d');
  });
});
