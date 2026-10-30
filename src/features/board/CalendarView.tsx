import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Icon, type IconName } from '@/components/Icon';
import {
  addDaysKey,
  eachDateKey,
  formatMonthDay,
  parseDateKey,
  toDateKey,
  todayKey,
} from '@/lib/date';
import {
  PRIORITY_META,
  boardColorValue,
  type Card,
  type CardPatch,
  type Priority,
} from '@/lib/types';
import { useAppStore } from '@/store/appStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import type { BoardViewProps } from './TableView';
import './calendar.css';

/** 周一为每周起点 */
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
/** 固定 6 行 × 7 列，保证月份切换时页面不跳动 */
const CELL_COUNT = 42;
const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const EMPTY_ENTRIES: Card[] = [];

function validDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  return parseDateKey(value) ? value : null;
}

/** 同一格里：未完成在前 → 优先级高在前 → 列表内 position */
function compareEntries(a: Card, b: Card): number {
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  const rankA = a.priority ? PRIORITY_RANK[a.priority] : 3;
  const rankB = b.priority ? PRIORITY_RANK[b.priority] : 3;
  if (rankA !== rankB) return rankA - rankB;
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt);
}

function pad2(value: number): string {
  return `${value}`.padStart(2, '0');
}

function shiftMonthValue(year: number, month: number, delta: number): { year: number; month: number } {
  const next = new Date(year, month + delta, 1);
  return { year: next.getFullYear(), month: next.getMonth() };
}

interface DragState {
  cardId: string;
}

interface CalendarNote {
  key: string;
  icon: IconName;
  text: string;
}

/**
 * 日历视图（V0.3）
 * 固定 6×7 月历（周一起始，跨月淡化），按 dueDate 归入格子；
 * 支持上 / 下月、今天、显示已完成、拖拽条目改期（调用 store.updateCard 持久化）。
 */
