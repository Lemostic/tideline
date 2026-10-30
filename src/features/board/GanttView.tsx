import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import {
  addDaysKey,
  diffDays,
  eachDateKey,
  formatMonthDay,
  formatWeekday,
  parseDateKey,
  toDateKey,
  todayKey,
} from '@/lib/date';
import { PRIORITY_META, boardColorValue, type Card, type CardPatch, type List } from '@/lib/types';
import { useAppStore } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import type { BoardViewProps } from './TableView';
import './gantt.css';

/** 左侧任务列宽度（px），同时通过 CSS 变量传给布局 */
const LEFT_WIDTH = 300;
/** 日期范围前后留白天数 */
const RANGE_PAD = 7;
/** 防御性上限：异常数据也不把时间轴撑到不可用 */
const MAX_RANGE_DAYS = 200;

type GanttZoom = 'week' | 'day';

/** 周视图紧凑、日视图舒展：每档的「一天」像素宽 */
const ZOOM_WIDTHS: Record<GanttZoom, number> = { week: 26, day: 54 };

interface BarSpan {
  startKey: string;
  endKey: string;
  /** 只有开始或只有截止：渲染为单日里程碑 */
  milestone: boolean;
}

interface BarInfo extends BarSpan {
  card: Card;
  /** 相对时间轴起始日的偏移（天） */
  startIndex: number;
  endIndex: number;
}

interface ScheduledGroup {
  list: List;
  bars: BarInfo[];
}

interface DragState {
  cardId: string;
  pointerId: number;
  startX: number;
  deltaDays: number;
  minDelta: number;
  maxDelta: number;
  moved: boolean;
  originStartKey: string;
  originEndKey: string;
  /** 是否真的有该侧日期（只有截止日的卡片拖动时不应凭空补 startDate） */
  shiftStart: boolean;
  shiftDue: boolean;
}

function validDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  return parseDateKey(value) ? value : null;
}

/** 取出卡片在时间轴上的起止日；日期缺失时降级为单日里程碑 */
function cardSpan(card: Card): BarSpan | null {
  const start = validDateKey(card.startDate);
  const due = validDateKey(card.dueDate);
  if (!start && !due) return null;
  if (start && due) {
    return start <= due
      ? { startKey: start, endKey: due, milestone: false }
      : { startKey: due, endKey: start, milestone: false };
  }
  const single = (start ?? due) as string;
  return { startKey: single, endKey: single, milestone: true };
}

