import { describe, expect, it } from 'vitest';
import {
  POOL_MAX_GROUPS,
  buildPoolBreakdown,
  mergePoolTail,
  poolSegment,
  type PoolFilters,
  type PoolGroup,
} from './pool';
import type { Card } from './types';

const now = new Date(2026, 5, 15); // 2026-06-15 周一

function card(id: string, overrides: Partial<Card> = {}): Card {
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
    completed: false,
    deletedAt: null,
    labels: [],
    parentCardId: null,
    position: 0,
    createdAt: '2026-06-10T02:00:00.000Z',
    updatedAt: '2026-06-10T02:00:00.000Z',
    ...overrides,
  };
}

const baseFilters: PoolFilters = {
  dimension: 'board',
  rangeDays: 30,
  weekStartsOn: 1,
  now,
};

function groupsOf(cards: Card[], filters: Partial<PoolFilters> = {}): PoolGroup[] {
  return buildPoolBreakdown(cards, { ...baseFilters, ...filters }).groups;
}

function segmentSum(groups: PoolGroup[]): number {
  return groups.reduce((sum, g) => sum + g.done + g.overdue + g.dueSoon + g.open, 0);
}

describe('poolSegment', () => {
  it('每张任务恰好落入一段', () => {
    expect(poolSegment(card('a', { completed: true }), now, 1)).toBe('done');
    expect(poolSegment(card('b', { dueDate: '2026-06-10' }), now, 1)).toBe('overdue');
    expect(poolSegment(card('c', { dueDate: '2026-06-15' }), now, 1)).toBe('dueSoon');
    expect(poolSegment(card('d', { dueDate: '2026-06-18' }), now, 1)).toBe('dueSoon');
    expect(poolSegment(card('e', { dueDate: '2026-07-20' }), now, 1)).toBe('open');
    expect(poolSegment(card('f', { dueDate: null }), now, 1)).toBe('open');
    // 已完成任务即使逾期也只算完成，不重复计入逾期
    expect(poolSegment(card('g', { completed: true, dueDate: '2026-01-01' }), now, 1)).toBe('done');
  });
});

describe('buildPoolBreakdown', () => {
  it('段和恒等于池总量，完成率来自 done / total', () => {
    const cards = [
      card('c1', { completed: true }),
      card('c2', { completed: true }),
      card('c3', { dueDate: '2026-06-01' }),
      card('c4', { dueDate: '2026-06-16' }),
      card('c5'),
    ];
    const data = buildPoolBreakdown(cards, baseFilters);
    expect(data.total).toBe(5);
    expect(data.done).toBe(2);
    expect(segmentSum(data.groups)).toBe(data.total);
    expect(data.completionRate).toBeCloseTo(0.4, 5);
  });

  it('按看板分组，板块按总量降序，缺名的看板归入未分组', () => {
    const cards = [
      card('a', { boardId: 'b1' }),
      card('b', { boardId: 'b1' }),
      card('c', { boardId: 'b2', completed: true }),
      card('d', { boardId: 'gone' }),
    ];
    const groups = groupsOf(cards, {
      dimension: 'board',
      boardTitle: new Map([
        ['b1', '看板一'],
        ['b2', '看板二'],
      ]),
    });
    // 总量降序；并列时「未分组」作为兜底桶排最后
    expect(groups.map((group) => group.label)).toEqual(['看板一', '看板二', '未分组']);
    expect(groups[0].total).toBe(2);
    expect(segmentSum(groups)).toBe(4);
  });

  it('优先级维度保持固定顺序：高 → 中 → 低 → 无', () => {
    const cards = [
      card('a'),
      card('b', { priority: 'low' }),
      card('c', { priority: 'high' }),
      card('d', { priority: 'medium' }),
    ];
    const groups = groupsOf(cards, { dimension: 'priority' });
    expect(groups.map((group) => group.key)).toEqual(['high', 'medium', 'low', 'none']);
  });

  it('按周维度补齐空周并按时间升序', () => {
    const cards = [
      card('this', { createdAt: '2026-06-15T02:00:00.000Z' }),
      card('threeWeeksAgo', { createdAt: '2026-05-28T02:00:00.000Z' }),
    ];
    const groups = groupsOf(cards, { dimension: 'week', rangeDays: 30 });
    // 30 天 → 5 个周桶，最早的在前
    expect(groups).toHaveLength(5);
    expect(groups[0].key).toBe('2026-05-18');
    expect(groups[groups.length - 1].key).toBe('2026-06-15');
    // 空周保留 0 高度，避免时间轴断裂
    expect(groups.filter((group) => group.total === 0).length).toBe(3);
    expect(groups.reduce((sum, group) => sum + group.total, 0)).toBe(2);
  });

  it('按周维度忽略窗口外创建的任务', () => {
    const cards = [card('old', { createdAt: '2026-01-01T02:00:00.000Z' })];
    const data = buildPoolBreakdown(cards, { ...baseFilters, dimension: 'week', rangeDays: 7 });
    expect(data.total).toBe(0);
    expect(data.groups).toHaveLength(1);
    expect(data.rangeApplied).toBe(true);
  });

  it('结构维度不受时间范围影响，全量入池', () => {
    const cards = [card('old', { createdAt: '2025-01-01T02:00:00.000Z' })];
    const data = buildPoolBreakdown(cards, { ...baseFilters, rangeDays: 7 });
    expect(data.total).toBe(1);
    expect(data.rangeApplied).toBe(false);
  });

  it('分组超过上限时合并尾部且段和守恒', () => {
    const cards = Array.from({ length: POOL_MAX_GROUPS + 5 }, (_, index) =>
      card(`c${index}`, {
        labels: [`标签${String(index).padStart(2, '0')}`],
        completed: index % 3 === 0,
      }),
    );
    const groups = groupsOf(cards, { dimension: 'label' });
    expect(groups).toHaveLength(POOL_MAX_GROUPS);
    expect(groups[groups.length - 1].key).toBe('__other__');
    expect(groups[groups.length - 1].mergedCount).toBe(6);
    expect(segmentSum(groups)).toBe(cards.length);
  });

  it('陈积任务只统计未完成且超过 30 天', () => {
    const cards = [
      card('old', { createdAt: '2026-04-01T02:00:00.000Z' }),
      card('fresh', { createdAt: '2026-06-14T02:00:00.000Z' }),
      card('doneOld', { createdAt: '2026-01-01T02:00:00.000Z', completed: true }),
    ];
    const data = buildPoolBreakdown(cards, baseFilters);
    expect(data.stale).toBe(1);
  });

  it('交叉筛选收窄池子', () => {
    const cards = [
      card('a', { boardId: 'b1' }),
      card('b', { boardId: 'b2' }),
    ];
    const data = buildPoolBreakdown(cards, {
      ...baseFilters,
      crossFilter: { dimension: 'board', key: 'b2' },
    });
    expect(data.total).toBe(1);
    expect(data.groups).toHaveLength(1);
  });

  it('空池不除零', () => {
    const data = buildPoolBreakdown([], baseFilters);
    expect(data.total).toBe(0);
    expect(data.completionRate).toBe(0);
    expect(data.groups).toEqual([]);
  });
});

describe('mergePoolTail', () => {
  it('未超限时原样返回', () => {
    const groups: PoolGroup[] = [
      {
        key: 'k',
        label: 'K',
        total: 1,
        done: 0,
        overdue: 0,
        dueSoon: 0,
        open: 1,
        completionRate: 0,
        mergedCount: 1,
      },
    ];
    expect(mergePoolTail(groups, 12)).toEqual(groups);
  });
});