export function CalendarView({ board, lists, cards }: BoardViewProps) {
  const openCard = useUiStore((state) => state.openCard);
  const updateCard = useAppStore((state) => state.updateCard);
  const weekStartsOn = useSettingsStore((state) => state.weekStartsOn);
  const weekdayLabels =
    weekStartsOn === 1
      ? WEEKDAY_LABELS
      : [WEEKDAY_LABELS[6], ...WEEKDAY_LABELS.slice(0, 6)];
  const isWeekendIndex = (index: number) =>
    weekStartsOn === 1 ? index % 7 >= 5 : index % 7 === 0 || index % 7 === 6;

  const today = todayKey();
  const [view, setView] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [showCompleted, setShowCompleted] = useState(true);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const [maxEntries, setMaxEntries] = useState(3);
  const gridRef = useRef<HTMLDivElement>(null);
  const draggedRef = useRef(false);

  const boardAccent = boardColorValue(board.color);
  const listById = useMemo(() => new Map(lists.map((list) => [list.id, list])), [lists]);

  const shownCards = useMemo(
    () => (showCompleted ? cards : cards.filter((card) => !card.completed)),
    [cards, showCompleted],
  );
  const datedCards = useMemo(
    () => shownCards.filter((card) => validDateKey(card.dueDate) !== null),
    [shownCards],
  );
  const undatedCount = shownCards.length - datedCards.length;

  // dueDate → 当天条目（已按完成态 / 优先级排序）
  const entriesByDay = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const card of datedCards) {
      const key = validDateKey(card.dueDate);
      if (!key) continue;
      const bucket = map.get(key);
      if (bucket) bucket.push(card);
      else map.set(key, [card]);
    }
    for (const bucket of map.values()) bucket.sort(compareEntries);
    return map;
  }, [datedCards]);

  const gridStartKey = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const dayOfWeek = first.getDay();
    first.setDate(first.getDate() - ((dayOfWeek - weekStartsOn + 7) % 7));
    return toDateKey(first);
  }, [view.year, view.month, weekStartsOn]);

  const gridDays = useMemo(
    () => eachDateKey(gridStartKey, addDaysKey(gridStartKey, CELL_COUNT - 1)),
    [gridStartKey],
  );

  const monthKey = `${view.year}-${pad2(view.month + 1)}`;
  const monthStartKey = `${monthKey}-01`;
  const monthEndKey = toDateKey(new Date(view.year, view.month + 1, 0));

  const monthStats = useMemo(() => {
    let total = 0;
    let completed = 0;
    for (const card of datedCards) {
      const due = validDateKey(card.dueDate);
      if (!due || !due.startsWith(monthKey)) continue;
      total += 1;
      if (card.completed) completed += 1;
    }
    return { total, completed };
  }, [datedCards, monthKey]);

  // 每格最多展示几条：按格子实际高度在 1~4 之间自适应，避免撑破 6 行网格
  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const measure = () => {
      const cellHeight = element.clientHeight / 6;
      const available = cellHeight - 30;
      setMaxEntries(Math.max(1, Math.min(4, Math.floor(available / 22))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setExpandedDay(null);
  }, [view.year, view.month]);

  const shiftMonth = (delta: number) => {
    setView((current) => shiftMonthValue(current.year, current.month, delta));
    setExpandedDay(null);
    setDropDay(null);
  };

  const goToday = () => {
    const now = new Date();
    setView({ year: now.getFullYear(), month: now.getMonth() });
    setExpandedDay(null);
    setDropDay(null);
  };

  const entryAccent = (card: Card) =>
    PRIORITY_META.find((item) => item.key === card.priority)?.color ?? boardAccent;

  const notes = useMemo<CalendarNote[]>(() => {
    const items: CalendarNote[] = [];
    if (cards.length === 0) {
      items.push({
        key: 'empty',
        icon: 'info',
        text: '这个看板还没有任务：先到「看板」视图添加任务，它们会按截止日期出现在日历上。',
      });
      return items;
    }
    if (datedCards.length === 0) {
      items.push({
        key: 'no-due',
        icon: 'calendar',
        text: `当前 ${undatedCount} 个任务都还没有截止日期，在任务抽屉里补充后即可显示在月历上。`,
      });
      return items;
    }
    if (monthStats.total === 0) {
      items.push({
        key: 'month-empty',
        icon: 'calendar',
        text: `${view.year} 年 ${view.month + 1} 月还没有截止任务，可以切换到其他月份看看。`,
      });
    }
    if (undatedCount > 0) {
      items.push({
        key: 'undated',
        icon: 'clock',
        text: `另有 ${undatedCount} 个任务没有截止日期，暂不显示在月历上。`,
      });
    }
    return items;
  }, [cards.length, datedCards.length, undatedCount, monthStats.total, view.year, view.month]);

  const handleEntryDragStart = (event: DragEvent<HTMLElement>, card: Card) => {
    draggedRef.current = true;
    setDragState({ cardId: card.id });
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.id);
  };

  const handleEntryDragEnd = () => {
    // 延后一拍再解除，避免拖拽结束时的 click 误开任务抽屉
    window.setTimeout(() => {
      draggedRef.current = false;
    }, 0);
    setDragState(null);
    setDropDay(null);
  };

  const handleCellDragOver = (event: DragEvent<HTMLDivElement>, dayKey: string) => {
    if (!dragState) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropDay((current) => (current === dayKey ? current : dayKey));
  };

  const handleCellDrop = (event: DragEvent<HTMLDivElement>, dayKey: string) => {
    event.preventDefault();
    const cardId = dragState?.cardId ?? event.dataTransfer.getData('text/plain');
    setDragState(null);
    setDropDay(null);
    if (!cardId) return;
    const card = cards.find((item) => item.id === cardId);
    if (!card) return;
    const currentDue = validDateKey(card.dueDate);
    if (currentDue === dayKey) return;
    const patch: CardPatch = { dueDate: dayKey };
    // 保持「开始日期 ≤ 截止日期」：拖到开始日期之前时，同步前移开始日期
    const startKey = validDateKey(card.startDate);
    if (startKey && startKey > dayKey) patch.startDate = dayKey;
    void updateCard(card.id, patch).catch(() => undefined);
  };

  const openEntry = (cardId: string) => {
    if (draggedRef.current) return;
    openCard(cardId);
  };

  const handleEntryKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, cardId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openCard(cardId);
    }
  };

  const renderEntry = (card: Card) => {
    const due = validDateKey(card.dueDate);
    const listTitle = listById.get(card.listId)?.title ?? '';
    return (
      <div
        key={card.id}
        role="button"
        tabIndex={0}
        draggable
        className={`cal-entry${card.completed ? ' is-completed' : ''}${
          dragState?.cardId === card.id ? ' is-dragging' : ''
        }`}
        title={`${card.title}${listTitle ? ` · ${listTitle}` : ''}${
          due ? ` · 截止 ${formatMonthDay(due)}` : ''
        } · 拖动可改期`}
        aria-label={`打开任务：${card.title}`}
        onClick={() => openEntry(card.id)}
        onKeyDown={(event) => handleEntryKeyDown(event, card.id)}
        onDragStart={(event) => handleEntryDragStart(event, card)}
        onDragEnd={handleEntryDragEnd}
      >
        <span
          className="cal-entry-dot"
          style={{ background: card.completed ? 'var(--faint)' : entryAccent(card) }}
        />
        <span className="cal-entry-title">{card.title}</span>
      </div>
    );
  };

  const renderCell = (dayKey: string, index: number) => {
    const date = parseDateKey(dayKey);
    if (!date) return null;
    const isCurrentMonth = dayKey.slice(0, 7) === monthKey;
    const isToday = dayKey === today;
    const isWeekend = isWeekendIndex(index);
    const entries = entriesByDay.get(dayKey) ?? EMPTY_ENTRIES;
    const expanded = expandedDay === dayKey;
    // 有溢出时留一行给「+N 更多」，保证入口始终可见（不会被条目区滚动藏起来）
    const hasOverflow = !expanded && entries.length > maxEntries;
    const visibleEntries = expanded
      ? entries
      : hasOverflow
        ? entries.slice(0, Math.max(1, maxEntries - 1))
        : entries;
    const hiddenCount = entries.length - visibleEntries.length;
    const isDropTarget = dropDay === dayKey && dragState !== null;
    return (
      <div
        key={dayKey}
        className={[
          'cal-cell',
          isCurrentMonth ? '' : 'is-other-month',
          isToday ? 'is-today' : '',
          isWeekend ? 'is-weekend' : '',
          isDropTarget ? 'is-drop-target' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        title={`${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`}
        onDragOver={(event) => handleCellDragOver(event, dayKey)}
        onDrop={(event) => handleCellDrop(event, dayKey)}
      >
        <div className="cal-cell-head">
          <span className="cal-daynum">{date.getDate()}</span>
          {isToday ? <span className="cal-today-tag">今天</span> : null}
        </div>
        <div className="cal-cell-body">
          {visibleEntries.map(renderEntry)}
        </div>
        {hiddenCount > 0 || (expanded && entries.length > 0) ? (
          <div className="cal-cell-foot">
            {hiddenCount > 0 ? (
              <button
                type="button"
                className="cal-more"
                onClick={() => setExpandedDay(dayKey)}
                title={`展开当天全部 ${entries.length} 个任务`}
              >
                +{hiddenCount} 更多
              </button>
            ) : (
              <button
                type="button"
                className="cal-more is-collapse"
                onClick={() => setExpandedDay(null)}
              >
                收起
              </button>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="cal-view">
      <div className="cal-toolbar">
        <div className="cal-month-nav">
          <button
            type="button"
            className="btn btn-icon cal-nav-btn"
            aria-label="上个月"
            title="上个月"
            onClick={() => shiftMonth(-1)}
          >
            <Icon name="chevron-left" size={16} />
          </button>
          <span className="cal-month-title">
            {view.year} 年 {view.month + 1} 月
          </span>
          <button
            type="button"
            className="btn btn-icon cal-nav-btn"
            aria-label="下个月"
            title="下个月"
            onClick={() => shiftMonth(1)}
          >
            <Icon name="chevron-right" size={16} />
          </button>
        </div>

        <span className="cal-month-range">
          {formatMonthDay(monthStartKey)} – {formatMonthDay(monthEndKey)}
        </span>

        <button type="button" className="btn btn-ghost btn-sm cal-today-btn" onClick={goToday}>
          <Icon name="target" size={13} />
          今天
        </button>

        <span className="grow" />

        <span className="cal-stats">
          本月 {monthStats.total} 个任务
          {monthStats.completed > 0 ? ` · 已完成 ${monthStats.completed}` : ''}
        </span>
        <button
          type="button"
          className={`cal-toggle${showCompleted ? ' is-on' : ''}`}
          aria-pressed={showCompleted}
          onClick={() => setShowCompleted((value) => !value)}
        >
          <Icon name="check-circle" size={14} />
          显示已完成
        </button>
      </div>

      {notes.length > 0 ? (
        <div className="cal-notes">
          {notes.map((note) => (
            <div className="cal-note" key={note.key}>
              <Icon name={note.icon} size={12} />
              <span>{note.text}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="cal-sheet">
        <div className="cal-weekdays">
          {weekdayLabels.map((label, index) => (
            <span key={label} className={`cal-weekday${isWeekendIndex(index) ? ' is-weekend' : ''}`}>
              {label}
            </span>
          ))}
        </div>
        <div className="cal-grid" ref={gridRef}>
          {gridDays.map((dayKey, index) => renderCell(dayKey, index))}
        </div>
      </div>
    </div>
  );
}
