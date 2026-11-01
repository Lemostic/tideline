import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import {
  GoalFormModal,
  goalScopeLabel,
  goalStatusLabel,
} from '@/components/GoalFormModal';
import { TaskLinkModal } from '@/components/TaskLinkModal';
import { formatDateCN, formatDueLabel, formatRelativeTime } from '@/lib/date';
import {
  directGoalChildren,
  goalAncestors,
  goalProgressDetail,
} from '@/lib/goals';
import { boardColorValue } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import './goals.css';

/** 目标详情：进度回写、子目标树、关联任务与状态管理。 */
export function GoalDetailPage() {
  const { goalId } = useParams();
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const openCard = useUiStore((state) => state.openCard);
  const requestConfirm = useUiStore((state) => state.requestConfirm);
  const createGoal = useAppStore((state) => state.createGoal);
  const updateGoal = useAppStore((state) => state.updateGoal);
  const deleteGoal = useAppStore((state) => state.deleteGoal);
  const updateCard = useAppStore((state) => state.updateCard);

  const goal = useMemo(
    () => snapshot.goals.find((item) => item.id === goalId) ?? null,
    [snapshot.goals, goalId],
  );
  const [editOpen, setEditOpen] = useState(false);
  const [childOpen, setChildOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const boardById = useMemo(
    () => new Map(snapshot.boards.map((board) => [board.id, board])),
    [snapshot.boards],
  );
  const listById = useMemo(
    () => new Map(snapshot.lists.map((list) => [list.id, list])),
    [snapshot.lists],
  );

  if (!goal) {
    return (
      <div className="page goals-page">
        <div className="goals-empty">
          <EmptyState
            icon={<Icon name="target" size={22} />}
            title="目标不存在"
            description="它可能已经被删除，回到目标列表重新选择。"
            action={
              <button type="button" className="btn btn-primary" onClick={() => navigate('/goals')}>
                返回目标
              </button>
            }
          />
        </div>
      </div>
    );
  }

  const progress = goalProgressDetail(goal, snapshot.goals, snapshot.cards);
  const children = directGoalChildren(goal.id, snapshot.goals);
  const linkedCards = goal.cardIds
    .map((id) => snapshot.cards.find((card) => card.id === id))
    .filter((card): card is NonNullable<typeof card> => Boolean(card));
  const ancestors = goalAncestors(goal, snapshot.goals);
  const isCompleted = goal.status === 'completed';

  const handleDelete = async () => {
    const confirmed = await requestConfirm({
      title: `删除目标「${goal.title}」`,
      description: '目标本身会被删除，关联的任务不受影响。',
      details:
        children.length > 0
          ? [`${children.length} 个子目标会保留并升为顶层目标`]
          : undefined,
      confirmLabel: '删除目标',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await deleteGoal(goal.id);
      navigate('/goals');
    } catch {
      // 全局错误条提示
    }
  };

  const handleToggleStatus = async () => {
    await updateGoal(goal.id, { status: isCompleted ? 'active' : 'completed' }).catch(() => undefined);
  };

  const handleUnlink = async (cardId: string) => {
    await updateGoal(goal.id, {
      cardIds: goal.cardIds.filter((id) => id !== cardId),
    }).catch(() => undefined);
  };

  return (
    <div className="page goals-page goal-detail-page">
      <div className="goal-detail-top">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/goals')}>
          <Icon name="arrow-left" size={13} />
          目标
        </button>
        <span className="goal-detail-crumb">
          {ancestors.slice(0, -1).map((item) => (
            <span key={item.id}>
              {item.title}
              <Icon name="chevron-right" size={11} />
            </span>
          ))}
          <strong>{goal.title}</strong>
        </span>
      </div>

      <header className="goal-detail-head">
        <div className="goal-detail-head-main">
          <span className={`goal-detail-icon goal-scope-${goal.scope}`}>
            <Icon name="target" size={20} />
          </span>
          <div>
            <div className="goal-detail-badges">
              <span className={`goal-scope-badge scope-${goal.scope}`}>{goalScopeLabel(goal.scope)}</span>
              <span className={`goal-status goal-status-${goal.status}`}>{goalStatusLabel(goal.status)}</span>
              {goal.dueDate ? <span className="goal-detail-period">截止 {formatDateCN(goal.dueDate)}</span> : null}
            </div>
            <h1 className="goal-detail-title">{goal.title}</h1>
            <p className="goal-detail-sub">
              {goal.description || '还没有描述，编辑目标补充背景与成功标准。'}
            </p>
          </div>
        </div>
        <div className="goal-detail-actions">
          <button
            type="button"
            className={`btn btn-sm ${isCompleted ? 'btn-ghost' : 'btn-primary'}`}
            onClick={() => void handleToggleStatus()}
          >
            <Icon name="check-circle" size={13} />
            {isCompleted ? '重新开启' : '标记达成'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditOpen(true)}>
            <Icon name="pencil" size={13} />
            编辑
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handleDelete()}>
            <Icon name="trash" size={13} />
            删除
          </button>
        </div>
      </header>

      <section className="goal-detail-progress">
        <div className="goal-progress-ring">
          <svg viewBox="0 0 120 120" role="img" aria-label={`目标进度 ${progress.percent}%`}>
            <circle cx="60" cy="60" r="48" className="goal-ring-bg" />
            <circle
              cx="60"
              cy="60"
              r="48"
              className="goal-ring-value"
              strokeDasharray={`${(progress.percent / 100) * 2 * Math.PI * 48} ${2 * Math.PI * 48}`}
              transform="rotate(-90 60 60)"
            />
          </svg>
          <div className="goal-ring-center">
            <strong>{progress.percent}%</strong>
            <span>进度</span>
          </div>
        </div>
        <div className="goal-progress-info">
          <div className="goal-progress-source-line">
            <span className={`goal-source-badge source-${progress.source}`}>
              {progress.source === 'tasks'
                ? '按关联任务自动回写'
                : progress.source === 'children'
                  ? '按子目标自动汇总'
                  : '手动进度'}
            </span>
          </div>
          <div className="goal-progress-stats">
            <span><strong>{progress.linkedCount}</strong> 关联任务</span>
            <span><strong>{progress.completedCount}</strong> 已完成</span>
            <span><strong>{progress.childCount}</strong> 子目标</span>
          </div>
          {progress.source === 'manual' ? (
            <p className="goal-progress-hint">
              关联任务或添加子目标后，进度会自动计算。也可以直接编辑手动进度。
            </p>
          ) : (
            <p className="goal-progress-hint">
              进度由{progress.source === 'tasks' ? '任务完成情况' : '子目标进度'}自动计算；调整关联内容即可回写。
            </p>
          )}
          <div className="goal-progress-bar">
            <span style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      </section>

      <div className="goal-detail-grid">
        <section className="goal-panel">
          <div className="goal-panel-head">
            <div>
              <h2>关联任务</h2>
              <p>任务完成后自动计入进度</p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLinkOpen(true)}>
              <Icon name="link" size={13} />
              关联任务
            </button>
          </div>
          {linkedCards.length === 0 ? (
            <p className="goal-panel-empty">还没有关联任务。点击右上角「关联任务」从看板里挑选。</p>
          ) : (
            <ul className="goal-task-list">
              {linkedCards.map((card) => {
                const board = boardById.get(card.boardId);
                return (
                  <li key={card.id} className={`goal-task${card.completed ? ' is-completed' : ''}`}>
                    <input
                      type="checkbox"
                      className="tbl-check"
                      checked={card.completed}
                      aria-label={`标记任务「${card.title}」为${card.completed ? '未完成' : '已完成'}`}
                      onChange={(event) =>
                        void updateCard(card.id, { completed: event.target.checked }).catch(
                          () => undefined,
                        )
                      }
                    />
                    <button type="button" className="goal-task-main" onClick={() => openCard(card.id)}>
                      <span className="goal-task-title">{card.title}</span>
                      <span className="goal-task-meta">
                        {board ? (
                          <>
                            <i style={{ background: boardColorValue(board.color) }} />
                            {board.title}
                          </>
                        ) : (
                          '未知看板'
                        )}
                        {' · '}
                        {listById.get(card.listId)?.title ?? '未知列表'}
                      </span>
                    </button>
                    <span className={`goal-task-due${card.dueDate ? '' : ' is-empty'}`}>
                      {card.dueDate ? formatDueLabel(card.dueDate) : '无截止'}
                    </span>
                    <button
                      type="button"
                      className="goal-task-remove"
                      onClick={() => void handleUnlink(card.id)}
                      aria-label={`取消关联任务「${card.title}」`}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="goal-panel">
          <div className="goal-panel-head">
            <div>
              <h2>子目标</h2>
              <p>子目标进度会向上汇总</p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChildOpen(true)}>
              <Icon name="plus" size={13} />
              新建子目标
            </button>
          </div>
          {children.length === 0 ? (
            <p className="goal-panel-empty">还没有子目标。把大目标拆成几个可执行的小目标。</p>
          ) : (
            <ul className="goal-child-list">
              {children.map((child) => {
                const childProgress = goalProgressDetail(child, snapshot.goals, snapshot.cards);
                return (
                  <li key={child.id}>
                    <button
                      type="button"
                      className={`goal-child goal-scope-${child.scope}`}
                      onClick={() => navigate(`/goals/${child.id}`)}
                    >
                      <span className={`goal-child-dot status-${child.status}`} />
                      <span className="goal-child-main">
                        <span className="goal-child-title">{child.title}</span>
                        <span className="goal-child-meta">
                          {goalScopeLabel(child.scope)} · {goalStatusLabel(child.status)} ·{' '}
                          {childProgress.linkedCount} 个任务
                        </span>
                      </span>
                      <span className="goal-child-progress">
                        <span className="goal-child-bar">
                          <span style={{ width: `${childProgress.percent}%` }} />
                        </span>
                        <strong>{childProgress.percent}%</strong>
                      </span>
                      <Icon name="chevron-right" size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className="goal-detail-foot">
        <span>创建于 {formatDateCN(goal.createdAt.slice(0, 10))} · 更新于 {formatRelativeTime(goal.updatedAt)}</span>
      </div>

      <GoalFormModal
        open={editOpen}
        mode="edit"
        initial={goal}
        goals={snapshot.goals}
        onClose={() => setEditOpen(false)}
        onSubmit={async (input) => {
          await updateGoal(goal.id, input);
          setEditOpen(false);
        }}
      />

      <GoalFormModal
        open={childOpen}
        mode="create"
        parentId={goal.id}
        goals={snapshot.goals}
        onClose={() => setChildOpen(false)}
        onSubmit={async (input) => {
          const child = await createGoal(input);
          setChildOpen(false);
          navigate(`/goals/${child.id}`);
        }}
      />

      <TaskLinkModal
        open={linkOpen}
        cards={snapshot.cards}
        boards={snapshot.boards}
        lists={snapshot.lists}
        initialCardIds={goal.cardIds}
        onClose={() => setLinkOpen(false)}
        onSave={async (cardIds) => {
          await updateGoal(goal.id, { cardIds });
          setLinkOpen(false);
        }}
      />
    </div>
  );
}
