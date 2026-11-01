import {
  Fragment,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { formatRelativeTime, todayKey } from '@/lib/date';
import {
  boardColorValue,
  BOARD_SORT_OPTIONS,
  PRIORITY_META,
  type Board,
  type BoardSortKey,
  type Card,
  type CardPatch,
  type List,
  type Priority,
} from '@/lib/types';
import { useAppStore } from '@/store/appStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import { InlineEdit } from './InlineEdit';
import './table.css';

export interface BoardViewProps {
  board: Board;
  lists: List[];
  cards: Card[];
  /** 受控排序键：保存视图会指定排序方式；不传时用组件内部状态 */
  sort?: BoardSortKey;
  onSortChange?: (key: BoardSortKey) => void;
}

/** 列数：任务 / 状态 / 优先级 / 开始日期 / 截止日期 / 标签 / 子任务 / 更新时间 */
const COLUMN_COUNT = 8;

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

const stopRowClick = (event: ReactMouseEvent) => event.stopPropagation();

/** 截止日期升序，无日期的排最后 */
function compareDueAsc(a: Card, b: Card): number {
  if (a.dueDate === b.dueDate) return a.createdAt.localeCompare(b.createdAt);
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  return a.dueDate.localeCompare(b.dueDate);
}

/** 截止日期降序，无日期的同样排最后 */
function compareDueDesc(a: Card, b: Card): number {
  if (a.dueDate === b.dueDate) return a.createdAt.localeCompare(b.createdAt);
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  return b.dueDate.localeCompare(a.dueDate);
}

function comparePriority(a: Card, b: Card): number {
  const rankA = a.priority ? PRIORITY_RANK[a.priority] : 3;
  const rankB = b.priority ? PRIORITY_RANK[b.priority] : 3;
  if (rankA !== rankB) return rankA - rankB;
  return compareDueAsc(a, b);
}

/**
 * 看板表格视图（V0.3.4）。
 *
 * 与旧版的区别：
 * - 不再把「列表」作为一列，而是按列表分组（与甘特视图一致的左侧分组逻辑）；
 * - 任务行下展开子任务子行，形成「列表分组 → 任务 → 子任务」三层缩进层级；
 * - 子任务行可直接勾选完成，任务行的进度条同步更新。
 */
export function TableView({
  board,
  lists,
  cards,
  sort: controlledSort,
  onSortChange,
}: BoardViewProps) {
  const openCard = useUiStore((state) => state.openCard);
  const updateCard = useAppStore((state) => state.updateCard);
  const hideCompletedByDefault = useSettingsStore((state) => state.hideCompletedByDefault);

  const [query, setQuery] = useState('');
  const [showCompleted, setShowCompleted] = useState(() => !hideCompletedByDefault);
  const [internalSortKey, setInternalSortKey] = useState<BoardSortKey>('due-asc');
  const sortKey = controlledSort ?? internalSortKey;
  const changeSortKey = (key: BoardSortKey) => {
    setInternalSortKey(key);
    onSortChange?.(key);
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 折叠的任务 id（默认全部展开，保证层级一眼可见） */
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());

  const today = todayKey();
  const accent = boardColorValue(board.color);

  const completedCount = useMemo(
    () => cards.reduce((total, card) => (card.completed ? total + 1 : total), 0),
    [cards],
  );

  const visibleCards = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const filtered = cards.filter((card) => {
      if (!showCompleted && card.completed) return false;
      if (!keyword) return true;
      return (
        card.title.toLowerCase().includes(keyword) ||
        card.labels.some((label) => label.toLowerCase().includes(keyword)) ||
        card.subtasks.some((subtask) => subtask.title.toLowerCase().includes(keyword))
      );
    });

    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'due-desc':
          return compareDueDesc(a, b);
        case 'priority':
          return comparePriority(a, b);
        case 'created-desc':
          return b.createdAt.localeCompare(a.createdAt);
        case 'created-asc':
          return a.createdAt.localeCompare(b.createdAt);
        case 'updated-desc':
          return b.updatedAt.localeCompare(a.updatedAt);
        default:
          return compareDueAsc(a, b);
      }
    });
  }, [cards, query, showCompleted, sortKey]);

  /** 按列表分组：组顺序与看板列顺序一致，组内保持当前排序结果 */
  const groups = useMemo(() => {
    const byList = new Map<string, Card[]>();
    for (const list of lists) byList.set(list.id, []);
    for (const card of visibleCards) {
      const bucket = byList.get(card.listId);
      if (bucket) bucket.push(card);
    }
    return lists
      .map((list) => ({ list, cards: byList.get(list.id) ?? [] }))
      .filter((group) => group.cards.length > 0);
  }, [lists, visibleCards]);

  const patchCard = (id: string, patch: CardPatch) => {
    void updateCard(id, patch).catch(() => undefined);
  };

  const toggleSubtask = (card: Card, subtaskId: string) => {
    patchCard(card.id, {
      subtasks: card.subtasks.map((subtask) =>
        subtask.id === subtaskId ? { ...subtask, done: !subtask.done } : subtask,
      ),
    });
  };

  const toggleCollapse = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearFilters = () => {
    setQuery('');
    setShowCompleted(true);
  };

  const countText =
    visibleCards.length === cards.length
      ? `共 ${cards.length} 个任务${completedCount > 0 ? ` · 已完成 ${completedCount}` : ''}`
      : `显示 ${visibleCards.length} / ${cards.length} 个任务`;

  if (cards.length === 0) {
    return (
      <div className="tbl-view">
        <div className="tbl-empty">
          <EmptyState
            icon={<Icon name="table" size={22} />}
            title="这个看板还没有任务"
            description={`回到「看板」视图，在「${board.title}」的列表里添加第一张任务卡片，表格会实时同步。`}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="tbl-view">
      <div className="tbl-toolbar">
        <div className="tbl-search">
          <Icon name="search" size={14} className="tbl-search-icon" />
          <input
            className="tbl-search-input"
            value={query}
            placeholder="搜索标题、标签或子任务"
            aria-label="搜索任务标题、标签或子任务"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="tbl-search-clear"
              aria-label="清除搜索"
              onClick={() => setQuery('')}
            >
              <Icon name="x" size={12} />
            </button>
          ) : null}
        </div>

        <span className="tbl-count">{countText}</span>
        <span className="grow" />

        <label className="tbl-switch">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(event) => setShowCompleted(event.target.checked)}
          />
          <span className="tbl-switch-track" aria-hidden="true" />
          <span className="tbl-switch-label">显示已完成</span>
        </label>

        <label className="tbl-sort">
          <Icon name="sort" size={13} />
          <select
            value={sortKey}
            aria-label="排序方式"
            onChange={(event) => changeSortKey(event.target.value as BoardSortKey)}
          >
            {BOARD_SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {visibleCards.length === 0 ? (
        <div className="tbl-empty">
          <EmptyState
            icon={<Icon name="search" size={22} />}
            title="没有匹配的任务"
            description="换个关键词，或者打开「显示已完成」再看看。"
            action={
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                清除筛选
              </button>
            }
          />
        </div>
      ) : (
        <div className="tbl-scroll">
          <table className="tbl-grid">
            <caption className="sr-only">{board.title} 的任务表格（按列表分组）</caption>
            <colgroup>
              <col />
              <col style={{ width: 58 }} />
              <col style={{ width: 92 }} />
              <col style={{ width: 126 }} />
              <col style={{ width: 126 }} />
              <col style={{ width: 156 }} />
              <col style={{ width: 116 }} />
              <col style={{ width: 92 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">任务</th>
                <th scope="col">状态</th>
                <th scope="col">优先级</th>
                <th scope="col">开始日期</th>
                <th scope="col">截止日期</th>
                <th scope="col">标签</th>
                <th scope="col">子任务</th>
                <th scope="col">更新时间</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const completedInGroup = group.cards.reduce(
                  (total, card) => (card.completed ? total + 1 : total),
                  0,
                );
                return (
                  <Fragment key={group.list.id}>
                    <tr className="tbl-group-row">
                      <td colSpan={COLUMN_COUNT}>
                        <div className="tbl-group-inner">
                          <span className="tbl-group-dot" style={{ background: accent }} />
                          <span className="tbl-group-title">{group.list.title}</span>
                          <span className="tbl-group-count">
                            {group.cards.length} 个任务
                            {completedInGroup > 0 ? ` · ${completedInGroup} 已完成` : ''}
                          </span>
                        </div>
                      </td>
                    </tr>

                    {group.cards.map((card) => {
                      const expanded = card.subtasks.length > 0 && !collapsedIds.has(card.id);
                      return (
                        <Fragment key={card.id}>
                          <TableRow
                            card={card}
                            today={today}
                            editing={editingId === card.id}
                            expanded={expanded}
                            onToggleExpand={() => toggleCollapse(card.id)}
                            onEditingChange={(editing) =>
                              setEditingId(editing ? card.id : null)
                            }
                            onPatch={patchCard}
                            onOpen={openCard}
                          />
                          {expanded
                            ? card.subtasks.map((subtask) => (
                                <SubtaskRow
                                  key={subtask.id}
                                  subtask={subtask}
                                  onToggle={() => toggleSubtask(card, subtask.id)}
                                  onOpen={() => openCard(card.id)}
                                />
                              ))
                            : null}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface TableRowProps {
  card: Card;
  today: string;
  editing: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onEditingChange: (editing: boolean) => void;
  onPatch: (id: string, patch: CardPatch) => void;
  onOpen: (id: string) => void;
}

function TableRow({
  card,
  today,
  editing,
  expanded,
  onToggleExpand,
  onEditingChange,
  onPatch,
  onOpen,
}: TableRowProps) {
  const priority = PRIORITY_META.find((item) => item.key === card.priority);
  const overdue = card.dueDate !== null && !card.completed && card.dueDate < today;
  const subtaskTotal = card.subtasks.length;
  const subtaskDone = card.subtasks.reduce((total, item) => (item.done ? total + 1 : total), 0);
  const subtaskPercent = subtaskTotal > 0 ? Math.round((subtaskDone / subtaskTotal) * 100) : 0;

  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(card.id);
    }
  };

  const className = [
    'tbl-row',
    'tbl-task-row',
    card.completed ? 'is-completed' : '',
    editing ? 'is-editing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <tr
      className={className}
      tabIndex={0}
      aria-label={`打开任务：${card.title}`}
      onClick={() => onOpen(card.id)}
      onKeyDown={handleRowKeyDown}
    >
      <td className="tbl-col-title" onClick={stopRowClick}>
        <div className="tbl-task-title-cell">
          {subtaskTotal > 0 ? (
            <button
              type="button"
              className={`tbl-expand${expanded ? ' is-expanded' : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                onToggleExpand();
              }}
              aria-label={expanded ? `收起子任务：${card.title}` : `展开子任务：${card.title}`}
              aria-expanded={expanded}
              title={expanded ? '收起子任务' : `展开 ${subtaskTotal} 个子任务`}
            >
              <Icon name="chevron-right" size={13} />
            </button>
          ) : (
            <span className="tbl-expand-spacer" aria-hidden="true" />
          )}
          <InlineEdit
            value={card.title}
            editing={editing}
            onEditingChange={onEditingChange}
            onCommit={(next) => onPatch(card.id, { title: next })}
            ariaLabel="任务标题"
            maxLength={200}
            title="点击编辑任务标题"
            displayClassName="tbl-title-btn"
            inputClassName="tbl-title-input"
          />
        </div>
      </td>

      <td className="tbl-col-status" onClick={stopRowClick}>
        <input
          type="checkbox"
          className="tbl-check"
          checked={card.completed}
          aria-label={card.completed ? `标记「${card.title}」为未完成` : `标记「${card.title}」为已完成`}
          title={card.completed ? '已完成，点击取消' : '点击标记完成'}
          onChange={(event) => onPatch(card.id, { completed: event.target.checked })}
        />
      </td>

      <td className="tbl-col-priority" onClick={stopRowClick}>
        <span className="tbl-priority" data-priority={card.priority ?? 'none'}>
          <span
            className="dot"
            style={{ background: priority?.color ?? 'var(--line-strong)' }}
            aria-hidden="true"
          />
          <select
            className="tbl-inline-select"
            value={card.priority ?? ''}
            aria-label={`${card.title} 优先级`}
            onChange={(event) =>
              onPatch(card.id, { priority: (event.target.value || null) as Priority | null })
            }
          >
            <option value="">无</option>
            {PRIORITY_META.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </span>
      </td>

      <td className="tbl-col-date" onClick={stopRowClick}>
        <input
          type="date"
          className={`tbl-date${card.startDate ? '' : ' is-empty'}`}
          value={card.startDate ?? ''}
          aria-label={`${card.title} 开始日期`}
          onChange={(event) => onPatch(card.id, { startDate: event.target.value || null })}
        />
      </td>

      <td className="tbl-col-date" onClick={stopRowClick}>
        <input
          type="date"
          className={`tbl-date${overdue ? ' is-overdue' : ''}${card.dueDate ? '' : ' is-empty'}`}
          value={card.dueDate ?? ''}
          aria-label={`${card.title} 截止日期`}
          title={overdue ? '已逾期' : undefined}
          onChange={(event) => onPatch(card.id, { dueDate: event.target.value || null })}
        />
      </td>

      <td className="tbl-col-labels">
        <div className="tbl-labels">
          {card.labels.length === 0 ? (
            <span className="tbl-muted">—</span>
          ) : (
            <>
              {card.labels.slice(0, 2).map((label) => (
                <span className="chip tbl-label" key={label} title={label}>
                  {label}
                </span>
              ))}
              {card.labels.length > 2 ? (
                <span
                  className="chip tbl-label tbl-label-more"
                  title={card.labels.slice(2).join('、')}
                >
                  +{card.labels.length - 2}
                </span>
              ) : null}
            </>
          )}
        </div>
      </td>

      <td className="tbl-col-subtasks">
        {subtaskTotal === 0 ? (
          <span className="tbl-muted">—</span>
        ) : (
          <span className="tbl-progress" title={`子任务完成 ${subtaskDone} / ${subtaskTotal}`}>
            <span className="tbl-progress-bar">
              <span
                className={`tbl-progress-fill${subtaskDone === subtaskTotal ? ' is-done' : ''}`}
                style={{ width: `${subtaskPercent}%` }}
              />
            </span>
            <span className="tbl-progress-text">
              {subtaskDone}/{subtaskTotal}
            </span>
          </span>
        )}
      </td>

      <td className="tbl-col-updated">
        <span
          className="tbl-updated"
          title={new Date(card.updatedAt).toLocaleString('zh-CN')}
        >
          {formatRelativeTime(card.updatedAt)}
        </span>
      </td>
    </tr>
  );
}

interface SubtaskRowProps {
  subtask: Card['subtasks'][number];
  onToggle: () => void;
  onOpen: () => void;
}

/** 子任务子行：第三层缩进，可直接勾选；点击行打开父任务抽屉 */
function SubtaskRow({ subtask, onToggle, onOpen }: SubtaskRowProps) {
  return (
    <tr
      className={`tbl-subtask-row${subtask.done ? ' is-done' : ''}`}
      onClick={onOpen}
    >
      <td colSpan={COLUMN_COUNT}>
        <div className="tbl-subtask-inner">
          <span className="tbl-tree" aria-hidden="true" />
          <input
            type="checkbox"
            className="tbl-check tbl-subtask-check"
            checked={subtask.done}
            aria-label={`子任务「${subtask.title}」${subtask.done ? '已完成，点击取消' : '未完成，点击完成'}`}
            onClick={stopRowClick}
            onChange={onToggle}
          />
          <span className="tbl-subtask-title">{subtask.title}</span>
          <span className="tbl-subtask-tag">子任务</span>
        </div>
      </td>
    </tr>
  );
}
