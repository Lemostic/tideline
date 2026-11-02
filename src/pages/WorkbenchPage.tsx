import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { PageHeadBand } from '@/components/PageHeadBand';
import { BoardCard, NewBoardCard } from '@/features/home/BoardCard';
import { DeleteBoardDialog, RenameBoardDialog } from '@/features/home/BoardDialogs';
import { PopMenu } from '@/features/board/PopMenu';
import {
  dueBucket,
  formatDueLabel,
  formatRelativeTime,
  todaySummary,
} from '@/lib/date';
import { goalProgressDetail, topLevelGoals } from '@/lib/goals';
import { boardColorValue, type Board, type Card, type List } from '@/lib/types';
import { rootCards } from '@/lib/taskTree';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import './home.css';
import './workbench.css';

const FOCUS_LIMIT = 7;
const RECENT_LIMIT = 6;
const GALLERY_RECENT_LIMIT = 6;
const WORKBENCH_VIEW_KEY = 'tideline.workbench.view.v1';

type WorkbenchView = 'workbench' | 'boards';

function loadWorkbenchView(): WorkbenchView {
  if (typeof localStorage === 'undefined') return 'workbench';
  try {
    return localStorage.getItem(WORKBENCH_VIEW_KEY) === 'boards' ? 'boards' : 'workbench';
  } catch {
    return 'workbench';
  }
}

