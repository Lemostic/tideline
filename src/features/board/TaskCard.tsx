import { useRef, type DragEvent, type KeyboardEvent } from 'react';
import { Icon } from '@/components/Icon';
import { dueBucket, formatDueLabel, formatMonthDay } from '@/lib/date';
import { blockersFor } from '@/lib/dependencies';
import { labelStyle } from '@/lib/labelColors';
import { PRIORITY_META, boardColorValue, type Card } from '@/lib/types';
import { useSnapshot } from '@/store/appStore';
import { useSettingsStore } from '@/store/settingsStore';

interface TaskCardProps {
  card: Card;
  /** 正在被拖动：半透明占位，让落点更清楚 */
  dragging: boolean;
  /** 批量选择模式：显示复选框，点击卡片改为切换选中 */
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  /** 拖拽落点指示：在卡片上方 / 下方画一条主色线 */
  dropSide: 'before' | 'end' | null;
  onOpen: () => void;
  onCardDragStart: (cardId: string) => void;
  onCardDragEnd: () => void;
}

const DESC_SNIPPET_MAX = 72;

/**
 * 看板卡片：标题 + 描述摘要 + 标签 + 截止日期 / 优先级 / 子任务进度。
 * 卡片只呈现已填写的字段；全都空着时给一条安静提示，而不是三行「无……」占位。
 */
