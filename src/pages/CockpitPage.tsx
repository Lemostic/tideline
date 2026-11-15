import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { boardLoad, buildHorizon, focusCards, riskSummary } from '@/lib/cockpit';
import {
  addDaysKey,
  formatMonthDay,
  formatRelativeTime,
  formatWeekday,
  todayKey,
} from '@/lib/date';
import { rootCards, subtaskProgress } from '@/lib/taskTree';
import { boardColorValue, PRIORITY_META, type Card } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import './cockpit.css';

function greetingForHour(hour: number): string {
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function formatMinutes(minutes: number): string {
  if (minutes <= 0) return '未估时';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours}h`;
}

function priorityMeta(priority: Card['priority']) {
  return PRIORITY_META.find((item) => item.key === priority) ?? null;
}

export function CockpitPage() {
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const openCard = useUiStore((state) => state.openCard);
  const notify = useUiStore((state) => state.notify);
  const updateCard = useAppStore((state) => state.updateCard);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const allRootCards = useMemo(() => rootCards(snapshot.cards), [snapshot.cards]);
  const today = useMemo(() => todayKey(), []);
  const horizon = useMemo(
    () => buildHorizon(allRootCards, today, 7),
    [allRootCards, today],
  );
  const risk = useMemo(
    () => riskSummary(allRootCards, snapshot.dependencies, today),
    [allRootCards, snapshot.dependencies, today],
  );
  const focus = useMemo(() => focusCards(allRootCards, today, 5), [allRootCards, today]);
  const loadDays = useMemo(() => buildHorizon(allRootCards, today, 14), [allRootCards, today]);
  const boardStats = useMemo(
    () => boardLoad(allRootCards, snapshot.boards.map((board) => board.id), today),
    [allRootCards, snapshot.boards, today],
  );
  const recent = useMemo(
    () =>
      allRootCards
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 6),
    [allRootCards],
  );
  const statByBoard = useMemo(
    () => new Map(boardStats.map((stat) => [stat.boardId, stat])),
    [boardStats],
  );
  const maxLoad = Math.max(240, ...loadDays.map((day) => day.load));
  const selected = selectedId
    ? snapshot.cards.find((card) => card.id === selectedId) ?? null
    : null;
  const todayCount = horizon[0]?.tasks.length ?? 0;
  const openCount = allRootCards.filter((card) => !card.completed).length;

  const completeCard = (card: Card) => {
    void updateCard(card.id, { completed: true })
      .then(() => notify(`已完成「${card.title}」`, 'success'))
      .catch(() => undefined);
  };

  return (
    <div className="page cockpit-page">
      <header className="cockpit-head">
        <div className="cockpit-title">
          <span className="cockpit-eyebrow">潮汐驾驶舱 · {formatWeekday(today)}</span>
          <h1>
            {greetingForHour(new Date().getHours())}，今天有
            <strong>{todayCount}</strong>
            项到期
          </h1>
          <p>
            本地快照 · 共 {snapshot.boards.length} 个看板、{openCount} 项进行中
            {risk.overdue.length > 0 ? ` · ${risk.overdue.length} 项已逾期` : ' · 没有逾期'}
          </p>
        </div>
        <div className="cockpit-head-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/timeline')}>
            <Icon name="gantt" size={14} />
            时间线
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/boards')}>
            <Icon name="layout-grid" size={14} />
            全部看板
          </button>
        </div>
      </header>

      <div className="cockpit-grid">
        <div className="cockpit-main">
          <section className="cockpit-band horizon" aria-label="今日航向">
            <div className="cockpit-band-head">
              <div>
                <span className="cockpit-band-kicker">TIDE HORIZON</span>
                <h2>今日航向</h2>
              </div>
              <span className="cockpit-band-note">未来 7 天的到期节奏，点击任务进入检视</span>
            </div>
            <div className="horizon-track">
              {horizon.map((day) => (
                <div
                  key={day.key}
                  className={`horizon-day${day.isToday ? ' is-today' : ''}`}
                >
                  <div className="horizon-day-head">
                    <span>{day.weekday}</span>
                    <strong>{day.monthDay}</strong>
                    {day.tasks.length > 0 ? <em>{day.tasks.length}</em> : null}
                  </div>
                  <div className="horizon-tasks">
                    {day.tasks.slice(0, 3).map((card) => (
                      <button
                        key={card.id}
                        type="button"
                        className={`horizon-task${card.priority ? ` is-${card.priority}` : ''}${
                          selectedId === card.id ? ' is-selected' : ''
                        }`}
                        onClick={() => setSelectedId(card.id)}
                        title={card.title}
                      >
                        <span>{card.title}</span>
                      </button>
                    ))}
                    {day.tasks.length > 3 ? (
                      <span className="horizon-more">+{day.tasks.length - 3}</span>
                    ) : null}
                    {day.tasks.length === 0 ? (
                      <span className="horizon-empty">—</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="cockpit-instruments">
            <section className="cockpit-band risk-radar" aria-label="风险雷达">
              <div className="cockpit-band-head">
                <div>
                  <span className="cockpit-band-kicker">RISK RADAR</span>
                  <h2>风险雷达</h2>
                </div>
                <button className="cockpit-link" onClick={() => navigate('/tasks')}>
                  全部任务 <Icon name="chevron-right" size={12} />
                </button>
              </div>
              <div className="risk-list">
                {[
                  { key: 'overdue', label: '已逾期', tone: 'danger', items: risk.overdue },
                  { key: 'blocked', label: '被阻塞', tone: 'warn', items: risk.blocked },
                  { key: 'soon', label: '三天内', tone: 'accent', items: risk.dueSoon },
                  { key: 'free', label: '无日期', tone: 'muted', items: risk.unscheduled },
                ].map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    className={`risk-row risk-${row.tone}`}
                    onClick={() => row.items[0] && setSelectedId(row.items[0].id)}
                  >
                    <span className="risk-dot" />
                    <span className="risk-label">{row.label}</span>
                    <strong>{row.items.length}</strong>
                    <span className="risk-sample">
                      {row.items[0]?.title ?? '—'}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="cockpit-band load-tide" aria-label="负载潮汐">
              <div className="cockpit-band-head">
                <div>
                  <span className="cockpit-band-kicker">LOAD TIDE</span>
                  <h2>负载潮汐</h2>
                </div>
                <span className="cockpit-band-note">未来 14 天预估</span>
              </div>
              <div className="tide-chart">
                {loadDays.map((day) => {
                  const height = Math.max(4, Math.round((day.load / maxLoad) * 100));
                  return (
                    <div
                      key={day.key}
                      className={`tide-bar${day.isToday ? ' is-today' : ''}${
                        day.minutes > 480 ? ' is-over' : ''
                      }`}
                      title={`${day.monthDay} ${day.weekday} · ${day.tasks.length} 项 · ${formatMinutes(day.load)}`}
                    >
                      <span className="tide-fill" style={{ height: `${height}%` }} />
                      <span className="tide-label">{day.weekday.slice(1, 2)}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="cockpit-band constellation" aria-label="看板星座">
              <div className="cockpit-band-head">
                <div>
                  <span className="cockpit-band-kicker">BOARD CONSTELLATION</span>
                  <h2>看板星座</h2>
                </div>
                <button className="cockpit-link" onClick={() => navigate('/boards')}>
                  全部 <Icon name="chevron-right" size={12} />
                </button>
              </div>
              <div className="constellation-grid">
                {snapshot.boards.slice(0, 6).map((board) => {
                  const stat = statByBoard.get(board.id);
                  const percent =
                    stat && stat.total > 0 ? Math.round((stat.completed / stat.total) * 100) : 0;
                  return (
                    <button
                      key={board.id}
                      type="button"
                      className="constellation-item"
                      onClick={() => navigate(`/board/${board.id}`)}
                      style={{ '--board-color': boardColorValue(board.color) } as CSSProperties}
                    >
                      <span
                        className="constellation-ring"
                        style={{ '--ring-percent': `${percent}%` } as CSSProperties}
                      >
                        {percent}%
                      </span>
                      <span className="constellation-name">{board.title}</span>
                      <span className="constellation-meta">
                        {stat?.total ?? 0} 项
                        {stat && stat.overdue > 0 ? <em>{stat.overdue} 逾期</em> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          <section className="cockpit-band recent-band" aria-label="最近变动">
            <div className="cockpit-band-head">
              <div>
                <span className="cockpit-band-kicker">RECENT WAKE</span>
                <h2>最近变动</h2>
              </div>
              <button className="cockpit-link" onClick={() => navigate('/tasks')}>
                我的任务 <Icon name="chevron-right" size={12} />
              </button>
            </div>
            <div className="recent-list">
              {recent.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="recent-item"
                  onClick={() => setSelectedId(card.id)}
                >
                  <span
                    className="recent-dot"
                    style={
                      {
                        '--recent-color': boardColorValue(
                          snapshot.boards.find((board) => board.id === card.boardId)?.color ??
                            'teal',
                        ),
                      } as CSSProperties
                    }
                  />
                  <span className="recent-text">
                    <strong>{card.title}</strong>
                    <small>
                      {snapshot.boards.find((board) => board.id === card.boardId)?.title ?? ''}
                      {' · '}
                      {formatRelativeTime(card.updatedAt)}
                    </small>
                  </span>
                  {card.completed ? <em>已完成</em> : null}
                </button>
              ))}
            </div>
          </section>
        </div>

        <aside className="cockpit-inspector" aria-label="检视器">
          <div className="inspector-head">
            <span className="cockpit-band-kicker">INSPECTOR</span>
            <h2>{selected ? '任务检视' : '今日专注'}</h2>
          </div>
          {selected ? (
            <div className="inspector-body">
              <button className="inspector-back" onClick={() => setSelectedId(null)}>
                <Icon name="arrow-left" size={13} /> 返回专注列表
              </button>
              <h3 className="inspector-title">{selected.title}</h3>
              <div className="inspector-tags">
                <span>
                  {snapshot.boards.find((board) => board.id === selected.boardId)?.title ?? '看板'}
                </span>
                <span>
                  {snapshot.lists.find((list) => list.id === selected.listId)?.title ?? '列表'}
                </span>
                {selected.priority ? (
                  <span className={`inspector-priority is-${selected.priority}`}>
                    {priorityMeta(selected.priority)?.label}优先级
                  </span>
                ) : null}
              </div>
              <dl className="inspector-facts">
                <div>
                  <dt>截止</dt>
                  <dd>
                    {selected.dueDate
                      ? `${formatMonthDay(selected.dueDate)} · ${formatWeekday(selected.dueDate)}`
                      : '未设置'}
                  </dd>
                </div>
                <div>
                  <dt>预估</dt>
                  <dd>
                    {selected.estimatedMinutes
                      ? formatMinutes(selected.estimatedMinutes)
                      : '未估时'}
                  </dd>
                </div>
                <div>
                  <dt>子任务</dt>
                  <dd>
                    {(() => {
                      const progress = subtaskProgress(snapshot.cards, selected.id);
                      return progress.total > 0 ? `${progress.done}/${progress.total}` : '无';
                    })()}
                  </dd>
                </div>
              </dl>
              {selected.labels.length > 0 ? (
                <div className="inspector-labels">
                  {selected.labels.map((label) => (
                    <span key={label}>{label}</span>
                  ))}
                </div>
              ) : null}
              <div className="inspector-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => completeCard(selected)}
                >
                  <Icon name="check" size={13} /> 完成
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => openCard(selected.id)}>
                  打开详情
                </button>
              </div>
            </div>
          ) : (
            <div className="inspector-body">
              <p className="inspector-note">
                从航向、风险或专注列表里选一项任务，它的状态与动作会显示在这里。
              </p>
              <ol className="focus-list">
                {focus.map((card, index) => (
                  <li key={card.id}>
                    <button type="button" onClick={() => setSelectedId(card.id)}>
                      <span className="focus-index">{`${index + 1}`.padStart(2, '0')}</span>
                      <span className="focus-text">
                        <strong>{card.title}</strong>
                        <small>
                          {card.dueDate ? formatMonthDay(card.dueDate) : '无截止'}
                          {' · '}
                          {snapshot.boards.find((board) => board.id === card.boardId)?.title ?? ''}
                        </small>
                      </span>
                      <Icon name="chevron-right" size={12} />
                    </button>
                  </li>
                ))}
                {focus.length === 0 ? <li className="focus-empty">今天没有待处理任务。</li> : null}
              </ol>
              <div className="inspector-summary">
                <div>
                  <span>未来 7 天</span>
                  <strong>
                    {horizon.reduce((sum, day) => sum + day.tasks.length, 0)}
                  </strong>
                </div>
                <div>
                  <span>预估负载</span>
                  <strong>
                    {formatMinutes(horizon.reduce((sum, day) => sum + day.load, 0))}
                  </strong>
                </div>
                <div>
                  <span>下一个节点</span>
                  <strong>{formatMonthDay(addDaysKey(today, 7))}</strong>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
