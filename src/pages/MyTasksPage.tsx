import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { PageHeadBand } from '@/components/PageHeadBand';
import { EmptyState } from '@/components/Modal';
import {
  dueBucket,
  formatDateCN,
  formatDueLabel,
  todaySummary,
  type DueBucket,
} from '@/lib/date';
import { boardColorValue, PRIORITY_META, type Board, type Card } from '@/lib/types';
import { rootCards } from '@/lib/taskTree';
import {
  countOverdue,
  dueChipClass,
  selectTaskGroups,
  TASK_SORT_OPTIONS,
  type TaskSortKey,
} from '@/features/tasks/group';
import { useSnapshot } from '@/store/appStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import './tasks.css';

const ALL_BOARDS = 'all';

/** 每列的空态提示：语气克制，不抢卡片信息 */
const EMPTY_HINTS: Record<DueBucket, string> = {
  overdue: '没有逾期，节奏正好',
  today: '今天没有到期任务',
  week: '本周没有到期的任务',
  later: '之后暂时没有安排',
  none: '每条任务都排好了日期',
};

function priorityOf(priority: Card['priority']) {
  return priority ? PRIORITY_META.find((meta) => meta.key === priority) ?? null : null;
}

/**
 * 我的任务：按截止日期分五列（已逾期 / 今天 / 本周 / 稍后 / 无截止日期）。
 * 分组与排序规则见 src/features/tasks/group.ts，日期分桶复用 src/lib/date.ts。
 */
