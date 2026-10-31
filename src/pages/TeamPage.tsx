import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { EmptyState, Modal } from '@/components/Modal';
import { formatDateCN } from '@/lib/date';
import {
  activeMembers,
  formatMonthCN,
  isWeekend,
  MEMBER_ROLE_META,
  memberRoleLabel,
  monthKey,
  overtimeHoursInMonth,
  PERFORMANCE_CATEGORY_META,
  performanceByMember,
  performanceCategoryLabel,
} from '@/lib/team';
import type {
  MemberRole,
  OvertimeStatus,
  PerformanceCategory,
  TeamMember,
} from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import './team.css';

type TeamTab = 'members' | 'overtime' | 'performance';

function todayLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`;
}

function memberInitials(name: string): string {
  return name.trim().slice(0, 2) || '?';
}

/**
 * 项目组与资源（V0.8）：成员进出、周末加班排班/记录、绩效加减分。
 * 数据全部保存在本地，用于个人项目负责人做资源盘点。
 */
export function TeamPage() {
  const snapshot = useSnapshot();
  const createMember = useAppStore((state) => state.createTeamMember);
  const updateMember = useAppStore((state) => state.updateTeamMember);
  const deleteMember = useAppStore((state) => state.deleteTeamMember);
  const createOvertime = useAppStore((state) => state.createOvertime);
  const updateOvertime = useAppStore((state) => state.updateOvertime);
  const deleteOvertime = useAppStore((state) => state.deleteOvertime);
  const createPerformance = useAppStore((state) => state.createPerformance);
  const deletePerformance = useAppStore((state) => state.deletePerformance);

  const [tab, setTab] = useState<TeamTab>('members');
  const [month, setMonth] = useState(monthKey());
  const [memberModalOpen, setMemberModalOpen] = useState(false);
  const [memberEditing, setMemberEditing] = useState<TeamMember | null>(null);
  const [overtimeModalOpen, setOvertimeModalOpen] = useState(false);
  const [performanceModalOpen, setPerformanceModalOpen] = useState(false);

  const members = snapshot.teamMembers;
  const overtime = snapshot.overtimeRecords;
  const performance = snapshot.performanceRecords;
  const active = activeMembers(members);
  const released = members.filter((member) => member.status === 'released');
  const memberById = useMemo(
    () => new Map(members.map((member) => [member.id, member])),
    [members],
  );

  const monthOvertime = useMemo(
    () => overtime.filter((record) => record.date.startsWith(month)),
    [overtime, month],
  );
  const monthPerformance = useMemo(
    () => performance.filter((record) => record.date.startsWith(month)),
    [performance, month],
  );
  const performanceRows = useMemo(
    () => performanceByMember(performance, month),
    [performance, month],
  );
  const overtimeTotal = overtimeHoursInMonth(overtime, month);
  const performanceNet = monthPerformance.reduce((sum, record) => sum + record.points, 0);
  const roleCounts = useMemo(
    () =>
      MEMBER_ROLE_META.map((role) => ({
        ...role,
        count: active.filter((member) => member.role === role.key).length,
      })),
    [active],
  );

  const releaseMember = async (member: TeamMember) => {
    if (!window.confirm(`确认释放「${member.name}」？项目数据不会删除，可随时回归。`)) return;
    await updateMember(member.id, {
      status: 'released',
      releasedAt: todayLocalDate(),
    }).catch(() => undefined);
  };

  const rejoinMember = async (member: TeamMember) => {
    await updateMember(member.id, { status: 'active', releasedAt: null }).catch(() => undefined);
  };

  const removeMember = async (member: TeamMember) => {
    if (
      !window.confirm(
        `确认删除项目成员「${member.name}」？其加班与绩效记录会一起删除。`,
      )
    ) {
      return;
    }
    await deleteMember(member.id).catch(() => undefined);
  };

  const handleAdd = () => {
    if (tab === 'members') {
      setMemberEditing(null);
      setMemberModalOpen(true);
    } else if (tab === 'overtime') {
      if (members.length === 0) return;
      setOvertimeModalOpen(true);
    } else {
      if (members.length === 0) return;
      setPerformanceModalOpen(true);
    }
  };

  return (
    <div className="page team-page">
      <header className="team-head">
        <div>
          <div className="page-eyebrow">项目组 · {formatMonthCN(month)}</div>
          <h1 className="team-title">团队资源</h1>
          <p className="team-sub">
            盘活开发 / 测试 / 需求资源：记录成员进出、周末加班和绩效加减分，全部数据只在本机。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={handleAdd}
          disabled={tab !== 'members' && members.length === 0}
        >
          <Icon name="plus" size={14} />
          {tab === 'members' ? '添加成员' : tab === 'overtime' ? '添加加班记录' : '添加绩效记录'}
        </button>
      </header>

      <section className="team-stats" aria-label="项目组概览">
        <div className="team-stat">
          <span>在组资源</span>
          <strong>{active.length}</strong>
          <div className="team-role-mini">
            {roleCounts
              .filter((role) => role.count > 0)
              .map((role) => (
                <span key={role.key}>
                  {role.label} {role.count}
                </span>
              ))}
          </div>
        </div>
        <div className="team-stat">
          <span>已释放</span>
          <strong>{released.length}</strong>
          <div className="team-stat-hint">保留历史记录，可回归</div>
        </div>
        <div className="team-stat">
          <span>本月周末加班</span>
          <strong>{overtimeTotal}<em>h</em></strong>
          <div className="team-stat-hint">
            已发生 {monthOvertime.filter((record) => record.status === 'done').length} 条 · 排班{' '}
            {monthOvertime.filter((record) => record.status === 'planned').length} 条
          </div>
        </div>
        <div className={`team-stat${performanceNet < 0 ? ' is-danger' : ''}`}>
          <span>本月绩效净分</span>
          <strong>
            {performanceNet > 0 ? '+' : ''}
            {performanceNet}
          </strong>
          <div className="team-stat-hint">{monthPerformance.length} 条加减分记录</div>
        </div>
      </section>

      <div className="team-toolbar">
        <div className="team-tabs" role="tablist" aria-label="项目组视图">
          {[
            { key: 'members', label: '成员', count: members.length },
            { key: 'overtime', label: '周末加班', count: overtime.length },
            { key: 'performance', label: '绩效加减分', count: performance.length },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={`team-tab${tab === item.key ? ' is-active' : ''}`}
              onClick={() => setTab(item.key as TeamTab)}
            >
              {item.label} <span>{item.count}</span>
            </button>
          ))}
        </div>
        <span className="grow" />
        <label className="team-month">
          统计月份
          <input
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value || monthKey())}
            aria-label="项目组统计月份"
          />
        </label>
      </div>

      {tab === 'members' ? (
        <section className="team-panel">
          {members.length === 0 ? (
            <div className="team-empty">
              <EmptyState
                icon={<Icon name="users" size={22} />}
                title="还没有项目成员"
                description="把开发、测试、需求同学加入项目组，记录入组与释放日期，方便盘点资源。"
                action={
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setMemberEditing(null);
                      setMemberModalOpen(true);
                    }}
                  >
                    添加第一个成员
                  </button>
                }
              />
            </div>
          ) : (
            <div className="team-member-list">
              {members.map((member) => (
                <article className={`team-member-row${member.status === 'released' ? ' is-released' : ''}`} key={member.id}>
                  <span className="team-avatar">{memberInitials(member.name)}</span>
                  <div className="team-member-main">
                    <div className="team-member-title">
                      <h3>{member.name}</h3>
                      <span className={`team-role role-${member.role}`}>{memberRoleLabel(member.role)}</span>
                      <span className={`team-status status-${member.status}`}>
                        {member.status === 'active' ? '在组' : '已释放'}
                      </span>
                    </div>
                    <div className="team-member-meta">
                      <span>入组 {formatDateCN(member.joinedAt)}</span>
                      {member.releasedAt ? <span>释放 {formatDateCN(member.releasedAt)}</span> : null}
                      {member.note ? <span className="team-member-note">{member.note}</span> : null}
                    </div>
                  </div>
                  <div className="team-member-actions">
                    {member.status === 'active' ? (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void releaseMember(member)}>
                        释放
                      </button>
                    ) : (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void rejoinMember(member)}>
                        回归
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-icon"
                      aria-label={`编辑 ${member.name}`}
                      onClick={() => {
                        setMemberEditing(member);
                        setMemberModalOpen(true);
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

      {tab === 'overtime' ? (
        <section className="team-panel">
          {overtime.length === 0 ? (
            <div className="team-empty">
              <EmptyState
                icon={<Icon name="calendar" size={22} />}
                title="还没有周末加班记录"
                description="先排班、再记录实际加班时长，月底可以按成员和状态汇总。"
                action={
                  members.length > 0 ? (
                    <button type="button" className="btn btn-primary" onClick={() => setOvertimeModalOpen(true)}>
                      添加加班记录
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="team-records">
              {overtime.map((record) => {
                const member = memberById.get(record.memberId);
                return (
                  <article className={`team-record${record.status === 'done' ? ' is-done' : ''}`} key={record.id}>
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
                          {record.status === 'planned' ? '排班' : '已发生'}
                        </span>
                      </div>
                      <div className="team-record-meta">
                        <span>{record.hours} 小时</span>
                        {record.note ? <span>{record.note}</span> : null}
                      </div>
                    </div>
                    <div className="team-record-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          void updateOvertime(record.id, {
                            status: record.status === 'planned' ? 'done' : 'planned',
                          }).catch(() => undefined)
                        }
                      >
                        {record.status === 'planned' ? '标记已发生' : '改回排班'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`删除 ${member?.name ?? ''} 的加班记录`}
                        onClick={() => {
                          if (!window.confirm('确认删除这条加班记录？')) return;
                          void deleteOvertime(record.id).catch(() => undefined);
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </article>
                );
              })}
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
                title="还没有绩效记录"
                description="用加分和减分记录交付、质量、协作表现，按月自动汇总排名。"
                action={
                  members.length > 0 ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => setPerformanceModalOpen(true)}
                    >
                      添加绩效记录
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <>
              <div className="team-ranking">
                {performanceRows.map((row, index) => {
                  const member = memberById.get(row.memberId);
                  return (
                    <div className="team-rank" key={row.memberId}>
                      <span className="team-rank-index">{index + 1}</span>
                      <span className="team-rank-name">{member?.name ?? '未知成员'}</span>
                      <span className="team-rank-detail">
                        <em className="is-plus">+{row.plus}</em>
                        <em className="is-minus">-{row.minus}</em>
                        <strong className={row.total < 0 ? 'is-negative' : ''}>
                          {row.total > 0 ? '+' : ''}
                          {row.total}
                        </strong>
                      </span>
                    </div>
                  );
                })}
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
                          <span>{formatDateCN(record.date)}</span>
                          <span>{record.reason}</span>
                          {record.note ? <span>{record.note}</span> : null}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`删除 ${member?.name ?? ''} 的绩效记录`}
                        onClick={() => {
                          if (!window.confirm('确认删除这条绩效记录？')) return;
                          void deletePerformance(record.id).catch(() => undefined);
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

      <MemberModal
        open={memberModalOpen}
        member={memberEditing}
        onClose={() => setMemberModalOpen(false)}
        onSubmit={async (input) => {
          if (memberEditing) {
            await updateMember(memberEditing.id, input);
          } else {
            await createMember(input);
          }
          setMemberModalOpen(false);
        }}
      />
      <OvertimeModal
        open={overtimeModalOpen}
        members={members}
        onClose={() => setOvertimeModalOpen(false)}
        onSubmit={async (input) => {
          await createOvertime(input);
          setOvertimeModalOpen(false);
        }}
      />
      <PerformanceModal
        open={performanceModalOpen}
        members={members}
        onClose={() => setPerformanceModalOpen(false)}
        onSubmit={async (input) => {
          await createPerformance(input);
          setPerformanceModalOpen(false);
        }}
      />
    </div>
  );
}

interface MemberModalProps {
  open: boolean;
  member: TeamMember | null;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    role: MemberRole;
    joinedAt: string;
    note: string;
    status?: 'active' | 'released';
    releasedAt?: string | null;
  }) => Promise<void>;
}

function MemberModal({ open, member, onClose, onSubmit }: MemberModalProps) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<MemberRole>('dev');
  const [joinedAt, setJoinedAt] = useState(todayLocalDate());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(member?.name ?? '');
    setRole(member?.role ?? 'dev');
    setJoinedAt(member?.joinedAt ?? todayLocalDate());
    setNote(member?.note ?? '');
    setBusy(false);
    setError(null);
    return undefined;
  }, [open, member]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (busy) return;
    if (!name.trim()) {
      setError('请填写成员姓名');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), role, joinedAt, note: note.trim() });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={member ? '编辑项目成员' : '添加项目成员'}
      subtitle="入组与释放日期用于资源盘点"
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleSubmit()} disabled={busy}>
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
            placeholder="例如：张三 / 小北"
            onChange={(event) => setName(event.target.value)}
            aria-label="成员姓名"
          />
        </label>
        <div className="team-form-grid">
          <label className="team-form-field">
            <span>角色</span>
            <select
              className="select"
              value={role}
              onChange={(event) => setRole(event.target.value as MemberRole)}
              aria-label="成员角色"
            >
              {MEMBER_ROLE_META.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="team-form-field">
            <span>入组日期</span>
            <input
              className="input"
              type="date"
              value={joinedAt}
              onChange={(event) => setJoinedAt(event.target.value)}
              aria-label="成员入组日期"
            />
          </label>
        </div>
        <label className="team-form-field">
          <span>备注</span>
          <textarea
            className="input team-form-textarea"
            value={note}
            maxLength={160}
            placeholder="擅长领域、当前负责模块等"
            onChange={(event) => setNote(event.target.value)}
            aria-label="成员备注"
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
  onClose,
  onSubmit,
}: {
  open: boolean;
  members: TeamMember[];
  onClose: () => void;
  onSubmit: (input: {
    memberId: string;
    date: string;
    hours: number;
    status: OvertimeStatus;
    note: string;
  }) => Promise<void>;
}) {
  const [memberId, setMemberId] = useState('');
  const [date, setDate] = useState(todayLocalDate());
  const [hours, setHours] = useState('8');
  const [status, setStatus] = useState<OvertimeStatus>('planned');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMemberId(members[0]?.id ?? '');
    setDate(todayLocalDate());
    setHours('8');
    setStatus('planned');
    setNote('');
    setBusy(false);
    setError(null);
  }, [open, members]);

  if (!open) return null;

  const submit = async () => {
    if (busy) return;
    const parsed = Number(hours);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('请填写大于 0 的加班时长');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ memberId, date, hours: parsed, status, note: note.trim() });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="添加周末加班"
      subtitle="先排班，实际发生后可标记为「已发生」"
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : '保存加班记录'}
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
            <input
              className="input"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              aria-label="加班日期"
            />
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
              <option value="planned">排班（未来）</option>
              <option value="done">已发生</option>
            </select>
          </label>
        </div>
        {date ? (
          <p className={`team-weekend-note${isWeekend(date) ? ' is-weekend' : ''}`}>
            {isWeekend(date) ? '这一天是周末，适合安排加班。' : '提示：这一天不是周末，仍可记录调休/工作日加班。'}
          </p>
        ) : null}
        <label className="team-form-field">
          <span>备注</span>
          <textarea
            className="input team-form-textarea"
            value={note}
            maxLength={180}
            placeholder="加班内容、版本节点等"
            onChange={(event) => setNote(event.target.value)}
            aria-label="加班备注"
          />
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
  const [date, setDate] = useState(todayLocalDate());
  const [points, setPoints] = useState('5');
  const [category, setCategory] = useState<PerformanceCategory>('delivery');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMemberId(members[0]?.id ?? '');
    setDate(todayLocalDate());
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
      subtitle="加分填正数，减分填负数；月度汇总自动排名"
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
            <input
              className="input"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              aria-label="绩效日期"
            />
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
            placeholder="例如：提前交付登录模块 / 线上缺陷复盘不到位"
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
