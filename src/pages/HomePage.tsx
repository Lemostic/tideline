import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { BoardCard, NewBoardCard } from '@/features/home/BoardCard';
import { DeleteBoardDialog, RenameBoardDialog } from '@/features/home/BoardDialogs';
import { todaySummary } from '@/lib/date';
import type { Board } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import './home.css';

const RECENT_LIMIT = 6;

/** 首页：星标看板 / 最近更新 / 全部看板 */
export function HomePage() {
  const snapshot = useSnapshot();
  const openNewBoard = useUiStore((state) => state.openNewBoard);
  const toggleStar = useAppStore((state) => state.toggleStar);
  const navigate = useNavigate();

  const [renameTarget, setRenameTarget] = useState<Board | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Board | null>(null);

  const boards = snapshot.boards;

  const taskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of snapshot.cards) {
      counts.set(card.boardId, (counts.get(card.boardId) ?? 0) + 1);
    }
    return counts;
  }, [snapshot.cards]);

  const listCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const list of snapshot.lists) {
      counts.set(list.boardId, (counts.get(list.boardId) ?? 0) + 1);
    }
    return counts;
  }, [snapshot.lists]);

  const byRecent = useMemo(
    () => [...boards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [boards],
  );
  const starred = useMemo(() => byRecent.filter((board) => board.starred), [byRecent]);
  const recent = useMemo(
    () => byRecent.filter((board) => !board.starred).slice(0, RECENT_LIMIT),
    [byRecent],
  );
  const openTasks = useMemo(
    () => snapshot.cards.filter((card) => !card.completed).length,
    [snapshot.cards],
  );

  const handleToggleStar = (board: Board) => {
    void toggleStar(board.id).catch(() => undefined);
  };

  const taskCountOf = (boardId: string) => taskCounts.get(boardId) ?? 0;

  const emptyDescription =
    '看板是任务的容器。新建一个空白看板，或者从模板中心挑一个现成的开始。';

  return (
    <div className="page home-page">
      <div className="page-head">
        <h1 className="page-title">首页</h1>
        <p className="page-sub">
          {boards.length > 0
            ? `${todaySummary()} · ${boards.length} 个看板 · ${openTasks} 个待办任务`
            : todaySummary()}
        </p>
      </div>

      {boards.length === 0 ? (
        <div className="home-empty-card">
          <EmptyState
            icon={<Icon name="layout-grid" size={22} />}
            title="还没有看板，先建一个吧"
            description={emptyDescription}
            action={
              <div className="home-empty-actions">
                <button className="btn btn-primary" onClick={openNewBoard}>
                  <Icon name="plus" size={14} />
                  新建看板
                </button>
                <button className="btn btn-ghost" onClick={() => navigate('/templates')}>
                  <Icon name="sparkles" size={14} />
                  浏览模板
                </button>
              </div>
            }
          />
          <div className="home-empty-steps" aria-hidden="true">
            <span className="home-empty-step">
              <em>1</em>创建看板
            </span>
            <span className="home-empty-arrow">
              <Icon name="chevron-right" size={12} />
            </span>
            <span className="home-empty-step">
              <em>2</em>添加列表
            </span>
            <span className="home-empty-arrow">
              <Icon name="chevron-right" size={12} />
            </span>
            <span className="home-empty-step">
              <em>3</em>把任务拖进合适的列表
            </span>
          </div>
        </div>
      ) : (
        <>
          {starred.length > 0 ? (
            <BoardSection
              icon="star-filled"
              title="星标看板"
              count={starred.length}
              hint="置顶你常看的看板"
              tone="star"
            >
              <div className="home-grid">
                {starred.map((board) => (
                  <BoardCard
                    key={board.id}
                    board={board}
                    taskCount={taskCountOf(board.id)}
                    onToggleStar={handleToggleStar}
                    onRename={setRenameTarget}
                    onDelete={setDeleteTarget}
                  />
                ))}
              </div>
            </BoardSection>
          ) : null}

          {recent.length > 0 ? (
            <BoardSection
              icon="clock"
              title="最近"
              count={recent.length}
              hint="按更新时间排序"
            >
              <div className="home-grid">
                {recent.map((board) => (
                  <BoardCard
                    key={board.id}
                    board={board}
                    taskCount={taskCountOf(board.id)}
                    onToggleStar={handleToggleStar}
                    onRename={setRenameTarget}
                    onDelete={setDeleteTarget}
                  />
                ))}
              </div>
            </BoardSection>
          ) : null}

          <BoardSection icon="layout-grid" title="全部看板" count={boards.length}>
            <div className="home-grid">
              {byRecent.map((board) => (
                <BoardCard
                  key={board.id}
                  board={board}
                  taskCount={taskCountOf(board.id)}
                  onToggleStar={handleToggleStar}
                  onRename={setRenameTarget}
                  onDelete={setDeleteTarget}
                />
              ))}
              <NewBoardCard onClick={openNewBoard} />
            </div>
          </BoardSection>
        </>
      )}

      {renameTarget ? (
        <RenameBoardDialog board={renameTarget} onClose={() => setRenameTarget(null)} />
      ) : null}
      {deleteTarget ? (
        <DeleteBoardDialog
          board={deleteTarget}
          listCount={listCounts.get(deleteTarget.id) ?? 0}
          taskCount={taskCountOf(deleteTarget.id)}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </div>
  );
}

interface BoardSectionProps {
  icon: IconName;
  title: string;
  count: number;
  hint?: string;
  tone?: 'star' | 'muted';
  children: ReactNode;
}

function BoardSection({ icon, title, count, hint, tone = 'muted', children }: BoardSectionProps) {
  return (
    <section className="home-section">
      <header className="section-head home-section-head">
        <span className={`home-section-icon home-section-icon-${tone}`}>
          <Icon name={icon} size={14} />
        </span>
        <h2 className="section-title">{title}</h2>
        <span className="section-count">{count}</span>
        {hint ? <span className="home-section-hint">{hint}</span> : null}
      </header>
      {children}
    </section>
  );
}
