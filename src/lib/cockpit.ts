import { addDaysKey, formatMonthDay, formatWeekday, todayKey } from './date';
import { isBlocked } from './dependencies';
import type { Card, CardDependency } from './types';

export interface CockpitDay {
  key: string;
  weekday: string;
  monthDay: string;
  isToday: boolean;
  tasks: Card[];
  /** 已填写的预估工时合计（分钟） */
  minutes: number;
  /** 负载口径：未估时任务按 45 分钟计，避免图表因缺数据完全塌陷 */
  load: number;
}

/** 把未完成任务按截止日期落到时间带上；范围外的任务不出现。 */
export function buildHorizon(
  cards: Card[],
  startKey: string = todayKey(),
  days = 7,
): CockpitDay[] {
  const buckets = Array.from({ length: days }, (_, index) => {
    const key = addDaysKey(startKey, index);
    return {
      key,
      weekday: formatWeekday(key),
      monthDay: formatMonthDay(key),
      isToday: key === startKey,
      tasks: [] as Card[],
      minutes: 0,
      load: 0,
    };
  });
  const byKey = new Map(buckets.map((day) => [day.key, day]));
  for (const card of cards) {
    if (card.completed || !card.dueDate) continue;
    const day = byKey.get(card.dueDate);
    if (!day) continue;
    day.tasks.push(card);
    day.minutes += card.estimatedMinutes ?? 0;
    day.load += card.estimatedMinutes ?? 45;
  }
  for (const day of buckets) {
    day.tasks.sort(
      (a, b) => Number(b.priority === 'high') - Number(a.priority === 'high'),
    );
  }
  return buckets;
}

export interface RiskSummary {
  overdue: Card[];
  blocked: Card[];
  dueSoon: Card[];
  unscheduled: Card[];
}

/** 风险雷达：逾期、被阻塞、三天内到期与无截止日期四个口径互不重叠。 */
export function riskSummary(
  cards: Card[],
  dependencies: CardDependency[],
  today: string = todayKey(),
): RiskSummary {
  const soonEnd = addDaysKey(today, 2);
  const overdue: Card[] = [];
  const blocked: Card[] = [];
  const dueSoon: Card[] = [];
  const unscheduled: Card[] = [];
  for (const card of cards) {
    if (card.completed) continue;
    if (card.dueDate && card.dueDate < today) {
      overdue.push(card);
      continue;
    }
    if (isBlocked(card.id, dependencies, cards)) {
      blocked.push(card);
      continue;
    }
    if (card.dueDate && card.dueDate <= soonEnd) {
      dueSoon.push(card);
      continue;
    }
    if (!card.dueDate) unscheduled.push(card);
  }
  return { overdue, blocked, dueSoon, unscheduled };
}

/** 今日专注：逾期 → 今天 → 三天内 → 高优先级，最多取 limit 条。 */
export function focusCards(
  cards: Card[],
  today: string = todayKey(),
  limit = 5,
): Card[] {
  const soonEnd = addDaysKey(today, 2);
  const rank = (card: Card): number => {
    if (card.dueDate && card.dueDate < today) return 0;
    if (card.dueDate === today) return 1;
    if (card.dueDate && card.dueDate <= soonEnd) return 2;
    if (card.priority === 'high') return 3;
    return 4;
  };
  return cards
    .filter((card) => !card.completed)
    .slice()
    .sort((a, b) => {
      const delta = rank(a) - rank(b);
      if (delta !== 0) return delta;
      return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
    })
    .slice(0, limit);
}

export interface BoardLoad {
  boardId: string;
  total: number;
  completed: number;
  overdue: number;
}

export function boardLoad(cards: Card[], boardIds: string[], today: string = todayKey()): BoardLoad[] {
  const stats = new Map<string, BoardLoad>(
    boardIds.map((boardId) => [boardId, { boardId, total: 0, completed: 0, overdue: 0 }]),
  );
  for (const card of cards) {
    const stat = stats.get(card.boardId);
    if (!stat) continue;
    stat.total += 1;
    if (card.completed) stat.completed += 1;
    else if (card.dueDate && card.dueDate < today) stat.overdue += 1;
  }
  return Array.from(stats.values());
}
