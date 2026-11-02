import { describe, expect, it } from 'vitest';
import {
  buildAging,
  buildDashboard,
  buildDimension,
  buildEfficiency,
  buildThroughput,
  buildTrend,
  type DashboardFilters,
} from './dashboard';
import type { Board, Card, CardDependency, List, Snapshot } from './types';
import { rootCards } from './taskTree';

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
  return { id, boardId, title: '待办', color: 'slate', wipLimit: null, position: 0, createdAt: '2026-05-01T00:00:00.000Z' };
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
    estimatedMinutes: null,
    actualMinutes: null,
    priority: null,
    completed: false,
    deletedAt: null,
    labels: [],
    parentCardId: null,
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
    }),
    card('c3', 'b1', 'l1', {
      dueDate: '2026-06-15',
      priority: 'medium',
      createdAt: '2026-06-15T02:00:00.000Z',
    }),
    card('c4', 'b1', 'l1', { dueDate: '2026-06-17' }),
    card('c5', 'b1', 'l1', { dueDate: null }),
    card('c6', 'b2', 'l2', { dueDate: '2026-06-01' }),
    // V0.14.0：子任务是真实卡片，只进入子任务完成率，不计入任务 KPI。
    card('c2s1', 'b1', 'l1', { parentCardId: 'c2', completed: true }),
    card('c2s2', 'b1', 'l1', { parentCardId: 'c2' }),
    card('c3s1', 'b1', 'l1', { parentCardId: 'c3', completed: true }),
  ];
  const dependencies: CardDependency[] = [
    { cardId: 'c3', dependsOnCardId: 'c1' },
    { cardId: 'c4', dependsOnCardId: 'c2' },
  ];
  return { boards, lists, cards, inbox: [], dependencies, boardSets: [], goals: [], teamMembers: [], overtimeRecords: [], performanceRecords: [], memberTenures: [], projects: [], projectMetaFields: [], projectRoles: [], recurrences: [], automationRules: [], customFields: [], cardFieldValues: [], savedViews: [] };
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

describe('BI 维度聚合', () => {
  it('吞吐节奏按周分桶，净增 = 新建 - 完成', () => {
    const points = buildThroughput(rootCards(snapshot().cards), now, 30, 1);
    expect(points).toHaveLength(5);
    const totalCreated = points.reduce((sum, point) => sum + point.created, 0);
    const totalCompleted = points.reduce((sum, point) => sum + point.completed, 0);
    expect(totalCreated).toBe(6);
    expect(totalCompleted).toBe(1);
    expect(points[points.length - 1].net).toBe(
      points[points.length - 1].created - points[points.length - 1].completed,
    );
  });

  it('结构维度按分组统计总数、已完成与占比', () => {
    const slices = buildDimension(rootCards(snapshot().cards), now, 1, (card) =>
      card.boardId === 'b1' ? { key: 'b1', label: '看板一' } : { key: 'b2', label: '看板二' },
    );
    expect(slices[0].key).toBe('b1');
    expect(slices[0].total).toBe(5);
    expect(slices[0].completed).toBe(1);
    expect(slices[0].overdue).toBe(1);
    expect(Math.round(slices[0].share * 100) / 100).toBeCloseTo(5 / 6, 2);
  });

  it('效率指标给出中位周期、积压与本周净增', () => {
    const metrics = buildEfficiency(rootCards(snapshot().cards), now, 1);
    // c2 于 6-10 创建、6-14 完成，周期 4 天
    expect(metrics.medianCycleDays).toBe(4);
    expect(metrics.averageCycleDays).toBe(4);
    expect(metrics.backlog).toBe(2); // c1 + c6
  });

  it('任务年龄分桶只统计未完成任务', () => {
    const buckets = buildAging(rootCards(snapshot().cards), now);
    const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    // 5 个未完成任务
    expect(total).toBe(5);
    expect(buckets.find((bucket) => bucket.key === 'aged')?.count).toBe(0);
  });

  it('交叉筛选把其余维度一起收窄', () => {
    const data = buildDashboard(snapshot(), 0, {
      ...filters,
      crossFilter: { dimension: 'board', key: 'b2' },
    });
    expect(data.kpis.total).toBe(1);
    expect(data.crossFilter?.key).toBe('b2');
    // 被筛的那一维保留全貌，方便换选；其它维度被收窄
    expect(data.byBoard).toHaveLength(2);
    expect(data.byList.every((slice) => slice.key === 'l2')).toBe(true);
  });

  it('不筛选时各维度覆盖全部任务', () => {
    const data = buildDashboard(snapshot(), 0, filters);
    expect(data.byBoard.reduce((sum, slice) => sum + slice.total, 0)).toBe(6);
    expect(data.crossFilter).toBeNull();
  });
});
