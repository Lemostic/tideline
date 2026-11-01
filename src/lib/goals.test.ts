import { describe, expect, it } from 'vitest';
import {
  descendantGoalIds,
  goalAncestors,
  goalProgress,
  goalProgressDetail,
  topLevelGoals,
} from '@/lib/goals';
import type { Card, Goal } from '@/lib/types';

function card(id: string, completed: boolean): Card {
  return {
    id,
    boardId: 'b1',
    listId: 'l1',
    title: id,
    description: '',
    dueDate: null,
    startDate: null,
    estimatedMinutes: null,
    actualMinutes: null,
    priority: null,
    completed,
    deletedAt: null,
    labels: [],
    subtasks: [],
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function goal(id: string, patch: Partial<Goal> = {}): Goal {
  return {
    id,
    title: id,
    description: '',
    scope: 'team',
    status: 'active',
    startDate: null,
    dueDate: null,
    manualProgress: 0,
    parentId: null,
    cardIds: [],
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

const cards = [card('c1', true), card('c2', true), card('c3', false), card('c4', false)];

describe('goal progress', () => {
  it('有关联任务时按完成比例计算', () => {
    const target = goal('g1', { cardIds: ['c1', 'c2', 'c3', 'c4'] });
    expect(goalProgress(target, [target], cards)).toBe(50);
    expect(goalProgressDetail(target, [target], cards).source).toBe('tasks');
    expect(goalProgressDetail(target, [target], cards).completedCount).toBe(2);
  });

  it('无关联任务时汇总子目标平均值', () => {
    const parent = goal('p');
    const childA = goal('a', { parentId: 'p', cardIds: ['c1', 'c3'] });
    const childB = goal('b', { parentId: 'p', manualProgress: 100 });
    expect(goalProgress(parent, [parent, childA, childB], cards)).toBe(75);
    expect(goalProgressDetail(parent, [parent, childA, childB], cards).source).toBe('children');
  });

  it('没有任务和子目标时使用手动进度', () => {
    const target = goal('g', { manualProgress: 42 });
    expect(goalProgress(target, [target], cards)).toBe(42);
    expect(goalProgressDetail(target, [target], cards).source).toBe('manual');
  });

  it('有关联任务时优先于子目标', () => {
    const parent = goal('p', { cardIds: ['c1', 'c2'] });
    const child = goal('c', { parentId: 'p', manualProgress: 100 });
    expect(goalProgress(parent, [parent, child], cards)).toBe(100);
  });

  it('忽略回收站中的关联任务', () => {
    const trashed = { ...card('c9', true), deletedAt: '2026-01-01T00:00:00.000Z' };
    const target = goal('g', { cardIds: ['c1', 'c9'], manualProgress: 5 });
    expect(goalProgress(target, [target], [card('c1', false), trashed])).toBe(0);
  });
});

describe('goal tree helpers', () => {
  const goals = [
    goal('root', { position: 1 }),
    goal('child', { parentId: 'root', position: 0 }),
    goal('grandchild', { parentId: 'child' }),
    goal('other', { position: 0 }),
    goal('orphan', { parentId: 'missing' }),
  ];

  it('只把真实根与孤儿目标作为顶层', () => {
    expect(topLevelGoals(goals).map((item) => item.id)).toEqual(['orphan', 'other', 'root']);
  });

  it('返回全部后代并构造祖先路径', () => {
    expect([...descendantGoalIds('root', goals)].sort()).toEqual(['child', 'grandchild']);
    const path = goalAncestors(goals[2], goals);
    expect(path.map((item) => item.id)).toEqual(['root', 'child', 'grandchild']);
  });
});
