/**
 * 使用统计的纯逻辑：时长格式化、区间计算、每日补齐与汇总。
 *
 * 页面只负责渲染与调用 api，所有可测的计算都放在这里，
 * 这样 vitest 不需要渲染组件也能覆盖边界。
 */
import { addDaysKey, eachDateKey, parseDateKey, startOfWeek, toDateKey } from './date';
import type { UsageAppStat, UsageDailyStat, UsageOverview } from './types';

/** 统计区间类型 */
export type UsageRangeKind = 'today' | 'week' | 'last7' | 'custom';

/** 空闲阈值可调下限（秒） */
export const USAGE_IDLE_MIN_SECONDS = 30;

/** 空闲阈值可调上限（秒） */
export const USAGE_IDLE_MAX_SECONDS = 3600;

/**
 * 把秒数格式化成中文可读时长。
 * - 0（或负数、非有限值）→ '0 分钟'
 * - 不足 1 分钟 → '45 秒'
 * - 不足 1 小时 → '10 分钟'
 * - 其余 → '1 小时 1 分钟'（整点只显示小时）
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 分钟';
  const total = Math.floor(seconds);
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分钟`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
}

/**
 * 把 0~1 的占比格式化成百分比字符串，保留 1 位小数。
 * 0（或非法值）→ '0%'；0.2534 → '25.3%'。
 */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  const percent = Math.min(100, share * 100);
  const rounded = Math.round(percent * 10) / 10;
  if (rounded === 0) return '0%';
  return `${rounded.toFixed(1)}%`;
}

/** 占比换算成百分比数值，供进度条宽度使用 */
export function usageSharePercent(share: number): number {
  if (!Number.isFinite(share) || share <= 0) return 0;
  return Math.min(100, Math.round(share * 1000) / 10);
}

/**
 * 计算统计区间（本地时区，YYYY-MM-DD）。
 * - today：今天
 * - week：本周一至今天
 * - last7：今天往前 6 天至今天
 * - custom：使用传入的 from/to，缺省或非法时回退到今天
 */
export function buildUsageRange(
  kind: UsageRangeKind,
  today: Date,
  custom?: { from: string; to: string },
): { from: string; to: string } {
  const todayValue = toDateKey(today);
  if (kind === 'week') {
    return { from: toDateKey(startOfWeek(today, 1)), to: todayValue };
  }
  if (kind === 'last7') {
    return { from: addDaysKey(todayValue, -6), to: todayValue };
  }
  if (kind === 'custom') {
    const from = normalizeRangeKey(custom?.from, todayValue);
    const to = normalizeRangeKey(custom?.to, todayValue);
    return from <= to ? { from, to } : { from: to, to: from };
  }
  return { from: todayValue, to: todayValue };
}

/** 区间标题：同一天只显示一天，否则显示起止日期 */
export function formatUsageRangeLabel(from: string, to: string): string {
  const fromDate = parseDateKey(from);
  const toDate = parseDateKey(to);
  if (!fromDate || !toDate) return '';
  const fromLabel = `${fromDate.getMonth() + 1}月${fromDate.getDate()}日`;
  if (from === to) return fromLabel;
  return `${fromLabel} - ${toDate.getMonth() + 1}月${toDate.getDate()}日`;
}

/**
 * 把区间内缺失的日期补成 0，并按日期升序返回。
 * 区间外的原始数据会被丢弃；重复日期以最后一条为准。
 */
export function fillDailyRange(
  daily: UsageDailyStat[],
  from: string,
  to: string,
): UsageDailyStat[] {
  const days = eachDateKey(from, to);
  if (days.length === 0) return [];
  const map = new Map<string, number>();
  for (const item of daily) {
    if (!item) continue;
    map.set(item.day, item.seconds);
  }
  return days.map((day) => ({ day, seconds: map.get(day) ?? 0 }));
}

/** 汇总结果 */
export interface UsageSummary {
  /** 区间总时长（秒） */
  totalSeconds: number;
  /** 纳入统计的应用数 */
  trackedApps: number;
  /** 有使用时长的应用，按时长降序 */
  topApps: UsageAppStat[];
  /** 有使用时长的天数 */
  activeDays: number;
  /** 单日最长时长（秒） */
  peakSeconds: number;
  /** 单日最长时长的日期 */
  peakDay: string | null;
  /** 日均时长（秒，按区间全部天数计） */
  dailyAverageSeconds: number;
  /** 排名第一的应用占比（0~1） */
  topShare: number;
}

/** 汇总区间总览：过滤零时长应用并按占比排序，同时统计每日峰值 */
export function summarizeUsage(overview: UsageOverview): UsageSummary {
  const topApps = [...(overview.apps ?? [])]
    .filter((item) => item.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds || a.appName.localeCompare(b.appName));
  const daily = [...(overview.daily ?? [])].sort((a, b) => a.day.localeCompare(b.day));
  let peakSeconds = 0;
  let peakDay: string | null = null;
  let activeDays = 0;
  let total = 0;
  for (const item of daily) {
    total += item.seconds;
    if (item.seconds > 0) activeDays += 1;
    if (item.seconds > peakSeconds) {
      peakSeconds = item.seconds;
      peakDay = item.day;
    }
  }
  return {
    totalSeconds: overview.totalSeconds ?? 0,
    trackedApps: overview.trackedApps ?? topApps.length,
    topApps,
    activeDays,
    peakSeconds,
    peakDay,
    dailyAverageSeconds: daily.length > 0 ? Math.round(total / daily.length) : 0,
    topShare: topApps[0]?.share ?? 0,
  };
}

/** 把空闲阈值夹到允许范围内 */
export function clampIdleThreshold(seconds: number): number {
  if (!Number.isFinite(seconds)) return USAGE_IDLE_MIN_SECONDS;
  return Math.min(
    USAGE_IDLE_MAX_SECONDS,
    Math.max(USAGE_IDLE_MIN_SECONDS, Math.round(seconds)),
  );
}

/** 归一化区间端点：非法或缺省时回退到今天 */
function normalizeRangeKey(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const date = parseDateKey(value);
  return date ? toDateKey(date) : fallback;
}
