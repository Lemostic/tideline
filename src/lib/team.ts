import type {
  LeaveRecord,
  LeaveStatus,
  LeaveType,
  MemberTenure,
  OvertimeRecord,
  OvertimeStatus,
  PerformanceCategory,
  PerformanceRecord,
  Project,
  ProjectMetaField,
  ProjectRole,
  TeamMember,
} from './types';
import { diffDays } from './date';

export const PROJECT_COLORS = [
  '#0f766e',
  '#2f6fd0',
  '#9a6512',
  '#5a48c9',
  '#b84a62',
  '#3f7d4e',
  '#64748b',
] as const;

export const PERFORMANCE_CATEGORY_META: ReadonlyArray<{
  key: PerformanceCategory;
  label: string;
}> = [
  { key: 'delivery', label: '交付' },
  { key: 'quality', label: '质量' },
  { key: 'collaboration', label: '协作' },
  { key: 'other', label: '其他' },
];

export function performanceCategoryLabel(category: PerformanceCategory): string {
  return PERFORMANCE_CATEGORY_META.find((item) => item.key === category)?.label ?? '其他';
}

export function isWeekend(dateKey: string): boolean {
  const date = new Date(`${dateKey}T00:00:00`);
  const day = date.getDay();
  return day === 0 || day === 6;
}

