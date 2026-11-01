/**
 * 仪表盘统计聚合（V0.5.3）。
 *
 * 全部从本地快照派生，不发请求、不写数据库；纯函数方便单测。
 * 完成趋势用 `updatedAt` 近似「完成日期」：任务完成后再编辑会顺延，
 * 这是本地工具在缺少 completedAt 字段时的取舍，页面上会标注口径。
 *
 * BI 视角的四个维度：
 *   - 时间：新建 / 完成趋势，以及按周聚合的吞吐节奏
 *   - 结构：看板、列表、标签的分布与占比
 *   - 风险：逾期、临期、阻塞、无截止日期
 *   - 效率：周期时间（创建→完成）与周转（WIP）
 */
import {
  addDaysKey,
  diffDays,
  dueBucket,
  endOfWeek,
  startOfWeek,
  toDateKey,
  type DueBucket,
  type WeekStart,
} from './date';
import { isBlockingRelation } from './types';
import type { Board, Card, CardDependency, List, Priority, Snapshot } from './types';

export const DASHBOARD_RANGES = [7, 30, 90] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export interface DashboardFilters {
  /** null 表示全部看板 */
  boardId: string | null;
  rangeDays: DashboardRange;
  weekStartsOn: WeekStart;
  now?: Date;
  /** 交叉筛选：在结构维度上点选某一格后，其余图表都按它过滤 */
  crossFilter?: CrossFilter | null;
}

/** 交叉筛选条件：维度 + 分组键 */
export interface CrossFilter {
  dimension: DimensionKey;
  key: string;
}

export type DimensionKey = 'board' | 'list' | 'label';

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
  /** 上一等长区间的新建数，用于环比 */
  createdPrevRange: number;
  /** 上一等长区间的完成数，用于环比 */
  completedPrevRange: number;
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

/** 吞吐节奏：一周一个桶，统计新建 / 完成 / 净增 */
export interface ThroughputPoint {
  /** 桶的周一日期（YYYY-MM-DD） */
  weekStart: string;
  created: number;
  completed: number;
  /** 净增 = 新建 - 完成 */
  net: number;
}

/** 结构维度：一个分组（看板 / 列表 / 标签）的构成 */
export interface DimensionSlice {
  key: string;
  label: string;
  total: number;
  completed: number;
  overdue: number;
  /** 占比 0–1，按任务总数 */
  share: number;
}

/** 效率指标 */
export interface EfficiencyMetrics {
  /** 已完成任务的中位周期天数（创建 → 完成） */
  medianCycleDays: number;
  /** 平均周期天数 */
  averageCycleDays: number;
  /** 近 N 天新建任务的平均天数跨度（仍未完成） */
  avgAgeDays: number;
  /** 积压：已逾期且未完成的任务数 */
  backlog: number;
  /** 本周净增任务数 */
  weeklyNet: number;
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
  /** 时间维度：按周的吞吐节奏 */
  throughput: ThroughputPoint[];
  /** 结构维度：按看板分组 */
  byBoard: DimensionSlice[];
  /** 结构维度：按列表分组 */
  byList: DimensionSlice[];
  /** 结构维度：按标签分组 */
  byLabel: DimensionSlice[];
  /** 效率维度 */
  efficiency: EfficiencyMetrics;
  /** 当前生效的交叉筛选，页面上要显示它可被撤销 */
  crossFilter: CrossFilter | null;
  /** 任务年龄分布：未完成任务按「已经挂了多久」分桶 */
  aging: AgingBucket[];
}