export function MyTasksPage() {
  const snapshot = useSnapshot();
  const openCard = useUiStore((state) => state.openCard);
  const weekStartsOn = useSettingsStore((state) => state.weekStartsOn);
  const hideCompletedByDefault = useSettingsStore((state) => state.hideCompletedByDefault);

  const [boardFilter, setBoardFilter] = useState<string>(ALL_BOARDS);
  const [sort, setSort] = useState<TaskSortKey>('due-asc');
  const [showCompleted, setShowCompleted] = useState(() => !hideCompletedByDefault);

  // 看板可能在别处被删除：失效时自动回落到「全部看板」
  const filterValid =
    boardFilter === ALL_BOARDS || snapshot.boards.some((board) => board.id === boardFilter);
  const activeBoardId = filterValid && boardFilter !== ALL_BOARDS ? boardFilter : null;

  // V0.14.0：我的任务只看主任务，子任务折叠在父任务详情里。
  const taskCards = useMemo(() => rootCards(snapshot.cards), [snapshot.cards]);

  // 以快照变化为节拍刷新「今天」，避免分组与 chip 文案跨天失真
  const now = useMemo(() => new Date(), [taskCards]);

  const groups = useMemo(
    () =>
      selectTaskGroups(taskCards, {
        boardId: activeBoardId,
        showCompleted,
        sort,
        now,
        weekStartsOn,
      }),
    [taskCards, activeBoardId, showCompleted, sort, now, weekStartsOn],
  );

  const overdueCount = useMemo(
    () => countOverdue(taskCards, activeBoardId, now),
    [taskCards, activeBoardId, now],
  );

  const boardById = useMemo(
    () => new Map(snapshot.boards.map((board) => [board.id, board])),
    [snapshot.boards],
  );

  const visibleCount = groups.reduce((total, group) => total + group.cards.length, 0);

  return (
    <div className="page tasks-page">
      <PageHeadBand
        eyebrow={todaySummary(now)}
        title="我的任务"
        readouts={[
          { label: '显示中', value: visibleCount },
          {
            label: '已逾期',
            value: overdueCount,
            tone: overdueCount > 0 ? 'danger' : 'muted',
          },
        ]}
        actions={
        <div className="page-actions">
          <div className="tasks-toolbar">
            <label className="tasks-tool" title="按看板筛选">
              <Icon name="layout-grid" size={14} />
              <select
                className="tasks-tool-select"
                value={filterValid ? boardFilter : ALL_BOARDS}
                onChange={(event) => setBoardFilter(event.target.value)}
                aria-label="按看板筛选"
              >
                <option value={ALL_BOARDS}>全部看板</option>
                {snapshot.boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.title}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={13} className="tasks-tool-caret" />
            </label>

            <span className="tasks-tool-sep" aria-hidden="true" />

            <label className="tasks-tool" title="排序方式">
              <Icon name="arrow-up-down" size={14} />
              <select
                className="tasks-tool-select"
                value={sort}
                onChange={(event) => setSort(event.target.value as TaskSortKey)}
                aria-label="排序方式"
              >
                {TASK_SORT_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={13} className="tasks-tool-caret" />
            </label>

            <span className="tasks-tool-sep" aria-hidden="true" />

            <button
              type="button"
              role="switch"
              aria-checked={showCompleted}
              className={`tasks-switch${showCompleted ? ' on' : ''}`}
              onClick={() => setShowCompleted((value) => !value)}
              title={showCompleted ? '隐藏已完成任务' : '显示已完成任务'}
            >
              <span className="tasks-switch-track">
                <span className="tasks-switch-knob" />
              </span>
              显示已完成
            </button>
          </div>
        </div>
        }
      />

      {snapshot.cards.length === 0 ? (
        <EmptyState
          icon={<Icon name="check-circle" size={22} />}
          title="还没有任何任务"
          description="在看板里添加任务，或把收件箱里的念头转成任务，它们会按截止日期自动排到这里。"
        />
      ) : (
        <>
          <div className="tasks-board">
            {groups.map((group) => (
              <section
                key={group.meta.key}
                className={`tasks-col tone-${group.meta.tone}`}
                aria-label={group.meta.label}
              >
                <header className="tasks-col-head">
                  <span className="tasks-col-mark" aria-hidden="true" />
                  <h2 className="tasks-col-title">{group.meta.label}</h2>
                  <span
                    className={`tasks-col-count${
                      group.meta.key === 'overdue' && group.cards.length > 0 ? ' is-overdue' : ''
                    }`}
                  >
                    {group.cards.length}
                  </span>
                </header>

                <div className="tasks-col-body">
                  {group.cards.length === 0 ? (
                    <p className="tasks-col-empty">{EMPTY_HINTS[group.meta.key]}</p>
                  ) : (
                    group.cards.map((card) => (
                      <TaskCardView
                        key={card.id}
                        card={card}
                        board={boardById.get(card.boardId)}
                        onOpen={() => openCard(card.id)}
                      />
                    ))
                  )}
                </div>
              </section>
            ))}
          </div>

          <p className="tasks-foot">
            {visibleCount > 0
              ? `当前显示 ${visibleCount} 个任务，${showCompleted ? '包含已完成' : '未包含已完成'}`
              : '当前筛选下没有任务，试试切换看板或显示已完成'}
          </p>
        </>
      )}
    </div>
  );
}

interface TaskCardViewProps {
  card: Card;
  board?: Board;
  onOpen: () => void;
}

function TaskCardView({ card, board, onOpen }: TaskCardViewProps) {
  const weekStartsOn = useSettingsStore((state) => state.weekStartsOn);
  const bucket = dueBucket(card.dueDate, new Date(), weekStartsOn);
  const priority = priorityOf(card.priority);

  return (
    <button
      type="button"
      className={`tasks-card${card.completed ? ' done' : ''}`}
      onClick={onOpen}
      title="打开任务详情"
    >
      <span className="tasks-card-title">{card.title}</span>

      <span className="tasks-card-meta">
        <span className="tasks-card-board">
          <span
            className="tasks-card-board-dot"
            style={{ background: board ? boardColorValue(board.color) : 'var(--line-strong)' }}
          />
          <span className="tasks-card-board-name">{board?.title ?? '未知看板'}</span>
        </span>

        <span className="tasks-card-tags">
          {card.completed ? (
            <span className="tasks-card-done-chip">
              <Icon name="check-circle" size={11} />
              已完成
            </span>
          ) : null}

          {card.dueDate ? (
            <span
              className={dueChipClass(bucket)}
              title={`截止日期 ${formatDateCN(card.dueDate)}`}
            >
              <Icon name="clock" size={10} />
              {formatDueLabel(card.dueDate)}
            </span>
          ) : null}

          {priority ? (
            <span className="tasks-card-priority" title={`优先级：${priority.label}`}>
              <span className="tasks-card-priority-dot" style={{ background: priority.color }} />
              {priority.label}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
