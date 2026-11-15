import { useMemo, type CSSProperties } from 'react';
import { Icon } from '@/components/Icon';
import { addDaysKey, formatMonthDay, formatWeekday, todayKey } from '@/lib/date';
import { rootCards } from '@/lib/taskTree';
import { boardColorValue, type Card } from '@/lib/types';
import { useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import './timeline.css';

const RANGE_DAYS = 14;

export function TimelinePage() {
  const snapshot = useSnapshot();
  const openCard = useUiStore((state) => state.openCard);
  const today = useMemo(() => todayKey(), []);
  const cards = useMemo(
    () => rootCards(snapshot.cards).filter((card) => !card.completed),
    [snapshot.cards],
  );
  const days = useMemo(
    () =>
      Array.from({ length: RANGE_DAYS }, (_, index) => {
        const key = addDaysKey(today, index);
        return {
          key,
          weekday: formatWeekday(key),
          monthDay: formatMonthDay(key),
          isToday: key === today,
          tasks: cards.filter((card) => card.dueDate === key),
        };
      }),
    [cards, today],
  );
  const unscheduled = cards.filter(
    (card) => !card.dueDate || card.dueDate < today || card.dueDate > addDaysKey(today, RANGE_DAYS - 1),
  );
  const boardById = useMemo(
    () => new Map(snapshot.boards.map((board) => [board.id, board])),
    [snapshot.boards],
  );

  const taskButton = (card: Card) => {
    const board = boardById.get(card.boardId);
    return (
      <button
        key={card.id}
        type="button"
        className="timeline-task"
        onClick={() => openCard(card.id)}
        style={
          {
            '--task-color': board ? boardColorValue(board.color) : 'var(--primary)',
          } as CSSProperties
        }
        title={`${board?.title ?? ''} · ${card.title}`}
      >
        <span className="timeline-task-dot" />
        <span className="timeline-task-title">{card.title}</span>
        <small>{board?.title ?? ''}</small>
      </button>
    );
  };

  return (
    <div className="page timeline-page">
      <header className="timeline-head">
        <div>
          <span className="timeline-kicker">TIDE LINE</span>
          <h1>时间线</h1>
          <p>未来两周的到期节奏，跨看板汇总；点击任务直接进入详情。</p>
        </div>
        <div className="timeline-legend">
          <span>
            <i className="is-today" /> 今天
          </span>
          <span>
            <i /> 到期任务
          </span>
        </div>
      </header>

      <div className="timeline-scroll">
        <div className="timeline-grid">
          {days.map((day) => (
            <section
              key={day.key}
              className={`timeline-day${day.isToday ? ' is-today' : ''}`}
              aria-label={`${day.monthDay} ${day.weekday}`}
            >
              <header>
                <span>{day.weekday}</span>
                <strong>{day.monthDay}</strong>
                <em>{day.tasks.length}</em>
              </header>
              <div className="timeline-day-tasks">
                {day.tasks.map(taskButton)}
                {day.tasks.length === 0 ? <span className="timeline-empty">—</span> : null}
              </div>
            </section>
          ))}
        </div>
      </div>

      <section className="timeline-unscheduled">
        <div className="timeline-unscheduled-head">
          <div>
            <span className="timeline-kicker">OPEN WATER</span>
            <h2>未排期与窗口外</h2>
          </div>
          <span>{unscheduled.length} 项</span>
        </div>
        <div className="timeline-unscheduled-list">
          {unscheduled.slice(0, 18).map(taskButton)}
          {unscheduled.length === 0 ? (
            <span className="timeline-empty">
              <Icon name="check-circle" size={15} /> 所有任务都在两周窗口内
            </span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
