import { describe, expect, it } from 'vitest';
import type { Card } from '@/lib/types';
import { countOverdue, dueChipClass, selectTaskGroups } from './group';

/** 固定「今天」为 2026-10-30（周五），本周从 10-26 到 11-01 */
const NOW = new Date(2026, 9, 30, 10, 0, 0);

function makeCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    boardId: 'board-1',
    listId: 'list-1',
    title: `任务 ${id}`,
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
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

/** 覆盖五个桶的样板数据 */
function sampleCards(): Card[] {
  return [
    makeCard('a-overdue', { dueDate: '2026-10-29' }),
    makeCard('b-today', { dueDate: '2026-10-30' }),
    makeCard('c-week-sat', { dueDate: '2026-10-31' }),
    makeCard('d-week-sun', { dueDate: '2026-11-01' }),
    makeCard('e-later', { dueDate: '2026-11-05' }),
    makeCard('f-none', { dueDate: null }),
  ];
}

describe('selectTaskGroups', () => {
  it('按 DUE_BUCKETS 的固定顺序返回五列，卡片落到正确的桶', () => {
    const groups = selectTaskGroups(sampleCards(), { now: NOW });

    expect(groups.map((group) => group.meta.key)).toEqual([
      'overdue',
      'today',
      'week',
      'later',
      'none',
    ]);
    expect(groups.map((group) => group.meta.label)).toEqual([
      '已逾期',
      '今天到期',
      '本周到期',
      '稍后到期',
      '无截止日期',
    ]);
    expect(groups.map((group) => group.cards.map((card) => card.id))).toEqual([
      ['a-overdue'],
      ['b-today'],
      ['c-week-sat', 'd-week-sun'],
      ['e-later'],
      ['f-none'],
    ]);
  });

  it('没有任何任务时仍返回五个空分组', () => {
    const groups = selectTaskGroups([], { now: NOW });
    expect(groups).toHaveLength(5);
    expect(groups.every((group) => group.cards.length === 0)).toBe(true);
  });

  it('默认隐藏已完成任务，打开开关后重新出现', () => {
    const cards = [
      makeCard('done', { dueDate: '2026-10-30', completed: true }),
      makeCard('todo', { dueDate: '2026-10-30' }),
    ];

    const hidden = selectTaskGroups(cards, { now: NOW });
    expect(hidden.find((group) => group.meta.key === 'today')?.cards.map((c) => c.id)).toEqual([
      'todo',
    ]);

    const shown = selectTaskGroups(cards, { now: NOW, showCompleted: true });
    expect(shown.find((group) => group.meta.key === 'today')?.cards.map((c) => c.id)).toHaveLength(2);
  });

  it('按看板筛选，null 表示全部看板', () => {
    const cards = [
      makeCard('board-1-card', { boardId: 'board-1', dueDate: '2026-10-30' }),
      makeCard('board-2-card', { boardId: 'board-2', dueDate: '2026-10-30' }),
    ];

    const all = selectTaskGroups(cards, { now: NOW, boardId: null });
    expect(all.find((group) => group.meta.key === 'today')?.cards).toHaveLength(2);

    const onlySecond = selectTaskGroups(cards, { now: NOW, boardId: 'board-2' });
    expect(onlySecond.find((group) => group.meta.key === 'today')?.cards.map((c) => c.id)).toEqual([
      'board-2-card',
    ]);
  });

  it('截止时间升序：同一列内由近到远', () => {
    const groups = selectTaskGroups(sampleCards(), { now: NOW, sort: 'due-asc' });
    const week = groups.find((group) => group.meta.key === 'week');
    expect(week?.cards.map((card) => card.dueDate)).toEqual(['2026-10-31', '2026-11-01']);
  });

  it('截止时间降序：同一列内由远到近，无日期仍然垫底', () => {
    const cards = [
      makeCard('none-1', { dueDate: null }),
      makeCard('later-1', { dueDate: '2026-11-20' }),
      makeCard('later-2', { dueDate: '2026-11-05' }),
    ];

    const groups = selectTaskGroups(cards, { now: NOW, sort: 'due-desc' });
    expect(groups.find((group) => group.meta.key === 'later')?.cards.map((c) => c.id)).toEqual([
      'later-1',
      'later-2',
    ]);
    expect(groups.find((group) => group.meta.key === 'none')?.cards.map((c) => c.id)).toEqual([
      'none-1',
    ]);
  });

  it('创建时间排序：由新到旧', () => {
    const cards = [
      makeCard('old', { dueDate: '2026-10-30', createdAt: '2026-10-02T09:00:00.000Z' }),
      makeCard('newest', { dueDate: '2026-10-30', createdAt: '2026-10-20T09:00:00.000Z' }),
      makeCard('middle', { dueDate: '2026-10-30', createdAt: '2026-10-11T09:00:00.000Z' }),
    ];

    const groups = selectTaskGroups(cards, { now: NOW, sort: 'created-desc' });
    expect(groups.find((group) => group.meta.key === 'today')?.cards.map((c) => c.id)).toEqual([
      'newest',
      'middle',
      'old',
    ]);
  });

  it('无截止日期列按创建时间由新到旧，且不依赖 dueDate 排序', () => {
    const cards = [
      makeCard('none-old', { createdAt: '2026-09-01T09:00:00.000Z' }),
      makeCard('none-new', { createdAt: '2026-10-21T09:00:00.000Z' }),
    ];

    for (const sort of ['due-asc', 'due-desc', 'created-desc'] as const) {
      const groups = selectTaskGroups(cards, { now: NOW, sort });
      expect(groups.find((group) => group.meta.key === 'none')?.cards.map((c) => c.id)).toEqual([
        'none-new',
        'none-old',
      ]);
    }
  });

  it('不修改传入的卡片数组', () => {
    const cards = sampleCards();
    const before = cards.map((card) => card.id);
    selectTaskGroups(cards, { now: NOW, sort: 'due-desc' });
    expect(cards.map((card) => card.id)).toEqual(before);
  });
});

describe('countOverdue', () => {
  it('只统计未完成的逾期任务', () => {
    const cards = [
      makeCard('overdue', { dueDate: '2026-10-29' }),
      makeCard('overdue-done', { dueDate: '2026-10-29', completed: true }),
      makeCard('today', { dueDate: '2026-10-30' }),
    ];
    expect(countOverdue(cards, null, NOW)).toBe(1);
  });

  it('跟随看板筛选范围', () => {
    const cards = [
      makeCard('board-1-overdue', { boardId: 'board-1', dueDate: '2026-10-20' }),
      makeCard('board-2-overdue', { boardId: 'board-2', dueDate: '2026-10-20' }),
    ];
    expect(countOverdue(cards, null, NOW)).toBe(2);
    expect(countOverdue(cards, 'board-2', NOW)).toBe(1);
  });
});

describe('dueChipClass', () => {
  it('逾期红、今天橙、本周青，其余中性', () => {
    expect(dueChipClass('overdue')).toBe('chip chip-danger');
    expect(dueChipClass('today')).toBe('chip chip-accent');
    expect(dueChipClass('week')).toBe('chip chip-soft');
    expect(dueChipClass('later')).toBe('chip');
    expect(dueChipClass('none')).toBe('chip');
  });
});
