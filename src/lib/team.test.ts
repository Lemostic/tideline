import { describe, expect, it } from 'vitest';
import {
  activeMembers,
  isWeekend,
  overtimeHoursInMonth,
  performanceByMember,
  projectMembers,
  projectMeta,
  projectOvertime,
  projectPerformance,
  projectRolesOf,
  projectTenureStats,
  roleName,
  tenureDays,
  tenureIsActive,
  tenureOverlapsRange,
  tenureSummaryForProject,
} from '@/lib/team';
import type {
  OvertimeRecord,
  PerformanceRecord,
  ProjectMetaField,
  ProjectRole,
  TeamMember,
} from '@/lib/types';

function member(id: string, projectId: string, status: 'active' | 'released'): TeamMember {
  return {
    id,
    projectId,
    roleId: 'r1',
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

function overtime(
  id: string,
  projectId: string,
  memberId: string,
  date: string,
  hours: number,
): OvertimeRecord {
  return {
    id,
    projectId,
    memberId,
    date,
    hours,
    status: 'done',
    note: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function performance(
  id: string,
  projectId: string,
  memberId: string,
  date: string,
  points: number,
): PerformanceRecord {
  return {
    id,
    projectId,
    memberId,
    date,
    points,
    reason: 'r',
    category: 'delivery',
    note: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const roles: ProjectRole[] = [
  {
    id: 'r1',
    projectId: 'p1',
    name: '开发',
    color: '#2f6fd0',
    position: 0,
    createdAt: '',
    updatedAt: '',
  },
];

const meta: ProjectMetaField[] = [
  {
    id: 'm1',
    projectId: 'p1',
    name: '客户',
    value: '某集团',
    position: 0,
    createdAt: '',
    updatedAt: '',
  },
];

describe('team helpers', () => {
  it('区分周末', () => {
    expect(isWeekend('2026-10-31')).toBe(true);
    expect(isWeekend('2026-11-01')).toBe(true);
    expect(isWeekend('2026-11-02')).toBe(false);
  });

  it('按月汇总加班时长', () => {
    const records = [
      overtime('1', 'p1', 'a', '2026-10-03', 4),
      overtime('2', 'p1', 'a', '2026-10-04', 3.5),
      overtime('3', 'p1', 'a', '2026-09-27', 8),
    ];
    expect(overtimeHoursInMonth(records, '2026-10')).toBe(7.5);
  });

  it('按成员汇总绩效加减分并排序', () => {
    const records = [
      performance('1', 'p1', 'a', '2026-10-03', 5),
      performance('2', 'p1', 'a', '2026-10-04', -2),
      performance('3', 'p1', 'b', '2026-10-05', 3),
      performance('4', 'p1', 'b', '2026-09-05', 99),
    ];
    const result = performanceByMember(records, '2026-10');
    expect(result.map((item) => item.memberId)).toEqual(['a', 'b']);
    expect(result[0]).toMatchObject({ memberId: 'a', plus: 5, minus: 2, total: 3, count: 2 });
  });

  it('按项目隔离成员、加班、绩效、角色与元数据', () => {
    const members = [member('a', 'p1', 'active'), member('b', 'p2', 'released')];
    expect(activeMembers(members).map((item) => item.id)).toEqual(['a']);
    expect(projectMembers(members, 'p2').map((item) => item.id)).toEqual(['b']);
    expect(projectOvertime([overtime('1', 'p1', 'a', '2026-10-03', 4)], 'p1')).toHaveLength(1);
    expect(projectPerformance([performance('1', 'p2', 'b', '2026-10-03', 2)], 'p1')).toHaveLength(0);
    expect(projectRolesOf(roles, 'p1')).toHaveLength(1);
    expect(roleName(roles, 'r1')).toBe('开发');
    expect(projectMeta(meta, 'p1')[0].value).toBe('某集团');
  });

  it('统计多段投入：天数、开放段与项目汇总', () => {
    const first = {
      id: 't1',
      memberId: 'a',
      projectId: 'p1',
      startedAt: '2026-01-01',
      endedAt: '2026-01-10',
      note: '',
      createdAt: '',
      updatedAt: '',
    };
    const second = {
      ...first,
      id: 't2',
      startedAt: '2026-02-01',
      endedAt: null,
    };
    expect(tenureDays(first)).toBe(10);
    // 以固定 asOf 避免依赖今天
    expect(tenureDays(second, '2026-02-10')).toBe(10);
    expect(tenureIsActive(second)).toBe(true);

    const members = [member('a', 'p1', 'active')];
    const summaries = tenureSummaryForProject([first, second], members, 'p1', '2026-02-10');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ totalDays: 20, active: true });
    expect(projectTenureStats(summaries)).toMatchObject({
      totalDays: 20,
      activeMembers: 1,
      historicalMembers: 0,
      segmentCount: 2,
    });
    expect(tenureOverlapsRange(first, '2026-01-05', '2026-01-20')).toBe(true);
    expect(tenureOverlapsRange(first, '2026-02-01', '2026-02-20')).toBe(false);
  });
});
