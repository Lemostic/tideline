/**
 * 日期工具：全部按「本地时区」处理纯日期（YYYY-MM-DD），避免时区漂移。
 * 我的任务分组、看板卡片角标、收件箱相对时间共用这里。
 */
import type { Card } from './types';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayKey(now: Date = new Date()): string {
  return toDateKey(now);
}

/** 解析 YYYY-MM-DD 为本地零点的 Date，非法输入返回 null */
export function parseDateKey(key: string | null | undefined): Date | null {
  if (!key) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateCN(dateKey: string | null): string {
  const date = parseDateKey(dateKey);
  if (!date) return '无截止日期';
  return `${date.getFullYear()}/${`${date.getMonth() + 1}`.padStart(2, '0')}/${`${date.getDate()}`.padStart(2, '0')}`;
}

export function formatMonthDay(dateKey: string): string {
  const date = parseDateKey(dateKey);
  if (!date) return '';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatWeekday(dateKey: string): string {
  const date = parseDateKey(dateKey);
  return date ? WEEKDAYS[date.getDay()] : '';
}

/** 两个日期相差的整天数（b - a），用于「逾期 N 天」 */
export function diffDays(fromKey: string, toKey: string): number {
  const from = parseDateKey(fromKey);
  const to = parseDateKey(toKey);
  if (!from || !to) return 0;
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/** 周一为一周起点 */
export function startOfWeek(now: Date = new Date()): Date {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = date.getDay(); // 0 = 周日
  const offset = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - offset);
  return date;
}

/** 本周周日（含） */
export function endOfWeek(now: Date = new Date()): Date {
  const start = startOfWeek(now);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return end;
}

export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';

export interface DueBucketMeta {
  key: DueBucket;
  label: string;
  tone: 'danger' | 'warn' | 'normal' | 'muted';
}

export const DUE_BUCKETS: ReadonlyArray<DueBucketMeta> = [
  { key: 'overdue', label: '已逾期', tone: 'danger' },
  { key: 'today', label: '今天到期', tone: 'warn' },
  { key: 'week', label: '本周到期', tone: 'normal' },
  { key: 'later', label: '稍后到期', tone: 'normal' },
  { key: 'none', label: '无截止日期', tone: 'muted' },
];

export function dueBucket(dueDate: string | null, now: Date = new Date()): DueBucket {
  if (!dueDate) return 'none';
  const due = parseDateKey(dueDate);
  if (!due) return 'none';
  const today = toDateKey(now);
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  const weekEnd = endOfWeek(now);
  if (due <= weekEnd) return 'week';
  return 'later';
}

export function groupCardsByDue(
  cards: Card[],
  now: Date = new Date(),
): Array<{ meta: DueBucketMeta; cards: Card[] }> {
  const buckets = new Map<DueBucket, Card[]>();
  for (const meta of DUE_BUCKETS) buckets.set(meta.key, []);
  for (const card of cards) {
    buckets.get(dueBucket(card.dueDate, now))!.push(card);
  }
  return DUE_BUCKETS.map((meta) => {
    const list = buckets.get(meta.key)!;
    list.sort(compareByDueDate);
    return { meta, cards: list };
  });
}

/** 截止日期升序；无截止日期排最后；同日按创建时间 */
export function compareByDueDate(a: Card, b: Card): number {
  if (a.dueDate === b.dueDate) return a.createdAt.localeCompare(b.createdAt);
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  return a.dueDate.localeCompare(b.dueDate);
}

/** 卡片角标的截止日期文案：已逾期 / 今天 / 明天 / 10月28日 */
export function formatDueLabel(dueDate: string | null, now: Date = new Date()): string {
  const due = parseDateKey(dueDate);
  if (!due) return '';
  const today = toDateKey(now);
  const diff = diffDays(today, dueDate!);
  if (diff < 0) return `逾期 ${-diff} 天`;
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (due.getFullYear() === now.getFullYear()) {
    return `${due.getMonth() + 1}月${due.getDate()}日`;
  }
  return formatDateCN(dueDate);
}

/** 收件箱、模板等处的相对时间 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = now.getTime() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return formatDateCN(toDateKey(date));
}

/** 今天 / 本周的温馨提示，用于我的任务页头部 */
export function todaySummary(now: Date = new Date()): string {
  return `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 ${WEEKDAYS[now.getDay()]}`;
}

/** 在纯日期上加减天数，返回新的 YYYY-MM-DD（甘特视图拖拽 / 排期用） */
export function addDaysKey(dateKey: string, days: number): string {
  const date = parseDateKey(dateKey);
  if (!date) return dateKey;
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

/** 生成 [startKey, endKey] 之间（含两端）的日期列表，最多 limit 天，防止异常数据撑爆页面 */
export function eachDateKey(
  startKey: string,
  endKey: string,
  limit = 400,
): string[] {
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  if (!start || !end || end < start) return [];
  const result: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end && result.length < limit) {
    result.push(toDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

