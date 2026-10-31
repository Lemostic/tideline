import { describe, expect, it } from 'vitest';
import {
  buildUsageRange,
  clampIdleThreshold,
  fillDailyRange,
  formatDuration,
  formatShare,
  formatUsageRangeLabel,
  summarizeUsage,
  usageSharePercent,
  USAGE_IDLE_MAX_SECONDS,
  USAGE_IDLE_MIN_SECONDS,
} from './usage';
import type { UsageAppStat, UsageDailyStat, UsageOverview } from './types';

describe('formatDuration', () => {
  it('零时长显示 0 分钟', () => {
    expect(formatDuration(0)).toBe('0 分钟');
  });

  it('不足一分钟按秒显示', () => {
    expect(formatDuration(45)).toBe('45 秒');
    expect(formatDuration(59)).toBe('59 秒');
  });

  it('不足一小时按分钟显示', () => {
    expect(formatDuration(60)).toBe('1 分钟');
    expect(formatDuration(600)).toBe('10 分钟');
    expect(formatDuration(3599)).toBe('59 分钟');
  });

  it('满一小时显示小时', () => {
    expect(formatDuration(3600)).toBe('1 小时');
    expect(formatDuration(7200)).toBe('2 小时');
  });

  it('小时带分钟', () => {
    expect(formatDuration(3661)).toBe('1 小时 1 分钟');
    expect(formatDuration(7322)).toBe('2 小时 2 分钟');
  });

  it('非法值回落为 0 分钟', () => {
    expect(formatDuration(-10)).toBe('0 分钟');
    expect(formatDuration(Number.NaN)).toBe('0 分钟');
  });
});

describe('formatShare', () => {
  it('零占比显示 0%', () => {
    expect(formatShare(0)).toBe('0%');
  });

  it('保留一位小数', () => {
    expect(formatShare(0.2534)).toBe('25.3%');
    expect(formatShare(0.5)).toBe('50.0%');
    expect(formatShare(1)).toBe('100.0%');
  });

  it('四舍五入后为 0 显示 0%', () => {
    expect(formatShare(0.0001)).toBe('0%');
  });

  it('非法值显示 0%', () => {
    expect(formatShare(Number.NaN)).toBe('0%');
    expect(formatShare(-1)).toBe('0%');
  });
});

describe('usageSharePercent', () => {
  it('换算成百分比数值', () => {
    expect(usageSharePercent(0.2534)).toBe(25.3);
    expect(usageSharePercent(0)).toBe(0);
    expect(usageSharePercent(1.5)).toBe(100);
  });
});

