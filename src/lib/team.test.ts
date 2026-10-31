import { describe, expect, it } from 'vitest';
import {
  activeMembers,
  isWeekend,
  overtimeHoursInMonth,
  performanceByMember,
} from '@/lib/team';
import type { OvertimeRecord, PerformanceRecord, TeamMember } from '@/lib/types';

function member(id: string, status: 'active' | 'released'): TeamMember {
  return {
    id,
    name: id,
    role: 'dev',
    status,
    joinedAt: '2026-01-01',
    releasedAt: status === 'released' ? '2026-06-01' : null,
    note: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function overtime(id: string, memberId: string, date: string, hours: number): OvertimeRecord {
  return {
    id,
    memberId,
    date,
    hours,
    status: 'done',
    note: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function performance(id: string, memberId: string, date: string, points: number): PerformanceRecord {
  return {
    id,
    memberId,
    date,
    points,
    reason: 'r',
    category: 'delivery',
    note: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('team helpers', () => {
  it('区分周末', () => {
    expect(isWeekend('2026-10-31')).toBe(true); // 周六
    expect(isWeekend('2026-11-01')).toBe(true); // 周日
    expect(isWeekend('2026-11-02')).toBe(false);
  });

  it('按月汇总加班时长', () => {
    const records = [
      overtime('1', 'a', '2026-10-03', 4),
      overtime('2', 'a', '2026-10-04', 3.5),
      overtime('3', 'a', '2026-09-27', 8),
    ];
    expect(overtimeHoursInMonth(records, '2026-10')).toBe(7.5);
  });

  it('按成员汇总绩效加减分并排序', () => {
    const records = [
      performance('1', 'a', '2026-10-03', 5),
      performance('2', 'a', '2026-10-04', -2),
      performance('3', 'b', '2026-10-05', 3),
      performance('4', 'b', '2026-09-05', 99),
    ];
    const result = performanceByMember(records, '2026-10');
    expect(result.map((item) => item.memberId)).toEqual(['a', 'b']);
    expect(result[0]).toMatchObject({ memberId: 'a', plus: 5, minus: 2, total: 3, count: 2 });
  });

  it('区分在组与已释放成员', () => {
    const members = [member('a', 'active'), member('b', 'released')];
    expect(activeMembers(members).map((item) => item.id)).toEqual(['a']);
  });
});
