import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { PageHeadBand } from '@/components/PageHeadBand';
import { BoardSetFormModal } from '@/components/BoardSetFormModal';
import { formatRelativeTime } from '@/lib/date';
import { boardColorValue, type BoardSet } from '@/lib/types';
import { rootCards } from '@/lib/taskTree';
import { useAppStore, useSnapshot } from '@/store/appStore';
import './board-sets.css';

interface SetStats {
  boardCount: number;
  taskCount: number;
  completed: number;
  overdue: number;
}

function statsForSet(set: BoardSet, snapshot: ReturnType<typeof useSnapshot>): SetStats {
  const boardIds = new Set(set.boardIds);
  // V0.14.0：与详情页一致，只统计主任务。
  const cards = rootCards(
    snapshot.cards.filter((card) => boardIds.has(card.boardId)),
  );
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;
  return {
    boardCount: set.boardIds.filter((id) => snapshot.boards.some((board) => board.id === id)).length,
    taskCount: cards.length,
    completed: cards.filter((card) => card.completed).length,
    overdue: cards.filter((card) => !card.completed && card.dueDate !== null && card.dueDate < todayKey)
      .length,
  };
}

/**
 * 看板集列表（V0.5.4）：把多个看板聚合到一起，进入详情查看跨看板汇总表。
 * 看板集本身只存成员关系；任务数据仍来自各看板现有卡片，不复制。
 */
export function BoardSetsPage() {
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const createBoardSet = useAppStore((state) => state.createBoardSet);
  const [formOpen, setFormOpen] = useState(false);

  const sets = useMemo(
    () =>
      snapshot.boardSets.map((set) => ({
        set,
        stats: statsForSet(set, snapshot),
      })),
    [snapshot],
  );

  if (snapshot.boards.length === 0) {
    return (
      <div className="page board-sets-page">
        <div className="board-sets-empty">
          <EmptyState
            icon={<Icon name="layers" size={22} />}
            title="还没有可以汇总的看板"
            description="先创建至少一个看板，再把它加入看板集做跨看板汇总。"
            action={
              <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
                返回工作台
              </button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page board-sets-page">
      <PageHeadBand
        eyebrow="看板集"
        title="多个看板，一处查看"
        description="把跨项目的看板收进同一个看板集，用汇总表对比任务、完成进度与风险。任务仍归属原看板，不做复制。"
        readouts={[
          { label: '看板集', value: sets.length },
          { label: '任务', value: sets.reduce((sum, item) => sum + item.stats.taskCount, 0) },
          {
            label: '逾期',
            value: sets.reduce((sum, item) => sum + item.stats.overdue, 0),
            tone: sets.some((item) => item.stats.overdue > 0) ? 'danger' : 'muted',
          },
        ]}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setFormOpen(true)}
          >
            <Icon name="plus" size={14} />
            新建看板集
          </button>
        }
      />

      {snapshot.boardSets.length === 0 ? (
        <div className="board-sets-blank">
          <div className="board-sets-blank-card">
            <span className="board-sets-blank-icon">
              <Icon name="layers" size={22} />
            </span>
            <h2>还没有看板集</h2>
            <p>
              把「产品发布」「内容创作计划」这类相关看板放进一个看板集，打开后就是一页跨看板任务清单。
            </p>
            <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
              创建第一个看板集
            </button>
          </div>
        </div>
      ) : (
        <div className="board-sets-grid">
          {sets.map(({ set, stats }) => {
            const boards = set.boardIds
              .map((id) => snapshot.boards.find((board) => board.id === id))
              .filter((board): board is NonNullable<typeof board> => Boolean(board));
            const rate = stats.taskCount === 0 ? 0 : stats.completed / stats.taskCount;
            return (
              <article
                key={set.id}
                className="board-set-card"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/board-sets/${set.id}`)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    navigate(`/board-sets/${set.id}`);
                  }
                }}
              >
                <div className="board-set-card-head">
                  <span className="board-set-card-icon">
                    <Icon name="layers" size={17} />
                  </span>
                  <div className="board-set-card-titles">
                    <h2>{set.title}</h2>
                    <p>{set.description || '跨看板汇总表'}</p>
                  </div>
                  <Icon name="chevron-right" size={14} />
                </div>

                <div className="board-set-card-stats">
                  <span><strong>{stats.boardCount}</strong> 个看板</span>
                  <span><strong>{stats.taskCount}</strong> 个任务</span>
                  <span className={stats.overdue > 0 ? 'is-danger' : ''}>
                    <strong>{stats.overdue}</strong> 个逾期
                  </span>
                  <span>完成 {Math.round(rate * 100)}%</span>
                </div>

                <div className="board-set-card-boards">
                  {boards.slice(0, 4).map((board) => (
                    <span key={board.id} className="board-set-chip">
                      <i style={{ background: boardColorValue(board.color) }} />
                      {board.title}
                    </span>
                  ))}
                  {boards.length > 4 ? (
                    <span className="board-set-chip is-more">+{boards.length - 4}</span>
                  ) : null}
                </div>

                <div className="board-set-card-foot">
                  <span>更新于 {formatRelativeTime(set.updatedAt)}</span>
                  <span className="board-set-open">打开汇总表 →</span>
                </div>
              </article>
            );
          })}

          <button type="button" className="board-set-new-card" onClick={() => setFormOpen(true)}>
            <Icon name="plus" size={18} />
            <span>新建看板集</span>
          </button>
        </div>
      )}

      <BoardSetFormModal
        open={formOpen}
        mode="create"
        boards={snapshot.boards}
        onClose={() => setFormOpen(false)}
        onSubmit={async ({ title, description, boardIds }) => {
          const set = await createBoardSet({ title, description, boardIds });
          setFormOpen(false);
          navigate(`/board-sets/${set.id}`);
        }}
      />
    </div>
  );
}
