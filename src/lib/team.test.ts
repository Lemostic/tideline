import { describe, expect, it } from 'vitest';
import {
  activeMembers,
  approvedLeaveDays,
  approvedLeaveDaysInMonth,
  isWeekend,
  leaveDayCount,
  leaveStatusLabel,
  leaveTypeLabel,
  memberPortraits,
  normalizeOvertimeAbsenceReason,
  OVERTIME_ABSENCE_REASON_MAX,
  overtimeAbsenceCount,
  overtimeAbsenceCountInMonth,
  overtimeDoneHours,
  overtimeHoursInMonth,
  overtimeStatusLabel,
  pendingLeaveCount,
  pendingLeaveCountInMonth,
  performanceByMember,
  projectLeave,
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
  validateLeaveInput,
  validateOvertimeAbsenceReason,
} from '@/lib/team';
import type {
  LeaveRecord,
  LeaveStatus,
  LeaveType,
  OvertimeRecord,
  OvertimeStatus,
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
  status: OvertimeStatus = 'done',
  absenceReason = '',
): OvertimeRecord {
  return {
    id,
    projectId,
    memberId,
    date,
    hours,
    status,
    absenceReason,
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

function leave(
  id: string,
  projectId: string,
  memberId: string,
  startDate: string,
  endDate: string,
  status: LeaveStatus = 'approved',
  leaveType: LeaveType = 'personal',
): LeaveRecord {
  return {
    id,
    projectId,
    memberId,
    startDate,
    endDate,
    days: leaveDayCount(startDate, endDate),
    leaveType,
    status,
    reason: '家中有事',
    note: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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

  it('本月加班只统计已出勤，排班与未出勤不计入', () => {
    const records = [
      overtime('1', 'p1', 'a', '2026-10-03', 8, 'done'),
      overtime('2', 'p1', 'b', '2026-10-04', 8, 'planned'),
      overtime('3', 'p1', 'c', '2026-10-05', 8, 'absent', '临时发烧请假'),
      overtime('4', 'p1', 'd', '2026-10-06', 4, 'done'),
    ];
    expect(overtimeHoursInMonth(records, '2026-10')).toBe(12);
    expect(overtimeAbsenceCountInMonth(records, '2026-10')).toBe(1);
    expect(overtimeAbsenceCountInMonth(records, '2026-09')).toBe(0);
    expect(overtimeDoneHours(records)).toBe(12);
    expect(overtimeAbsenceCount(records)).toBe(1);
  });

  it('未出勤原因必填且最多 200 字，非未出勤状态清空原因', () => {
    expect(validateOvertimeAbsenceReason('planned', '')).toBeNull();
    expect(validateOvertimeAbsenceReason('done', '   ')).toBeNull();
    expect(validateOvertimeAbsenceReason('absent', '   ')).toBe('请填写未出勤原因');
    expect(validateOvertimeAbsenceReason('absent', '临时发烧请假')).toBeNull();
    expect(
      validateOvertimeAbsenceReason('absent', 'x'.repeat(OVERTIME_ABSENCE_REASON_MAX + 1)),
    ).toBe(`未出勤原因最多 ${OVERTIME_ABSENCE_REASON_MAX} 字`);
    expect(
      validateOvertimeAbsenceReason('absent', 'x'.repeat(OVERTIME_ABSENCE_REASON_MAX)),
    ).toBeNull();
    // 按 Unicode 码点计数：200 个 emoji 仍算 200 字，与 Rust 侧一致。
    expect(
      validateOvertimeAbsenceReason('absent', '🙂'.repeat(OVERTIME_ABSENCE_REASON_MAX)),
    ).toBeNull();
    expect(
      validateOvertimeAbsenceReason('absent', '🙂'.repeat(OVERTIME_ABSENCE_REASON_MAX + 1)),
    ).toBe(`未出勤原因最多 ${OVERTIME_ABSENCE_REASON_MAX} 字`);
    expect(normalizeOvertimeAbsenceReason('absent', ' 临时发烧请假 ')).toBe('临时发烧请假');
    expect(normalizeOvertimeAbsenceReason('done', '历史原因')).toBe('');
  });

  it('加班状态有统一中文标签', () => {
    expect(overtimeStatusLabel('planned')).toBe('排班');
    expect(overtimeStatusLabel('done')).toBe('已出勤');
    expect(overtimeStatusLabel('absent')).toBe('未出勤');
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

  it('请假天数按自然日含首尾计算', () => {
    expect(leaveDayCount('2026-10-01', '2026-10-01')).toBe(1);
    expect(leaveDayCount('2026-10-01', '2026-10-03')).toBe(3);
    expect(leaveDayCount('2026-10-01', '2026-11-01')).toBe(32);
    // 结束早于开始时不算天数
    expect(leaveDayCount('2026-10-05', '2026-10-01')).toBe(0);
    expect(leaveDayCount('', '2026-10-01')).toBe(0);
  });

  it('请假必填起止日期、结束不早于开始、事由 1–200 字', () => {
    expect(validateLeaveInput('', '2026-10-01', '事由')).toBe('请选择请假开始日期');
    expect(validateLeaveInput('2026-10-01', '', '事由')).toBe('请选择请假结束日期');
    expect(validateLeaveInput('2026-10-05', '2026-10-01', '事由')).toBe(
      '结束日期不能早于开始日期',
    );
    expect(validateLeaveInput('2026-10-01', '2026-10-02', '   ')).toBe('请填写请假事由');
    expect(validateLeaveInput('2026-10-01', '2026-10-02', '家中有事')).toBeNull();
    expect(validateLeaveInput('2026-10-01', '2026-10-02', 'x'.repeat(201))).toBe(
      '请假事由最多 200 字',
    );
    expect(validateLeaveInput('2026-10-01', '2026-10-02', 'x'.repeat(200))).toBeNull();
    // 与 Rust 侧一致，按 Unicode 码点计数
    expect(validateLeaveInput('2026-10-01', '2026-10-02', '🙂'.repeat(200))).toBeNull();
    expect(validateLeaveInput('2026-10-01', '2026-10-02', '🙂'.repeat(201))).toBe(
      '请假事由最多 200 字',
    );
    // 跨度上限
    expect(validateLeaveInput('2020-01-01', '2026-01-01', '事由')).toBe(
      '请假跨度不能超过 366 天',
    );
  });

  it('请假类型与状态有统一中文标签', () => {
    expect(leaveTypeLabel('annual')).toBe('年假');
    expect(leaveTypeLabel('sick')).toBe('病假');
    expect(leaveTypeLabel('other')).toBe('其他');
    expect(leaveStatusLabel('pending')).toBe('待审批');
    expect(leaveStatusLabel('approved')).toBe('已批准');
    expect(leaveStatusLabel('rejected')).toBe('已驳回');
  });

  it('只有已批准的请假计入资源占用', () => {
    const records = [
      leave('1', 'p1', 'a', '2026-10-01', '2026-10-03'),
      leave('2', 'p1', 'a', '2026-10-10', '2026-10-11', 'pending'),
      leave('3', 'p1', 'b', '2026-10-05', '2026-10-06', 'rejected'),
    ];
    expect(approvedLeaveDays(records)).toBe(3);
    expect(pendingLeaveCount(records)).toBe(1);
    expect(projectLeave(records, 'p1')).toHaveLength(3);
    expect(projectLeave(records, 'p2')).toHaveLength(0);
    expect(approvedLeaveDaysInMonth(records, '2026-10')).toBe(3);
    expect(approvedLeaveDaysInMonth(records, '2026-09')).toBe(0);
    expect(pendingLeaveCountInMonth(records, '2026-10')).toBe(1);
    expect(pendingLeaveCountInMonth(records, '2026-09')).toBe(0);
  });

  it('跨月的请假按月切分天数', () => {
    const records = [leave('1', 'p1', 'a', '2026-10-28', '2026-11-02')];
    // 10 月 28–31 日共 4 天，11 月 1–2 日共 2 天
    expect(approvedLeaveDaysInMonth(records, '2026-10')).toBe(4);
    expect(approvedLeaveDaysInMonth(records, '2026-11')).toBe(2);
  });

  it('生成成员画像：汇总投入、加班、请假与绩效并给出标签', () => {
    const members = [member('a', 'p1', 'active'), member('b', 'p1', 'released')];
    const tenures = [
      {
        id: 't1',
        memberId: 'a',
        projectId: 'p1',
        startedAt: '2026-01-01',
        endedAt: '2026-01-10',
        note: '',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 't2',
        memberId: 'b',
        projectId: 'p1',
        startedAt: '2026-02-01',
        endedAt: '2026-02-05',
        note: '',
        createdAt: '',
        updatedAt: '',
      },
    ];
    const portraits = memberPortraits(
      {
        members,
        tenures,
        overtime: [
          overtime('1', 'p1', 'a', '2026-10-03', 8, 'done'),
          overtime('2', 'p1', 'a', '2026-10-04', 8, 'absent', '临时有事'),
          overtime('3', 'p1', 'a', '2026-10-11', 8, 'absent', '临时有事'),
        ],
        leave: [leave('1', 'p1', 'a', '2026-10-01', '2026-10-06')],
        performance: [performance('1', 'p1', 'a', '2026-10-03', 5)],
        roles,
      },
      'p1',
    );
    expect(portraits).toHaveLength(2);
    const a = portraits.find((item) => item.member.id === 'a');
    expect(a).toMatchObject({
      roleName: '开发',
      active: true,
      tenureDays: 10,
      tenureSegments: 1,
      overtimeHours: 8,
      overtimeDone: 1,
      overtimeAbsent: 2,
      leaveDays: 6,
      leaveCount: 1,
      leavePending: 0,
      performancePoints: 5,
      performanceCount: 1,
    });
    // 1/3 出勤率
    expect(a?.attendanceRate).toBeCloseTo(1 / 3);
    const tags = a?.tags.map((tag) => tag.key) ?? [];
    expect(tags).toContain('attendance-bad');
    expect(tags).toContain('performance-good');
    expect(tags).toContain('leave-long');

    // 没有排班的成员出勤率为 null，而不是 0；已离组的成员带「已离组」标签
    const b = portraits.find((item) => item.member.id === 'b');
    expect(b?.attendanceRate).toBeNull();
    expect(b?.tags.map((tag) => tag.key)).toContain('released');
  });
});
