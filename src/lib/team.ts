import type {
  MemberRole,
  OvertimeRecord,
  PerformanceCategory,
  PerformanceRecord,
  TeamMember,
} from './types';

export const MEMBER_ROLE_META: ReadonlyArray<{
  key: MemberRole;
  label: string;
  short: string;
}> = [
  { key: 'dev', label: '开发', short: '研' },
  { key: 'test', label: '测试', short: '测' },
  { key: 'requirements', label: '需求', short: '需' },
  { key: 'design', label: '设计', short: '设' },
  { key: 'other', label: '其他', short: '他' },
];

export const PERFORMANCE_CATEGORY_META: ReadonlyArray<{
  key: PerformanceCategory;
  label: string;
}> = [
  { key: 'delivery', label: '交付' },
  { key: 'quality', label: '质量' },
  { key: 'collaboration', label: '协作' },
  { key: 'other', label: '其他' },
];

export function memberRoleLabel(role: MemberRole): string {
  return MEMBER_ROLE_META.find((item) => item.key === role)?.label ?? '其他';
}

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
  return Math.round(
    records
      .filter((record) => record.date.startsWith(month))
      .reduce((sum, record) => sum + record.hours, 0) * 10,
  ) / 10;
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
