import type {
  OvertimeRecord,
  PerformanceCategory,
  PerformanceRecord,
  Project,
  ProjectMetaField,
  ProjectRole,
  TeamMember,
} from './types';

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
    ? records.filter((record) => record.projectId === projectId && record.date.startsWith(month))
    : records.filter((record) => record.projectId === projectId)
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