export function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`;
}

export function formatMonthCN(month: string): string {
  const [year, value] = month.split('-');
  return `${year} 年 ${Number(value)} 月`;
}

export function overtimeHoursInMonth(records: OvertimeRecord[], month: string): number {
  return (
    Math.round(
      records
        .filter((record) => record.date.startsWith(month) && record.status === 'done')
        .reduce((sum, record) => sum + record.hours, 0) * 10,
    ) / 10
  );
}

/** V0.13.2：未出勤原因长度上限，前端表单与数据层共用。 */
export const OVERTIME_ABSENCE_REASON_MAX = 200;

export const OVERTIME_STATUS_META: ReadonlyArray<{ key: OvertimeStatus; label: string }> = [
  { key: 'planned', label: '排班' },
  { key: 'done', label: '已出勤' },
  { key: 'absent', label: '未出勤' },
];

export function overtimeStatusLabel(status: OvertimeStatus): string {
  return OVERTIME_STATUS_META.find((item) => item.key === status)?.label ?? '排班';
}

/**
 * 校验未出勤原因：未出勤必须填写 1–200 字，其它状态不需要原因。
 * 返回错误文案，通过校验返回 null。
 */
export function validateOvertimeAbsenceReason(
  status: OvertimeStatus,
  reason: string,
): string | null {
  if (status !== 'absent') return null;
  const text = reason.trim();
  if (!text) return '请填写未出勤原因';
  // 与 Rust 侧 chars().count() 对齐，按 Unicode 码点计数，避免 emoji 边界口径不一致。
  if (Array.from(text).length > OVERTIME_ABSENCE_REASON_MAX) {
    return `未出勤原因最多 ${OVERTIME_ABSENCE_REASON_MAX} 字`;
  }
  return null;
}

/** 写库前归一：未出勤保留 trim 后的原因，其它状态一律清空，避免残留脏字段。 */
export function normalizeOvertimeAbsenceReason(status: OvertimeStatus, reason: string): string {
  return status === 'absent' ? reason.trim() : '';
}

/** 全部「已出勤」记录的工时合计（排班与未出勤不计入）。 */
export function overtimeDoneHours(records: OvertimeRecord[]): number {
  return records
    .filter((record) => record.status === 'done')
    .reduce((sum, record) => sum + record.hours, 0);
}

/** 未出勤记录条数。 */
export function overtimeAbsenceCount(records: OvertimeRecord[]): number {
  return records.filter((record) => record.status === 'absent').length;
}

/** 指定月份内未出勤记录条数。 */
export function overtimeAbsenceCountInMonth(records: OvertimeRecord[], month: string): number {
  return records.filter(
    (record) => record.status === 'absent' && record.date.startsWith(month),
  ).length;
}

export interface MemberPerformance {
  memberId: string;
  plus: number;
  minus: number;
  total: number;
  count: number;
}

export function performanceByMember(
  records: PerformanceRecord[],
  month?: string,
): MemberPerformance[] {
  const map = new Map<string, MemberPerformance>();
  for (const record of records) {
    if (month && !record.date.startsWith(month)) continue;
    const current = map.get(record.memberId) ?? {
      memberId: record.memberId,
      plus: 0,
      minus: 0,
      total: 0,
      count: 0,
    };
    if (record.points > 0) current.plus += record.points;
    else current.minus += Math.abs(record.points);
    current.total += record.points;
    current.count += 1;
    map.set(record.memberId, current);
  }
  return [...map.values()].sort((a, b) => b.total - a.total || b.plus - a.plus);
}

export function activeMembers(members: TeamMember[]): TeamMember[] {
  return members.filter((member) => member.status === 'active');
}

export function releasedMembers(members: TeamMember[]): TeamMember[] {
  return members.filter((member) => member.status === 'released');
}

export function projectMembers(members: TeamMember[], projectId: string): TeamMember[] {
  return members.filter((member) => member.projectId === projectId);
}

export function projectOvertime(records: OvertimeRecord[], projectId: string): OvertimeRecord[] {
  return records.filter((record) => record.projectId === projectId);
}

export function projectPerformance(
  records: PerformanceRecord[],
  projectId: string,
): PerformanceRecord[] {
  return records.filter((record) => record.projectId === projectId);
}

export function projectMeta(
  fields: ProjectMetaField[],
  projectId: string,
): ProjectMetaField[] {
  return fields
    .filter((field) => field.projectId === projectId)
    .sort((a, b) => a.position - b.position);
}

export function projectRolesOf(roles: ProjectRole[], projectId: string): ProjectRole[] {
  return roles
    .filter((role) => role.projectId === projectId)
    .sort((a, b) => a.position - b.position);
}

export function roleName(roles: ProjectRole[], roleId: string): string {
  return roles.find((role) => role.id === roleId)?.name ?? '未分配角色';
}

export function roleColor(roles: ProjectRole[], roleId: string): string {
  return roles.find((role) => role.id === roleId)?.color ?? '#64748b';
}

export function projectOvertimeHours(records: OvertimeRecord[], projectId: string, month?: string) {
  return (month
    ? records.filter(
        (record) =>
          record.projectId === projectId &&
          record.status === 'done' &&
          record.date.startsWith(month),
      )
    : records.filter((record) => record.projectId === projectId && record.status === 'done')
  ).reduce((sum, record) => sum + record.hours, 0);
}

export function projectPerformanceNet(
  records: PerformanceRecord[],
  projectId: string,
  month?: string,
): number {
  return records
    .filter(
      (record) =>
        record.projectId === projectId && (!month || record.date.startsWith(month)),
    )
    .reduce((sum, record) => sum + record.points, 0);
}

export function activeProjectCount(projects: Project[]): number {
  return projects.filter((project) => project.status === 'active').length;
}

// ---------- 多段投入记录（V0.8.3） ----------

export function todayKeyLocal(date = new Date()): string {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

export function projectTenures(tenures: MemberTenure[], projectId: string): MemberTenure[] {
  return tenures
    .filter((tenure) => tenure.projectId === projectId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

export function memberTenuresOf(tenures: MemberTenure[], memberId: string): MemberTenure[] {
  return tenures
    .filter((tenure) => tenure.memberId === memberId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

/** 含首尾日期；开放段按今天计算；未来段返回 0。 */
export function tenureDays(tenure: MemberTenure, asOf = todayKeyLocal()): number {
  const start = Date.parse(`${tenure.startedAt}T00:00:00Z`);
  const end = Date.parse(`${tenure.endedAt ?? asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
}

export function tenureIsActive(tenure: MemberTenure): boolean {
  return tenure.endedAt === null;
}

export function tenureOverlapsRange(
  tenure: MemberTenure,
  from: string,
  to: string,
): boolean {
  if (from && tenure.endedAt !== null && tenure.endedAt < from) return false;
  if (to && tenure.startedAt > to) return false;
  return true;
}

export interface MemberTenureSummary {
  member: TeamMember;
  segments: MemberTenure[];
  totalDays: number;
  active: boolean;
  firstStartedAt: string | null;
  latestEndedAt: string | null;
}

