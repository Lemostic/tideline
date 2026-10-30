import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { formatDueLabel, todaySummary } from '@/lib/date';
import { blockersFor } from '@/lib/dependencies';
import {
  buildDashboard,
  DASHBOARD_RANGES,
  type BoardHealth,
  type DashboardRange,
  type PrioritySlice,
  type StatusSlice,
  type TrendPoint,
} from '@/lib/dashboard';
import { boardColorValue, type Card } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import './dashboard.css';

const STATUS_COLORS: Record<string, string> = {
  completed: '#0f766e',
  overdue: '#c54a3a',
  today: '#e9a23b',
  week: '#4c8dff',
  later: '#7b8794',
  none: '#d9ded6',
};

const PRIORITY_COLORS: Record<string, string> = {
  high: '#e5533d',
  medium: '#e9a23b',
  low: '#4c8dff',
  none: '#d9ded6',
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * 仪表盘（V0.5.3）：本机全部任务统计 + 趋势 + 状态 / 优先级 / 看板健康度 / 重点任务。
 * 全部从 snapshot 派生，不发网络请求；时间范围与看板筛选只作用于统计视图。
 */
export function DashboardPage() {
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const trash = useAppStore((state) => state.trash);
  const loadTrash = useAppStore((state) => state.loadTrash);
  const openCard = useUiStore((state) => state.openCard);
  const weekStartsOn = useSettingsStore((state) => state.weekStartsOn);

  const [boardFilter, setBoardFilter] = useState('all');
  const [rangeDays, setRangeDays] = useState<DashboardRange>(30);

  useEffect(() => {
    void loadTrash().catch(() => undefined);
  }, [loadTrash]);

  const now = useMemo(() => new Date(), [snapshot.cards]);
  const activeBoardId =
    boardFilter !== 'all' && snapshot.boards.some((board) => board.id === boardFilter)
      ? boardFilter
      : null;

  const data = useMemo(
    () =>
      buildDashboard(snapshot, trash.length, {
        boardId: activeBoardId,
        rangeDays,
        weekStartsOn,
        now,
      }),
    [snapshot, trash.length, activeBoardId, rangeDays, weekStartsOn, now],
  );

  const boardById = useMemo(
    () => new Map(snapshot.boards.map((board) => [board.id, board])),
    [snapshot.boards],
  );

  if (snapshot.boards.length === 0) {
    return (
      <div className="page dashboard-page">
        <div className="dashboard-empty">
          <EmptyState
            icon={<Icon name="chart" size={22} />}
            title="还没有可统计的看板"
            description="先创建一个看板，仪表盘会自动汇总任务、完成率和趋势。"
            action={
              <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
                去创建看板
              </button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page dashboard-page">
      <header className="dashboard-head">
        <div className="dashboard-head-text">
          <div className="page-eyebrow">仪表盘 · {todaySummary(now)}</div>
          <h1 className="dashboard-title">
            {data.board ? `${data.board.title} · 仪表盘` : '全部看板 · 仪表盘'}
          </h1>
          <p className="dashboard-sub">
            共 {snapshot.boards.length} 个看板 · {data.kpis.total} 个任务 · 已完成{' '}
            {data.kpis.completed} · 近 {rangeDays} 天新建 {data.kpis.createdInRange}
          </p>
        </div>

        <div className="dashboard-controls">
          <label className="dashboard-select">
            <Icon name="layout-grid" size={13} />
            <select
              value={boardFilter}
              onChange={(event) => setBoardFilter(event.target.value)}
              aria-label="选择看板"
            >
              <option value="all">全部看板</option>
              {snapshot.boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.title}
                </option>
              ))}
            </select>
          </label>
          <div className="dashboard-range" role="tablist" aria-label="统计时间范围">
            {DASHBOARD_RANGES.map((days) => (
              <button
                key={days}
                type="button"
                role="tab"
                aria-selected={rangeDays === days}
                className={`dashboard-range-btn${rangeDays === days ? ' is-active' : ''}`}
                onClick={() => setRangeDays(days)}
              >
                {days} 天
              </button>
            ))}
          </div>
        </div>
      </header>

      <section className="dashboard-kpis" aria-label="核心指标">
        <KpiCard
          label="任务总数"
          value={String(data.kpis.total)}
          sub={`已完成 ${data.kpis.completed} 个`}
          icon="list"
        />
        <KpiCard
          label="完成率"
          value={percent(data.kpis.completionRate)}
          sub={`子任务 ${data.kpis.subtaskDone}/${data.kpis.subtaskTotal}`}
          icon="check-circle"
          tone="primary"
          progress={data.kpis.completionRate}
        />
        <KpiCard
          label="已逾期"
          value={String(data.kpis.overdue)}
          sub={`今天到期 ${data.kpis.dueToday} 个`}
          icon="clock"
          tone="danger"
        />
        <KpiCard
          label="本周到期"
          value={String(data.kpis.dueWeek)}
          sub={`无截止日期 ${data.kpis.noDue} 个`}
          icon="calendar"
          tone="warn"
        />
        <KpiCard
          label="被阻塞"
          value={String(data.kpis.blocked)}
          sub={`任务依赖未完成`}
          icon="link"
          tone="warn"
        />
        <KpiCard
          label="回收站"
          value={String(data.kpis.trash)}
          sub={`近 ${rangeDays} 天完成 ${data.kpis.completedInRange}`}
          icon="trash"
        />
      </section>

      <div className="dashboard-grid">
        <section className="dash-card dash-trend">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">任务趋势</h2>
              <p className="dash-card-desc">
                近 {rangeDays} 天新建与完成（完成时间按最后更新近似）
              </p>
            </div>
            <div className="dash-legend">
              <span><i style={{ background: '#0f766e' }} />新建</span>
              <span><i style={{ background: '#e9a23b' }} />完成</span>
            </div>
          </div>
          <TrendChart points={data.trend} />
        </section>

        <section className="dash-card dash-status">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">任务状态</h2>
              <p className="dash-card-desc">按截止日期分组，含已完成</p>
            </div>
          </div>
          <StatusDonut slices={data.status} total={data.kpis.total} rate={data.kpis.completionRate} />
        </section>

        <section className="dash-card dash-priority">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">优先级分布</h2>
              <p className="dash-card-desc">全部任务（含已完成）</p>
            </div>
          </div>
          <PriorityBars slices={data.priority} />
        </section>

        <section className="dash-card dash-health">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">看板健康度</h2>
              <p className="dash-card-desc">各看板完成进度与逾期情况，点击进入看板</p>
            </div>
            <span className="dash-card-count">{data.boardHealth.length} 个看板</span>
          </div>
          <div className="dash-board-list">
            {data.boardHealth.map((item) => (
              <BoardHealthRow
                key={item.board.id}
                item={item}
                onClick={() => navigate(`/board/${item.board.id}`)}
              />
            ))}
          </div>
        </section>

        <section className="dash-card dash-focus">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">重点关注</h2>
              <p className="dash-card-desc">逾期、今天与本周到期，按紧急程度排序</p>
            </div>
            <span className="dash-card-count">{data.focus.length} 个任务</span>
          </div>
          <FocusList
            cards={data.focus}
            boardById={boardById}
            onOpen={openCard}
          />
        </section>

        <section className="dash-card dash-blocked">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">被阻塞任务</h2>
              <p className="dash-card-desc">前置任务尚未完成，点击查看详情</p>
            </div>
            <span className="dash-card-count">{data.kpis.blocked} 个</span>
          </div>
          <BlockedList
            cards={data.blockedCards}
            snapshot={snapshot}
            boardById={boardById}
            onOpen={openCard}
          />
        </section>
      </div>
    </div>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  sub: string;
  icon: 'list' | 'check-circle' | 'clock' | 'calendar' | 'link' | 'trash';
  tone?: 'primary' | 'danger' | 'warn';
  progress?: number;
}

function KpiCard({ label, value, sub, icon, tone, progress }: KpiCardProps) {
  return (
    <div className={`dash-kpi${tone ? ` tone-${tone}` : ''}`}>
      <div className="dash-kpi-head">
        <span className="dash-kpi-label">{label}</span>
        <span className="dash-kpi-icon">
          <Icon name={icon} size={14} />
        </span>
      </div>
      <div className="dash-kpi-value">{value}</div>
      <div className="dash-kpi-sub">{sub}</div>
      {progress !== undefined ? (
        <div className="dash-kpi-progress">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function TrendChart({ points }: { points: TrendPoint[] }) {
  const width = 760;
  const height = 250;
  const pad = { top: 18, right: 16, bottom: 30, left: 34 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const max = Math.max(1, ...points.map((point) => Math.max(point.created, point.completed)));
  const x = (index: number) =>
    points.length <= 1 ? pad.left : pad.left + (index / (points.length - 1)) * innerWidth;
  const y = (value: number) => pad.top + innerHeight - (value / max) * innerHeight;
  const line = (key: 'created' | 'completed') =>
    points.map((point, index) => `${x(index)},${y(point[key])}`).join(' ');
  const labelStep = Math.max(1, Math.ceil(points.length / 6));
  const gridValues = [0, 0.5, 1];

  return (
    <div className="dash-trend-wrap">
      <svg
        className="dash-trend-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="近段时间任务新建与完成趋势"
      >
        {gridValues.map((ratio) => {
          const value = Math.round(max * ratio);
          const gridY = y(value);
          return (
            <g key={ratio}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={gridY}
                y2={gridY}
                className="dash-grid-line"
              />
              <text x={pad.left - 6} y={gridY + 3} textAnchor="end" className="dash-axis-label">
                {value}
              </text>
            </g>
          );
        })}

        <polyline points={line('created')} className="dash-trend-line is-created" />
        <polyline points={line('completed')} className="dash-trend-line is-completed" />

        {points.map((point, index) => (
          <g key={point.date}>
            <circle
              cx={x(index)}
              cy={y(point.created)}
              r={points.length > 30 ? 2 : 3}
              className="dash-point is-created"
            >
              <title>{`${point.date} 新建 ${point.created} 个`}</title>
            </circle>
            <circle
              cx={x(index)}
              cy={y(point.completed)}
              r={points.length > 30 ? 2 : 3}
              className="dash-point is-completed"
            >
              <title>{`${point.date} 完成 ${point.completed} 个`}</title>
            </circle>
            {index % labelStep === 0 || index === points.length - 1 ? (
              <text x={x(index)} y={height - 10} textAnchor="middle" className="dash-axis-label">
                {point.date.slice(5).replace('-', '/')}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
    </div>
  );
}

function StatusDonut({
  slices,
  total,
  rate,
}: {
  slices: StatusSlice[];
  total: number;
  rate: number;
}) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="dash-donut">
      <div className="dash-donut-chart">
        <svg viewBox="0 0 140 140" role="img" aria-label="任务状态分布">
          <circle cx="70" cy="70" r={radius} className="dash-donut-bg" />
          {slices.map((slice) => {
            if (slice.count === 0 || total === 0) return null;
            const fraction = slice.count / total;
            const dash = fraction * circumference;
            const element = (
              <circle
                key={slice.key}
                cx="70"
                cy="70"
                r={radius}
                stroke={STATUS_COLORS[slice.key]}
                strokeDasharray={`${dash} ${circumference}`}
                strokeDashoffset={-offset}
                className="dash-donut-seg"
                transform="rotate(-90 70 70)"
              >
                <title>{`${slice.label} ${slice.count} 个`}</title>
              </circle>
            );
            offset += dash;
            return element;
          })}
          <text x="70" y="66" textAnchor="middle" className="dash-donut-value">
            {percent(rate)}
          </text>
          <text x="70" y="82" textAnchor="middle" className="dash-donut-label">
            完成率
          </text>
        </svg>
      </div>
      <ul className="dash-status-legend">
        {slices.map((slice) => (
          <li key={slice.key}>
            <i style={{ background: STATUS_COLORS[slice.key] }} />
            <span>{slice.label}</span>
            <strong>{slice.count}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PriorityBars({ slices }: { slices: PrioritySlice[] }) {
  const max = Math.max(1, ...slices.map((slice) => slice.count));
  return (
    <div className="dash-priority-bars">
      {slices.map((slice) => (
        <div className="dash-priority-row" key={slice.key}>
          <span className="dash-priority-label">
            <i style={{ background: PRIORITY_COLORS[slice.key] }} />
            {slice.label}
          </span>
          <div className="dash-priority-track">
            <span
              style={{
                width: slice.count === 0 ? 0 : `${Math.max(4, (slice.count / max) * 100)}%`,
                background: PRIORITY_COLORS[slice.key],
              }}
            />
          </div>
          <strong>{slice.count}</strong>
        </div>
      ))}
    </div>
  );
}

function BoardHealthRow({ item, onClick }: { item: BoardHealth; onClick: () => void }) {
  return (
    <button type="button" className="dash-board-row" onClick={onClick}>
      <span
        className="dash-board-dot"
        style={{ background: boardColorValue(item.board.color) }}
      />
      <span className="dash-board-main">
        <span className="dash-board-name">{item.board.title}</span>
        <span className="dash-board-meta">
          {item.total} 个任务 · 已完成 {item.completed}
          {item.overdue > 0 ? ` · ${item.overdue} 个逾期` : ''}
        </span>
      </span>
      <span className="dash-board-progress">
        <span style={{ width: `${Math.round(item.completionRate * 100)}%` }} />
      </span>
      <span className="dash-board-rate">{percent(item.completionRate)}</span>
      <Icon name="chevron-right" size={13} />
    </button>
  );
}

function FocusList({
  cards,
  boardById,
  onOpen,
}: {
  cards: Card[];
  boardById: Map<string, { title: string }>;
  onOpen: (id: string) => void;
}) {
  if (cards.length === 0) {
    return <p className="dash-empty-text">没有逾期或临近到期的任务，节奏正好。</p>;
  }
  return (
    <ul className="dash-list">
      {cards.map((card) => {
        const overdue = card.dueDate !== null && card.dueDate < todayKey();
        return (
          <li key={card.id}>
            <button type="button" className="dash-list-item" onClick={() => onOpen(card.id)}>
              <span className={`dash-list-dot${overdue ? ' is-danger' : ''}`} />
              <span className="dash-list-main">
                <span className="dash-list-title">{card.title}</span>
                <span className="dash-list-meta">{boardById.get(card.boardId)?.title ?? '未知看板'}</span>
              </span>
              <span className={`dash-list-due${overdue ? ' is-danger' : ''}`}>
                {formatDueLabel(card.dueDate ?? '')}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function BlockedList({
  cards,
  snapshot,
  boardById,
  onOpen,
}: {
  cards: Card[];
  snapshot: ReturnType<typeof useSnapshot>;
  boardById: Map<string, { title: string }>;
  onOpen: (id: string) => void;
}) {
  if (cards.length === 0) {
    return <p className="dash-empty-text">没有被前置任务阻塞的任务。</p>;
  }
  return (
    <ul className="dash-list">
      {cards.map((card) => {
        const blockers = blockersFor(card.id, snapshot.dependencies, snapshot.cards);
        const unfinished = blockers.filter((blocker) => !blocker.completed).length;
        return (
          <li key={card.id}>
            <button type="button" className="dash-list-item" onClick={() => onOpen(card.id)}>
              <span className="dash-list-dot is-blocked" />
              <span className="dash-list-main">
                <span className="dash-list-title">{card.title}</span>
                <span className="dash-list-meta">
                  {boardById.get(card.boardId)?.title ?? '未知看板'} · 被 {unfinished} 个前置任务阻塞
                </span>
              </span>
              <Icon name="link" size={13} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, '0');
  const d = `${now.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}
