import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState, Modal } from '@/components/Modal';
import {
  isWeekend,
  monthKey,
  overtimeHoursInMonth,
  PERFORMANCE_CATEGORY_META,
  performanceByMember,
  performanceCategoryLabel,
  PROJECT_COLORS,
  projectMeta,
  projectMembers,
  projectOvertime,
  projectPerformance,
  projectRolesOf,
  roleColor,
  roleName,
} from '@/lib/team';
import type {
  OvertimeStatus,
  PerformanceCategory,
  Project,
  ProjectMetaField,
  ProjectRole,
  TeamMember,
} from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
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

type Tab = 'members' | 'overtime' | 'performance' | 'settings';

export function ProjectDetailPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const project = snapshot.projects.find((item) => item.id === projectId) ?? null;
  const updateProject = useAppStore((state) => state.updateProject);
  const deleteProject = useAppStore((state) => state.deleteProject);
  const updateMember = useAppStore((state) => state.updateTeamMember);
  const deleteMember = useAppStore((state) => state.deleteTeamMember);
  const createOvertime = useAppStore((state) => state.createOvertime);
  const updateOvertime = useAppStore((state) => state.updateOvertime);
  const deleteOvertime = useAppStore((state) => state.deleteOvertime);
  const createPerformance = useAppStore((state) => state.createPerformance);
  const deletePerformance = useAppStore((state) => state.deletePerformance);
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
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [roleOpen, setRoleOpen] = useState(false);
  const [roleEditing, setRoleEditing] = useState<ProjectRole | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [metaEditing, setMetaEditing] = useState<ProjectMetaField | null>(null);

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
  const meta = projectMeta(snapshot.projectMetaFields, project.id);
  const active = members.filter((member) => member.status === 'active');
  const released = members.filter((member) => member.status === 'released');
  const memberById = new Map(members.map((member) => [member.id, member]));
  const monthPerformance = performance.filter((record) => record.date.startsWith(month));
  const performanceRows = performanceByMember(performance, month);
  const overtimeTotal = overtimeHoursInMonth(overtime, month);
  const performanceNet = monthPerformance.reduce((sum, record) => sum + record.points, 0);
  const roleCounts = roles.map((role) => ({
    ...role,
    count: active.filter((member) => member.roleId === role.id).length,
  }));

  const releaseMember = async (member: TeamMember) => {
    if (!window.confirm(`确认释放「${member.name}」？记录保留，可随时回归。`)) return;
    await updateMember(member.id, {
      status: 'released',
      releasedAt: todayLocalDate(),
    }).catch(() => undefined);
  };

  const removeMember = async (member: TeamMember) => {
    if (!window.confirm(`确认删除「${member.name}」？其加班与绩效记录会一起删除。`)) return;
    await deleteMember(member.id).catch(() => undefined);
  };

  const removeRole = async (role: ProjectRole) => {
    if (!window.confirm(`确认删除角色「${role.name}」？`)) return;
    await deleteRole(role.id).catch((reason) => {
      window.alert(reason instanceof Error ? reason.message : String(reason));
    });
  };

  const removeMeta = async (field: ProjectMetaField) => {
    if (!window.confirm(`确认删除元数据「${field.name}」？`)) return;
    await deleteMeta(field.id).catch(() => undefined);
  };

  const archiveProject = async () => {
    await updateProject(project.id, {
      status: project.status === 'active' ? 'archived' : 'active',
    }).catch(() => undefined);
  };

  const removeProject = async () => {
    if (
      !window.confirm(
        `确认删除项目「${project.name}」？项目内所有成员、角色、元数据、加班与绩效都会删除。`,
      )
    ) {
      return;
    }
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
            <span>本月加班</span>
          </div>
          <div>
            <strong>{performanceNet > 0 ? '+' : ''}{performanceNet}</strong>
            <span>本月绩效</span>
          </div>
        </div>
      </header>

      <div className="team-toolbar">
        <div className="team-tabs" role="tablist" aria-label="项目视图">
          {[
            { key: 'members', label: '成员', count: members.length },
            { key: 'overtime', label: '周末加班', count: overtime.length },
            { key: 'performance', label: '绩效加减分', count: performance.length },
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
        {tab === 'overtime' ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setOvertimeOpen(true)}
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
        <label className="team-month">
          统计月份
          <input
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value || monthKey())}
            aria-label="项目统计月份"
          />
        </label>
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

      {tab === 'overtime' ? (
        <section className="team-panel">
          {overtime.length === 0 ? (
            <div className="team-empty">
              <EmptyState
                icon={<Icon name="calendar" size={22} />}
                title="还没有本项目的加班记录"
                description="排班与已发生记录都按项目隔离，不会和其他项目混在一起。"
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
                        aria-label="删除加班记录"
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
        onClose={() => setOvertimeOpen(false)}
        onSubmit={async (input) => {
          await createOvertime(input);
          setOvertimeOpen(false);
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
  const [joinedAt, setJoinedAt] = useState(todayLocalDate());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(member?.name ?? '');
    setRoleId(member?.roleId ?? roles[0]?.id ?? '');
    setJoinedAt(member?.joinedAt ?? todayLocalDate());
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
            <span>入组日期</span>
            <input
              className="input"
              type="date"
              value={joinedAt}
              onChange={(event) => setJoinedAt(event.target.value)}
              aria-label="项目成员入组日期"
            />
          </label>
        </div>
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
        <p className={`team-weekend-note${isWeekend(date) ? ' is-weekend' : ''}`}>
          {isWeekend(date) ? '这一天是周末，适合安排加班。' : '提示：这一天不是周末，仍可记录调休/工作日加班。'}
        </p>
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
