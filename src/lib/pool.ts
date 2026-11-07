/**
 * 任务池堆积聚合（V0.17）。
 *
 * 「一个任务池」= 统计范围内的全部主任务；每张任务恰好落入一段：
 *   done（已完成）/ overdue（逾期未完成）/ dueSoon（今天或本周到期）/ open（正常推进）
 * 四段之和恒等于池总量，所以柱高就是池子大小，绿色段的占比就是实际进度。
 *
 * 纯函数：只读 Card[]，不发请求、不写库，方便单测。
 */
import { addDaysKey, toDateKey, dueBucket, type WeekStart } from './date';
import type { DimensionKey } from './dashboard';
import type { Card, Priority } from './types';

export const POOL_RANGES = [7, 30, 90] as const;
export type PoolRange = (typeof POOL_RANGES)[number];

export type PoolSegmentKey = 'done' | 'overdue' | 'dueSoon' | 'open';

export const POOL_SEGMENTS: ReadonlyArray<{ key: PoolSegmentKey; label: string }> = [
  { key: 'done', label: '已完成' },
  { key: 'overdue', label: '逾期未完成' },
  { key: 'dueSoon', label: '本周到期' },
  { key: 'open', label: '正常推进' },
];

/** 维度：时间（按创建周）/ 看板 / 列表 / 标签 / 优先级 */
export type PoolDimension = 'week' | 'board' | 'list' | 'label' | 'priority';

export const POOL_DIMENSIONS: ReadonlyArray<{ key: PoolDimension; label: string }> = [
  { key: 'week', label: '按周' },
  { key: 'board', label: '按看板' },
  { key: 'list', label: '按列表' },
  { key: 'label', label: '按标签' },
  { key: 'priority', label: '按优先级' },
];

/** 分组上限：超出部分合并成「其它 N 组」，不静默丢数据 */
export const POOL_MAX_GROUPS = 12;

/** 未完成超过这个天数记为「陈积」 */
export const POOL_STALE_DAYS = 30;

export interface PoolGroup {
  key: string;
  label: string;
  total: number;
  done: number;
  overdue: number;
  dueSoon: number;
  open: number;
  /** 完成率 0–1；空组记 0 */
  completionRate: number;
  /** 合并桶里包含的原始分组数；普通分组为 1 */
  mergedCount: number;
}

export interface PoolBreakdown {
  dimension: PoolDimension;
  groups: PoolGroup[];
  /** 池总览：维度无关，永远是全量池 */
  total: number;
  done: number;
  completionRate: number;
  /** 未完成且已挂了超过 POOL_STALE_DAYS 天 */
  stale: number;
  /** 时间范围是否在这个维度上生效（只有「按周」生效） */
  rangeApplied: boolean;
}

export interface PoolFilters {
  dimension: PoolDimension;
  /** 只作用于「按周」维度 */
  rangeDays: PoolRange;
  weekStartsOn: WeekStart;
  now: Date;
  /** 结构维度分组所需的名称表；缺省时归入未分组 */
  boardTitle?: Map<string, string>;
  listTitle?: Map<string, string>;
  /** 交叉筛选：与页面其余图表共用一套条件 */
  crossFilter?: { dimension: DimensionKey; key: string } | null;
}

const PRIORITY_ORDER: ReadonlyArray<{ key: Priority | 'none'; label: string }> = [
  { key: 'high', label: '高优先级' },
  { key: 'medium', label: '中优先级' },
  { key: 'low', label: '低优先级' },
  { key: 'none', label: '无优先级' },
];

function isoDateKey(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : toDateKey(date);
}

/** 每张任务恰好落入一段 */
export function poolSegment(card: Card, now: Date, weekStartsOn: WeekStart): PoolSegmentKey {
  if (card.completed) return 'done';
  const bucket = dueBucket(card.dueDate, now, weekStartsOn);
  if (bucket === 'overdue') return 'overdue';
  if (bucket === 'today' || bucket === 'week') return 'dueSoon';
  return 'open';
}

function emptyGroup(key: string, label: string): PoolGroup {
  return {
    key,
    label,
    total: 0,
    done: 0,
    overdue: 0,
    dueSoon: 0,
    open: 0,
    completionRate: 0,
    mergedCount: 1,
  };
}

function accumulate(group: PoolGroup, segment: PoolSegmentKey): void {
  group.total += 1;
  group[segment] += 1;
  group.completionRate = group.total === 0 ? 0 : group.done / group.total;
}

/** 某个日期键所在周的起始日（YYYY-MM-DD） */
function weekKeyOf(dateKey: string, weekStartsOn: WeekStart): string {
  if (!dateKey) return '';
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  const diff = (date.getDay() - weekStartsOn + 7) % 7;
  date.setDate(date.getDate() - diff);
  return toDateKey(date);
}

function weekLabel(weekStart: string): string {
  return `${weekStart.slice(5).replace('-', '/')} 周`;
}

/**
 * 「按周」维度：自当前周往前推 rangeDays 对应的周数，补齐空周并按时间升序。
 * 窗口外创建的任务不属于任何一根柱，因此这里的段和只覆盖窗口内新建的池。
 */