export function tenureSummaryForProject(
  tenures: MemberTenure[],
  members: TeamMember[],
  projectId: string,
  asOf = todayKeyLocal(),
): MemberTenureSummary[] {
  return members
    .filter((member) => member.projectId === projectId)
    .map((member) => {
      const segments = memberTenuresOf(tenures, member.id);
      return {
        member,
        segments,
        totalDays: segments.reduce((sum, tenure) => sum + tenureDays(tenure, asOf), 0),
        active: segments.some((tenure) => tenureIsActive(tenure)),
        firstStartedAt: segments[0]?.startedAt ?? null,
        latestEndedAt:
          [...segments]
            .map((tenure) => tenure.endedAt)
            .filter((value): value is string => Boolean(value))
            .sort()
            .at(-1) ?? null,
      };
    })
    .sort((a, b) => b.totalDays - a.totalDays || a.member.name.localeCompare(b.member.name));
}

export interface ProjectTenureStats {
  totalDays: number;
  activeMembers: number;
  historicalMembers: number;
  averageDays: number;
  segmentCount: number;
}

export function projectTenureStats(
  summaries: MemberTenureSummary[],
): ProjectTenureStats {
  const totalDays = summaries.reduce((sum, item) => sum + item.totalDays, 0);
  const activeMembers = summaries.filter((item) => item.active).length;
  const historicalMembers = summaries.length - activeMembers;
  return {
    totalDays,
    activeMembers,
    historicalMembers,
    averageDays: summaries.length > 0 ? Math.round(totalDays / summaries.length) : 0,
    segmentCount: summaries.reduce((sum, item) => sum + item.segments.length, 0),
  };
}

export function formatTenureRange(tenure: MemberTenure): string {
  return `${tenure.startedAt} → ${tenure.endedAt ?? '至今'}`;
}

// ---------- 请假记录（V0.16.0） ----------

export const LEAVE_TYPE_META: ReadonlyArray<{ key: LeaveType; label: string }> = [
  { key: 'annual', label: '年假' },
  { key: 'sick', label: '病假' },
  { key: 'personal', label: '事假' },
  { key: 'compensatory', label: '调休' },
  { key: 'marriage', label: '婚假' },
  { key: 'maternity', label: '产假' },
  { key: 'bereavement', label: '丧假' },
  { key: 'other', label: '其他' },
];

/** 全部合法的请假类型键，备份解析与归一化共用。 */
export const LEAVE_TYPE_KEYS: ReadonlyArray<LeaveType> = LEAVE_TYPE_META.map(
  (item) => item.key,
);

export const LEAVE_STATUS_META: ReadonlyArray<{ key: LeaveStatus; label: string }> = [
  { key: 'pending', label: '待审批' },
  { key: 'approved', label: '已批准' },
  { key: 'rejected', label: '已驳回' },
];

export function leaveTypeLabel(type: LeaveType): string {
  return LEAVE_TYPE_META.find((item) => item.key === type)?.label ?? '其他';
}

export function leaveStatusLabel(status: LeaveStatus): string {
  return LEAVE_STATUS_META.find((item) => item.key === status)?.label ?? '待审批';
}

/** 请假事由长度上限，前端表单与数据层共用。 */
export const LEAVE_REASON_MAX = 200;

/** 单条请假记录的最大跨度（自然日），防止误填整年区间。 */
export const LEAVE_DAYS_MAX = 366;

/** 请假天数（自然日，含首尾）；起止日期非法时返回 0。 */
export function leaveDayCount(startDate: string, endDate: string): number {
  if (!startDate || !endDate) return 0;
  const span = diffDays(startDate, endDate);
  if (span < 0) return 0;
  return span + 1;
}

/**
 * 校验请假区间与事由：
 * - 起止日期必填，结束日期不得早于开始日期；
 * - 跨度不超过上限；
 * - 事由必填，1–200 字。
 * 通过校验返回 null，否则返回中文错误文案。
 */
export function validateLeaveInput(
  startDate: string,
  endDate: string,
  reason: string,
): string | null {
  if (!startDate) return '请选择请假开始日期';
  if (!endDate) return '请选择请假结束日期';
  const days = leaveDayCount(startDate, endDate);
  if (days <= 0) return '结束日期不能早于开始日期';
  if (days > LEAVE_DAYS_MAX) return `请假跨度不能超过 ${LEAVE_DAYS_MAX} 天`;
  const text = reason.trim();
  if (!text) return '请填写请假事由';
  // 与 Rust 侧 chars().count() 对齐，按 Unicode 码点计数。
  if (Array.from(text).length > LEAVE_REASON_MAX) {
    return `请假事由最多 ${LEAVE_REASON_MAX} 字`;
  }
  return null;
}

