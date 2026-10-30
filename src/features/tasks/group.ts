/**
 * 我的任务：筛选 / 排序 / 分组的纯函数
 *
 * 日期分桶完全复用 src/lib/date.ts（dueBucket / groupCardsByDue / 截止日期文案），
 * 这里只负责把「看板筛选 + 已完成过滤 + 排序」接到分桶之上，方便单测与复用。
 */
import { dueBucket, groupCardsByDue, type DueBucket, type DueBucketMeta, type WeekStart } from '@/lib/date';
import type { Card } from '@/lib/types';

export type TaskSortKey = 'due-asc' | 'due-desc' | 'created-desc';

export const TASK_SORT_OPTIONS: ReadonlyArray<{ key: TaskSortKey; label: string }> = [
  { key: 'due-asc', label: '截止时间 · 由近到远' },
  { key: 'due-desc', label: '截止时间 · 由远到近' },
  { key: 'created-desc', label: '创建时间 · 由新到旧' },
];

export interface TaskGroup {
  meta: DueBucketMeta;
  cards: Card[];
}

export interface TaskQuery {
  /** null / undefined 表示全部看板 */
  boardId?: string | null;
  /** 默认隐藏已完成，和页面开关一致 */
  showCompleted?: boolean;
  sort?: TaskSortKey;
  /** 便于单测注入固定「今天」 */
  now?: Date;
  /** 每周起始日：1=周一（默认），0=周日 */
  weekStartsOn?: WeekStart;
}

/** 创建时间新→旧；同一毫秒用 id 兜底，保证排序稳定 */
function compareCreatedDesc(a: Card, b: Card): number {
  const byCreatedAt = b.createdAt.localeCompare(a.createdAt);
  return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
}

/** 有日期的排在前面，无日期垫底；同一天再按创建时间 */
function compareDueAsc(a: Card, b: Card): number {
  if (!a.dueDate && !b.dueDate) return compareCreatedDesc(a, b);
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  return compareCreatedDesc(a, b);
}

/** 截止日期远→近，无日期仍然垫底 */
function compareDueDesc(a: Card, b: Card): number {
  if (!a.dueDate && !b.dueDate) return compareCreatedDesc(a, b);
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  if (a.dueDate !== b.dueDate) return b.dueDate.localeCompare(a.dueDate);
  return compareCreatedDesc(a, b);
}

export function compareCards(sort: TaskSortKey): (a: Card, b: Card) => number {
  if (sort === 'due-desc') return compareDueDesc;
  if (sort === 'created-desc') return compareCreatedDesc;
  return compareDueAsc;
}

/** 过滤掉不合当前视图的任务：看板范围 + 是否展示已完成 */
export function filterCards(cards: Card[], query: TaskQuery = {}): Card[] {
  const { boardId = null, showCompleted = false } = query;
  return cards.filter(
    (card) => (showCompleted || !card.completed) && (!boardId || card.boardId === boardId),
  );
}

/**
 * 页面主入口：先筛选，再按截止日期分五桶，最后在桶内按选择的规则排序。
 * 返回顺序固定为 DUE_BUCKETS 的顺序：已逾期 / 今天 / 本周 / 稍后 / 无截止日期。
 */
export function selectTaskGroups(cards: Card[], query: TaskQuery = {}): TaskGroup[] {
  const { sort = 'due-asc', now = new Date(), weekStartsOn = 1 } = query;
  const comparator = compareCards(sort);
  return groupCardsByDue(filterCards(cards, query), now, weekStartsOn).map((group) => ({
    meta: group.meta,
    cards: [...group.cards].sort(comparator),
  }));
}

/** 顶部「N 条逾期」：只统计未完成的，跟随当前看板筛选；与「显示已完成」开关无关 */
export function countOverdue(
  cards: Card[],
  boardId: string | null = null,
  now: Date = new Date(),
): number {
  return cards.filter(
    (card) =>
      !card.completed &&
      (!boardId || card.boardId === boardId) &&
      dueBucket(card.dueDate, now) === 'overdue',
  ).length;
}

/** 截止日期 chip 的视觉语气：逾期红、今天橙、本周青、其它中性 */
export function dueChipClass(bucket: DueBucket): string {
  switch (bucket) {
    case 'overdue':
      return 'chip chip-danger';
    case 'today':
      return 'chip chip-accent';
    case 'week':
      return 'chip chip-soft';
    default:
      return 'chip';
  }
}