export function TaskCard({
  card,
  dragging,
  selectionMode,
  selected,
  onToggleSelect,
  dropSide,
  onOpen,
  onCardDragStart,
  onCardDragEnd,
}: TaskCardProps) {
  const draggedRef = useRef(false);
  const snapshot = useSnapshot();
  const weekStartsOn = useSettingsStore((state) => state.weekStartsOn);
  const blockers = blockersFor(card.id, snapshot.dependencies, snapshot.cards);
  const unfinishedBlockers = blockers.filter((blocker) => !blocker.completed);
  const dueLabel = card.dueDate ? formatDueLabel(card.dueDate) : '';
  const dueTone = card.dueDate ? dueBucket(card.dueDate, new Date(), weekStartsOn) : 'none';
  const priority = PRIORITY_META.find((item) => item.key === card.priority);
  const description = card.description.trim().replace(/\s+/g, ' ');
  const hasDescription = description.length > 0;
  const labels = card.labels;
  const board = snapshot.boards.find((item) => item.id === card.boardId);
  const visibleLabels = labels.slice(0, 3);
  const hiddenLabels = labels.length - visibleLabels.length;
  const subtaskDone = card.subtasks.filter((subtask) => subtask.done).length;
  const subtaskTotal = card.subtasks.length;
  const progress = subtaskTotal > 0 ? Math.round((subtaskDone / subtaskTotal) * 100) : 0;

  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    draggedRef.current = true;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.id);
    onCardDragStart(card.id);
  };

  const handleDragEnd = () => {
    // 延后一拍再解除，避免拖拽结束时的 click 误开任务抽屉
    window.setTimeout(() => {
      draggedRef.current = false;
    }, 0);
    onCardDragEnd();
  };

  const handleClick = () => {
    if (draggedRef.current) return;
    if (selectionMode) {
      onToggleSelect();
      return;
    }
    onOpen();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (selectionMode) onToggleSelect();
      else onOpen();
    }
  };

  const className = [
    'task-card',
    card.accent ? 'has-accent' : '',
    card.completed ? 'is-completed' : '',
    dragging ? 'is-dragging' : '',
    selectionMode ? 'is-selecting' : '',
    selected ? 'is-selected' : '',
    dropSide === 'before' ? 'drop-before' : '',
    dropSide === 'end' ? 'drop-end' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={className}
      data-card-id={card.id}
      style={card.accent ? { borderTopColor: boardColorValue(card.accent) } : undefined}
      draggable={!selectionMode}
      role="button"
      tabIndex={0}
      aria-label={selectionMode ? `选择任务：${card.title}` : `打开任务：${card.title}`}
      aria-pressed={selectionMode ? selected : undefined}
      onDragStart={selectionMode ? undefined : handleDragStart}
      onDragEnd={selectionMode ? undefined : handleDragEnd}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {selectionMode ? (
        <label
          className="task-card-select"
          onClick={(event) => event.stopPropagation()}
          title={selected ? '取消选择' : '选择任务'}
        >
          <input
            type="checkbox"
            checked={selected}
            aria-label={`选择任务：${card.title}`}
            onChange={onToggleSelect}
          />
          <span className="task-card-select-box" aria-hidden="true">
            {selected ? <Icon name="check" size={11} /> : null}
          </span>
        </label>
      ) : null}

      <div className="task-card-title" title={card.title}>{card.title}</div>

      {unfinishedBlockers.length > 0 ? (
        <div
          className="task-card-blocked"
          title={`前置任务未完成：${unfinishedBlockers.map((item) => item.title).join('、')}`}
        >
          <Icon name="link" size={11} />
          被 {unfinishedBlockers.length} 个前置任务阻塞
        </div>
      ) : null}

      {hasDescription ? (
        <p className="task-card-desc-text" title={description}>
          {description.length > DESC_SNIPPET_MAX
            ? `${description.slice(0, DESC_SNIPPET_MAX)}…`
            : description}
        </p>
      ) : null}

      {labels.length > 0 ? (
        <div className="task-card-labels">
          {visibleLabels.map((label) => (
            <span key={label} className="task-card-label" style={labelStyle(label, board)} title={`标签：${label}`}>
              {label}
            </span>
          ))}
          {hiddenLabels > 0 ? (
            <span className="task-card-label is-more" title={labels.join('、')}>
              +{hiddenLabels}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="task-card-meta">
        {dueLabel ? (
          <span
            className={`chip task-card-meta-item task-card-due${
              dueTone === 'overdue' ? ' is-overdue' : ''
            }${dueTone === 'today' ? ' is-today' : ''}`}
            title={`截止日期 ${card.dueDate}`}
          >
            <Icon name="clock" size={11} />
            {dueLabel}
          </span>
        ) : null}

        {priority ? (
          <span className="task-card-meta-item task-card-priority" title={`优先级：${priority.label}`}>
            <span className="dot" style={{ background: priority.color }} />
            {priority.label}优先级
          </span>
        ) : null}

        {subtaskTotal > 0 ? (
          <span
            className={`task-card-meta-item task-card-subtasks${
              subtaskDone === subtaskTotal ? ' is-done' : ''
            }`}
            title={`子任务完成 ${subtaskDone} / ${subtaskTotal}`}
          >
            <Icon name="check-circle" size={11} />
            {subtaskDone}/{subtaskTotal}
            <span className="task-card-progress" aria-hidden="true">
              <span
                className="task-card-progress-fill"
                style={{ width: `${progress}%` }}
              />
            </span>
          </span>
        ) : null}

        {card.startDate ? (
          <span className="task-card-meta-item is-start" title={`开始日期 ${card.startDate}`}>
            <Icon name="calendar" size={11} />
            开始 {formatMonthDay(card.startDate)}
          </span>
        ) : null}

        {/* 什么都没填时，只给一条安静的提示，而不是三行「无……」占位 */}
        {!dueLabel && !priority && subtaskTotal === 0 && !card.startDate ? (
          <span className="task-card-hint" title="补充截止日期、优先级或子任务，让这张卡可被跟进">
            补充截止日期或优先级
          </span>
        ) : null}
      </div>

      {/* 底栏只承载「已完成」这一个状态；更新时间由工作台的「最近更新」统一呈现，
          每张卡都挂一行时间只会淹没真正重要的信息 */}
      {card.completed ? (
        <div className="task-card-foot">
          <span className="task-card-completed">
            <Icon name="check" size={10} />
            已完成
          </span>
        </div>
      ) : null}
    </article>
  );
}