export function projectLeave(records: LeaveRecord[], projectId: string): LeaveRecord[] {
  return records.filter((record) => record.projectId === projectId);
}

export function memberLeave(records: LeaveRecord[], memberId: string): LeaveRecord[] {
  return records.filter((record) => record.memberId === memberId);
}

/** 已批准的请假天数合计（待审批与已驳回不计入资源占用）。 */
export function approvedLeaveDays(records: LeaveRecord[]): number {
  return records
    .filter((record) => record.status === 'approved')
    .reduce((sum, record) => sum + record.days, 0);
}

/** 某条请假记录落在 [from, to] 区间内的天数（跨月的记录按天切分）。 */
export function leaveDaysInRange(record: LeaveRecord, from: string, to: string): number {
  if (!from || !to) return record.days;
  const start = record.startDate > from ? record.startDate : from;
  const end = record.endDate < to ? record.endDate : to;
  if (start > end) return 0;
  return diffDays(start, end) + 1;
}

/** 某月的首尾日期（YYYY-MM → YYYY-MM-DD）。 */
export function monthRange(month: string): { from: string; to: string } {
  const [year, value] = month.split('-');
  const days = new Date(Number(year), Number(value), 0).getDate();
  return {
    from: `${month}-01`,
    to: `${month}-${`${days}`.padStart(2, '0')}`,
  };
}

/** 指定月份内已批准的请假天数合计（跨月记录按天切分）。 */
export function approvedLeaveDaysInMonth(records: LeaveRecord[], month: string): number {
  const { from, to } = monthRange(month);
  return records
    .filter((record) => record.status === 'approved')
    .reduce((sum, record) => sum + leaveDaysInRange(record, from, to), 0);
}

/** 待审批的请假条数。 */
export function pendingLeaveCount(records: LeaveRecord[]): number {
  return records.filter((record) => record.status === 'pending').length;
}

/** 指定月份内待审批的请假条数（跨月记录只要与该月有交集就计入）。 */
export function pendingLeaveCountInMonth(records: LeaveRecord[], month: string): number {
  const { from, to } = monthRange(month);
  return records.filter(
    (record) =>
      record.status === 'pending' &&
      record.startDate <= to &&
      record.endDate >= from,
  ).length;
}

// ---------- 用户画像（V0.16.0） ----------

/** 画像标签的判定阈值，集中定义便于统一口径。 */
export const PORTRAIT_THRESHOLD = {
  /** 累计投入达到该人天视为投入稳定 */
  tenureDays: 30,
  /** 加班工时达到该小时数视为周末常驻 */
  overtimeHours: 40,
  /** 请假达到该天数视为请假期偏长 */
  leaveDays: 5,
} as const;

export interface MemberPortraitTag {
  key: string;
  label: string;
  tone: 'positive' | 'neutral' | 'warning';
}

export interface MemberPortrait {
  member: TeamMember;
  roleName: string;
  roleColor: string;
  /** 累计投入人天 */
  tenureDays: number;
  /** 投入段数 */
  tenureSegments: number;
  /** 当前是否在组 */
  active: boolean;
  /** 加班工时合计（只算已出勤） */
  overtimeHours: number;
  /** 周末排班条数 */
  overtimeScheduled: number;
  /** 周末已出勤条数 */
  overtimeDone: number;
  /** 周末未出勤条数 */
  overtimeAbsent: number;
  /** 周末出勤率 0–1；没有实际排班时为 null */
  attendanceRate: number | null;
  /** 已批准请假天数 */
  leaveDays: number;
  /** 请假条数（含待审批与已驳回） */
  leaveCount: number;
  /** 待审批请假条数 */
  leavePending: number;
  /** 绩效净分 */
  performancePoints: number;
  /** 绩效记录条数 */
  performanceCount: number;
  /** 画像标签 */
  tags: MemberPortraitTag[];
}

export interface PortraitSource {
  members: TeamMember[];
  tenures: MemberTenure[];
  overtime: OvertimeRecord[];
  leave: LeaveRecord[];
  performance: PerformanceRecord[];
  roles: ProjectRole[];
}

