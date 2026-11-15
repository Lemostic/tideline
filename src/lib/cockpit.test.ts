import { describe, expect, it } from 'vitest';
import { boardLoad, buildHorizon, focusCards, riskSummary } from '@/lib/cockpit';
import type { Card, CardDependency } from '@/lib/types';

const base: Card = {
  id: 'c1',
  boardId: 'b1',
  listId: 'l1',
  parentCardId: null,
  title: '任务',
  description: '',
  dueDate: null,
  startDate: null,
  estimatedMinutes: null,
  actualMinutes: null,
  priority: null,
  completed: false,
  deletedAt: null,
  labels: [],
  position: 0,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function card(patch: Partial<Card>): Card {
  return { ...base, ...patch };
}

describe('cockpit helpers', () => {
  it('按截止日期把任务放进七日航向，范围外与无日期任务不入带', () => {
    const days = buildHorizon(
      [
        card({ id: 'a', dueDate: '2026-11-15', estimatedMinutes: 120 }),
        card({ id: 'b', dueDate: '2026-11-17', estimatedMinutes: 30 }),
        card({ id: 'c', dueDate: '2026-11-30' }),
        card({ id: 'd', dueDate: null }),
        card({ id: 'done', dueDate: '2026-11-15', completed: true }),
      ],
      '2026-11-15',
      7,
    );
    expect(days).toHaveLength(7);
    expect(days[0].isToday).toBe(true);
    expect(days[0].tasks.map((item) => item.id)).toEqual(['a']);
    expect(days[0].minutes).toBe(120);
    expect(days[0].load).toBe(120);
    expect(days[2].tasks.map((item) => item.id)).toEqual(['b']);
    expect(days[2].load).toBe(30);
    expect(days.flatMap((day) => day.tasks.map((item) => item.id))).not.toContain('c');
    expect(days.flatMap((day) => day.tasks.map((item) => item.id))).not.toContain('d');
    expect(days.flatMap((day) => day.tasks.map((item) => item.id))).not.toContain('done');
  });

  it('风险口径互不重叠：逾期优先于阻塞与临期', () => {
    const cards = [
      card({ id: 'late', dueDate: '2026-11-14' }),
      card({ id: 'blocked', dueDate: '2026-11-16' }),
      card({ id: 'soon', dueDate: '2026-11-17' }),
      card({ id: 'free', dueDate: null }),
      card({ id: 'done', dueDate: '2026-11-01', completed: true }),
    ];
    const dependencies: CardDependency[] = [
      { cardId: 'blocked', dependsOnCardId: 'open', relationType: 'blocks' },
    ];
    const withBlocker = [...cards, card({ id: 'open' })];
    const risk = riskSummary(withBlocker, dependencies, '2026-11-15');
    expect(risk.overdue.map((item) => item.id)).toEqual(['late']);
    expect(risk.blocked.map((item) => item.id)).toEqual(['blocked']);
    expect(risk.dueSoon.map((item) => item.id)).toEqual(['soon']);
    expect(risk.unscheduled.map((item) => item.id)).toEqual(['free', 'open']);
    expect(cards.find((item) => item.id === 'done')?.completed).toBe(true);
  });

  it('今日专注按逾期、今天、临期、高优先级排序', () => {
    const focus = focusCards(
      [
        card({ id: 'later', dueDate: '2026-12-01' }),
        card({ id: 'today', dueDate: '2026-11-15' }),
        card({ id: 'late', dueDate: '2026-11-10' }),
        card({ id: 'soon', dueDate: '2026-11-16' }),
        card({ id: 'high', priority: 'high' }),
      ],
      '2026-11-15',
    );
    expect(focus.map((item) => item.id)).toEqual(['late', 'today', 'soon', 'high', 'later']);
  });

  it('看板负载统计总数、完成数与逾期数', () => {
    const loads = boardLoad(
      [
        card({ id: 'a', boardId: 'b1', completed: true }),
        card({ id: 'b', boardId: 'b1', dueDate: '2026-11-10' }),
        card({ id: 'c', boardId: 'b2' }),
      ],
      ['b1', 'b2', 'b3'],
      '2026-11-15',
    );
    expect(loads).toEqual([
      { boardId: 'b1', total: 2, completed: 1, overdue: 1 },
      { boardId: 'b2', total: 1, completed: 0, overdue: 0 },
      { boardId: 'b3', total: 0, completed: 0, overdue: 0 },
    ]);
  });
});