function greetingForHour(hour: number): string {
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/**
 * 工作台（V0.7.1）：产品经理的本地门户。
 * 聚合今日重点、目标进度、看板全景和最近动态，所有数据来自同一份本地快照。
 */
export function WorkbenchPage() {
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  // V0.14.0：工作台只展示主任务，子任务折叠在父任务里。
  const taskCards = useMemo(() => rootCards(snapshot.cards), [snapshot.cards]);
  const openNewBoard = useUiStore((state) => state.openNewBoard);
  const openCard = useUiStore((state) => state.openCard);
  const openSearch = useUiStore((state) => state.openSearch);
  const toggleStar = useAppStore((state) => state.toggleStar);

  const [renameTarget, setRenameTarget] = useState<Board | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Board | null>(null);
  const [viewMode, setViewMode] = useState<WorkbenchView>(loadWorkbenchView);

  const switchView = (next: WorkbenchView) => {
    setViewMode(next);
    try {
      localStorage.setItem(WORKBENCH_VIEW_KEY, next);
    } catch {
      // 本地存储不可用时保持内存态
    }
  };

  const handleToggleStar = (board: Board) => {
    void toggleStar(board.id).catch(() => undefined);
  };

  const now = useMemo(() => new Date(), [taskCards]);
  const today = useMemo(() => {
    const date = new Date();
    return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
  }, []);

  const boardStats = useMemo(() => {
    const map = new Map<
      string,
      { total: number; completed: number; overdue: number; listCount: number }
    >();
    for (const board of snapshot.boards) {
      map.set(board.id, {
        total: 0,
        completed: 0,
        overdue: 0,
        listCount: snapshot.lists.filter((list) => list.boardId === board.id).length,
      });
    }
    for (const card of taskCards) {
      const stat = map.get(card.boardId);
      if (!stat) continue;
      stat.total += 1;
      if (card.completed) stat.completed += 1;
      else if (card.dueDate !== null && card.dueDate < today) stat.overdue += 1;
    }
    return map;
  }, [snapshot.boards, snapshot.lists, taskCards, today]);

  const openCards = useMemo(
    () => taskCards.filter((card) => !card.completed),
    [taskCards],
  );
  const overdue = useMemo(
    () => openCards.filter((card) => card.dueDate !== null && card.dueDate < today),
    [openCards, today],
  );
  const dueToday = useMemo(
    () => openCards.filter((card) => card.dueDate === today),
    [openCards, today],
  );
  const dueThisWeek = useMemo(
    () => openCards.filter((card) => dueBucket(card.dueDate ?? null) === 'week'),
    [openCards],
  );
  const recentCompleted = useMemo(() => {
    const threshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return taskCards.filter(
      (card) => card.completed && Date.parse(card.updatedAt) >= threshold,
    ).length;
  }, [taskCards]);

  const focusCards = useMemo(() => {
    const rank: Record<string, number> = { overdue: 0, today: 1, week: 2 };
    return [...overdue, ...dueToday, ...dueThisWeek]
      .filter((card, index, list) => list.findIndex((item) => item.id === card.id) === index)
      .sort((a, b) => {
        const bucketA = rank[dueBucket(a.dueDate)] ?? 3;
        const bucketB = rank[dueBucket(b.dueDate)] ?? 3;
        if (bucketA !== bucketB) return bucketA - bucketB;
        return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
      })
      .slice(0, FOCUS_LIMIT);
  }, [overdue, dueToday, dueThisWeek]);

  const activeGoals = useMemo(
    () => snapshot.goals.filter((goal) => goal.status === 'active'),
    [snapshot.goals],
  );
  const goalRows = useMemo(
    () =>
      topLevelGoals(activeGoals)
        .slice(0, 4)
        .map((goal) => ({
          goal,
          progress: goalProgressDetail(goal, snapshot.goals, taskCards),
        })),
    [activeGoals, snapshot.goals, taskCards],
  );

  const recentCards = useMemo(
    () => [...taskCards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_LIMIT),
    [taskCards],
  );
  const boardRows = useMemo(
    () =>
      [...snapshot.boards].sort((a, b) => {
        if (a.starred !== b.starred) return a.starred ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      }),
    [snapshot.boards],
  );
  const boardTitle = useMemo(
    () => new Map(snapshot.boards.map((board) => [board.id, board.title])),
    [snapshot.boards],
  );
  const listTitle = useMemo(
    () => new Map(snapshot.lists.map((list) => [list.id, list.title])),
    [snapshot.lists],
  );

  const emptyDescription = '工作台会汇总今日重点、目标进度和所有看板。先创建一个看板或从模板开始。';

  if (snapshot.boards.length === 0) {
    return (
      <div className="page workbench-page">
        <PageHeadBand
          eyebrow={`工作台 · ${todaySummary(now)}`}
          title={`${greetingForHour(now.getHours())}，开始搭建你的工作台`}
          description="把看板、目标和今天要做的事收在同一处。"
        />
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
        </div>
      </div>
    );
  }

  return (
    <div className="page workbench-page">
      <PageHeadBand
        eyebrow={`工作台 · ${todaySummary(now)}`}
        title={
          viewMode === 'boards' ? (
            '所有看板'
          ) : (
            <>
              {greetingForHour(now.getHours())}，今天{focusCards.length > 0 ? (
                <>有 <em className="headline-figure">{focusCards.length}</em> 件需要关注</>
              ) : (
                <><em className="headline-figure">没有</em>需要关注的事</>
              )}
            </>
          )
        }
        description={
          viewMode === 'boards'
            ? '切换回门户视图，可以看今日重点和目标进度。'
            : '把看板、目标和今天要做的事收在同一处。'
        }
        readouts={
          viewMode === 'workbench'
            ? [
                { label: '看板', value: snapshot.boards.length, tone: 'muted' },
                { label: '进行中', value: openCards.length },
                {
                  label: '已逾期',
                  value: overdue.length,
                  tone: overdue.length > 0 ? 'danger' : 'muted',
                },
                { label: '今天到期', value: dueToday.length, tone: 'accent' },
                { label: '本周完成', value: recentCompleted },
              ]
            : [
                { label: '看板', value: snapshot.boards.length, tone: 'muted' },
                { label: '任务', value: taskCards.length },
              ]
        }
        actions={
          <>
            <div className="wb-view-switch" role="tablist" aria-label="工作台视图">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'workbench'}
                className={`wb-view-btn${viewMode === 'workbench' ? ' is-active' : ''}`}
                onClick={() => switchView('workbench')}
              >
                <Icon name="layout-grid" size={12} />
                工作台
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'boards'}
                className={`wb-view-btn${viewMode === 'boards' ? ' is-active' : ''}`}
                onClick={() => switchView('boards')}
              >
                <Icon name="columns" size={12} />
                看板列表
              </button>
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={openNewBoard}>
              <Icon name="plus" size={14} />
              新建看板
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={openSearch}>
              <Icon name="search" size={14} />
              全局搜索
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/inbox')}>
              <Icon name="inbox" size={14} />
              快速记录
            </button>
          </>
        }
      />

      {viewMode === 'workbench' ? (
        <>
      <div className="wb-grid">
        <section className="wb-card wb-focus">
          <div className="wb-card-head">
            <div>
              <h2>今日聚焦</h2>
              <p>逾期、今天和本周到期，按紧急程度排序</p>
            </div>
            <button type="button" className="wb-text-btn" onClick={() => navigate('/tasks')}>
              全部任务 <Icon name="chevron-right" size={12} />
            </button>
          </div>
          {focusCards.length === 0 ? (
            <p className="wb-empty">今天没有到期或逾期任务，适合推进重要但不紧急的事。</p>
          ) : (
            <ul className="wb-task-list">
              {focusCards.map((card) => {
                const overdueCard = card.dueDate !== null && card.dueDate < today;
                return (
                  <li key={card.id}>
                    <button type="button" className="wb-task" onClick={() => openCard(card.id)}>
                      <span className={`wb-task-dot${overdueCard ? ' is-danger' : ''}`} />
                      <span className="wb-task-main">
                        <span className="wb-task-title">{card.title}</span>
                        <span className="wb-task-meta">
                          {boardTitle.get(card.boardId) ?? '未知看板'} ·{' '}
                          {listTitle.get(card.listId) ?? '未知列表'}
                        </span>
                      </span>
                      <span className={`wb-task-due${overdueCard ? ' is-danger' : ''}`}>
                        {formatDueLabel(card.dueDate)}
                      </span>
                      <Icon name="chevron-right" size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="wb-card wb-goals">
          <div className="wb-card-head">
            <div>
              <h2>目标进度</h2>
              <p>关联任务完成后自动回写</p>
            </div>
            <button type="button" className="wb-text-btn" onClick={() => navigate('/goals')}>
              全部目标 <Icon name="chevron-right" size={12} />
            </button>
          </div>
          {goalRows.length === 0 ? (
            <div className="wb-goal-empty">
              <p className="wb-empty">还没有进行中的目标。</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/goals')}>
                <Icon name="target" size={13} />
                去创建目标
              </button>
            </div>
          ) : (
            <ul className="wb-goal-list">
              {goalRows.map(({ goal, progress }) => (
                <li key={goal.id}>
                  <button
                    type="button"
                    className="wb-goal"
                    onClick={() => navigate(`/goals/${goal.id}`)}
                  >
                    <span className="wb-goal-main">
                      <span className="wb-goal-title">{goal.title}</span>
                      <span className="wb-goal-meta">
                        {progress.linkedCount} 个任务 · {progress.source === 'tasks' ? '任务回写' : progress.source === 'children' ? '子目标汇总' : '手动'}
                      </span>
                    </span>
                    <span className="wb-goal-progress">
                      <span className="wb-goal-bar">
                        <span style={{ width: `${progress.percent}%` }} />
                      </span>
                      <strong>{progress.percent}%</strong>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="wb-card wb-boards">
          <div className="wb-card-head">
            <div>
              <h2>看板全景</h2>
              <p>一眼看到每个看板的推进与风险</p>
            </div>
            <button type="button" className="wb-text-btn" onClick={() => navigate('/dashboard')}>
              仪表盘 <Icon name="chart" size={12} />
            </button>
          </div>
          <div className="wb-board-list">
            {boardRows.map((board) => {
              const stat = boardStats.get(board.id) ?? {
                total: 0,
                completed: 0,
                overdue: 0,
                listCount: 0,
              };
              const rate = stat.total === 0 ? 0 : Math.round((stat.completed / stat.total) * 100);
              return (
                <article
                  key={board.id}
                  className="wb-board"
                  onClick={() => navigate(`/board/${board.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      navigate(`/board/${board.id}`);
                    }
                  }}
                >
                  <span
                    className="wb-board-dot"
                    style={{ background: boardColorValue(board.color) }}
                  />
                  <div className="wb-board-main">
                    <div className="wb-board-title-line">
                      <h3>{board.title}</h3>
                      {board.starred ? <Icon name="star-filled" size={11} /> : null}
                    </div>
                    <div className="wb-board-meta">
                      <span>{stat.total} 个任务</span>
                      <span>已完成 {stat.completed}</span>
                      {stat.overdue > 0 ? (
                        <span className="is-danger">{stat.overdue} 个逾期</span>
                      ) : null}
                      <span>更新于 {formatRelativeTime(board.updatedAt)}</span>
                    </div>
                    <div className="wb-board-bar">
                      <span style={{ width: `${rate}%` }} />
                    </div>
                  </div>
                  <strong className="wb-board-rate">{rate}%</strong>
                  <div
                    className="wb-board-actions"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      className={`wb-board-icon${board.starred ? ' is-starred' : ''}`}
                      onClick={() => void toggleStar(board.id).catch(() => undefined)}
                      title={board.starred ? '取消星标' : '星标看板'}
                      aria-label={board.starred ? `取消星标 ${board.title}` : `星标 ${board.title}`}
                    >
                      <Icon name={board.starred ? 'star-filled' : 'star'} size={13} />
                    </button>
                    <PopMenu
                      ariaLabel={`${board.title} 更多操作`}
                      entries={[
                        {
                          kind: 'item',
                          label: '重命名看板',
                          icon: 'pencil',
                          onSelect: () => setRenameTarget(board),
                        },
                        { kind: 'sep' },
                        {
                          kind: 'item',
                          label: '删除看板',
                          icon: 'trash',
                          danger: true,
                          onSelect: () => setDeleteTarget(board),
                        },
                      ]}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="wb-card wb-recent">
          <div className="wb-card-head">
            <div>
              <h2>最近更新</h2>
              <p>刚刚被推进或修改的任务</p>
            </div>
          </div>
          {recentCards.length === 0 ? (
            <p className="wb-empty">还没有任务动态。</p>
          ) : (
            <ul className="wb-recent-list">
              {recentCards.map((card) => (
                <li key={card.id}>
                  <button type="button" className="wb-recent-item" onClick={() => openCard(card.id)}>
                    <span className={`wb-recent-state${card.completed ? ' is-done' : ''}`}>
                      {card.completed ? <Icon name="check" size={9} /> : null}
                    </span>
                    <span className="wb-recent-main">
                      <span className={`wb-recent-title${card.completed ? ' is-done' : ''}`}>
                        {card.title}
                      </span>
                      <span className="wb-recent-meta">
                        {boardTitle.get(card.boardId) ?? '未知看板'} ·{' '}
                        {formatRelativeTime(card.updatedAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="wb-recent-foot">
            <button type="button" className="wb-text-btn" onClick={() => navigate('/inbox')}>
              <Icon name="inbox" size={12} /> 收件箱 {snapshot.inbox.length > 0 ? `(${snapshot.inbox.length})` : ''}
            </button>
          </div>
        </section>
      </div>
        </>
      ) : (
        <BoardGallery
          boards={snapshot.boards}
          cards={taskCards}
          lists={snapshot.lists}
          onToggleStar={handleToggleStar}
          onRename={setRenameTarget}
          onDelete={setDeleteTarget}
          onNewBoard={openNewBoard}
        />
      )}

      {renameTarget ? (
        <RenameBoardDialog board={renameTarget} onClose={() => setRenameTarget(null)} />
      ) : null}
      {deleteTarget ? (
        <DeleteBoardDialog
          board={deleteTarget}
          listCount={boardStats.get(deleteTarget.id)?.listCount ?? 0}
          taskCount={boardStats.get(deleteTarget.id)?.total ?? 0}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </div>
  );
}

/** 原首页的看板卡片视图：星标 / 最近 / 全部看板。 */
function BoardGallery({
  boards,
  cards,
  lists,
  onToggleStar,
  onRename,
  onDelete,
  onNewBoard,
}: {
  boards: Board[];
  cards: Card[];
  lists: List[];
  onToggleStar: (board: Board) => void;
  onRename: (board: Board) => void;
  onDelete: (board: Board) => void;
  onNewBoard: () => void;
}) {
  const taskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of cards) counts.set(card.boardId, (counts.get(card.boardId) ?? 0) + 1);
    return counts;
  }, [cards]);
  const byRecent = useMemo(
    () => [...boards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [boards],
  );
  const starred = useMemo(() => byRecent.filter((board) => board.starred), [byRecent]);
  const recent = useMemo(
    () => byRecent.filter((board) => !board.starred).slice(0, GALLERY_RECENT_LIMIT),
    [byRecent],
  );
  const taskCountOf = (boardId: string) => taskCounts.get(boardId) ?? 0;

  return (
    <div className="wb-gallery">
      <p className="wb-gallery-hint">
        原首页看板卡片视图 · 共 {boards.length} 个看板 / {lists.length} 个列表 · 点击卡片进入看板
      </p>

      {starred.length > 0 ? (
        <GallerySection
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
                onToggleStar={onToggleStar}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </div>
        </GallerySection>
      ) : null}

      {recent.length > 0 ? (
        <GallerySection icon="clock" title="最近" count={recent.length} hint="按更新时间排序">
          <div className="home-grid">
            {recent.map((board) => (
              <BoardCard
                key={board.id}
                board={board}
                taskCount={taskCountOf(board.id)}
                onToggleStar={onToggleStar}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </div>
        </GallerySection>
      ) : null}

      <GallerySection icon="layout-grid" title="全部看板" count={boards.length}>
        <div className="home-grid">
          {byRecent.map((board) => (
            <BoardCard
              key={board.id}
              board={board}
              taskCount={taskCountOf(board.id)}
              onToggleStar={onToggleStar}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
          <NewBoardCard onClick={onNewBoard} />
        </div>
      </GallerySection>
    </div>
  );
}

function GallerySection({
  icon,
  title,
  count,
  hint,
  tone = 'muted',
  children,
}: {
  icon: IconName;
  title: string;
  count: number;
  hint?: string;
  tone?: 'star' | 'muted';
  children: ReactNode;
}) {
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
