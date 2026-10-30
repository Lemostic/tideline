import { useRef, type DragEvent, type KeyboardEvent } from 'react';
import { Icon } from '@/components/Icon';
import { dueBucket, formatDueLabel, formatMonthDay, formatRelativeTime } from '@/lib/date';
import { PRIORITY_META, type Card } from '@/lib/types';

interface TaskCardProps {
  card: Card;
  /** 正在被拖动：半透明占位，让落点更清楚 */
  dragging: boolean;
  /** 拖拽落点指示：在卡片上方 / 下方画一条主色线 */
  dropSide: 'before' | 'end' | null;
  onOpen: () => void;
  onCardDragStart: (cardId: string) => void;
  onCardDragEnd: () => void;
}

const DESC_SNIPPET_MAX = 72;

/**
 * 看板卡片：标题 + 描述摘要 + 标签 + 截止日期 / 优先级 / 子任务进度 + 更新时间。
 * 没填写的字段用弱化的「无…」占位，提示这张卡还可以补充哪些信息。
 */
export function TaskCard({
  card,
  dragging,
  dropSide,
  onOpen,
  onCardDragStart,
  onCardDragEnd,
}: TaskCardProps) {
  const draggedRef = useRef(false);
  const dueLabel = card.dueDate ? formatDueLabel(card.dueDate) : '';
  const dueTone = card.dueDate ? dueBucket(card.dueDate) : 'none';
  const priority = PRIORITY_META.find((item) => item.key === card.priority);
  const description = card.description.trim().replace(/\s+/g, ' ');
  const hasDescription = description.length > 0;
  const labels = card.labels;
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
    onOpen();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };

  const className = [
    'task-card',
    card.completed ? 'is-completed' : '',
    dragging ? 'is-dragging' : '',
    dropSide === 'before' ? 'drop-before' : '',
    dropSide === 'end' ? 'drop-end' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={className}
      data-card-id={card.id}
      draggable
      role="button"
      tabIndex={0}
      aria-label={`打开任务：${card.title}`}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="task-card-title" title={card.title}>{card.title}</div>

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
            <span key={label} className="task-card-label" title={`标签：${label}`}>
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
        ) : (
          <span className="task-card-meta-item is-placeholder" title="还没有设置截止日期">
            <Icon name="clock" size={11} />
            无截止日期
          </span>
        )}

        {priority ? (
          <span className="task-card-meta-item task-card-priority" title={`优先级：${priority.label}`}>
            <span className="dot" style={{ background: priority.color }} />
            {priority.label}优先级
          </span>
        ) : (
          <span className="task-card-meta-item is-placeholder" title="还没有设置优先级">
            <span className="dot is-empty" />
            无优先级
          </span>
        )}

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
        ) : (
          <span className="task-card-meta-item is-placeholder" title="还没有拆分子任务">
            <Icon name="check-circle" size={11} />
            无子任务
          </span>
        )}

        {card.startDate ? (
          <span className="task-card-meta-item is-start" title={`开始日期 ${card.startDate}`}>
            <Icon name="calendar" size={11} />
            开始 {formatMonthDay(card.startDate)}
          </span>
        ) : null}
      </div>

      <div className="task-card-foot">
        <span className="task-card-updated">
          <Icon name="refresh" size={10} />
          更新于 {formatRelativeTime(card.updatedAt)}
        </span>
        {card.completed ? (
          <span className="task-card-completed">
            <Icon name="check" size={10} />
            已完成
          </span>
        ) : null}
      </div>
    </article>
  );
}
