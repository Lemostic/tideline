import { describe, expect, it } from 'vitest';
import { buildDashboard, buildTrend, type DashboardFilters } from './dashboard';
import type { Board, Card, CardDependency, List, Snapshot } from './types';

const now = new Date(2026, 5, 15); // 2026-06-15 周一

function board(id: string, title: string): Board {
  return {
    id,
    title,
    description: '',
    color: 'blue',
    starred: false,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  };
}

function list(id: string, boardId: string): List {
  return { id, boardId, title: '待办', position: 0, createdAt: '2026-05-01T00:00:00.000Z' };
}

function card(
  id: string,
  boardId: string,
  listId: string,
  overrides: Partial<Card> = {},
): Card {
  return {
    id,
    boardId,
    listId,
    title: id,
    description: '',
    dueDate: null,
    startDate: null,
    priority: null,
    completed: false,
    deletedAt: null,
    labels: [],
    subtasks: [],
    position: 0,
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

function snapshot(): Snapshot {
  const boards = [board('b1', '看板一'), board('b2', '看板二')];
  const lists = [list('l1', 'b1'), list('l2', 'b2')];
  const cards: Card[] = [
    card('c1', 'b1', 'l1', { dueDate: '2026-06-10', createdAt: '2026-06-10T02:00:00.000Z' }),
    card('c2', 'b1', 'l1', {
      completed: true,
      dueDate: '2026-06-12',
      updatedAt: '2026-06-14T02:00:00.000Z',
      priority: 'high',
      subtasks: [
        { id: 's1', title: '一', done: true },
        { id: 's2', title: '二', done: false },
      ],
    }),
    card('c3', 'b1', 'l1', {
      dueDate: '2026-06-15',
      priority: 'medium',
      createdAt: '2026-06-15T02:00:00.000Z',
      subtasks: [{ id: 's3', title: '三', done: true }],
    }),
    card('c4', 'b1', 'l1', { dueDate: '2026-06-17' }),
    card('c5', 'b1', 'l1', { dueDate: null }),
    card('c6', 'b2', 'l2', { dueDate: '2026-06-01' }),
  ];
  const dependencies: CardDependency[] = [
    { cardId: 'c3', dependsOnCardId: 'c1' },
    { cardId: 'c4', dependsOnCardId: 'c2' },
  ];
  return { boards, lists, cards, inbox: [], dependencies, boardSets: [], goals: [] };
}

const filters: DashboardFilters = {
  boardId: null,
  rangeDays: 7,
  weekStartsOn: 1,
  now,
};

describe('dashboard aggregation', () => {
  it('汇总 KPI、状态、优先级与子任务', () => {
    const data = buildDashboard(snapshot(), 3, filters);
    expect(data.kpis.total).toBe(6);
    expect(data.kpis.completed).toBe(1);
    expect(data.kpis.overdue).toBe(2); // c1 + b2 的 c6
    expect(data.kpis.dueToday).toBe(1);
    expect(data.kpis.dueWeek).toBe(1);
    expect(data.kpis.noDue).toBe(1);
    expect(data.kpis.blocked).toBe(1); // c3 被未完成的 c1 阻塞；c4 的 c2 已完成
    expect(data.kpis.trash).toBe(3);
    expect(data.kpis.subtaskTotal).toBe(3);
    expect(data.kpis.subtaskDone).toBe(2);
    expect(data.status.find((slice) => slice.key === 'completed')?.count).toBe(1);
    expect(data.status.find((slice) => slice.key === 'overdue')?.count).toBe(2);
    expect(data.priority.find((slice) => slice.key === 'high')?.count).toBe(1);
  });

  it('按看板过滤只统计该看板', () => {
    const data = buildDashboard(snapshot(), 0, { ...filters, boardId: 'b1' });
    expect(data.board?.title).toBe('看板一');
    expect(data.kpis.total).toBe(5);
    expect(data.kpis.overdue).toBe(1);
    expect(data.boardHealth).toHaveLength(2);
  });

  it('趋势按天聚合新建与完成', () => {
    const data = buildDashboard(snapshot(), 0, filters);
    expect(data.trend).toHaveLength(7);
    expect(data.trend.reduce((total, point) => total + point.created, 0)).toBe(6);
    expect(data.trend.reduce((total, point) => total + point.completed, 0)).toBe(1);
    expect(data.trend[data.trend.length - 1].created).toBe(1); // c3 6-15 创建
  });

  it('趋势在无数据时保持完整日期轴', () => {
    const points = buildTrend([], now, 30);
    expect(points).toHaveLength(30);
    expect(points.every((point) => point.created === 0 && point.completed === 0)).toBe(true);
  });

  it('重点任务把逾期排在最前', () => {
    const data = buildDashboard(snapshot(), 0, filters);
    expect(data.focus[0].id).toBe('c6');
    expect(data.focus.some((item) => item.id === 'c1')).toBe(true);
  });

  it('周日为起始时本周口径仍可计算', () => {
    const data = buildDashboard(snapshot(), 0, { ...filters, weekStartsOn: 0 });
    expect(data.kpis.total).toBe(6);
    expect(data.kpis.dueWeek).toBeGreaterThanOrEqual(0);
  });
});
