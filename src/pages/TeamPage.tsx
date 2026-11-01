import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState, Modal } from '@/components/Modal';
import { PageHeadBand } from '@/components/PageHeadBand';
import { PROJECT_COLORS, projectMeta, projectMembers, projectOvertime } from '@/lib/team';
import type { Project } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import './team.css';

function formatDateCN(value: string): string {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${year}/${month}/${day}`;
}

/** 项目空间列表（V0.9）：多项目、自定义颜色/元数据，进入详情维护角色与成员。 */
export function TeamPage() {
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const createProject = useAppStore((state) => state.createProject);
  const updateProject = useAppStore((state) => state.updateProject);
  const deleteProject = useAppStore((state) => state.deleteProject);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);

  const projects = snapshot.projects;
  const activeCount = projects.filter((project) => project.status === 'active').length;
  const archivedCount = projects.filter((project) => project.status === 'archived').length;
  const totalActiveMembers = snapshot.teamMembers.filter(
    (member) => member.status === 'active',
  ).length;

  const projectStats = useMemo(
    () =>
      projects.map((project) => ({
        members: projectMembers(snapshot.teamMembers, project.id).filter(
          (member) => member.status === 'active',
        ).length,
        overtime: projectOvertime(snapshot.overtimeRecords, project.id).reduce(
          (sum, record) => sum + record.hours,
          0,
        ),
        meta: projectMeta(snapshot.projectMetaFields, project.id),
      })),
    [projects, snapshot],
  );

  const requestConfirm = useUiStore((state) => state.requestConfirm);

  const removeProject = async (project: Project) => {
    const confirmed = await requestConfirm({
      title: `删除项目「${project.name}」`,
      description: '项目内成员、角色、元数据、加班与绩效记录都会删除，且不可恢复。',
      confirmLabel: '删除项目',
      tone: 'danger',
    });
    if (!confirmed) return;
    await deleteProject(project.id).catch(() => undefined);
  };

  const archiveProject = async (project: Project) => {
    await updateProject(project.id, {
      status: project.status === 'active' ? 'archived' : 'active',
    }).catch(() => undefined);
  };

  return (
    <div className="page team-page">
      <PageHeadBand
        eyebrow="项目管理 · 多项目资源"
        title="项目空间"
        description="每个项目独立维护成员、角色、元数据、周末加班与绩效；像看板一样自由增删改，数据只在本机。"
        readouts={[
          { label: '项目', value: projects.length },
          { label: '进行中', value: activeCount },
          { label: '已归档', value: archivedCount, tone: 'muted' },
          { label: '在组资源', value: totalActiveMembers },
        ]}
        actions={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            <Icon name="plus" size={14} /> 新建项目
          </button>
        }
      />

      <section className="team-stats" aria-label="项目概览">
        <div className="team-stat">
          <span>累计加班</span>
          <strong>
            {Math.round(
              snapshot.overtimeRecords.reduce((sum, record) => sum + record.hours, 0) * 10,
            ) / 10}
            <em>h</em>
          </strong>
          <div className="team-stat-hint">{snapshot.overtimeRecords.length} 条记录</div>
        </div>
        <div className="team-stat">
          <span>绩效净分</span>
          <strong>
            {snapshot.performanceRecords.reduce((sum, record) => sum + record.points, 0)}
          </strong>
          <div className="team-stat-hint">{snapshot.performanceRecords.length} 条加减分</div>
        </div>
      </section>

      {projects.length === 0 ? (
        <section className="team-panel">
          <div className="team-empty">
            <EmptyState
              icon={<Icon name="users" size={22} />}
              title="还没有项目"
              description="创建第一个项目，再添加成员与自定义角色。一个项目就是一套独立的资源台账。"
              action={
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setEditing(null);
                    setModalOpen(true);
                  }}
                >
                  创建第一个项目
                </button>
              }
            />
          </div>
        </section>
      ) : (
        <section className="project-list-section">
          <div className="project-list-head">
            <div>
              <h2>项目列表</h2>
              <p>按项目维护资源、角色与投入；点击整行进入项目。</p>
            </div>
            <span>{projects.length} 个项目</span>
          </div>
          <div className="project-list">
          {projects.map((project, index) => {
            const stat = projectStats[index];
            return (
              <article
                className={`project-card project-row${project.status === 'archived' ? ' is-archived' : ''}`}
                key={project.id}
                style={{ '--project-color': project.color } as React.CSSProperties}
                onClick={() => navigate(`/team/${project.id}`)}
              >
                <div className="project-row-main">
                  <div className="project-card-top">
                    <span className="project-color-dot" />
                    <h2>{project.name}</h2>
                    {project.status === 'archived' ? (
                      <span className="project-status-badge">已归档</span>
                    ) : null}
                    {project.starred ? (
                      <span className="project-star" aria-label="星标项目">
                        ★
                      </span>
                    ) : null}
                  </div>
                  <p className="project-description">
                    {project.description || '还没有项目说明，点击进入项目设置补充。'}
                  </p>
                  <div className="project-meta-chips">
                    {stat.meta.slice(0, 4).map((field) => (
                      <span key={field.id}>
                        {field.name}
                        {field.value ? `：${field.value}` : ''}
                      </span>
                    ))}
                    {stat.meta.length === 0 ? (
                      <span className="is-muted">暂未配置元数据</span>
                    ) : null}
                  </div>
                </div>

                <div className="project-row-stats">
                  <div>
                    <strong>{stat.members}</strong>
                    <span>在组成员</span>
                  </div>
                  <div>
                    <strong>{stat.overtime}<em>h</em></strong>
                    <span>累计加班</span>
                  </div>
                  <div>
                    <strong>{stat.meta.length}</strong>
                    <span>元数据</span>
                  </div>
                  <div>
                    <strong>{formatDateCN(project.updatedAt)}</strong>
                    <span>最近更新</span>
                  </div>
                </div>

                <div className="project-row-actions">
                  <button
                    type="button"
                    className="btn btn-icon"
                    aria-label={`编辑 ${project.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditing(project);
                      setModalOpen(true);
                    }}
                  >
                    <Icon name="pencil" size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon"
                    aria-label={`${project.status === 'active' ? '归档' : '恢复'} ${project.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void archiveProject(project);
                    }}
                  >
                    <Icon name={project.status === 'active' ? 'archive' : 'refresh'} size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon"
                    aria-label={`删除 ${project.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeProject(project);
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                  <span className="project-open">打开 →</span>
                </div>
              </article>
            );
          })}
          </div>
        </section>
      )}

      <ProjectModal
        open={modalOpen}
        project={editing}
        onClose={() => setModalOpen(false)}
        onSubmit={async (input) => {
          if (editing) {
            await updateProject(editing.id, input);
          } else {
            const created = await createProject(input);
            setModalOpen(false);
            navigate(`/team/${created.id}`);
            return;
          }
          setModalOpen(false);
        }}
      />
    </div>
  );
}