describe('buildUsageRange', () => {
  it('today 区间是今天', () => {
    const today = new Date(2026, 5, 15);
    expect(buildUsageRange('today', today)).toEqual({ from: '2026-06-15', to: '2026-06-15' });
  });

  it('week 区间是本周一至今天', () => {
    const wednesday = new Date(2026, 5, 17);
    expect(buildUsageRange('week', wednesday)).toEqual({
      from: '2026-06-15',
      to: '2026-06-17',
    });
  });

  it('week 区间在周一时从当天开始', () => {
    const monday = new Date(2026, 5, 15);
    expect(buildUsageRange('week', monday)).toEqual({
      from: '2026-06-15',
      to: '2026-06-15',
    });
  });

  it('last7 区间是今天往前 6 天', () => {
    const today = new Date(2026, 5, 15);
    expect(buildUsageRange('last7', today)).toEqual({
      from: '2026-06-09',
      to: '2026-06-15',
    });
  });

  it('last7 跨月时正确回退到上个月', () => {
    const today = new Date(2026, 5, 1);
    expect(buildUsageRange('last7', today)).toEqual({
      from: '2026-05-26',
      to: '2026-06-01',
    });
  });

  it('week 跨年时回到上一年年末', () => {
    const newYear = new Date(2026, 0, 1);
    expect(buildUsageRange('week', newYear)).toEqual({
      from: '2025-12-29',
      to: '2026-01-01',
    });
  });

  it('last7 跨年时回到上一年年末', () => {
    const newYear = new Date(2026, 0, 1);
    expect(buildUsageRange('last7', newYear)).toEqual({
      from: '2025-12-26',
      to: '2026-01-01',
    });
  });

  it('custom 区间使用传入的起止日期', () => {
    const today = new Date(2026, 5, 15);
    expect(
      buildUsageRange('custom', today, { from: '2026-01-01', to: '2026-01-31' }),
    ).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('custom 缺省时回退到今天', () => {
    const today = new Date(2026, 5, 15);
    expect(buildUsageRange('custom', today)).toEqual({
      from: '2026-06-15',
      to: '2026-06-15',
    });
    expect(buildUsageRange('custom', today, { from: '', to: '' })).toEqual({
      from: '2026-06-15',
      to: '2026-06-15',
    });
  });

  it('custom 起止颠倒时自动交换', () => {
    const today = new Date(2026, 5, 15);
    expect(
      buildUsageRange('custom', today, { from: '2026-03-10', to: '2026-03-01' }),
    ).toEqual({ from: '2026-03-01', to: '2026-03-10' });
  });
});

describe('formatUsageRangeLabel', () => {
  it('同一天只显示一个日期', () => {
    expect(formatUsageRangeLabel('2026-06-15', '2026-06-15')).toBe('6月15日');
  });

  it('跨天显示起止日期', () => {
    expect(formatUsageRangeLabel('2026-06-01', '2026-06-15')).toBe('6月1日 - 6月15日');
  });

  it('非法日期返回空字符串', () => {
    expect(formatUsageRangeLabel('bad', '2026-06-15')).toBe('');
  });
});

describe('fillDailyRange', () => {
  it('补齐缺失日期并升序排列', () => {
    const daily: UsageDailyStat[] = [
      { day: '2026-06-17', seconds: 120 },
      { day: '2026-06-15', seconds: 60 },
    ];
    expect(fillDailyRange(daily, '2026-06-15', '2026-06-17')).toEqual([
      { day: '2026-06-15', seconds: 60 },
      { day: '2026-06-16', seconds: 0 },
      { day: '2026-06-17', seconds: 120 },
    ]);
  });

  it('丢弃区间之外的数据', () => {
    const daily: UsageDailyStat[] = [
      { day: '2026-06-01', seconds: 999 },
      { day: '2026-06-16', seconds: 30 },
      { day: '2026-07-01', seconds: 888 },
    ];
    expect(fillDailyRange(daily, '2026-06-15', '2026-06-17')).toEqual([
      { day: '2026-06-15', seconds: 0 },
      { day: '2026-06-16', seconds: 30 },
      { day: '2026-06-17', seconds: 0 },
    ]);
  });

  it('重复日期以最后一条为准', () => {
    const daily: UsageDailyStat[] = [
      { day: '2026-06-15', seconds: 10 },
      { day: '2026-06-15', seconds: 20 },
    ];
    expect(fillDailyRange(daily, '2026-06-15', '2026-06-15')).toEqual([
      { day: '2026-06-15', seconds: 20 },
    ]);
  });

  it('区间非法或首尾颠倒时返回空数组', () => {
    expect(fillDailyRange([], '2026-06-17', '2026-06-15')).toEqual([]);
    expect(fillDailyRange([], 'bad', '2026-06-15')).toEqual([]);
  });

  it('空数据也能补出完整区间', () => {
    expect(fillDailyRange([], '2026-06-15', '2026-06-17')).toEqual([
      { day: '2026-06-15', seconds: 0 },
      { day: '2026-06-16', seconds: 0 },
      { day: '2026-06-17', seconds: 0 },
    ]);
  });
});

describe('summarizeUsage', () => {
  const apps: UsageAppStat[] = [
    { appKey: 'a', appName: 'Alpha', seconds: 0, share: 0 },
    { appKey: 'b', appName: 'Beta', seconds: 300, share: 0.6 },
    { appKey: 'c', appName: 'Gamma', seconds: 200, share: 0.4 },
  ];
  const daily: UsageDailyStat[] = [
    { day: '2026-06-15', seconds: 100 },
    { day: '2026-06-16', seconds: 0 },
    { day: '2026-06-17', seconds: 400 },
  ];
  const overview: UsageOverview = {
    rangeFrom: '2026-06-15',
    rangeTo: '2026-06-17',
    totalSeconds: 500,
    trackedApps: 3,
    apps,
    daily,
  };

  it('过滤零时长并按时长降序', () => {
    const summary = summarizeUsage(overview);
    expect(summary.topApps.map((item) => item.appKey)).toEqual(['b', 'c']);
  });

  it('统计活跃天数与每日峰值', () => {
    const summary = summarizeUsage(overview);
    expect(summary.activeDays).toBe(2);
    expect(summary.peakSeconds).toBe(400);
    expect(summary.peakDay).toBe('2026-06-17');
  });

  it('日均按区间全部天数计算', () => {
    expect(summarizeUsage(overview).dailyAverageSeconds).toBe(167);
  });

  it('第一名应用的占比来自排序结果', () => {
    expect(summarizeUsage(overview).topShare).toBe(0.6);
  });

  it('空数据不报错', () => {
    const empty = summarizeUsage({
      rangeFrom: '2026-06-15',
      rangeTo: '2026-06-15',
      totalSeconds: 0,
      trackedApps: 0,
      apps: [],
      daily: [],
    });
    expect(empty.topApps).toEqual([]);
    expect(empty.activeDays).toBe(0);
    expect(empty.peakDay).toBeNull();
    expect(empty.dailyAverageSeconds).toBe(0);
  });
});

describe('clampIdleThreshold', () => {
  it('夹在允许范围内', () => {
    expect(clampIdleThreshold(10)).toBe(USAGE_IDLE_MIN_SECONDS);
    expect(clampIdleThreshold(300)).toBe(300);
    expect(clampIdleThreshold(5000)).toBe(USAGE_IDLE_MAX_SECONDS);
  });

  it('非法值回落到下限', () => {
    expect(clampIdleThreshold(Number.NaN)).toBe(USAGE_IDLE_MIN_SECONDS);
  });
});