/** 十六进制颜色 → rgba，用于甘特条的淡色填充 */
function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => char + char)
          .join('')
      : normalized;
  const red = Number.parseInt(full.slice(0, 2), 16);
  const green = Number.parseInt(full.slice(2, 4), 16);
  const blue = Number.parseInt(full.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function rangeLabel(startKey: string, endKey: string): string {
  const startYear = parseDateKey(startKey)?.getFullYear();
  const endYear = parseDateKey(endKey)?.getFullYear();
  if (startYear === endYear) return `${formatMonthDay(startKey)} – ${formatMonthDay(endKey)}`;
  return `${startYear} 年 ${formatMonthDay(startKey)} – ${endYear} 年 ${formatMonthDay(endKey)}`;
}

/**
 * 甘特视图（V0.2）
 * 左侧任务列（sticky）+ 右侧时间轴（横向滚动），行一一对齐。
 * 时间轴范围取本看板已排期任务的最早开始 / 最晚截止（含今天），前后留白并补齐到整周，
 * 这样周末底色可以用固定 7 天周期绘制，网格渲染更省。
 */
export function GanttView({ board, lists, cards }: BoardViewProps) {
  const openCard = useUiStore((state) => state.openCard);
  const updateCard = useAppStore((state) => state.updateCard);

  const [zoom, setZoom] = useState<GanttZoom>('week');
  const [showCompleted, setShowCompleted] = useState(true);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const dayWidth = ZOOM_WIDTHS[zoom];
  const today = todayKey();
  const boardAccent = boardColorValue(board.color);

  const visibleCards = useMemo(
    () => (showCompleted ? cards : cards.filter((card) => !card.completed)),
    [cards, showCompleted],
  );

  const scheduledCards = useMemo(
    () => visibleCards.filter((card) => cardSpan(card) !== null),
    [visibleCards],
  );
  const unscheduledCards = useMemo(
    () => visibleCards.filter((card) => cardSpan(card) === null),
    [visibleCards],
  );

  // 时间轴范围：含今天、前后各留 RANGE_PAD 天，并补齐到整周（周一~周日）
  const range = useMemo(() => {
    let minKey: string | null = null;
    let maxKey: string | null = null;
    for (const card of scheduledCards) {
      const span = cardSpan(card);
      if (!span) continue;
      if (!minKey || span.startKey < minKey) minKey = span.startKey;
      if (!maxKey || span.endKey > maxKey) maxKey = span.endKey;
    }
    const anchorMin = minKey && minKey < today ? minKey : today;
    const anchorMax = maxKey && maxKey > today ? maxKey : today;

    const start = parseDateKey(anchorMin) as Date;
    start.setDate(start.getDate() - RANGE_PAD);
    const startDow = start.getDay();
    start.setDate(start.getDate() - (startDow === 0 ? 6 : startDow - 1));

    const end = parseDateKey(anchorMax) as Date;
    end.setDate(end.getDate() + RANGE_PAD);
    const endDow = end.getDay();
    end.setDate(end.getDate() + (endDow === 0 ? 0 : 7 - endDow));

    const startKey = toDateKey(start);
    let endKey = toDateKey(end);
    if (diffDays(startKey, endKey) > MAX_RANGE_DAYS) {
      endKey = addDaysKey(startKey, MAX_RANGE_DAYS);
    }
    return { startKey, endKey };
  }, [scheduledCards, today]);

  const days = useMemo(() => eachDateKey(range.startKey, range.endKey), [range.startKey, range.endKey]);
  const timelineWidth = days.length * dayWidth;
  const todayIndex = diffDays(range.startKey, today);
  const todayOffset = todayIndex * dayWidth;
  const todayInRange = todayIndex >= 0 && todayIndex < days.length;

  const months = useMemo(() => {
    const result: Array<{ key: string; label: string; width: number }> = [];
    for (const day of days) {
      const date = parseDateKey(day);
      if (!date) continue;
      const key = `${date.getFullYear()}-${date.getMonth() + 1}`;
      const last = result[result.length - 1];
      if (last && last.key === key) {
        last.width += dayWidth;
        continue;
      }
      const showYear = result.length === 0 || date.getMonth() === 0;
      result.push({
        key,
        width: dayWidth,
        label: showYear
          ? `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`
          : `${date.getMonth() + 1} 月`,
      });
    }
    return result;
  }, [days, dayWidth]);

  // 按列表分组 + 组内按开始日期排序，保证行顺序稳定
  const groups = useMemo<ScheduledGroup[]>(() => {
    const byList = new Map<string, BarInfo[]>();
    for (const list of lists) byList.set(list.id, []);
    for (const card of scheduledCards) {
      const span = cardSpan(card);
      if (!span) continue;
      const bucket = byList.get(card.listId);
      if (!bucket) continue;
      bucket.push({
        card,
        startKey: span.startKey,
        endKey: span.endKey,
        milestone: span.milestone,
        startIndex: diffDays(range.startKey, span.startKey),
        endIndex: diffDays(range.startKey, span.endKey),
      });
    }
    const result: ScheduledGroup[] = [];
    for (const list of lists) {
      const bars = byList.get(list.id) ?? [];
      bars.sort(
        (a, b) => a.startKey.localeCompare(b.startKey) || a.card.position - b.card.position,
      );
      if (bars.length > 0) result.push({ list, bars });
    }
    return result;
  }, [lists, scheduledCards, range.startKey]);

  const unscheduledSorted = useMemo(() => {
    const listOrder = new Map(lists.map((list, index) => [list.id, index]));
    return [...unscheduledCards].sort(
      (a, b) =>
        (listOrder.get(a.listId) ?? 0) - (listOrder.get(b.listId) ?? 0) || a.position - b.position,
    );
  }, [unscheduledCards, lists]);

  const setDragState = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // 切换缩放时保留「左边缘对应的日期」，首次进入则把「今天」定位到视野偏左
  const anchorRef = useRef<number | null>(null);
  const changeZoom = (next: GanttZoom) => {
    const element = scrollRef.current;
    if (element && next !== zoom) anchorRef.current = element.scrollLeft / dayWidth;
    setZoom(next);
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (anchorRef.current !== null) {
      element.scrollTo({ left: Math.max(0, anchorRef.current * dayWidth), behavior: 'auto' });
      anchorRef.current = null;
    } else {
      const offset = todayOffset + dayWidth / 2;
      const visibleWidth = Math.max(320, element.clientWidth - LEFT_WIDTH);
      element.scrollTo({ left: Math.max(0, offset - visibleWidth / 3), behavior: 'auto' });
    }
    // 依赖只有 zoom：数据变化时保持用户当前滚动位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  const scrollToToday = (behavior: ScrollBehavior) => {
    const element = scrollRef.current;
    if (!element) return;
    const offset = todayOffset + dayWidth / 2;
    const visibleWidth = Math.max(320, element.clientWidth - LEFT_WIDTH);
    element.scrollTo({ left: Math.max(0, offset - visibleWidth / 3), behavior });
  };

  const barColor = (card: Card) => {
    const priority = PRIORITY_META.find((item) => item.key === card.priority);
    return priority?.color ?? boardAccent;
  };

  const handleBarPointerDown = (event: ReactPointerEvent<HTMLDivElement>, bar: BarInfo) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startIndex = Math.max(0, Math.min(days.length - 1, bar.startIndex));
    const endIndex = Math.max(startIndex, Math.min(days.length - 1, bar.endIndex));
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({
      cardId: bar.card.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      deltaDays: 0,
      minDelta: -startIndex,
      maxDelta: days.length - 1 - endIndex,
      moved: false,
      originStartKey: bar.startKey,
      originEndKey: bar.endKey,
      shiftStart: Boolean(validDateKey(bar.card.startDate)),
      shiftDue: Boolean(validDateKey(bar.card.dueDate)),
    });
  };

  const handleBarPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const deltaPx = event.clientX - current.startX;
    const moved = current.moved || Math.abs(deltaPx) > 3;
    const rawDays = Math.round(deltaPx / dayWidth);
    const deltaDays = Math.max(current.minDelta, Math.min(current.maxDelta, rawDays));
    if (deltaDays === current.deltaDays && moved === current.moved) return;
    setDragState({ ...current, deltaDays, moved });
  };

  const handleBarPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const element = event.currentTarget;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    setDragState(null);
    if (!current.moved) {
      openCard(current.cardId);
      return;
    }
    if (current.deltaDays === 0) return;
    const patch: CardPatch = {};
    if (current.shiftStart) patch.startDate = addDaysKey(current.originStartKey, current.deltaDays);
    if (current.shiftDue) patch.dueDate = addDaysKey(current.originEndKey, current.deltaDays);
    if (patch.startDate === undefined && patch.dueDate === undefined) return;
    void updateCard(current.cardId, patch).catch(() => undefined);
  };

  const handleBarPointerCancel = () => setDragState(null);

  const openCardFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>, cardId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openCard(cardId);
    }
  };

  if (visibleCards.length === 0) {
    return (
      <div className="gantt-view">
        <div className="gantt-empty">
          <EmptyState
            icon={<Icon name="gantt" size={22} />}
            title={cards.length === 0 ? '这个看板还没有任务' : '没有可显示的任务'}
            description={
              cards.length === 0
                ? '先在看板视图里添加任务，再回到甘特视图给它们排期。'
                : '已完成的任务被隐藏了，打开「显示已完成」就能看到它们。'
            }
            action={
              cards.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowCompleted(true)}
                >
                  显示已完成
                </button>
              ) : undefined
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="gantt-view">
      <div className="gantt-toolbar">
        <div className="gantt-range" title="时间轴范围">
          <Icon name="calendar" size={14} />
          <span>{rangeLabel(range.startKey, range.endKey)}</span>
        </div>
        <span className="gantt-stats">
          已排期 {scheduledCards.length} · 未排期 {unscheduledCards.length}
        </span>
        <span className="grow" />
        <div className="gantt-seg" role="group" aria-label="时间轴缩放">
          <button
            type="button"
            className={`gantt-seg-btn${zoom === 'week' ? ' is-active' : ''}`}
            aria-pressed={zoom === 'week'}
            onClick={() => changeZoom('week')}
          >
            周
          </button>
          <button
            type="button"
            className={`gantt-seg-btn${zoom === 'day' ? ' is-active' : ''}`}
            aria-pressed={zoom === 'day'}
            onClick={() => changeZoom('day')}
          >
            日
          </button>
        </div>
        <button
          type="button"
          className={`gantt-toggle${showCompleted ? ' is-on' : ''}`}
          aria-pressed={showCompleted}
          onClick={() => setShowCompleted((value) => !value)}
        >
          <Icon name="check-circle" size={14} />
          显示已完成
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => scrollToToday('smooth')}
        >
          <Icon name="target" size={13} />
          回到今天
        </button>
      </div>

      {scheduledCards.length === 0 ? (
        <div className="gantt-note">
          <Icon name="clock" size={12} />
          还没有已排期的任务：点击任务，在详情里设置「开始日期 / 截止日期」后就会出现在时间轴上。
        </div>
      ) : null}

      <div className="gantt-scroll" ref={scrollRef}>
        <div
          className="gantt-grid"
          style={
            {
              width: LEFT_WIDTH + timelineWidth,
              '--gantt-day-w': `${dayWidth}px`,
              '--gantt-left-w': `${LEFT_WIDTH}px`,
            } as CSSProperties
          }
        >
          <div className="gantt-row gantt-head-row">
            <div className="gantt-left-cell gantt-head-left">
              <span className="gantt-head-title">任务</span>
              <span className="gantt-head-count">{scheduledCards.length}</span>
              <span className="grow" />
              <span className="gantt-head-meta">已排期</span>
            </div>
            <div className="gantt-head-timeline" style={{ width: timelineWidth }}>
              <div className="gantt-month-row">
                {months.map((month) => (
                  <div key={month.key} className="gantt-month-cell" style={{ width: month.width }}>
                    <span className="gantt-month-label">{month.label}</span>
                  </div>
                ))}
              </div>
              <div className="gantt-day-row">
                {days.map((day) => {
                  const date = parseDateKey(day);
                  if (!date) return null;
                  const dow = date.getDay();
                  const isWeekend = dow === 0 || dow === 6;
                  const isToday = day === today;
                  const isWeekStart = dow === 1;
                  return (
                    <div
                      key={day}
                      className={[
                        'gantt-day-cell',
                        isWeekend ? 'is-weekend' : '',
                        isToday ? 'is-today' : '',
                        isWeekStart ? 'is-week-start' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ width: dayWidth }}
                      title={`${day} ${formatWeekday(day)}`}
                    >
                      {zoom === 'day' ? (
                        <>
                          <span className="gantt-day-weekday">{formatWeekday(day)}</span>
                          <span className="gantt-day-num">
                            {date.getMonth() + 1}/{date.getDate()}
                          </span>
                        </>
                      ) : (
                        <span className="gantt-day-num">{date.getDate()}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {todayInRange ? (
                <span className="gantt-today-pill" style={{ left: todayOffset + dayWidth / 2 }}>
                  今天
                </span>
              ) : null}
            </div>
          </div>

          {groups.map((group) => (
            <Fragment key={group.list.id}>
              <div className="gantt-row gantt-group-row">
                <div className="gantt-left-cell gantt-group-left">
                  <span className="gantt-list-dot" style={{ background: boardAccent }} />
                  <span className="gantt-group-title">{group.list.title}</span>
                  <span className="gantt-group-count">{group.bars.length}</span>
                </div>
                <div className="gantt-timeline-cell" style={{ width: timelineWidth }} />
              </div>

              {group.bars.map((bar) => {
                const card = bar.card;
                const accent = barColor(card);
                const dragging = drag?.cardId === card.id;
                const startIndex = Math.max(0, Math.min(days.length - 1, bar.startIndex));
                const endIndex = Math.max(startIndex, Math.min(days.length - 1, bar.endIndex));
                const width = bar.milestone
                  ? Math.max(22, dayWidth - 6)
                  : (endIndex - startIndex + 1) * dayWidth - 4;
                const left =
                  startIndex * dayWidth + 2 + (dragging && drag ? drag.deltaDays * dayWidth : 0);
                const showTitle = width >= (zoom === 'day' ? 74 : 62);
                return (
                  <div className="gantt-row gantt-task-row" key={card.id}>
                    <div
                      className={`gantt-left-cell gantt-task-left${card.completed ? ' is-completed' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`打开任务：${card.title}`}
                      title={card.title}
                      onClick={() => openCard(card.id)}
                      onKeyDown={(event) => openCardFromKeyboard(event, card.id)}
                    >
                      <span className="gantt-list-dot" style={{ background: accent }} />
                      <span className="gantt-task-title">{card.title}</span>
                      {bar.milestone ? (
                        <span className="gantt-task-badge" title="只有单侧日期，按单日展示">
                          单日
                        </span>
                      ) : null}
                    </div>
                    <div
                      className="gantt-timeline-cell"
                      style={{ width: timelineWidth }}
                    >
                      <div
                        className={[
                          'gantt-bar',
                          bar.milestone ? 'is-milestone' : '',
                          card.completed ? 'is-completed' : '',
                          dragging ? 'is-dragging' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        style={{
                          left,
                          width,
                          background: card.completed
                            ? 'var(--surface-sunken)'
                            : hexToRgba(accent, 0.13),
                          borderLeft: `3px solid ${card.completed ? 'var(--line-strong)' : accent}`,
                          color: card.completed ? 'var(--faint)' : 'var(--ink-2)',
                        }}
                        title={`${card.title}${
                          bar.startKey !== bar.endKey
                            ? `（${formatMonthDay(bar.startKey)} – ${formatMonthDay(bar.endKey)}）`
                            : `（${formatMonthDay(bar.startKey)}）`
                        } · 拖动可平移`}
                        onPointerDown={(event) => handleBarPointerDown(event, bar)}
                        onPointerMove={handleBarPointerMove}
                        onPointerUp={handleBarPointerUp}
                        onPointerCancel={handleBarPointerCancel}
                      >
                        {card.completed ? (
                          <Icon name="check" size={11} />
                        ) : bar.milestone ? (
                          <Icon
                            name={card.dueDate ? 'flag' : 'clock'}
                            size={10}
                            style={{ color: accent }}
                          />
                        ) : null}
                        {showTitle ? <span className="gantt-bar-title">{card.title}</span> : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </Fragment>
          ))}

          {unscheduledSorted.length > 0 ? (
            <>
              <div className="gantt-row gantt-group-row gantt-unscheduled-group">
                <div className="gantt-left-cell gantt-group-left">
                  <Icon name="clock" size={13} />
                  <span className="gantt-group-title">未排期</span>
                  <span className="gantt-group-count">{unscheduledSorted.length}</span>
                </div>
                <div className="gantt-timeline-cell" style={{ width: timelineWidth }} />
              </div>
              {unscheduledSorted.map((card) => (
                <div className="gantt-row gantt-task-row" key={card.id}>
                  <div
                    className={`gantt-left-cell gantt-task-left${card.completed ? ' is-completed' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`打开任务：${card.title}`}
                    title={card.title}
                    onClick={() => openCard(card.id)}
                    onKeyDown={(event) => openCardFromKeyboard(event, card.id)}
                  >
                    <span className="gantt-list-dot" style={{ background: boardAccent }} />
                    <span className="gantt-task-title">{card.title}</span>
                    <span className="gantt-task-badge is-plain" title="还没有开始 / 截止日期">
                      未排期
                    </span>
                  </div>
                  <div
                    className="gantt-timeline-cell is-unscheduled"
                    style={{ width: timelineWidth }}
                  />
                </div>
              ))}
            </>
          ) : null}

          {todayInRange ? (
            <div
              className="gantt-today-line"
              style={{ left: LEFT_WIDTH + todayOffset + dayWidth / 2 }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