/** 任务年龄分桶：未完成任务已经存在了多久 */
export interface AgingBucket {
  key: 'fresh' | 'week' | 'month' | 'quarter' | 'aged';
  label: string;
  count: number;
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
    // V0.12：只有前置（blocks）关系产生阻塞。
    if (!isBlockingRelation(dependency.relationType)) return false;
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

/**
 * 时间维度：按周聚合的吞吐节奏。
 * 桶从当前周往前推 weeks 个，weekStart 用该周的起始日。
 */
export function buildThroughput(
  cards: Card[],
  now: Date,
  rangeDays: number,
  weekStartsOn: WeekStart,
): ThroughputPoint[] {
  const weeks = Math.max(1, Math.ceil(rangeDays / 7));
  const thisWeek = startOfWeek(now, weekStartsOn);
  const createdByWeek = new Map<string, number>();
  const completedByWeek = new Map<string, number>();

  for (const card of cards) {
    const created = isoDateKey(card.createdAt);
    if (created) createdByWeek.set(created, (createdByWeek.get(created) ?? 0) + 1);
    if (card.completed) {
      const completed = isoDateKey(card.updatedAt);
      if (completed) completedByWeek.set(completed, (completedByWeek.get(completed) ?? 0) + 1);
    }
  }

  const points: ThroughputPoint[] = [];
  for (let index = weeks - 1; index >= 0; index -= 1) {
    const weekStartDate = new Date(thisWeek);
    weekStartDate.setDate(weekStartDate.getDate() - index * 7);
    const weekStart = toDateKey(weekStartDate);
    const weekEnd = addDaysKey(weekStart, 6);
    const created = countIn(createdByWeek, weekStart, weekEnd);
    const completed = countIn(completedByWeek, weekStart, weekEnd);
    points.push({ weekStart, created, completed, net: created - completed });
  }
  return points;
}

function countIn(counts: Map<string, number>, from: string, to: string): number {
  let total = 0;
  for (const [key, count] of counts) {
    if (key >= from && key <= to) total += count;
  }
  return total;
}

/** 任务年龄分桶：未完成任务已经存在了多久（按创建时间算）。 */
export function buildAging(cards: Card[], now: Date): AgingBucket[] {
  const today = toDateKey(now);
  const defs: ReadonlyArray<{ key: AgingBucket['key']; label: string; max: number }> = [
    { key: 'fresh', label: '3 天内', max: 3 },
    { key: 'week', label: '4–7 天', max: 7 },
    { key: 'month', label: '8–30 天', max: 30 },
    { key: 'quarter', label: '31–90 天', max: 90 },
    { key: 'aged', label: '超过 90 天', max: Infinity },
  ];
  const counts = new Map<AgingBucket['key'], number>();
  for (const card of cards) {
    if (card.completed) continue;
    const created = isoDateKey(card.createdAt);
    if (!created) continue;
    const age = Math.max(0, diffDays(created, today));
    const bucket = defs.find((item) => age < item.max) ?? defs[defs.length - 1];
    counts.set(bucket.key, (counts.get(bucket.key) ?? 0) + 1);
  }
  return defs.map((item) => ({ key: item.key, label: item.label, count: counts.get(item.key) ?? 0 }));
}

/**
 * 结构维度：把任务按某个字段分组统计构成。
 * groupBy 返回分组键与显示名；未分组（如没有标签）的任务计入「未分组」。
 */
export function buildDimension(
  cards: Card[],
  now: Date,
  weekStartsOn: WeekStart,
  groupBy: (card: Card) => { key: string; label: string } | null,
): DimensionSlice[] {
  const buckets = new Map<string, DimensionSlice>();
  for (const card of cards) {
    const group = groupBy(card);
    const key = group?.key ?? '__none__';
    const label = group?.label ?? '未分组';
    const current = buckets.get(key) ?? { key, label, total: 0, completed: 0, overdue: 0, share: 0 };
    current.total += 1;
    if (card.completed) current.completed += 1;
    else if (dueBucket(card.dueDate, now, weekStartsOn) === 'overdue') current.overdue += 1;
    buckets.set(key, current);
  }
  const total = cards.length;
  return [...buckets.values()]
    .map((slice) => ({ ...slice, share: total === 0 ? 0 : slice.total / total }))
    .sort((a, b) => b.total - a.total);
}

/** 效率维度：周期时间、任务年龄与积压。 */
export function buildEfficiency(
  cards: Card[],
  now: Date,
  weekStartsOn: WeekStart,
): EfficiencyMetrics {
  const today = toDateKey(now);
  const cycleDays: number[] = [];
  const ages: number[] = [];

  for (const card of cards) {
    const created = isoDateKey(card.createdAt);
    if (!created) continue;
    if (card.completed) {
      const completed = isoDateKey(card.updatedAt);
      if (completed) {
        const days = diffDays(created, completed);
        // 完成时间早于创建时间是脏数据，直接忽略
        if (days >= 0) cycleDays.push(days);
      }
    } else {
      ages.push(Math.max(0, diffDays(created, today)));
    }
  }

  cycleDays.sort((a, b) => a - b);
  const median =
    cycleDays.length === 0
      ? 0
      : cycleDays.length % 2 === 1
        ? cycleDays[(cycleDays.length - 1) / 2]
        : (cycleDays[cycleDays.length / 2 - 1] + cycleDays[cycleDays.length / 2]) / 2;
  const average =
    cycleDays.length === 0
      ? 0
      : cycleDays.reduce((sum, value) => sum + value, 0) / cycleDays.length;
  const avgAge =
    ages.length === 0 ? 0 : ages.reduce((sum, value) => sum + value, 0) / ages.length;

  const thisWeek = startOfWeek(now, weekStartsOn);
  const thisWeekEnd = endOfWeek(now, weekStartsOn);
  const inThisWeek = (key: string) => key >= toDateKey(thisWeek) && key <= toDateKey(thisWeekEnd);
  const createdThisWeek = cards.filter((card) => inThisWeek(isoDateKey(card.createdAt))).length;
  const completedThisWeek = cards.filter(
    (card) => card.completed && inThisWeek(isoDateKey(card.updatedAt)),
  ).length;

  return {
    medianCycleDays: median,
    averageCycleDays: average,
    avgAgeDays: avgAge,
    backlog: cards.filter(
      (card) =>
        !card.completed && dueBucket(card.dueDate, now, weekStartsOn) === 'overdue',
    ).length,
    weeklyNet: createdThisWeek - completedThisWeek,
  };
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

/** 任务所属看板的分组键；看板已删除时归入未分组 */
function cardsBoardKey(card: Card, boardsById: Map<string, Board>): string {
  return boardsById.has(card.boardId) ? card.boardId : '__none__';
}

/** 任务所属列表的分组键；列表已删除时归入未分组 */
function cardsListKey(card: Card, listsById: Map<string, List>): string {
  return listsById.has(card.listId) ? card.listId : '__none__';
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
  const baseCards = boardId
    ? snapshot.cards.filter((card) => card.boardId === boardId)
    : snapshot.cards;

  const listsById = new Map(snapshot.lists.map((list) => [list.id, list]));
  const boardsById = new Map(snapshot.boards.map((board) => [board.id, board]));

  /** 交叉筛选：把任务落到某个维度分组，key 为 '__none__' 表示未分组 */
  const dimensionKeyOf = (card: Card, dimension: DimensionKey): string => {
    if (dimension === 'board') return cardsBoardKey(card, boardsById);
    if (dimension === 'list') return cardsListKey(card, listsById);
    return card.labels[0] ?? '__none__';
  };

  const crossFilter = filters.crossFilter ?? null;
  /** 应用全部交叉筛选条件 */
  const applyCross = (cards: Card[], skip?: DimensionKey): Card[] => {
    if (!crossFilter) return cards;
    if (crossFilter.dimension === skip) return cards;
    return cards.filter(
      (card) => dimensionKeyOf(card, crossFilter.dimension) === crossFilter.key,
    );
  };

  const activeCards = applyCross(baseCards);
  const cardsById = new Map(activeCards.map((card) => [card.id, card]));
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
  // 上一等长区间，用于环比
  const prevStart = addDaysKey(start, -filters.rangeDays);

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
      createdPrevRange: activeCards.filter((card) => {
        const key = isoDateKey(card.createdAt);
        return key >= prevStart && key < start;
      }).length,
      completedPrevRange: completed.filter((card) => {
        const key = isoDateKey(card.updatedAt);
        return key >= prevStart && key < start;
      }).length,
      trash: trashCount,
    },
    trend,
    status,
    priority,
    boardHealth: boardHealth(snapshot, now, filters.weekStartsOn),
    throughput: buildThroughput(activeCards, now, filters.rangeDays, filters.weekStartsOn),
    // 每个维度图保留自己这一维的全貌（否则会被自己筛到只剩一根柱），
    // 同时仍然受其它维度的交叉筛选影响
    byBoard: buildDimension(applyCross(baseCards, 'board'), now, filters.weekStartsOn, (card) => {
      const board = boardsById.get(card.boardId);
      return board ? { key: board.id, label: board.title } : null;
    }),
    byList: buildDimension(applyCross(baseCards, 'list'), now, filters.weekStartsOn, (card) => {
      const list = listsById.get(card.listId);
      return list ? { key: list.id, label: list.title } : null;
    }),
    byLabel: buildDimension(applyCross(baseCards, 'label'), now, filters.weekStartsOn, (card) => {
      const label = card.labels[0];
      return label ? { key: label, label } : null;
    }),
    efficiency: buildEfficiency(activeCards, now, filters.weekStartsOn),
    crossFilter,
    aging: buildAging(activeCards, now),
    focus,
    blockedCards: blockedCards.slice(0, 5),
  };
}
