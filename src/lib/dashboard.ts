/**
 * 仪表盘统计聚合（V0.5.3）。
 *
 * 全部从本地快照派生，不发请求、不写数据库；纯函数方便单测。
 * 完成趋势用 `updatedAt` 近似「完成日期」：任务完成后再编辑会顺延，
 * 这是本地工具在缺少 completedAt 字段时的取舍，页面上会标注口径。
 */
import { addDaysKey, dueBucket, toDateKey, type DueBucket, type WeekStart } from './date';
import type { Board, Card, CardDependency, Priority, Snapshot } from './types';

export const DASHBOARD_RANGES = [7, 30, 90] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export interface DashboardFilters {
  /** null 表示全部看板 */
  boardId: string | null;
  rangeDays: DashboardRange;
  weekStartsOn: WeekStart;
  now?: Date;
}

export interface DashboardKpis {
  total: number;
  completed: number;
  completionRate: number;
  overdue: number;
  dueToday: number;
  dueWeek: number;
  noDue: number;
  blocked: number;
  subtaskTotal: number;
  subtaskDone: number;
  createdInRange: number;
  completedInRange: number;
  trash: number;
}

export interface TrendPoint {
  date: string;
  created: number;
  completed: number;
}

export interface StatusSlice {
  key: 'completed' | DueBucket;
  label: string;
  count: number;
}

export interface PrioritySlice {
  key: Priority | 'none';
  label: string;
  count: number;
}

export interface BoardHealth {
  board: Board;
  total: number;
  completed: number;
  overdue: number;
  completionRate: number;
}

export interface DashboardData {
  board: Board | null;
  kpis: DashboardKpis;
  trend: TrendPoint[];
  status: StatusSlice[];
  priority: PrioritySlice[];
  boardHealth: BoardHealth[];
  focus: Card[];
  blockedCards: Card[];
}

const STATUS_LABELS: Record<DueBucket, string> = {
  overdue: '已逾期',
  today: '今天到期',
  week: '本周到期',
  later: '稍后',
  none: '无截止日期',
};

const PRIORITY_META: ReadonlyArray<{ key: Priority | 'none'; label: string }> = [
  { key: 'high', label: '高优先级' },
  { key: 'medium', label: '中优先级' },
  { key: 'low', label: '低优先级' },
  { key: 'none', label: '无优先级' },
];

function isoDateKey(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : toDateKey(date);
}

function isBlocked(card: Card, cardsById: Map<string, Card>, dependencies: CardDependency[]): boolean {
  return dependencies.some((dependency) => {
    if (dependency.cardId !== card.id) return false;
    const blocker = cardsById.get(dependency.dependsOnCardId);
    return Boolean(blocker && !blocker.completed);
  });
}

/** 近 N 天新建 / 完成趋势（完成按最后更新时间近似）。 */
export function buildTrend(
  cards: Card[],
  now: Date,
  rangeDays: DashboardRange,
): TrendPoint[] {
  const today = toDateKey(now);
  const start = addDaysKey(today, -(rangeDays - 1));
  const createdByDay = new Map<string, number>();
  const completedByDay = new Map<string, number>();
  for (const card of cards) {
    const created = isoDateKey(card.createdAt);
    if (created >= start && created <= today) {
      createdByDay.set(created, (createdByDay.get(created) ?? 0) + 1);
    }
    if (card.completed) {
      const completed = isoDateKey(card.updatedAt);
      if (completed >= start && completed <= today) {
        completedByDay.set(completed, (completedByDay.get(completed) ?? 0) + 1);
      }
    }
  }

  const points: TrendPoint[] = [];
  for (let index = 0; index < rangeDays; index += 1) {
    const date = addDaysKey(start, index);
    points.push({
      date,
      created: createdByDay.get(date) ?? 0,
      completed: completedByDay.get(date) ?? 0,
    });
  }
  return points;
}

function boardHealth(snapshot: Snapshot, now: Date, weekStartsOn: WeekStart): BoardHealth[] {
  return snapshot.boards.map((board) => {
    const cards = snapshot.cards.filter((card) => card.boardId === board.id);
    const completed = cards.filter((card) => card.completed).length;
    const overdue = cards.filter(
      (card) => !card.completed && dueBucket(card.dueDate, now, weekStartsOn) === 'overdue',
    ).length;
    return {
      board,
      total: cards.length,
      completed,
      overdue,
      completionRate: cards.length === 0 ? 0 : completed / cards.length,
    };
  });
}

