import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { PageHeadBand } from '@/components/PageHeadBand';
import {
  GoalFormModal,
  goalScopeLabel,
  goalStatusLabel,
} from '@/components/GoalFormModal';
import { formatDateCN, formatRelativeTime } from '@/lib/date';
import {
  directGoalChildren,
  goalProgressDetail,
  topLevelGoals,
} from '@/lib/goals';
import type { Card, Goal, GoalScope, GoalStatus } from '@/lib/types';
import { rootCards } from '@/lib/taskTree';
import { useAppStore, useSnapshot } from '@/store/appStore';
import './goals.css';

type ScopeFilter = GoalScope | 'all';
type StatusFilter = GoalStatus | 'all';

function percentText(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * 目标列表（V0.6）：公司 / 团队 / 个人目标树，进度按关联任务或子目标自动回写。
 */
export function GoalsPage() {
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  // V0.14.0：目标进度与关联选择器只统计主任务。
  const taskCards = useMemo(() => rootCards(snapshot.cards), [snapshot.cards]);
  const createGoal = useAppStore((state) => state.createGoal);
  const [formOpen, setFormOpen] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');

  const activeGoals = useMemo(
    () => snapshot.goals.filter((goal) => goal.status === 'active'),
    [snapshot.goals],
  );
  const stats = useMemo(() => {
    const linkedIds = new Set<string>();
    activeGoals.forEach((goal) => goal.cardIds.forEach((id) => linkedIds.add(id)));
    const roots = topLevelGoals(activeGoals);
    const average =
      roots.length === 0
        ? 0
        : Math.round(
            roots.reduce(
              (sum, goal) => sum + goalProgressDetail(goal, snapshot.goals, taskCards).percent,
              0,
            ) / roots.length,
          );
    return {
      active: activeGoals.length,
      completed: snapshot.goals.filter((goal) => goal.status === 'completed').length,
      linked: linkedIds.size,
      average,
    };
  }, [activeGoals, snapshot.goals, taskCards]);

  const visibleGoals = useMemo(
    () =>
      snapshot.goals.filter((goal) => {
        if (scopeFilter !== 'all' && goal.scope !== scopeFilter) return false;
        if (statusFilter !== 'all' && goal.status !== statusFilter) return false;
        return true;
      }),
    [snapshot.goals, scopeFilter, statusFilter],
  );
  const visibleIds = useMemo(() => new Set(visibleGoals.map((goal) => goal.id)), [visibleGoals]);
  const roots = useMemo(
    () =>
      visibleGoals
        .filter((goal) => !goal.parentId || !visibleIds.has(goal.parentId))
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    [visibleGoals, visibleIds],
  );

  if (snapshot.goals.length === 0) {
    return (
      <div className="page goals-page">
        <div className="goals-empty">
          <EmptyState
            icon={<Icon name="target" size={22} />}
            title="还没有目标"
            description="先建一个目标，把相关的看板任务关联进来，完成情况会自动汇成进度。"
            action={
              <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
                创建第一个目标
              </button>
            }
          />
        </div>
        <GoalFormModal
          open={formOpen}
          mode="create"
          goals={snapshot.goals}
          onClose={() => setFormOpen(false)}
          onSubmit={async (input) => {
            const goal = await createGoal(input);
            setFormOpen(false);
            navigate(`/goals/${goal.id}`);
          }}
        />
      </div>
    );
  }

  return (
    <div className="page goals-page">
      <PageHeadBand
        eyebrow="目标"
        title="目标与进度"
        description="用公司、团队、个人三层目标组织工作；关联任务完成后，目标进度会自动回写。"
        readouts={[
          { label: '进行中', value: stats.active },
          { label: '已达成', value: stats.completed, tone: 'muted' },
          { label: '平均进度', value: `${stats.average}%` },
        ]}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
            <Icon name="plus" size={14} />
            新建目标
          </button>
        }
      />

      <section className="goals-stats" aria-label="目标概览">
        <div className="goal-stat">
          <span>关联任务</span>
          <strong>{stats.linked}</strong>
        </div>
        <div className="goal-stat">
          <span>顶层平均进度</span>
          <strong>{stats.average}%</strong>
          <div className="goal-stat-bar">
            <span style={{ width: `${stats.average}%` }} />
          </div>
        </div>
      </section>

      <div className="goals-toolbar">
        <div className="goals-filters" role="tablist" aria-label="按层级筛选">
          {[
            { key: 'all', label: '全部层级' },
            { key: 'company', label: '公司' },
            { key: 'team', label: '团队' },
            { key: 'personal', label: '个人' },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={scopeFilter === item.key}
              className={`goals-filter${scopeFilter === item.key ? ' is-active' : ''}`}
              onClick={() => setScopeFilter(item.key as ScopeFilter)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <div className="goals-filters" role="tablist" aria-label="按状态筛选">
          {[
            { key: 'active', label: '进行中' },
            { key: 'completed', label: '已达成' },
            { key: 'archived', label: '已归档' },
            { key: 'all', label: '全部' },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={statusFilter === item.key}
              className={`goals-filter${statusFilter === item.key ? ' is-active' : ''}`}
              onClick={() => setStatusFilter(item.key as StatusFilter)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {visibleGoals.length === 0 ? (
        <div className="goals-no-match">
          <EmptyState
            icon={<Icon name="filter" size={22} />}
            title="没有符合条件的目标"
            description="调整层级或状态筛选，或新建一个目标。"
            action={
              <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
                新建目标
              </button>
            }
          />
        </div>
      ) : (
        <div className="goals-tree">
          {roots.map((goal) => (
            <GoalTreeRow
              key={goal.id}
              goal={goal}
              depth={0}
              goals={snapshot.goals}
              cards={taskCards}
              visibleIds={visibleIds}
              onOpen={(id) => navigate(`/goals/${id}`)}
            />
          ))}
        </div>
      )}

      <GoalFormModal
        open={formOpen}
        mode="create"
        goals={snapshot.goals}
        onClose={() => setFormOpen(false)}
        onSubmit={async (input) => {
          const goal = await createGoal(input);
          setFormOpen(false);
          navigate(`/goals/${goal.id}`);
        }}
      />
    </div>
  );
}

function GoalTreeRow({
  goal,
  depth,
  goals,
  cards,
  visibleIds,
  onOpen,
}: {
  goal: Goal;
  depth: number;
  goals: Goal[];
  cards: Card[];
  visibleIds: Set<string>;
  onOpen: (id: string) => void;
}) {
  const progress = goalProgressDetail(goal, goals, cards);
  const children = directGoalChildren(goal.id, goals).filter((child) => visibleIds.has(child.id));
  return (
    <>
      <article
        className={`goal-row goal-scope-${goal.scope}`}
        style={{ marginLeft: depth * 22 }}
        onClick={() => onOpen(goal.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(goal.id);
          }
        }}
      >
        {depth > 0 ? <span className="goal-tree-connector" aria-hidden="true" /> : null}
        <span className="goal-row-icon">
          <Icon name={goal.scope === 'company' ? 'target' : 'users'} size={15} />
        </span>
        <div className="goal-row-main">
          <div className="goal-row-top">
            <span className="goal-scope-badge">{goalScopeLabel(goal.scope)}</span>
            <h2 className="goal-row-title">{goal.title}</h2>
            <span className={`goal-status goal-status-${goal.status}`}>{goalStatusLabel(goal.status)}</span>
          </div>
          {goal.description ? <p className="goal-row-desc">{goal.description}</p> : null}
          <div className="goal-row-meta">
            <span>{progress.linkedCount} 个关联任务</span>
            {progress.source === 'tasks' ? (
              <span>已完成 {progress.completedCount}</span>
            ) : null}
            {progress.childCount > 0 ? <span>{progress.childCount} 个子目标</span> : null}
            {goal.dueDate ? <span>截止 {formatDateCN(goal.dueDate)}</span> : null}
            <span>更新于 {formatRelativeTime(goal.updatedAt)}</span>
          </div>
          <div className="goal-row-progress">
            <div className="goal-row-bar">
              <span style={{ width: `${progress.percent}%` }} />
            </div>
            <strong>{percentText(progress.percent)}</strong>
            <span className="goal-progress-source">
              {progress.source === 'tasks'
                ? '任务回写'
                : progress.source === 'children'
                  ? '子目标汇总'
                  : '手动'}
            </span>
          </div>
        </div>
        <Icon name="chevron-right" size={14} className="goal-row-arrow" />
      </article>
      {children.map((child) => (
        <GoalTreeRow
          key={child.id}
          goal={child}
          depth={depth + 1}
          goals={goals}
          cards={cards}
          visibleIds={visibleIds}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}
