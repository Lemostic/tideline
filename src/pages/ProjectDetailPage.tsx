import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DatePicker } from '@/components/DatePicker';
import { Icon } from '@/components/Icon';
import { EmptyState, Modal } from '@/components/Modal';
import {
  diffDays,
  endOfWeek,
  formatMonthDay,
  parseDateKey,
  startOfWeek,
  toDateKey,
} from '@/lib/date';
import {
  formatLeaveDays,
  formatMonthCN,
  isWeekend,
  LEAVE_DAYS_DECIMALS,
  LEAVE_DAYS_MAX,
  LEAVE_REASON_MAX,
  LEAVE_TYPE_META,
  leaveDaysInMonth,
  leaveDaysTotal,
  leaveSpanDays,
  leaveTypeLabel,
  memberPortraits,
  monthKey,
  OVERTIME_ABSENCE_REASON_MAX,
  overtimeAbsenceCountInMonth,
  overtimeHoursInMonth,
  overtimeStatusLabel,
  PERFORMANCE_CATEGORY_META,
  performanceByMember,
  performanceCategoryLabel,
  PROJECT_COLORS,
  projectLeave,
  projectMeta,
  projectMembers,
  projectOvertime,
  projectPerformance,
  projectRolesOf,
  projectTenureStats,
  projectTenures,
  roleColor,
  roleName,
  tenureDays,
  tenureOverlapsRange,
  tenureSummaryForProject,
  validateLeaveInput,
  validateOvertimeAbsenceReason,
} from '@/lib/team';
import type {
  LeaveRecord,
  LeaveType,
  MemberTenure,
  OvertimeRecord,
  OvertimeStatus,
  PerformanceCategory,
  Project,
  ProjectMetaField,
  ProjectRole,
  TeamMember,
} from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import { useSettingsStore } from '@/store/settingsStore';
import './team.css';

function todayLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`;
}

function initials(name: string): string {
  return name.trim().slice(0, 2) || '?';
}

function formatDate(value: string): string {
  if (!value) return '—';
  return value.slice(0, 10).replaceAll('-', '/');
}

type Tab =
  | 'members'
  | 'tenures'
  | 'leave'
  | 'overtime'
  | 'performance'
  | 'portrait'
  | 'settings';

export function ProjectDetailPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const project = snapshot.projects.find((item) => item.id === projectId) ?? null;
  const requestConfirm = useUiStore((state) => state.requestConfirm);
  const notify = useUiStore((state) => state.notify);
  const updateProject = useAppStore((state) => state.updateProject);
  const deleteProject = useAppStore((state) => state.deleteProject);
  const updateMember = useAppStore((state) => state.updateTeamMember);
  const deleteMember = useAppStore((state) => state.deleteTeamMember);
  const createTenure = useAppStore((state) => state.createTenure);
  const updateTenure = useAppStore((state) => state.updateTenure);
  const deleteTenure = useAppStore((state) => state.deleteTenure);
  const createOvertime = useAppStore((state) => state.createOvertime);
  const updateOvertime = useAppStore((state) => state.updateOvertime);
  const deleteOvertime = useAppStore((state) => state.deleteOvertime);
  const createPerformance = useAppStore((state) => state.createPerformance);
  const deletePerformance = useAppStore((state) => state.deletePerformance);
  const createLeave = useAppStore((state) => state.createLeave);
  const updateLeave = useAppStore((state) => state.updateLeave);
  const deleteLeave = useAppStore((state) => state.deleteLeave);
  const createRole = useAppStore((state) => state.createProjectRole);
  const updateRole = useAppStore((state) => state.updateProjectRole);
  const deleteRole = useAppStore((state) => state.deleteProjectRole);
  const createMeta = useAppStore((state) => state.createProjectMeta);
  const updateMeta = useAppStore((state) => state.updateProjectMeta);
  const deleteMeta = useAppStore((state) => state.deleteProjectMeta);

  const [tab, setTab] = useState<Tab>('members');
  const [month, setMonth] = useState(monthKey());
  const [memberModal, setMemberModal] = useState<TeamMember | null | 'new'>(null);
  const [memberOpen, setMemberOpen] = useState(false);
  const [overtimeOpen, setOvertimeOpen] = useState(false);
  const [overtimeEditing, setOvertimeEditing] = useState<OvertimeRecord | null>(null);
  const [overtimeAbsence, setOvertimeAbsence] = useState<OvertimeRecord | null>(null);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveEditing, setLeaveEditing] = useState<LeaveRecord | null>(null);
  const [roleOpen, setRoleOpen] = useState(false);
  const [roleEditing, setRoleEditing] = useState<ProjectRole | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [metaEditing, setMetaEditing] = useState<ProjectMetaField | null>(null);
  const [tenureOpen, setTenureOpen] = useState(false);
  const [tenureEditing, setTenureEditing] = useState<MemberTenure | null>(null);
  const [tenureMemberFilter, setTenureMemberFilter] = useState('');
  const [tenureFrom, setTenureFrom] = useState('');
  const [tenureTo, setTenureTo] = useState('');

  if (!project) {
    return (
      <div className="page team-page">
        <div className="team-panel team-empty">
          <EmptyState
            icon={<Icon name="users" size={22} />}
            title="项目不存在"
            description="项目可能已被删除，返回项目空间重新选择。"
            action={<Link className="btn btn-primary" to="/team">返回项目空间</Link>}
          />
        </div>
      </div>
    );
  }

  const members = projectMembers(snapshot.teamMembers, project.id);
  const roles = projectRolesOf(snapshot.projectRoles, project.id);
  const overtime = projectOvertime(snapshot.overtimeRecords, project.id);
  const performance = projectPerformance(snapshot.performanceRecords, project.id);
  const leave = projectLeave(snapshot.leaveRecords, project.id);
  const weekStartsOn = useSettingsStore((state) => state.weekStartsOn);

  const overtimeGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        startKey: string;
        endKey: string;
        records: Array<(typeof overtime)[number]>;
      }
    >();
    for (const record of overtime) {
      const date = parseDateKey(record.date);
      if (!date) continue;
      const start = startOfWeek(date, weekStartsOn);
      const startKey = toDateKey(start);
      const endKey = toDateKey(endOfWeek(date, weekStartsOn));
      const existing = groups.get(startKey);
      if (existing) existing.records.push(record);
      else groups.set(startKey, { startKey, endKey, records: [record] });
    }
    const thisWeekStart = toDateKey(startOfWeek(new Date(), weekStartsOn));
    return [...groups.entries()]
      .map(([key, group]) => {
        const weekOffset = diffDays(thisWeekStart, key);
        const relative =
          weekOffset === 0
            ? '本周'
            : weekOffset === 7
              ? '下周'
              : weekOffset === -7
                ? '上周'
                : '';
        const records = [...group.records].sort((a, b) => a.date.localeCompare(b.date));
        const doneHours =
          Math.round(
            records
              .filter((record) => record.status === 'done')
              .reduce((sum, record) => sum + record.hours, 0) * 10,
          ) / 10;
        return {
          key,
          startKey: group.startKey,
          endKey: group.endKey,
          relative,
          records,
          doneCount: records.filter((record) => record.status === 'done').length,
          absentCount: records.filter((record) => record.status === 'absent').length,
          plannedCount: records.filter((record) => record.status === 'planned').length,
          doneHours,
        };
      })
      .sort((a, b) => b.startKey.localeCompare(a.startKey));
  }, [overtime, weekStartsOn]);
  const meta = projectMeta(snapshot.projectMetaFields, project.id);
  const active = members.filter((member) => member.status === 'active');
  const released = members.filter((member) => member.status === 'released');
  const memberById = new Map(members.map((member) => [member.id, member]));
  const tenures = projectTenures(snapshot.memberTenures, project.id);
  const tenureSummaries = tenureSummaryForProject(
    snapshot.memberTenures,
    members,
    project.id,
  );
  const tenureStats = projectTenureStats(tenureSummaries);
  const filteredTenures = tenures.filter((tenure) => {
    if (tenureMemberFilter && tenure.memberId !== tenureMemberFilter) return false;
    return tenureOverlapsRange(tenure, tenureFrom, tenureTo);
  });
  const monthPerformance = performance.filter((record) => record.date.startsWith(month));
  const performanceRows = performanceByMember(performance, month);
  const overtimeTotal = overtimeHoursInMonth(overtime, month);
  const overtimeAbsenceTotal = overtimeAbsenceCountInMonth(overtime, month);
  const performanceNet = monthPerformance.reduce((sum, record) => sum + record.points, 0);
  const leaveMonthDays = leaveDaysInMonth(leave, month);
  const leaveTotalDays = leaveDaysTotal(leave);
  const portraits = memberPortraits(
    {
      members: snapshot.teamMembers,
      tenures: snapshot.memberTenures,
      overtime: snapshot.overtimeRecords,
      leave: snapshot.leaveRecords,
      performance: snapshot.performanceRecords,
      roles: snapshot.projectRoles,
    },
    project.id,
  );
  const leaveGroups = useMemo(() => {
    const groups = new Map<string, { key: string; records: LeaveRecord[]; days: number }>();
    for (const record of leave) {
      const key = record.startDate.slice(0, 7) || '未知月份';
      const existing = groups.get(key);
      if (existing) existing.records.push(record);
      else groups.set(key, { key, records: [record], days: 0 });
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        records: [...group.records].sort((a, b) => b.startDate.localeCompare(a.startDate)),
        days: leaveDaysTotal(group.records),
      }))
      .sort((a, b) => b.key.localeCompare(a.key));
  }, [leave]);
  const roleCounts = roles.map((role) => ({
    ...role,
    count: active.filter((member) => member.roleId === role.id).length,
  }));

  const releaseMember = async (member: TeamMember) => {
    const confirmed = await requestConfirm({
      title: `释放成员「${member.name}」`,
      description: '成员状态改为已释放，历史记录保留，随时可以回归。',
      confirmLabel: '释放成员',
    });
    if (!confirmed) return;
    await updateMember(member.id, {
      status: 'released',
      releasedAt: todayLocalDate(),
    }).catch(() => undefined);
  };

  const removeMember = async (member: TeamMember) => {
    const confirmed = await requestConfirm({
      title: `删除成员「${member.name}」`,
      description: '成员会从项目中移除，加班与绩效记录会一起删除。',
      confirmLabel: '删除成员',
      tone: 'danger',
    });
    if (!confirmed) return;
    await deleteMember(member.id).catch(() => undefined);
  };

  const removeRole = async (role: ProjectRole) => {
    const confirmed = await requestConfirm({
      title: `删除角色「${role.name}」`,
      description: '角色会从项目中移除，成员的角色分配会一并清空。',
      confirmLabel: '删除角色',
      tone: 'danger',
    });
    if (!confirmed) return;
    await deleteRole(role.id).catch((reason) => {
      notify(reason instanceof Error ? reason.message : String(reason), 'danger');
    });
  };

  const removeMeta = async (field: ProjectMetaField) => {
    const confirmed = await requestConfirm({
      title: `删除元数据「${field.name}」`,
      description: '这个自定义字段会从项目中移除，已经填写的值也会消失。',
      confirmLabel: '删除字段',
      tone: 'danger',
    });
    if (!confirmed) return;
    await deleteMeta(field.id).catch(() => undefined);
  };

  const removeTenure = async (tenure: MemberTenure) => {
    const confirmed = await requestConfirm({
      title: '删除这一段投入记录',
      description: '成员状态会按剩余时间段重新计算。',
      confirmLabel: '删除记录',
      tone: 'danger',
    });
    if (!confirmed) return;
    await deleteTenure(tenure.id).catch(() => undefined);
  };

  const archiveProject = async () => {
    await updateProject(project.id, {
      status: project.status === 'active' ? 'archived' : 'active',
    }).catch(() => undefined);
  };

  const removeProject = async () => {
    const confirmed = await requestConfirm({
      title: `删除项目「${project.name}」`,
      description: '项目内所有成员、角色、元数据、加班与绩效都会删除，且不可恢复。',
      confirmLabel: '删除项目',
      tone: 'danger',
    });
    if (!confirmed) return;
    await deleteProject(project.id).catch(() => undefined);
    navigate('/team');
  };

  return (
    <div className="page team-page project-detail">
      <div className="project-detail-head">
        <Link className="btn btn-ghost btn-sm project-back" to="/team">
          <Icon name="arrow-left" size={14} /> 项目空间
        </Link>
        <span className="grow" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void archiveProject()}>
          {project.status === 'active' ? '归档项目' : '恢复项目'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void removeProject()}>
          删除项目
        </button>
      </div>

      <header
        className="project-hero"
        style={{ '--project-color': project.color } as React.CSSProperties}
      >
        <span className="project-hero-dot" />
        <div className="project-hero-main">
          <div className="project-hero-title">
            <h1>{project.name}</h1>
            <span className={`project-status-badge${project.status === 'archived' ? ' is-archived' : ''}`}>
              {project.status === 'active' ? '进行中' : '已归档'}
            </span>
            <button
              type="button"
              className={`project-star-button${project.starred ? ' is-on' : ''}`}
              aria-label={project.starred ? '取消星标' : '星标项目'}
              onClick={() =>
                void updateProject(project.id, { starred: !project.starred }).catch(
                  () => undefined,
                )
              }
            >
              ★
            </button>
          </div>
          <p>{project.description || '还没有项目说明，可在下方「项目设置」补充。'}</p>
          <div className="project-meta-chips">
            {meta.length === 0 ? <span className="is-muted">暂无自定义元数据</span> : null}
            {meta.map((field) => (
              <span key={field.id}>
                {field.name}
                {field.value ? `：${field.value}` : ''}
              </span>
            ))}
          </div>
        </div>
        <div className="project-hero-stats">
          <div>
            <strong>{active.length}</strong>
            <span>在组</span>
          </div>
          <div>
            <strong>{released.length}</strong>
            <span>已释放</span>
          </div>
          <div>
            <strong>{overtimeTotal}h</strong>
            <span>
              本月加班
              {overtimeAbsenceTotal > 0 ? ` · 未出勤 ${overtimeAbsenceTotal}` : ''}
            </span>
          </div>
          <div>
            <strong>{performanceNet > 0 ? '+' : ''}{performanceNet}</strong>
            <span>本月绩效</span>
          </div>
          <div>
            <strong>{formatLeaveDays(leaveMonthDays)}<em>天</em></strong>
            <span>本月请假</span>
          </div>
        </div>
      </header>

      <div className="team-toolbar">
        <div className="team-tabs" role="tablist" aria-label="项目视图">
          {[
            { key: 'members', label: '成员', count: members.length },
            { key: 'tenures', label: '投入记录', count: tenures.length },
            { key: 'leave', label: '请假记录', count: leave.length },
            { key: 'overtime', label: '周末加班', count: overtime.length },
            { key: 'performance', label: '绩效加减分', count: performance.length },
            { key: 'portrait', label: '用户画像', count: portraits.length },
            { key: 'settings', label: '项目设置', count: roles.length + meta.length },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={`team-tab${tab === item.key ? ' is-active' : ''}`}
              onClick={() => setTab(item.key as Tab)}
            >
              {item.label} <span>{item.count}</span>
            </button>
          ))}
        </div>
        <span className="grow" />
        {tab === 'members' ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setMemberModal('new');
              setMemberOpen(true);
            }}
            disabled={roles.length === 0}
            title={roles.length === 0 ? '请先在项目设置中添加角色' : undefined}
          >
            <Icon name="plus" size={14} /> 添加成员
          </button>
        ) : null}
        {tab === 'tenures' ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setTenureEditing(null);
              setTenureOpen(true);
            }}
            disabled={members.length === 0}
          >
            <Icon name="plus" size={14} /> 添加时间段
          </button>
        ) : null}
        {tab === 'leave' ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setLeaveEditing(null);
              setLeaveOpen(true);
            }}
            disabled={members.length === 0}
          >
            <Icon name="plus" size={14} /> 请假记录
          </button>
        ) : null}
        {tab === 'overtime' ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setOvertimeEditing(null);
              setOvertimeOpen(true);
            }}
            disabled={members.length === 0}
          >
            <Icon name="plus" size={14} /> 加班记录
          </button>
        ) : null}
        {tab === 'performance' ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setPerformanceOpen(true)}
            disabled={members.length === 0}
          >
            <Icon name="plus" size={14} /> 绩效记录
          </button>
        ) : null}
        {tab === 'overtime' || tab === 'performance' ? (
          <label className="team-month">
            统计月份
            <input
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value || monthKey())}
              aria-label="项目统计月份"
            />
          </label>
        ) : null}
      </div>

      {tab === 'members' ? (
        <section className="team-panel">
          {members.length === 0 ? (
            <div className="team-empty">
              <EmptyState
                icon={<Icon name="users" size={22} />}
                title="项目还没有成员"
                description="先添加成员并选择项目自定义角色；同一成员可分别加入不同项目。"
                action={
                  roles.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        setMemberModal('new');
                        setMemberOpen(true);
                      }}
                    >
                      添加第一个成员
                    </button>
                  ) : (
                    <button type="button" className="btn btn-primary" onClick={() => setTab('settings')}>
                      先配置角色
                    </button>
                  )
                }
              />
            </div>
          ) : (
            <div className="team-member-list">
              {members.map((member) => (
                <article
                  className={`team-member-row${member.status === 'released' ? ' is-released' : ''}`}
                  key={member.id}
                >
                  <span className="team-avatar">{initials(member.name)}</span>
                  <div className="team-member-main">
                    <div className="team-member-title">
                      <h3>{member.name}</h3>
                      <span
                        className="team-role"
                        style={{
                          backgroundColor: `${roleColor(roles, member.roleId)}18`,
                          color: roleColor(roles, member.roleId),
                        }}
                      >
                        {roleName(roles, member.roleId)}
                      </span>
                      <span className={`team-status status-${member.status}`}>
                        {member.status === 'active' ? '在组' : '已释放'}
                      </span>
                    </div>
                    <div className="team-member-meta">
                      <span>入组 {formatDate(member.joinedAt)}</span>
                      {member.releasedAt ? <span>释放 {formatDate(member.releasedAt)}</span> : null}
                      {member.note ? <span className="team-member-note">{member.note}</span> : null}
                    </div>
                  </div>
                  <div className="team-member-actions">
                    {member.status === 'active' ? (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void releaseMember(member)}>
                        释放
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          void updateMember(member.id, {
                            status: 'active',
                            releasedAt: null,
                          }).catch(() => undefined)
                        }
                      >
                        回归
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-icon"
                      aria-label={`编辑 ${member.name}`}
                      onClick={() => {
                        setMemberModal(member);
                        setMemberOpen(true);
                      }}
                    >
                      <Icon name="pencil" size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon"
                      aria-label={`删除 ${member.name}`}
                      onClick={() => void removeMember(member)}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {tab === 'tenures' ? (
        <section className="team-panel tenure-panel">
          <div className="tenure-stats">
            <div className="tenure-stat">
              <span>累计投入</span>
              <strong>{tenureStats.totalDays}<em>人天</em></strong>
              <small>{tenureStats.segmentCount} 个时间段</small>
            </div>
            <div className="tenure-stat">
              <span>当前在组</span>
              <strong>{tenureStats.activeMembers}<em>人</em></strong>
              <small>开放时间段</small>
            </div>
            <div className="tenure-stat">
              <span>已释放成员</span>
              <strong>{tenureStats.historicalMembers}<em>人</em></strong>
              <small>已有出组记录</small>
            </div>
            <div className="tenure-stat">
              <span>人均投入</span>
              <strong>{tenureStats.averageDays}<em>天</em></strong>
              <small>按在册成员计算</small>
            </div>
          </div>

          <div className="tenure-filterbar">
            <label>
              成员
              <select
                className="select"
                value={tenureMemberFilter}
                onChange={(event) => setTenureMemberFilter(event.target.value)}
                aria-label="投入记录成员筛选"
              >
                <option value="">全部成员</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              从
              <DatePicker
                value={tenureFrom}
                onChange={setTenureFrom}
                ariaLabel="投入记录开始日期"
                placeholder="开始日期"
              />
            </label>
            <label>
              到
              <DatePicker
                value={tenureTo}
                onChange={setTenureTo}
                ariaLabel="投入记录结束日期"
                placeholder="结束日期"
              />
            </label>
            {tenureMemberFilter || tenureFrom || tenureTo ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setTenureMemberFilter('');
                  setTenureFrom('');
                  setTenureTo('');
                }}
              >
                清除筛选
              </button>
            ) : null}
            <span className="grow" />
            <span className="tenure-filter-count">{filteredTenures.length} 段</span>
          </div>

          {tenures.length === 0 ? (
            <div className="tenure-empty">
              <EmptyState
                icon={<Icon name="calendar-view" size={22} />}
                title="还没有投入记录"
                description="成员加入项目时会自动生成第一段；释放后再次加入会生成新的时间段。"
                action={
                  members.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        setTenureEditing(null);
                        setTenureOpen(true);
                      }}
                    >
                      添加时间段
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <>
              <div className="tenure-member-summary">
                <div className="tenure-member-summary-head">
                  <span>成员投入汇总</span>
                  <span>在册 {members.length} 人</span>
                </div>
                {tenureSummaries.map((summary) => (
                  <div className="tenure-member-row" key={summary.member.id}>
                    <span className="team-avatar">{initials(summary.member.name)}</span>
                    <div className="tenure-member-main">
                      <strong>{summary.member.name}</strong>
                      <span>
                        {roleName(roles, summary.member.roleId)} ·{' '}
                        {summary.active ? '在组' : '已释放'} · {summary.segments.length} 段
                      </span>
                    </div>
                    <span className="tenure-member-first">
                      {summary.firstStartedAt ? formatDate(summary.firstStartedAt) : '—'} 起
                    </span>
                    <span className="tenure-member-total">{summary.totalDays} 天</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setTenureMemberFilter(summary.member.id)}
                    >
                      查看
                    </button>
                  </div>
                ))}
              </div>

              <div className="tenure-segments">
                <div className="tenure-segments-head">
                  <span>时间段明细</span>
                  <span>{filteredTenures.length} 条</span>
                </div>
                {filteredTenures.length === 0 ? (
                  <p className="tenure-filter-empty">当前筛选条件下没有投入记录。</p>
                ) : (
                  filteredTenures.map((tenure) => {
                    const member = memberById.get(tenure.memberId);
                    return (
                      <div className="tenure-segment-row" key={tenure.id}>
                        <span className="tenure-segment-member">
                          {member?.name ?? '未知成员'}
                        </span>
                        <span className="tenure-segment-range">
                          {formatDate(tenure.startedAt)} → {tenure.endedAt ? formatDate(tenure.endedAt) : '至今'}
                        </span>
                        <span className={`tenure-segment-days${tenure.endedAt === null ? ' is-active' : ''}`}>
                          {tenureDays(tenure)} 天
                        </span>
                        <span className="tenure-segment-note">
                          {tenure.note || (tenure.endedAt === null ? '当前投入中' : '')}
                        </span>
                        <span className="grow" />
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setTenureEditing(tenure);
                            setTenureOpen(true);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label="删除投入时间段"
                          onClick={() => void removeTenure(tenure)}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </section>
      ) : null}

      {tab === 'leave' ? (
        <section className="team-panel">
          {leave.length === 0 ? (
            <div className="team-empty">
              <EmptyState
                icon={<Icon name="calendar" size={22} />}
                title="还没有本项目的请假记录"
                description="登记成员的请假区间、天数与事由即可。这里只做留档，不需要审批 —— 同事请假时已经同意过。"
              />
            </div>
          ) : (
            <>
              <div className="leave-summary">
                <div>
                  <strong>{leave.length}</strong>
                  <span>请假记录</span>
                </div>
                <div>
                  <strong>{formatLeaveDays(leaveTotalDays)}<em>天</em></strong>
                  <span>累计请假</span>
                </div>
                <div>
                  <strong>{formatLeaveDays(leaveMonthDays)}<em>天</em></strong>
                  <span>本月请假</span>
                </div>
              </div>
              <div className="leave-months">
                {leaveGroups.map((group) => (
                  <section className="leave-month" key={group.key}>
                    <div className="leave-month-head">
                      <span className="leave-month-title">
                        {group.key === '未知月份' ? group.key : formatMonthCN(group.key)}
                      </span>
                      <span className="leave-month-total">
                        <span className="leave-month-stat">{group.records.length} 条</span>
                        <span className="leave-month-stat is-approved">
                          {formatLeaveDays(group.days)} 天
                        </span>
                      </span>
                    </div>
                    <div className="team-records">
                      {group.records.map((record) => {
                        const member = memberById.get(record.memberId);
                        return (
                          <article className="team-record team-leave-record" key={record.id}>
                            <div className="team-record-date">
                              <strong>{record.startDate.slice(5).replace('-', '/')}</strong>
                              <span>{formatLeaveDays(record.days)} 天</span>
                            </div>
                            <div className="team-record-main">
                              <div className="team-record-title">
                                {member?.name ?? '未知成员'}
                                <span className="team-leave-type">
                                  {leaveTypeLabel(record.leaveType)}
                                </span>
                              </div>
                              <div className="team-record-meta">
                                <span>
                                  {record.startDate} → {record.endDate}
                                </span>
                                <span>{record.reason}</span>
                                {record.note ? <span>{record.note}</span> : null}
                              </div>
                            </div>
                            <div className="team-record-actions">
                              <button
                                type="button"
                                className="btn btn-icon"
                                aria-label="编辑请假记录"
                                onClick={() => {
                                  setLeaveEditing(record);
                                  setLeaveOpen(true);
                                }}
                              >
                                <Icon name="pencil" size={13} />
                              </button>
                              <button
                                type="button"
                                className="btn btn-icon"
                                aria-label="删除请假记录"
                                onClick={() => {
                                  void requestConfirm({
                                    title: '删除这条请假记录',
                                    description: '这条记录会从项目统计与成员画像中移除。',
                                    confirmLabel: '删除记录',
                                    tone: 'danger',
                                  }).then((confirmed) => {
                                    if (!confirmed) return;
                                    void deleteLeave(record.id).catch(() => undefined);
                                  });
                                }}
                              >
                                <Icon name="trash" size={13} />
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </section>
      ) : null}

      {tab === 'overtime' ? (
        <section className="team-panel">
          {overtime.length === 0 ? (
            <div className="team-empty">
              <EmptyState
                icon={<Icon name="calendar" size={22} />}
                title="还没有本项目的加班记录"
                description="先排班，再按实际出勤标记「已出勤」或「未出勤」；未出勤需要填写原因，未出勤的小时数不计入加班合计。"
              />
            </div>
          ) : (
            <div className="overtime-weeks">
              {overtimeGroups.map((group) => (
                <section className="overtime-week" key={group.key}>
                  <div className="overtime-week-head">
                    <div className="overtime-week-title">
                      <span className="overtime-week-range">
                        {formatMonthDay(group.startKey)} – {formatMonthDay(group.endKey)}
                      </span>
                      {group.relative ? (
                        <span className={`overtime-week-badge${group.relative === '本周' ? ' is-current' : ''}`}>
                          {group.relative}
                        </span>
                      ) : null}
                    </div>
                    <span className="overtime-week-total">
                      <span className="overtime-week-stat is-done">
                        已出勤 {group.doneCount} 条 · {group.doneHours}h
                      </span>
                      {group.absentCount > 0 ? (
                        <span className="overtime-week-stat is-absent">
                          未出勤 {group.absentCount} 条
                        </span>
                      ) : null}
                      {group.plannedCount > 0 ? (
                        <span className="overtime-week-stat">
                          排班 {group.plannedCount} 条
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div className="team-records">
                    {group.records.map((record) => {
                      const member = memberById.get(record.memberId);
                      return (
                        <article
                          className={`team-record${record.status === 'done' ? ' is-done' : ''}${
                            record.status === 'absent' ? ' is-absent' : ''
                          }`}
                          key={record.id}
                        >
                          <div className="team-record-date">
                            <strong>{record.date.slice(5).replace('-', '/')}</strong>
                            <span className={isWeekend(record.date) ? 'is-weekend' : ''}>
                              {isWeekend(record.date) ? '周末' : '工作日'}
                            </span>
                          </div>
                          <div className="team-record-main">
                            <div className="team-record-title">
                              {member?.name ?? '未知成员'}
                              <span className={`team-ot-status status-${record.status}`}>
                                {overtimeStatusLabel(record.status)}
                              </span>
                              {record.status === 'absent' ? (
                                <span className="team-ot-flag">工时未计入</span>
                              ) : null}
                            </div>
                            <div className="team-record-meta">
                              <span>
                                {record.status === 'done'
                                  ? `${record.hours} 小时`
                                  : `排班 ${record.hours} 小时`}
                              </span>
                              {record.note ? <span>{record.note}</span> : null}
                            </div>
                            {record.status === 'absent' ? (
                              <div className="team-record-reason">
                                <span className="team-record-reason-label">未出勤原因</span>
                                <span className="team-record-reason-text">
                                  {record.absenceReason || '未填写原因'}
                                </span>
                              </div>
                            ) : null}
                          </div>
                          <div className="team-record-actions">
                            {record.status === 'done' ? (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() =>
                                  void updateOvertime(record.id, {
                                    status: 'planned',
                                  }).catch(() => undefined)
                                }
                              >
                                改回排班
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() =>
                                  void updateOvertime(record.id, {
                                    status: 'done',
                                  }).catch(() => undefined)
                                }
                              >
                                标记已出勤
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setOvertimeAbsence(record)}
                            >
                              {record.status === 'absent' ? '修改原因' : '标记未出勤'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-icon"
                              aria-label="编辑加班记录"
                              onClick={() => {
                                setOvertimeEditing(record);
                                setOvertimeOpen(true);
                              }}
                            >
                              <Icon name="pencil" size={13} />
                            </button>
                            <button
                              type="button"
                              className="btn btn-icon"
                              aria-label="删除加班记录"
                              onClick={() => {
                                void requestConfirm({
                                  title: '删除这条加班记录',
                                  description: '这条记录会从项目统计中移除。',
                                  confirmLabel: '删除记录',
                                  tone: 'danger',
                                }).then((confirmed) => {
                                  if (!confirmed) return;
                                  void deleteOvertime(record.id).catch(() => undefined);
                                });
                              }}
                            >
                              <Icon name="trash" size={13} />
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {tab === 'performance' ? (
        <section className="team-panel">
          {performance.length === 0 ? (
            <div className="team-empty">
              <EmptyState
                icon={<Icon name="target" size={22} />}
                title="本项目还没有绩效记录"
                description="加分填正数、减分填负数；绩效按项目独立汇总排名。"
              />
            </div>
          ) : (
            <>
              <div className="team-ranking">
                {performanceRows.map((row, index) => (
                  <div className="team-rank" key={row.memberId}>
                    <span className="team-rank-index">{index + 1}</span>
                    <span className="team-rank-name">
                      {memberById.get(row.memberId)?.name ?? '未知成员'}
                    </span>
                    <span className="team-rank-detail">
                      <em className="is-plus">+{row.plus}</em>
                      <em className="is-minus">-{row.minus}</em>
                      <strong className={row.total < 0 ? 'is-negative' : ''}>
                        {row.total > 0 ? '+' : ''}
                        {row.total}
                      </strong>
                    </span>
                  </div>
                ))}
              </div>
              <div className="team-records">
                {performance.map((record) => {
                  const member = memberById.get(record.memberId);
                  return (
                    <article className="team-record team-performance-record" key={record.id}>
                      <div className={`team-points${record.points > 0 ? ' is-plus' : ' is-minus'}`}>
                        {record.points > 0 ? '+' : ''}
                        {record.points}
                      </div>
                      <div className="team-record-main">
                        <div className="team-record-title">
                          {member?.name ?? '未知成员'}
                          <span className="team-performance-category">
                            {performanceCategoryLabel(record.category)}
                          </span>
                        </div>
                        <div className="team-record-meta">
                          <span>{formatDate(record.date)}</span>
                          <span>{record.reason}</span>
                          {record.note ? <span>{record.note}</span> : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label="删除绩效记录"
                        onClick={() => {
                          void requestConfirm({
                            title: '删除这条绩效记录',
                            description: '这条记录会从项目统计中移除。',
                            confirmLabel: '删除记录',
                            tone: 'danger',
                          }).then((confirmed) => {
                            if (!confirmed) return;
                            void deletePerformance(record.id).catch(() => undefined);
                          });
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </section>
      ) : null}

      {tab === 'portrait' ? (
        <section className="team-panel">
          {portraits.length === 0 ? (
            <div className="team-empty">
              <EmptyState
                icon={<Icon name="users" size={22} />}
                title="本项目还没有成员画像"
                description="先在「成员」页添加成员；画像会自动汇总投入人天、周末加班、请假与绩效四个维度。"
              />
            </div>
          ) : (
            <>
              <div className="portrait-legend">
                <span>画像按投入人天排序，标签由本项目的投入、加班、请假与绩效数据推导</span>
                <span className="portrait-legend-keys">
                  <em className="is-positive">正向</em>
                  <em className="is-neutral">中性</em>
                  <em className="is-warning">需关注</em>
                </span>
              </div>
              <div className="portrait-grid">
                {portraits.map((portrait) => {
                  const rate = portrait.attendanceRate;
                  return (
                    <article className="portrait-card" key={portrait.member.id}>
                      <header className="portrait-head">
                        <span className="team-avatar">{initials(portrait.member.name)}</span>
                        <div className="portrait-head-main">
                          <div className="portrait-title">
                            <h3>{portrait.member.name}</h3>
                            <span
                              className="team-role"
                              style={{
                                backgroundColor: `${portrait.roleColor}18`,
                                color: portrait.roleColor,
                              }}
                            >
                              {portrait.roleName}
                            </span>
                            <span className={`team-status status-${portrait.member.status}`}>
                              {portrait.member.status === 'active' ? '在组' : '已释放'}
                            </span>
                          </div>
                          <p className="portrait-sub">
                            入组 {formatDate(portrait.member.joinedAt)} · 投入{' '}
                            {portrait.tenureSegments} 段
                          </p>
                        </div>
                      </header>

                      <div className="portrait-metrics">
                        <div className="portrait-metric">
                          <strong>{portrait.tenureDays}<em>天</em></strong>
                          <span>累计投入</span>
                        </div>
                        <div className="portrait-metric">
                          <strong>{portrait.overtimeHours}<em>h</em></strong>
                          <span>累计加班</span>
                        </div>
                        <div className="portrait-metric">
                          <strong>{formatLeaveDays(portrait.leaveDays)}<em>天</em></strong>
                          <span>累计请假</span>
                        </div>
                        <div className="portrait-metric">
                          <strong>
                            {portrait.performancePoints > 0 ? '+' : ''}
                            {portrait.performancePoints}
                          </strong>
                          <span>绩效净分</span>
                        </div>
                      </div>

                      <div className="portrait-meter">
                        <div className="portrait-meter-head">
                          <span>周末出勤率</span>
                          <strong>
                            {rate === null
                              ? '暂无排班'
                              : `${Math.round(rate * 100)}%（${portrait.overtimeDone}/${portrait.overtimeDone + portrait.overtimeAbsent}）`}
                          </strong>
                        </div>
                        <div className="portrait-meter-track">
                          <span
                            className="portrait-meter-fill"
                            style={{ width: `${rate === null ? 0 : Math.round(rate * 100)}%` }}
                          />
                        </div>
                      </div>

                      {portrait.tags.length > 0 ? (
                        <div className="portrait-tags">
                          {portrait.tags.map((tag) => (
                            <span className={`portrait-tag is-${tag.tone}`} key={tag.key}>
                              {tag.label}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="portrait-tags">
                          <span className="portrait-tag is-neutral">暂无画像标签</span>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </section>
      ) : null}

      {tab === 'settings' ? (
        <section className="project-settings-grid">
          <div className="team-panel project-settings-panel">
            <div className="project-settings-head">
              <div>
                <h3>角色</h3>
                <p>每个项目维护自己的角色名称与颜色，成员可自由分配。</p>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setRoleEditing(null);
                  setRoleOpen(true);
                }}
              >
                <Icon name="plus" size={13} /> 添加角色
              </button>
            </div>
            <div className="project-role-list">
              {roleCounts.map((role) => (
                <div className="project-role-row" key={role.id}>
                  <span className="project-role-color" style={{ backgroundColor: role.color }} />
                  <strong>{role.name}</strong>
                  <span className="project-role-count">{role.count} 人</span>
                  <span className="grow" />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setRoleEditing(role);
                      setRoleOpen(true);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon"
                    aria-label={`删除角色 ${role.name}`}
                    onClick={() => void removeRole(role)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
              {roleCounts.length === 0 ? <p className="project-empty-hint">还没有角色。</p> : null}
            </div>
          </div>

          <div className="team-panel project-settings-panel">
            <div className="project-settings-head">
              <div>
                <h3>项目元数据</h3>
                <p>自由添加客户、阶段、预算、上线日期等自定义字段。</p>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setMetaEditing(null);
                  setMetaOpen(true);
                }}
              >
                <Icon name="plus" size={13} /> 添加字段
              </button>
            </div>
            <div className="project-meta-list">
              {meta.map((field) => (
                <div className="project-meta-row" key={field.id}>
                  <div>
                    <strong>{field.name}</strong>
                    <span>{field.value || '空值'}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setMetaEditing(field);
                      setMetaOpen(true);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon"
                    aria-label={`删除元数据 ${field.name}`}
                    onClick={() => void removeMeta(field)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
              {meta.length === 0 ? <p className="project-empty-hint">还没有自定义元数据。</p> : null}
            </div>
          </div>
        </section>
      ) : null}

      <MemberModal
        open={memberOpen}
        project={project}
        roles={roles}
        member={memberModal === 'new' ? null : memberModal}
        onClose={() => setMemberOpen(false)}
        onSubmit={async (input) => {
          if (memberModal && memberModal !== 'new') {
            await updateMember(memberModal.id, input);
          } else {
            await useAppStore.getState().createTeamMember({
              projectId: project.id,
              ...input,
            });
          }
          setMemberOpen(false);
        }}
      />
      <OvertimeModal
        open={overtimeOpen}
        members={members}
        record={overtimeEditing}
        onClose={() => {
          setOvertimeOpen(false);
          setOvertimeEditing(null);
        }}
        onSubmit={async (input) => {
          if (overtimeEditing) {
            await updateOvertime(overtimeEditing.id, {
              memberId: input.memberId,
              date: input.date,
              hours: input.hours,
              status: input.status,
              absenceReason: input.absenceReason,
              note: input.note,
            });
          } else {
            await createOvertime(input);
          }
          setOvertimeOpen(false);
          setOvertimeEditing(null);
        }}
      />
      <AbsenceReasonModal
        record={overtimeAbsence}
        memberName={
          overtimeAbsence
            ? memberById.get(overtimeAbsence.memberId)?.name ?? '未知成员'
            : ''
        }
        onClose={() => setOvertimeAbsence(null)}
        onSubmit={async (reason) => {
          if (!overtimeAbsence) return;
          await updateOvertime(overtimeAbsence.id, {
            status: 'absent',
            absenceReason: reason,
          });
          setOvertimeAbsence(null);
        }}
      />
      <PerformanceModal
        open={performanceOpen}
        members={members}
        onClose={() => setPerformanceOpen(false)}
        onSubmit={async (input) => {
          await createPerformance(input);
          setPerformanceOpen(false);
        }}
      />
      <LeaveModal
        open={leaveOpen}
        members={members}
        record={leaveEditing}
        onClose={() => {
          setLeaveOpen(false);
          setLeaveEditing(null);
        }}
        onSubmit={async (input) => {
          if (leaveEditing) {
            await updateLeave(leaveEditing.id, {
              memberId: input.memberId,
              startDate: input.startDate,
              endDate: input.endDate,
              days: input.days,
              leaveType: input.leaveType,
              reason: input.reason,
              note: input.note,
            });
          } else {
            await createLeave(input);
          }
          setLeaveOpen(false);
          setLeaveEditing(null);
        }}
      />
      <TenureModal
        open={tenureOpen}
        members={members}
        tenure={tenureEditing}
        defaultMemberId={tenureMemberFilter}
        onClose={() => setTenureOpen(false)}
        onSubmit={async (input) => {
          if (tenureEditing) {
            await updateTenure(tenureEditing.id, {
              startedAt: input.startedAt,
              endedAt: input.endedAt,
              note: input.note,
            });
          } else {
            await createTenure(input);
          }
          setTenureOpen(false);
        }}
      />
      <RoleModal
        open={roleOpen}
        role={roleEditing}
        projectId={project.id}
        onClose={() => setRoleOpen(false)}
        onSubmit={async (input) => {
          if (roleEditing) {
            await updateRole(roleEditing.id, input);
          } else {
            await createRole({ projectId: project.id, ...input });
          }
          setRoleOpen(false);
        }}
      />
      <MetaModal
        open={metaOpen}
        field={metaEditing}
        projectId={project.id}
        onClose={() => setMetaOpen(false)}
        onSubmit={async (input) => {
          if (metaEditing) {
            await updateMeta(metaEditing.id, input);
          } else {
            await createMeta({ projectId: project.id, ...input });
          }
          setMetaOpen(false);
        }}
      />
    </div>
  );
}

// 成员表单：新增时可选角色；编辑时只能改姓名/角色/入组日期/备注。
function MemberModal({
  open,
  project,
  roles,
  member,
  onClose,
  onSubmit,
}: {
  open: boolean;
  project: Project;
  roles: ProjectRole[];
  member: TeamMember | null;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    roleId: string;
    joinedAt: string;
    note: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState('');
  const [joinedAt, setJoinedAt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(member?.name ?? '');
    setRoleId(member?.roleId ?? roles[0]?.id ?? '');
    setJoinedAt(member?.joinedAt ?? '');
    setNote(member?.note ?? '');
    setBusy(false);
    setError(null);
  }, [open, member, roles]);

  if (!open) return null;

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) {
      setError('请填写成员姓名');
      return;
    }
    if (!roleId) {
      setError('请选择角色');
      return;
    }
    if (!joinedAt) {
      setError('请选择入组日期');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), roleId, joinedAt, note: note.trim() });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={member ? '编辑项目成员' : '添加项目成员'}
      subtitle={`${project.name} · 角色由项目自定义`}
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="team-form">
        <label className="team-form-field">
          <span>姓名 / 花名</span>
          <input
            className="input"
            value={name}
            autoFocus
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            aria-label="项目成员姓名"
          />
        </label>
        <div className="team-form-grid">
          <label className="team-form-field">
            <span>角色</span>
            <select
              className="select"
              value={roleId}
              onChange={(event) => setRoleId(event.target.value)}
              aria-label="项目成员角色"
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
          <label className="team-form-field">
            <span>入组日期{member ? '（在投入记录中维护）' : ''}</span>
            <DatePicker
              value={joinedAt}
              onChange={setJoinedAt}
              disabled={member !== null}
              ariaLabel="项目成员入组日期"
            />
          </label>
        </div>
        {member ? (
          <p className="team-weekend-note">
            成员的多次入组/出组请到「投入记录」标签页维护，那里可以添加、编辑、删除每一段时间。
          </p>
        ) : null}
        <label className="team-form-field">
          <span>备注</span>
          <textarea
            className="input team-form-textarea"
            value={note}
            maxLength={160}
            onChange={(event) => setNote(event.target.value)}
            aria-label="项目成员备注"
          />
        </label>
        {error ? <p className="team-form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}

function OvertimeModal({
  open,
  members,
  record,
  onClose,
  onSubmit,
}: {
  open: boolean;
  members: TeamMember[];
  record: OvertimeRecord | null;
  onClose: () => void;
  onSubmit: (input: {
    memberId: string;
    date: string;
    hours: number;
    status: OvertimeStatus;
    absenceReason: string;
    note: string;
  }) => Promise<void>;
}) {
  const [memberId, setMemberId] = useState('');
  const [date, setDate] = useState('');
  const [hours, setHours] = useState('8');
  const [status, setStatus] = useState<OvertimeStatus>('planned');
  const [absenceReason, setAbsenceReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMemberId(record?.memberId ?? members[0]?.id ?? '');
    setDate(record?.date ?? '');
    setHours(record ? String(record.hours) : '8');
    setStatus(record?.status ?? 'planned');
    setAbsenceReason(record?.absenceReason ?? '');
    setNote(record?.note ?? '');
    setBusy(false);
    setError(null);
  }, [open, members, record]);

  if (!open) return null;

  const reasonCount = Array.from(absenceReason).length;

  const submit = async () => {
    if (busy) return;
    if (!date) {
      setError('请选择加班日期');
      return;
    }
    const parsed = Number(hours);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('请填写大于 0 的加班时长');
      return;
    }
    const absenceError = validateOvertimeAbsenceReason(status, absenceReason);
    if (absenceError) {
      setError(absenceError);
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        memberId,
        date,
        hours: parsed,
        status,
        absenceReason: status === 'absent' ? absenceReason.trim() : '',
        note: note.trim(),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={record ? '编辑加班记录' : '添加周末加班'}
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : record ? '保存修改' : '保存加班记录'}
          </button>
        </>
      }
    >
      <div className="team-form">
        <div className="team-form-grid">
          <label className="team-form-field">
            <span>成员</span>
            <select
              className="select"
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
              aria-label="加班成员"
            >
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                  {member.status === 'released' ? '（已释放）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="team-form-field">
            <span>日期</span>
            <DatePicker value={date} onChange={setDate} ariaLabel="加班日期" />
          </label>
          <label className="team-form-field">
            <span>时长（小时）</span>
            <input
              className="input"
              type="number"
              min={0.5}
              max={24}
              step={0.5}
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              aria-label="加班时长"
            />
          </label>
          <label className="team-form-field">
            <span>类型</span>
            <select
              className="select"
              value={status}
              onChange={(event) => setStatus(event.target.value as OvertimeStatus)}
              aria-label="加班状态"
            >
              <option value="planned">排班（待出勤）</option>
              <option value="done">已出勤</option>
              <option value="absent">未出勤</option>
            </select>
          </label>
        </div>
        <p className={`team-weekend-note${date && isWeekend(date) ? ' is-weekend' : ''}`}>
          {!date
            ? '选择日期后会自动判断是否为周末。'
            : isWeekend(date)
              ? '这一天是周末，适合安排加班。'
              : '提示：这一天不是周末，仍可记录调休/工作日加班。'}
        </p>
        {status === 'absent' ? (
          <label className="team-form-field">
            <span>未出勤原因（必填）</span>
            <textarea
              className="input team-form-textarea"
              value={absenceReason}
              maxLength={OVERTIME_ABSENCE_REASON_MAX}
              onChange={(event) => setAbsenceReason(event.target.value)}
              aria-label="未出勤原因"
              placeholder="例如：临时发烧请假、临时调休、家里有事…"
            />
            <span className="team-form-counter">
              {reasonCount}/{OVERTIME_ABSENCE_REASON_MAX} 字
            </span>
          </label>
        ) : null}
        <label className="team-form-field">
          <span>备注</span>
          <textarea
            className="input team-form-textarea"
            value={note}
            maxLength={180}
            onChange={(event) => setNote(event.target.value)}
            aria-label="加班备注"
          />
        </label>
        {error ? <p className="team-form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}

function AbsenceReasonModal({
  record,
  memberName,
  onClose,
  onSubmit,
}: {
  record: OvertimeRecord | null;
  memberName: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!record) return;
    setReason(record.absenceReason);
    setBusy(false);
    setError(null);
  }, [record]);

  if (!record) return null;

  const reasonCount = Array.from(reason).length;

  const submit = async () => {
    if (busy) return;
    const validation = validateOvertimeAbsenceReason('absent', reason);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(reason.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`标记未出勤 · ${memberName}`}
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : '确认未出勤'}
          </button>
        </>
      }
    >
      <div className="team-form">
        <p className="team-absence-hint">
          排班日期 {formatDate(record.date)} · 排班 {record.hours} 小时。未出勤记录不计入加班工时，
          原因会保留在这条记录上，便于事后追溯。
        </p>
        <label className="team-form-field">
          <span>未出勤原因（必填）</span>
          <textarea
            className="input team-form-textarea"
            value={reason}
            maxLength={OVERTIME_ABSENCE_REASON_MAX}
            onChange={(event) => setReason(event.target.value)}
            aria-label="未出勤原因"
            placeholder="例如：临时发烧请假、临时调休、家里有事…"
            autoFocus
          />
          <span className="team-form-counter">
            {reasonCount}/{OVERTIME_ABSENCE_REASON_MAX} 字
          </span>
        </label>
        {error ? <p className="team-form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}

function PerformanceModal({
  open,
  members,
  onClose,
  onSubmit,
}: {
  open: boolean;
  members: TeamMember[];
  onClose: () => void;
  onSubmit: (input: {
    memberId: string;
    date: string;
    points: number;
    reason: string;
    category: PerformanceCategory;
    note: string;
  }) => Promise<void>;
}) {
  const [memberId, setMemberId] = useState('');
  const [date, setDate] = useState('');
  const [points, setPoints] = useState('5');
  const [category, setCategory] = useState<PerformanceCategory>('delivery');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMemberId(members[0]?.id ?? '');
    setDate('');
    setPoints('5');
    setCategory('delivery');
    setReason('');
    setNote('');
    setBusy(false);
    setError(null);
  }, [open, members]);

  if (!open) return null;

  const submit = async () => {
    if (busy) return;
    if (!date) {
      setError('请选择绩效日期');
      return;
    }
    const value = Number(points);
    if (!Number.isFinite(value) || value === 0) {
      setError('绩效分值不能为 0，加分填正数、减分填负数');
      return;
    }
    if (!reason.trim()) {
      setError('请填写加减分原因');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        memberId,
        date,
        points: value,
        reason: reason.trim(),
        category,
        note: note.trim(),
      });
    } catch (reasonError) {
      setError(reasonError instanceof Error ? reasonError.message : String(reasonError));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="添加绩效加减分"
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : '保存绩效记录'}
          </button>
        </>
      }
    >
      <div className="team-form">
        <div className="team-form-grid">
          <label className="team-form-field">
            <span>成员</span>
            <select
              className="select"
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
              aria-label="绩效成员"
            >
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                  {member.status === 'released' ? '（已释放）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="team-form-field">
            <span>日期</span>
            <DatePicker value={date} onChange={setDate} ariaLabel="绩效日期" />
          </label>
          <label className="team-form-field">
            <span>分值（可负）</span>
            <input
              className="input"
              type="number"
              min={-100}
              max={100}
              step={1}
              value={points}
              onChange={(event) => setPoints(event.target.value)}
              aria-label="绩效分值"
            />
          </label>
          <label className="team-form-field">
            <span>维度</span>
            <select
              className="select"
              value={category}
              onChange={(event) => setCategory(event.target.value as PerformanceCategory)}
              aria-label="绩效维度"
            >
              {PERFORMANCE_CATEGORY_META.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="team-form-field">
          <span>原因</span>
          <input
            className="input"
            value={reason}
            maxLength={120}
            onChange={(event) => setReason(event.target.value)}
            aria-label="绩效原因"
          />
        </label>
        <label className="team-form-field">
          <span>补充说明（可选）</span>
          <textarea
            className="input team-form-textarea"
            value={note}
            maxLength={180}
            onChange={(event) => setNote(event.target.value)}
            aria-label="绩效补充说明"
          />
        </label>
        {error ? <p className="team-form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}

function LeaveModal({
  open,
  members,
  record,
  onClose,
  onSubmit,
}: {
  open: boolean;
  members: TeamMember[];
  record: LeaveRecord | null;
  onClose: () => void;
  onSubmit: (input: {
    memberId: string;
    startDate: string;
    endDate: string;
    days: number;
    leaveType: LeaveType;
    reason: string;
    note: string;
  }) => Promise<void>;
}) {
  const [memberId, setMemberId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [daysInput, setDaysInput] = useState('');
  const [leaveType, setLeaveType] = useState<LeaveType>('personal');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMemberId(record?.memberId ?? members[0]?.id ?? '');
    setStartDate(record?.startDate ?? '');
    setEndDate(record?.endDate ?? '');
    setDaysInput(record ? formatLeaveDays(record.days) : '');
    setLeaveType(record?.leaveType ?? 'personal');
    setReason(record?.reason ?? '');
    setNote(record?.note ?? '');
    setBusy(false);
    setError(null);
  }, [open, members, record]);

  if (!open) return null;

  const reasonCount = Array.from(reason).length;
  const spanDays = leaveSpanDays(startDate, endDate);
  const days = Number(daysInput);
  // 只允许两位小数：输入时就截断，避免提交后才发现被四舍五入。
  const handleDaysChange = (raw: string) => {
    const cleaned = raw.replace(/[^\d.]/g, '');
    if (cleaned === '') {
      setDaysInput('');
      return;
    }
    const value = Number(cleaned);
    if (!Number.isFinite(value)) return;
    const [intPart, decimalPart = ''] = cleaned.split('.');
    if (cleaned.includes('.')) {
      setDaysInput(`${intPart}.${decimalPart.slice(0, LEAVE_DAYS_DECIMALS)}`);
    } else {
      setDaysInput(intPart);
    }
  };

  const submit = async () => {
    if (busy) return;
    if (daysInput.trim() === '') {
      setError('请填写请假天数');
      return;
    }
    const parsedDays = Number(daysInput);
    const error_ = validateLeaveInput(startDate, endDate, parsedDays, reason);
    if (error_) {
      setError(error_);
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        memberId,
        startDate,
        endDate,
        days: parsedDays,
        leaveType,
        reason: reason.trim(),
        note: note.trim(),
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={record ? '编辑请假记录' : '添加请假记录'}
      subtitle="只做留档，不需要审批；天数按实际情况填写，最多两位小数"
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : record ? '保存修改' : '保存请假记录'}
          </button>
        </>
      }
    >
      <div className="team-form">
        <div className="team-form-grid">
          <label className="team-form-field">
            <span>成员</span>
            <select
              className="select"
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
              aria-label="请假成员"
            >
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                  {member.status === 'released' ? '（已释放）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="team-form-field">
            <span>请假类型</span>
            <select
              className="select"
              value={leaveType}
              onChange={(event) => setLeaveType(event.target.value as LeaveType)}
              aria-label="请假类型"
            >
              {LEAVE_TYPE_META.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="team-form-field">
            <span>开始日期</span>
            <DatePicker value={startDate} onChange={setStartDate} ariaLabel="请假开始日期" />
          </label>
          <label className="team-form-field">
            <span>结束日期</span>
            <DatePicker value={endDate} onChange={setEndDate} ariaLabel="请假结束日期" />
          </label>
          <label className="team-form-field">
            <span>请假天数</span>
            <input
              className="input"
              type="text"
              inputMode="decimal"
              value={daysInput}
              onChange={(event) => handleDaysChange(event.target.value)}
              aria-label="请假天数"
              placeholder="例如：3 或 0.5"
            />
            <span className="team-form-counter">
              {spanDays > 0
                ? `区间共 ${spanDays} 个自然日，按实际天数填写`
                : `最多 ${LEAVE_DAYS_MAX} 天，最多 ${LEAVE_DAYS_DECIMALS} 位小数`}
            </span>
          </label>
          <div className="team-form-field">
            <span>折算说明</span>
            <div className={`leave-days-preview${Number.isFinite(days) && days > 0 ? ' is-ready' : ''}`}>
              {Number.isFinite(days) && days > 0
                ? `${formatLeaveDays(days)} 天`
                : '填写后显示天数'}
            </div>
          </div>
        </div>
        <label className="team-form-field">
          <span>请假事由（必填）</span>
          <input
            className="input"
            value={reason}
            maxLength={LEAVE_REASON_MAX}
            onChange={(event) => setReason(event.target.value)}
            aria-label="请假事由"
            placeholder="例如：家里有事、家人生病、年假出行…"
          />
          <span className="team-form-counter">
            {reasonCount}/{LEAVE_REASON_MAX} 字
          </span>
        </label>
        <label className="team-form-field">
          <span>补充说明（可选）</span>
          <textarea
            className="input team-form-textarea"
            value={note}
            maxLength={180}
            onChange={(event) => setNote(event.target.value)}
            aria-label="请假补充说明"
          />
        </label>
        {error ? <p className="team-form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}

function TenureModal({
  open,
  members,
  tenure,
  defaultMemberId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  members: TeamMember[];
  tenure: MemberTenure | null;
  defaultMemberId: string;
  onClose: () => void;
  onSubmit: (input: {
    memberId: string;
    startedAt: string;
    endedAt: string | null;
    note: string;
  }) => Promise<void>;
}) {
  const [memberId, setMemberId] = useState('');
  const [startedAt, setStartedAt] = useState('');
  const [endedAt, setEndedAt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMemberId(tenure?.memberId || defaultMemberId || members[0]?.id || '');
    setStartedAt(tenure?.startedAt ?? '');
    setEndedAt(tenure?.endedAt ?? '');
    setNote(tenure?.note ?? '');
    setBusy(false);
    setError(null);
  }, [open, tenure, defaultMemberId, members]);

  if (!open) return null;

  const submit = async () => {
    if (busy) return;
    if (!memberId) {
      setError('请选择成员');
      return;
    }
    if (!startedAt) {
      setError('请选择入组日期');
      return;
    }
    if (endedAt && endedAt < startedAt) {
      setError('出组日期不能早于入组日期');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        memberId,
        startedAt,
        endedAt: endedAt || null,
        note: note.trim(),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={tenure ? '编辑投入时间段' : '添加投入时间段'}
      subtitle="一个成员可以有多段投入；时间段不能重叠，开放段最多一段"
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : '保存时间段'}
          </button>
        </>
      }
    >
      <div className="team-form">
        <label className="team-form-field">
          <span>成员</span>
          <select
            className="select"
            value={memberId}
            disabled={tenure !== null}
            onChange={(event) => setMemberId(event.target.value)}
            aria-label="投入记录成员"
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
        <div className="team-form-grid">
          <label className="team-form-field">
            <span>入组日期 / 开始</span>
            <DatePicker value={startedAt} onChange={setStartedAt} ariaLabel="投入记录开始" />
          </label>
          <label className="team-form-field">
            <span>出组日期 / 结束（留空=至今）</span>
            <DatePicker
              value={endedAt}
              onChange={setEndedAt}
              ariaLabel="投入记录结束"
              placeholder="留空表示至今"
            />
          </label>
        </div>
        <p className="team-weekend-note">
          留空表示该成员目前仍在项目中；释放/回归操作会自动创建或关闭时间段，之后可在这里修正具体日期。
        </p>
        <label className="team-form-field">
          <span>备注（可选）</span>
          <input
            className="input"
            value={note}
            maxLength={120}
            placeholder="例如：第一阶段开发、临时支援"
            onChange={(event) => setNote(event.target.value)}
            aria-label="投入记录备注"
          />
        </label>
        {error ? <p className="team-form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}

function RoleModal({
  open,
  role,
  projectId: _projectId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  role: ProjectRole | null;
  projectId: string;
  onClose: () => void;
  onSubmit: (input: { name: string; color: string }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>('#2f6fd0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? '');
    setColor(role?.color ?? '#2f6fd0');
    setBusy(false);
    setError(null);
  }, [open, role]);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim()) {
      setError('请填写角色名称');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), color });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={role ? '编辑角色' : '添加角色'}
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            保存角色
          </button>
        </>
      }
    >
      <div className="team-form">
        <label className="team-form-field">
          <span>角色名称</span>
          <input
            className="input"
            value={name}
            autoFocus
            maxLength={20}
            placeholder="例如：前端、后端、产品、数据"
            onChange={(event) => setName(event.target.value)}
            aria-label="角色名称"
          />
        </label>
        <div className="team-form-field">
          <span>颜色</span>
          <div className="project-color-picker">
            {PROJECT_COLORS.map((item) => (
              <button
                key={item}
                type="button"
                className={`project-color-option${color === item ? ' is-selected' : ''}`}
                style={{ backgroundColor: item }}
                aria-label={`角色颜色 ${item}`}
                onClick={() => setColor(item)}
              />
            ))}
            <input
              className="input project-color-input"
              value={color}
              maxLength={16}
              aria-label="自定义角色颜色"
              onChange={(event) => setColor(event.target.value)}
            />
          </div>
        </div>
        {error ? <p className="team-form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}

function MetaModal({
  open,
  field,
  projectId: _projectId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  field: ProjectMetaField | null;
  projectId: string;
  onClose: () => void;
  onSubmit: (input: { name: string; value: string }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(field?.name ?? '');
    setValue(field?.value ?? '');
    setBusy(false);
    setError(null);
  }, [open, field]);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim()) {
      setError('请填写字段名称');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), value });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={field ? '编辑项目元数据' : '添加项目元数据'}
      subtitle="字段完全自定义，例如：客户、阶段、预算、上线日期"
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            保存字段
          </button>
        </>
      }
    >
      <div className="team-form">
        <div className="team-form-grid">
          <label className="team-form-field">
            <span>字段名称</span>
            <input
              className="input"
              value={name}
              autoFocus
              maxLength={30}
              placeholder="例如：客户"
              onChange={(event) => setName(event.target.value)}
              aria-label="元数据名称"
            />
          </label>
          <label className="team-form-field">
            <span>字段值</span>
            <input
              className="input"
              value={value}
              maxLength={200}
              placeholder="例如：某集团"
              onChange={(event) => setValue(event.target.value)}
              aria-label="元数据值"
            />
          </label>
        </div>
        {error ? <p className="team-form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