/** 生成仪表盘全部派生数据。 */
export function buildDashboard(
  snapshot: Snapshot,
  trashCount: number,
  filters: DashboardFilters,
): DashboardData {
  const now = filters.now ?? new Date();
  const selectedBoard = filters.boardId
    ? snapshot.boards.find((board) => board.id === filters.boardId) ?? null
    : null;
  const boardId = selectedBoard?.id ?? null;
  const cards = boardId
    ? snapshot.cards.filter((card) => card.boardId === boardId)
    : snapshot.cards;
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const activeCards = cards;
  const completed = activeCards.filter((card) => card.completed);
  const uncompleted = activeCards.filter((card) => !card.completed);

  const overdue = uncompleted.filter(
    (card) => dueBucket(card.dueDate, now, filters.weekStartsOn) === 'overdue',
  );
  const dueToday = uncompleted.filter(
    (card) => dueBucket(card.dueDate, now, filters.weekStartsOn) === 'today',
  );
  const dueWeek = uncompleted.filter(
    (card) => dueBucket(card.dueDate, now, filters.weekStartsOn) === 'week',
  );
  const subtaskTotal = activeCards.reduce((total, card) => total + card.subtasks.length, 0);
  const subtaskDone = activeCards.reduce(
    (total, card) => total + card.subtasks.filter((subtask) => subtask.done).length,
    0,
  );
  const blockedCards = uncompleted.filter((card) => isBlocked(card, cardsById, snapshot.dependencies));
  const trend = buildTrend(activeCards, now, filters.rangeDays);
  const today = toDateKey(now);
  const start = addDaysKey(today, -(filters.rangeDays - 1));

  const statusCounts = new Map<string, number>();
  for (const card of activeCards) {
    if (card.completed) {
      statusCounts.set('completed', (statusCounts.get('completed') ?? 0) + 1);
    } else {
      const bucket = dueBucket(card.dueDate, now, filters.weekStartsOn);
      statusCounts.set(bucket, (statusCounts.get(bucket) ?? 0) + 1);
    }
  }
  const status: StatusSlice[] = [
    { key: 'completed', label: '已完成', count: statusCounts.get('completed') ?? 0 },
    ...(
      ['overdue', 'today', 'week', 'later', 'none'] as DueBucket[]
    ).map((key) => ({
      key,
      label: STATUS_LABELS[key],
      count: statusCounts.get(key) ?? 0,
    })),
  ];

  const priorityCounts = new Map<string, number>();
  for (const card of activeCards) {
    const key = card.priority ?? 'none';
    priorityCounts.set(key, (priorityCounts.get(key) ?? 0) + 1);
  }
  const priority: PrioritySlice[] = PRIORITY_META.map((item) => ({
    ...item,
    count: priorityCounts.get(item.key) ?? 0,
  }));

  const focus = [...uncompleted]
    .filter((card) => card.dueDate !== null)
    .sort((a, b) => {
      const aBucket = dueBucket(a.dueDate, now, filters.weekStartsOn);
      const bBucket = dueBucket(b.dueDate, now, filters.weekStartsOn);
      if (aBucket === 'overdue' && bBucket !== 'overdue') return -1;
      if (bBucket === 'overdue' && aBucket !== 'overdue') return 1;
      return (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
    })
    .slice(0, 6);

  return {
    board: selectedBoard,
    kpis: {
      total: activeCards.length,
      completed: completed.length,
      completionRate: activeCards.length === 0 ? 0 : completed.length / activeCards.length,
      overdue: overdue.length,
      dueToday: dueToday.length,
      dueWeek: dueWeek.length,
      noDue: uncompleted.filter((card) => !card.dueDate).length,
      blocked: blockedCards.length,
      subtaskTotal,
      subtaskDone,
      createdInRange: activeCards.filter((card) => {
        const key = isoDateKey(card.createdAt);
        return key >= start && key <= today;
      }).length,
      completedInRange: completed.filter((card) => {
        const key = isoDateKey(card.updatedAt);
        return key >= start && key <= today;
      }).length,
      trash: trashCount,
    },
    trend,
    status,
    priority,
    boardHealth: boardHealth(snapshot, now, filters.weekStartsOn),
    focus,
    blockedCards: blockedCards.slice(0, 5),
  };
}