function buildWeekGroups(cards: Card[], filters: PoolFilters): PoolGroup[] {
  const weeks = Math.max(1, Math.ceil(filters.rangeDays / 7));
  const thisWeek = weekKeyOf(toDateKey(filters.now), filters.weekStartsOn);
  if (!thisWeek) return [];

  const groups = new Map<string, PoolGroup>();
  const order: string[] = [];
  for (let index = weeks - 1; index >= 0; index -= 1) {
    const key = addDaysKey(thisWeek, -index * 7);
    order.push(key);
    groups.set(key, emptyGroup(key, weekLabel(key)));
  }

  const oldest = order[0];
  for (const card of cards) {
    const week = weekKeyOf(isoDateKey(card.createdAt), filters.weekStartsOn);
    if (!week || week < oldest) continue;
    const group = groups.get(week);
    if (!group) continue;
    accumulate(group, poolSegment(card, filters.now, filters.weekStartsOn));
  }
  return order.map((key) => groups.get(key) as PoolGroup);
}

interface GroupDef {
  key: string;
  label: string;
  sort: number;
}

/** 结构维度：先分组，再按池总量降序（优先级维度保留固定顺序） */
function buildStructuralGroups(
  cards: Card[],
  dimension: Exclude<PoolDimension, 'week'>,
  filters: PoolFilters,
): PoolGroup[] {
  const groups = new Map<string, PoolGroup>();
  const defs = new Map<string, GroupDef>();

  const defOf = (card: Card): GroupDef => {
    if (dimension === 'board') {
      const title = filters.boardTitle?.get(card.boardId);
      return title ? { key: card.boardId, label: title, sort: 0 } : { key: '__none__', label: '未分组', sort: 0 };
    }
    if (dimension === 'list') {
      const title = filters.listTitle?.get(card.listId);
      return title ? { key: card.listId, label: title, sort: 0 } : { key: '__none__', label: '未分组', sort: 0 };
    }
    if (dimension === 'label') {
      // 多标签任务只归入首个标签，与现有仪表盘口径一致
      const label = card.labels[0];
      return label ? { key: label, label, sort: 0 } : { key: '__none__', label: '无标签', sort: 0 };
    }
    const key: Priority | 'none' = card.priority ?? 'none';
    const sort = PRIORITY_ORDER.findIndex((item) => item.key === key);
    return { key, label: PRIORITY_ORDER[sort]?.label ?? '无优先级', sort };
  };

  for (const card of cards) {
    const def = defOf(card);
    defs.set(def.key, def);
    const group = groups.get(def.key) ?? emptyGroup(def.key, def.label);
    accumulate(group, poolSegment(card, filters.now, filters.weekStartsOn));
    groups.set(def.key, group);
  }

  const list = [...groups.values()];
  if (dimension === 'priority') {
    list.sort((a, b) => (defs.get(a.key)?.sort ?? 99) - (defs.get(b.key)?.sort ?? 99));
  } else {
    // 未分组是兜底桶，永远排在最后；其余按池总量降序
    list.sort((a, b) => {
      if (a.key === '__none__') return 1;
      if (b.key === '__none__') return -1;
      return b.total - a.total || a.label.localeCompare(b.label, 'zh');
    });
  }
  return list;
}

/** 分组超过上限时把尾部合并成「其它 N 组」，保持段和守恒 */
export function mergePoolTail(groups: PoolGroup[], max: number = POOL_MAX_GROUPS): PoolGroup[] {
  if (groups.length <= max) return groups;
  const head = groups.slice(0, max - 1);
  const tail = groups.slice(max - 1);
  const merged = emptyGroup('__other__', `其它 ${tail.length} 组`);
  merged.mergedCount = tail.reduce((sum, group) => sum + group.mergedCount, 0);
  for (const group of tail) {
    merged.total += group.total;
    merged.done += group.done;
    merged.overdue += group.overdue;
    merged.dueSoon += group.dueSoon;
    merged.open += group.open;
  }
  merged.completionRate = merged.total === 0 ? 0 : merged.done / merged.total;
  return [...head, merged];
}

/** 交叉筛选只收窄池子本身，与页面其余图表共用一套条件 */
function applyCross(cards: Card[], filters: PoolFilters): Card[] {
  const filter = filters.crossFilter;
  if (!filter) return cards;
  if (filter.dimension === 'board') return cards.filter((card) => card.boardId === filter.key);
  if (filter.dimension === 'list') return cards.filter((card) => card.listId === filter.key);
  return cards.filter((card) => card.labels[0] === filter.key);
}

/** 生成任务池堆积数据。cards 应已按统计范围过滤，且只含主任务。 */
export function buildPoolBreakdown(cards: Card[], filters: PoolFilters): PoolBreakdown {
  const scoped = applyCross(cards, filters);
  const staleBefore = addDaysKey(toDateKey(filters.now), -POOL_STALE_DAYS);

  const raw =
    filters.dimension === 'week'
      ? buildWeekGroups(scoped, filters)
      : buildStructuralGroups(scoped, filters.dimension, filters);

  const groups = mergePoolTail(raw);

  let total = 0;
  let done = 0;
  for (const group of groups) {
    total += group.total;
    done += group.done;
  }

  let stale = 0;
  for (const card of scoped) {
    if (card.completed) continue;
    const created = isoDateKey(card.createdAt);
    if (created && created < staleBefore) stale += 1;
  }

  return {
    dimension: filters.dimension,
    groups,
    total,
    done,
    completionRate: total === 0 ? 0 : done / total,
    stale,
    rangeApplied: filters.dimension === 'week',
  };
}