function ProjectModal({
  open,
  project,
  onClose,
  onSubmit,
}: {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    description: string;
    color: string;
    starred: boolean;
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<string>(PROJECT_COLORS[0]);
  const [starred, setStarred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setDescription(project?.description ?? '');
    setColor(project?.color ?? PROJECT_COLORS[0]);
    setStarred(project?.starred ?? false);
    setBusy(false);
    setError(null);
  }, [open, project]);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim()) {
      setError('请填写项目名称');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), description: description.trim(), color, starred });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={project ? '编辑项目' : '新建项目'}
      subtitle="项目是成员、角色、加班与绩效的独立容器"
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : '保存项目'}
          </button>
        </>
      }
    >
      <div className="team-form">
        <label className="team-form-field">
          <span>项目名称</span>
          <input
            className="input"
            value={name}
            autoFocus
            maxLength={60}
            placeholder="例如：潮线 2.0 商业化"
            onChange={(event) => setName(event.target.value)}
            aria-label="项目名称"
          />
        </label>
        <label className="team-form-field">
          <span>项目说明</span>
          <textarea
            className="input team-form-textarea"
            value={description}
            maxLength={300}
            placeholder="目标、范围、当前阶段等"
            onChange={(event) => setDescription(event.target.value)}
            aria-label="项目说明"
          />
        </label>
        <div className="team-form-field">
          <span>项目颜色</span>
          <div className="project-color-picker">
            {PROJECT_COLORS.map((item) => (
              <button
                key={item}
                type="button"
                aria-label={`项目颜色 ${item}`}
                className={`project-color-option${color === item ? ' is-selected' : ''}`}
                style={{ backgroundColor: item }}
                onClick={() => setColor(item)}
              />
            ))}
            <input
              type="text"
              className="input project-color-input"
              value={color}
              maxLength={16}
              aria-label="自定义项目颜色"
              onChange={(event) => setColor(event.target.value)}
            />
          </div>
        </div>
        <label className="team-checkbox">
          <input
            type="checkbox"
            checked={starred}
            onChange={(event) => setStarred(event.target.checked)}
          />
          星标项目（排在列表前面）
        </label>
        {error ? <p className="team-form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