/** 按项目生成成员画像：投入、加班、请假、绩效四个维度合并成一张画像。 */
export function memberPortraits(source: PortraitSource, projectId: string): MemberPortrait[] {
  const members = source.members.filter((member) => member.projectId === projectId);
  const tenures = source.tenures.filter((tenure) => tenure.projectId === projectId);
  const overtime = source.overtime.filter((record) => record.projectId === projectId);
  const leave = source.leave.filter((record) => record.projectId === projectId);
  const performance = source.performance.filter((record) => record.projectId === projectId);

  const portraits = members.map((member) => {
    const segments = tenures.filter((tenure) => tenure.memberId === member.id);
    const memberOvertime = overtime.filter((record) => record.memberId === member.id);
    const memberLeaveRecords = leave.filter((record) => record.memberId === member.id);
    const memberPerformance = performance.filter((record) => record.memberId === member.id);

    const totalDays = segments.reduce((sum, tenure) => sum + tenureDays(tenure), 0);
    const done = memberOvertime.filter((record) => record.status === 'done');
    const absent = memberOvertime.filter((record) => record.status === 'absent');
    const scheduled = memberOvertime.filter((record) => record.status === 'planned');
    const realized = done.length + absent.length;
    const points = memberPerformance.reduce((sum, record) => sum + record.points, 0);
    const leaveDays = approvedLeaveDays(memberLeaveRecords);

    const portrait: MemberPortrait = {
      member,
      roleName: roleName(source.roles, member.roleId),
      roleColor: roleColor(source.roles, member.roleId),
      tenureDays: totalDays,
      tenureSegments: segments.length,
      active: member.status === 'active',
      overtimeHours: Math.round(overtimeDoneHours(memberOvertime) * 10) / 10,
      overtimeScheduled: scheduled.length,
      overtimeDone: done.length,
      overtimeAbsent: absent.length,
      attendanceRate: realized > 0 ? done.length / realized : null,
      leaveDays,
      leaveCount: memberLeaveRecords.length,
      leavePending: pendingLeaveCount(memberLeaveRecords),
      performancePoints: points,
      performanceCount: memberPerformance.length,
      tags: [],
    };
    portrait.tags = portraitTags(portrait);
    return portrait;
  });

  return portraits.sort(
    (a, b) =>
      b.tenureDays - a.tenureDays ||
      b.overtimeHours - a.overtimeHours ||
      a.member.name.localeCompare(b.member.name),
  );
}

/** 由画像数据推导标签：正向标签与需要关注的标签都写明依据。 */
export function portraitTags(portrait: MemberPortrait): MemberPortraitTag[] {
  const tags: MemberPortraitTag[] = [];
  if (portrait.active && portrait.tenureDays >= PORTRAIT_THRESHOLD.tenureDays) {
    tags.push({ key: 'stable', label: '投入稳定', tone: 'positive' });
  }
  if (portrait.active && portrait.tenureDays === 0) {
    tags.push({ key: 'newcomer', label: '新成员待投入', tone: 'neutral' });
  }
  if (!portrait.active && portrait.tenureDays > 0) {
    tags.push({ key: 'released', label: '已离组', tone: 'neutral' });
  }
  if (portrait.overtimeHours >= PORTRAIT_THRESHOLD.overtimeHours) {
    tags.push({ key: 'overtime-heavy', label: '周末常驻', tone: 'neutral' });
  }
  if (portrait.attendanceRate !== null && portrait.attendanceRate >= 0.9) {
    tags.push({ key: 'attendance-good', label: '出勤稳定', tone: 'positive' });
  }
  if (portrait.overtimeAbsent > portrait.overtimeDone && portrait.overtimeAbsent > 0) {
    tags.push({ key: 'attendance-bad', label: '周末缺席偏多', tone: 'warning' });
  }
  if (portrait.performancePoints > 0) {
    tags.push({ key: 'performance-good', label: '绩效突出', tone: 'positive' });
  }
  if (portrait.performancePoints < 0) {
    tags.push({ key: 'performance-bad', label: '绩效待改进', tone: 'warning' });
  }
  if (portrait.leaveDays >= PORTRAIT_THRESHOLD.leaveDays) {
    tags.push({ key: 'leave-long', label: '请假期偏长', tone: 'warning' });
  }
  if (portrait.leavePending > 0) {
    tags.push({ key: 'leave-pending', label: '有假单待审批', tone: 'neutral' });
  }
  return tags;
}

/** 需要关注的标签数量，用于在画像卡片上标出关注度。 */
export function portraitAttentionCount(portrait: MemberPortrait): number {
  return portrait.tags.filter((tag) => tag.tone === 'warning').length;
}
