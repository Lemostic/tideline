import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { BoardSetFormModal } from '@/components/BoardSetFormModal';
import { formatDueLabel, formatRelativeTime } from '@/lib/date';
import {
  boardColorValue,
  PRIORITY_META,
  type Card,
  type Priority,
} from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import './board-sets.css';

type StatusFilter = 'all' | 'open' | 'done';
type SortKey = 'due-asc' | 'priority' | 'updated-desc';

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`;
}

function sortCards(cards: Card[], sort: SortKey): Card[] {
  const list = [...cards];
  if (sort === 'updated-desc') {
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  if (sort === 'priority') {
    return list.sort((a, b) => {
      const rankA = a.priority ? PRIORITY_RANK[a.priority] : 3;
      const rankB = b.priority ? PRIORITY_RANK[b.priority] : 3;
      return rankA - rankB || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
    });
  }
  return list.sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return b.updatedAt.localeCompare(a.updatedAt);
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  });
}

function priorityMeta(priority: Priority | null) {
  return priority ? PRIORITY_META.find((item) => item.key === priority) ?? null : null;
}

/** 看板集详情：跨看板任务汇总表 + 筛选 / 排序 / 行内完成。 */
export function BoardSetDetailPage() {
  const { setId } = useParams();
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const openCard = useUiStore((state) => state.openCard);
  const updateCard = useAppStore((state) => state.updateCard);
  const updateBoardSet = useAppStore((state) => state.updateBoardSet);
  const deleteBoardSet = useAppStore((state) => state.deleteBoardSet);

  const set = useMemo(
    () => snapshot.boardSets.find((item) => item.id === setId) ?? null,
    [snapshot.boardSets, setId],
  );
  const [editOpen, setEditOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [boardFilter, setBoardFilter] = useState('all');
  const [sort, setSort] = useState<SortKey>('due-asc');

  const boards = useMemo(() => {
    if (!set) return [];
    return set.boardIds
      .map((id) => snapshot.boards.find((board) => board.id === id))
      .filter((board): board is NonNullable<typeof board> => Boolean(board));
  }, [set, snapshot.boards]);
  const boardIds = useMemo(() => new Set(boards.map((board) => board.id)), [boards]);
  const cards = useMemo(
    () => (set ? snapshot.cards.filter((card) => boardIds.has(card.boardId)) : []),
    [set, snapshot.cards, boardIds],
  );
  const listById = useMemo(
    () => new Map(snapshot.lists.map((list) => [list.id, list])),
    [snapshot.lists],
  );

  const visibleCards = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const filtered = cards.filter((card) => {
      if (boardFilter !== 'all' && card.boardId !== boardFilter) return false;
      if (status === 'open' && card.completed) return false;
      if (status === 'done' && !card.completed) return false;
      if (!keyword) return true;
      return (
        card.title.toLowerCase().includes(keyword) ||
        card.labels.some((label) => label.toLowerCase().includes(keyword))
      );
    });
    return sortCards(filtered, sort);
  }, [cards, boardFilter, status, query, sort]);

  if (!set) {
    return (
      <div className="page board-sets-page">
        <div className="board-sets-empty">
          <EmptyState
            icon={<Icon name="layers" size={22} />}
            title="看板集不存在"
            description="它可能已经被删除，回到看板集列表重新选择。"
            action={
              <button type="button" className="btn btn-primary" onClick={() => navigate('/board-sets')}>
                返回看板集
              </button>
            }
          />
        </div>
      </div>
    );
  }

  const completed = cards.filter((card) => card.completed).length;
  const today = todayKey();
  const overdue = cards.filter(
    (card) => !card.completed && card.dueDate !== null && card.dueDate < today,
  ).length;
  const completionRate = cards.length === 0 ? 0 : completed / cards.length;

  const handleDelete = async () => {
    const confirmed = window.confirm(`确定删除看板集「${set.title}」吗？不会删除其中的看板与任务。`);
    if (!confirmed) return;
    try {
      await deleteBoardSet(set.id);
      navigate('/board-sets');
    } catch {
      // 错误由全局错误条提示
    }
  };

  return (
    <div className="page board-sets-page board-set-detail">
      <div className="set-detail-top">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => navigate('/board-sets')}
        >
          <Icon name="arrow-left" size={13} />
          看板集
        </button>
      </div>

      <header className="set-detail-head">
        <div className="set-detail-head-main">
          <span className="set-detail-icon">
            <Icon name="layers" size={20} />
          </span>
          <div>
            <div className="page-eyebrow">看板集 / 汇总表</div>
            <h1 className="set-detail-title">{set.title}</h1>
            <p className="set-detail-sub">
              {set.description || '跨看板任务汇总'} · {boards.length} 个看板 · {cards.length} 个任务 · 完成率{' '}
              {Math.round(completionRate * 100)}%
            </p>
          </div>
        </div>
        <div className="set-detail-actions">
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

      <section className="set-summary" aria-label="看板集概览">
        <div className="set-summary-item">
          <span>成员看板</span>
          <strong>{boards.length}</strong>
        </div>
        <div className="set-summary-item">
          <span>任务总数</span>
          <strong>{cards.length}</strong>
        </div>
        <div className="set-summary-item">
          <span>已完成</span>
          <strong>{completed}</strong>
        </div>
        <div className={`set-summary-item${overdue > 0 ? ' is-danger' : ''}`}>
          <span>已逾期</span>
          <strong>{overdue}</strong>
        </div>
        <div className="set-summary-item">
          <span>完成率</span>
          <strong>{Math.round(completionRate * 100)}%</strong>
        </div>
      </section>

      <div className="set-toolbar">
        <div className="set-board-filters" role="tablist" aria-label="按看板筛选">
          <button
            type="button"
            className={`set-filter-chip${boardFilter === 'all' ? ' is-active' : ''}`}
            aria-selected={boardFilter === 'all'}
            role="tab"
            onClick={() => setBoardFilter('all')}
          >
            全部
          </button>
          {boards.map((board) => (
            <button
              key={board.id}
              type="button"
              className={`set-filter-chip${boardFilter === board.id ? ' is-active' : ''}`}
              aria-selected={boardFilter === board.id}
              role="tab"
              onClick={() => setBoardFilter(board.id)}
            >
              <i style={{ background: boardColorValue(board.color) }} />
              {board.title}
            </button>
          ))}
        </div>
        <span className="grow" />
        <label className="tbl-search set-search">
          <Icon name="search" size={14} className="tbl-search-icon" />
          <input
            className="tbl-search-input"
            value={query}
            placeholder="搜索任务或标签"
            aria-label="搜索看板集任务"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="set-status-filter" role="tablist" aria-label="按状态筛选">
          {[
            { key: 'all', label: '全部' },
            { key: 'open', label: '未完成' },
            { key: 'done', label: '已完成' },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={status === item.key}
              className={`set-filter-chip${status === item.key ? ' is-active' : ''}`}
              onClick={() => setStatus(item.key as StatusFilter)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <select
          className="select set-sort"
          value={sort}
          onChange={(event) => setSort(event.target.value as SortKey)}
          aria-label="看板集排序"
        >
          <option value="due-asc">截止日期 · 最近</option>
          <option value="priority">优先级 · 高到低</option>
          <option value="updated-desc">更新时间 · 最新</option>
        </select>
      </div>

      <div className="set-table-meta">
        <span>
          显示 {visibleCards.length} / 共 {cards.length} 个任务
        </span>
      </div>

      {visibleCards.length === 0 ? (
        <div className="set-table-empty">
          <EmptyState
            icon={<Icon name="search" size={22} />}
            title="没有匹配的任务"
            description="换个关键词，或调整看板 / 状态筛选。"
          />
        </div>
      ) : (
        <div className="set-table-wrap">
          <table className="set-table">
            <caption className="sr-only">{set.title} 跨看板任务汇总表</caption>
            <colgroup>
              <col />
              <col style={{ width: 150 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 104 }} />
              <col style={{ width: 92 }} />
              <col style={{ width: 116 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 84 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">任务</th>
                <th scope="col">看板</th>
                <th scope="col">列表</th>
                <th scope="col">状态</th>
                <th scope="col">优先级</th>
                <th scope="col">截止日期</th>
                <th scope="col">标签</th>
                <th scope="col">更新时间</th>
              </tr>
            </thead>
            <tbody>
              {visibleCards.map((card) => {
                const board = boards.find((item) => item.id === card.boardId);
                const priority = priorityMeta(card.priority);
                const overdue = !card.completed && card.dueDate !== null && card.dueDate < today;
                return (
                  <tr
                    key={card.id}
                    className={card.completed ? 'is-completed' : ''}
                    onClick={() => openCard(card.id)}
                  >
                    <td className="set-col-title">
                      <button type="button" className="set-task-title" onClick={() => openCard(card.id)}>
                        {card.title}
                      </button>
                    </td>
                    <td>
                      {board ? (
                        <button
                          type="button"
                          className="set-board-link"
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate(`/board/${board.id}`);
                          }}
                        >
                          <i style={{ background: boardColorValue(board.color) }} />
                          {board.title}
                        </button>
                      ) : (
                        <span className="tbl-muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className="set-list-name">{listById.get(card.listId)?.title ?? '—'}</span>
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <label className="set-status">
                        <input
                          type="checkbox"
                          className="tbl-check"
                          checked={card.completed}
                          aria-label={`标记「${card.title}」为${card.completed ? '未完成' : '已完成'}`}
                          onChange={(event) =>
                            void updateCard(card.id, { completed: event.target.checked }).catch(
                              () => undefined,
                            )
                          }
                        />
                        <span>{card.completed ? '已完成' : '未完成'}</span>
                      </label>
                    </td>
                    <td>
                      {priority ? (
                        <span className="set-priority">
                          <i style={{ background: priority.color }} />
                          {priority.label}
                        </span>
                      ) : (
                        <span className="tbl-muted">无</span>
                      )}
                    </td>
                    <td>
                      <span className={`set-due${overdue ? ' is-overdue' : ''}`}>
                        {card.dueDate ? formatDueLabel(card.dueDate) : '—'}
                      </span>
                    </td>
                    <td>
                      <div className="set-labels">
                        {card.labels.length === 0 ? (
                          <span className="tbl-muted">—</span>
                        ) : (
                          <>
                            {card.labels.slice(0, 2).map((label) => (
                              <span key={label} className="chip set-label" title={label}>
                                {label}
                              </span>
                            ))}
                            {card.labels.length > 2 ? (
                              <span className="chip set-label is-more" title={card.labels.slice(2).join('、')}>
                                +{card.labels.length - 2}
                              </span>
                            ) : null}
                          </>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="set-updated" title={new Date(card.updatedAt).toLocaleString('zh-CN')}>
                        {formatRelativeTime(card.updatedAt)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <BoardSetFormModal
        open={editOpen}
        mode="edit"
        initial={set}
        boards={snapshot.boards}
        onClose={() => setEditOpen(false)}
        onSubmit={async ({ title, description, boardIds: nextBoardIds }) => {
          await updateBoardSet(set.id, { title, description, boardIds: nextBoardIds });
          setEditOpen(false);
          setBoardFilter('all');
        }}
      />
    </div>
  );
}
