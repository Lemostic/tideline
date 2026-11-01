import { describe, expect, it } from 'vitest';
import {
  blockerIds,
  blockersFor,
  crossBoardRelationCandidates,
  dependencyCandidates,
  dependentIds,
  isBlocked,
  relatedIds,
  relationTypeOf,
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

describe('relation types (V0.12)', () => {
  it('缺少关系类型时按「前置」处理', () => {
    expect(relationTypeOf({ cardId: 'c', dependsOnCardId: 'a' })).toBe('blocks');
    expect(
      relationTypeOf({ cardId: 'c', dependsOnCardId: 'a', relationType: 'relates' }),
    ).toBe('relates');
  });

  it('只有前置关系产生阻塞，相关与重复关系不阻塞', () => {
    const mixed: CardDependency[] = [
      { cardId: 'c', dependsOnCardId: 'a', relationType: 'relates' },
      { cardId: 'c', dependsOnCardId: 'b', relationType: 'duplicates' },
    ];
    expect(isBlocked('c', mixed, cards)).toBe(false);
    expect(blockersFor('c', mixed, cards)).toEqual([]);
    // 但它们仍是已建立的关系，不能重复添加
    expect(relatedIds('c', mixed).sort()).toEqual(['a', 'b']);
  });

  it('前置与其它关系混用时，阻塞只由前置关系决定', () => {
    const mixed: CardDependency[] = [
      { cardId: 'c', dependsOnCardId: 'a', relationType: 'blocks' },
      { cardId: 'c', dependsOnCardId: 'b', relationType: 'relates' },
    ];
    expect(blockersFor('c', mixed, cards).map((item) => item.id)).toEqual(['a']);
    expect(isBlocked('c', mixed, cards)).toBe(true);
    const aDone = cards.map((item) => (item.id === 'a' ? { ...item, completed: true } : item));
    expect(isBlocked('c', mixed, aDone)).toBe(false);
  });

  it('相关与重复关系不参与循环依赖传播', () => {
    // a <-> b 互为 relates，不构成阻塞链
    const related: CardDependency[] = [
      { cardId: 'a', dependsOnCardId: 'b', relationType: 'relates' },
      { cardId: 'b', dependsOnCardId: 'a', relationType: 'relates' },
    ];
    expect(dependentIds('a', related).size).toBe(0);

    // 换成 blocks 就会形成传播链
    const blocking: CardDependency[] = [
      { cardId: 'a', dependsOnCardId: 'b', relationType: 'blocks' },
      { cardId: 'b', dependsOnCardId: 'a', relationType: 'blocks' },
    ];
    expect(dependentIds('a', blocking).size).toBe(2);
  });

  it('跨看板关系候选包含其它看板的任务', () => {
    const candidates = crossBoardRelationCandidates(cards[0], cards, dependencies).map(
      (item) => item.id,
    );
    expect(candidates).toContain('d');
    expect(candidates).not.toContain('a');
    expect(candidates).not.toContain('c');
  });
});
