import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { PageHeadBand } from '@/components/PageHeadBand';
import { formatDueLabel, todaySummary } from '@/lib/date';
import { blockersFor } from '@/lib/dependencies';
import {
  buildDashboard,
  DASHBOARD_RANGES,
  type BoardHealth,
  type CrossFilter,
  type DashboardRange,
  type DimensionKey,
  type AgingBucket,
  type PrioritySlice,
  type StatusSlice,
  type ThroughputPoint,
  type TrendPoint,
} from '@/lib/dashboard';
import {
  buildPoolBreakdown,
  POOL_DIMENSIONS,
  POOL_SEGMENTS,
  type PoolDimension,
  type PoolGroup,
  type PoolRange,
} from '@/lib/pool';
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

/** 任务池四段：完成 = 成功色，风险从左到右递增 */
const POOL_COLORS: Record<string, string> = {
  done: '#2f8a53',
  overdue: '#c54a3a',
  dueSoon: '#e9a23b',
  open: '#b9c4bd',
};

/** 看板范围：全部 / 看板集 / 自定义多选 */
type BoardScope =
  | { kind: 'all' }
  | { kind: 'set'; id: string }
  | { kind: 'manual'; ids: string[] };

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** 把范围解析成传给聚合层的看板 id 列表；null = 全部看板 */
function resolveScopeIds(scope: BoardScope, snapshot: ReturnType<typeof useSnapshot>): string[] | null {
  if (scope.kind === 'all') return null;
  if (scope.kind === 'set') {
    const set = snapshot.boardSets.find((item) => item.id === scope.id);
    if (!set) return null;
    const alive = set.boardIds.filter((id) => snapshot.boards.some((board) => board.id === id));
    return alive.length === 0 ? null : alive;
  }
  const alive = scope.ids.filter((id) => snapshot.boards.some((board) => board.id === id));
  return alive.length === 0 ? null : alive;
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

  const [scope, setScope] = useState<BoardScope>({ kind: 'all' });
  const [rangeDays, setRangeDays] = useState<DashboardRange>(30);
  /** 交叉筛选：在结构维度上点选某一格，其余图表跟着过滤 */
  const [crossFilter, setCrossFilter] = useState<CrossFilter | null>(null);
  /** 任务池维度单独持有，便于在池内切换分组口径 */
  const [poolDimension, setPoolDimension] = useState<PoolDimension>('board');
  const [poolRange, setPoolRange] = useState<PoolRange>(30);

  useEffect(() => {
    void loadTrash().catch(() => undefined);
  }, [loadTrash]);

  const now = useMemo(() => new Date(), [snapshot.cards]);
  const scopeIds = useMemo(() => resolveScopeIds(scope, snapshot), [scope, snapshot]);

  const data = useMemo(
    () =>
      buildDashboard(snapshot, trash.length, {
        boardIds: scopeIds,
        rangeDays,
        weekStartsOn,
        now,
        crossFilter,
      }),
    [snapshot, trash.length, scopeIds, rangeDays, weekStartsOn, now, crossFilter],
  );

  // 池只统计范围内主任务，并跟随交叉筛选；与 buildDashboard 口径保持一致
  const poolCards = useMemo(() => {
    const ids = scopeIds ? new Set(scopeIds) : null;
    return snapshot.cards.filter(
      (card) => card.parentCardId === null && (!ids || ids.has(card.boardId)),
    );
  }, [snapshot.cards, scopeIds]);

  const pool = useMemo(
    () =>
      buildPoolBreakdown(poolCards, {
        dimension: poolDimension,
        rangeDays: poolRange,
        weekStartsOn,
        now,
        boardTitle: new Map(snapshot.boards.map((board) => [board.id, board.title])),
        listTitle: new Map(snapshot.lists.map((list) => [list.id, list.title])),
        crossFilter,
      }),
    [poolCards, poolDimension, poolRange, weekStartsOn, now, snapshot.boards, snapshot.lists, crossFilter],
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
      <PageHeadBand
        eyebrow={`仪表盘 · ${todaySummary(now)}`}
        title={data.board ? `${data.board.title} · 仪表盘` : '全部看板 · 仪表盘'}
        description="按看板与时间范围统计本机任务，趋势、状态与风险都从快照实时算出。"
        readouts={[
          { label: '任务', value: data.kpis.total },
          { label: '完成率', value: percent(data.kpis.completionRate) },
          { label: '已逾期', value: data.kpis.overdue, tone: data.kpis.overdue > 0 ? 'danger' : 'muted' },
          { label: '本周净增', value: signed(data.efficiency.weeklyNet), tone: data.efficiency.weeklyNet > 0 ? 'accent' : 'muted' },
        ]}
        actions={
          <div className="dashboard-controls">
            <ScopePicker
              scope={scope}
              boards={snapshot.boards}
              boardSets={snapshot.boardSets}
              onChange={setScope}
            />
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
        }
      />

      {/* 交叉筛选状态：只在生效时出现，点「清除」恢复全量 */}
      {data.crossFilter ? (
        <div className="dash-crossfilter" role="status">
          <Icon name="filter" size={13} />
          <span className="dash-crossfilter-text">
            已按「{CROSS_DIMENSION_LABELS[data.crossFilter.dimension]}」筛选，图表只显示
            {crossFilterLabel(data)}
          </span>
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            onClick={() => setCrossFilter(null)}
          >
            清除筛选
          </button>
        </div>
      ) : null}

      {/* 与上一等长区间对比：新建与完成的增减 */}
      <section className="dash-compare" aria-label="与上一周期对比">
        <CompareRow
          label="新建"
          current={data.kpis.createdInRange}
          previous={data.kpis.createdPrevRange}
        />
        <CompareRow
          label="完成"
          current={data.kpis.completedInRange}
          previous={data.kpis.completedPrevRange}
        />
        <span className="dash-compare-note">
          对比前 {rangeDays} 天
        </span>
      </section>

      {/* 任务总数、完成率、已逾期已在读数条里呈现，这里只放剩下的三项，避免同一数字出现两次 */}
      <section className="dashboard-kpis" aria-label="核心指标">
        <KpiCard
          label="本周到期"
          value={String(data.kpis.dueWeek)}
          sub={`今天到期 ${data.kpis.dueToday} 个`}
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
        <section className="dash-card dash-pool">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">任务池</h2>
              <p className="dash-card-desc">
                {pool.rangeApplied
                  ? `近 ${poolRange} 天新建的任务，柱高 = 当周入池量，绿色部分为已完成`
                  : '统计范围内全部任务，柱高 = 分组的池子大小，绿色部分为已完成'}
              </p>
            </div>
            <div className="dash-pool-tools">
              <div className="dash-legend dash-pool-legend">
                {POOL_SEGMENTS.map((segment) => (
                  <span key={segment.key}>
                    <i style={{ background: POOL_COLORS[segment.key] }} />
                    {segment.label}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <PoolOverview pool={pool} />

          <div className="dash-pool-bar">
            <div className="dashboard-range" role="tablist" aria-label="任务池分组维度">
              {POOL_DIMENSIONS.map((dimension) => (
                <button
                  key={dimension.key}
                  type="button"
                  role="tab"
                  aria-selected={poolDimension === dimension.key}
                  className={`dashboard-range-btn${poolDimension === dimension.key ? ' is-active' : ''}`}
                  onClick={() => setPoolDimension(dimension.key)}
                >
                  {dimension.label}
                </button>
              ))}
            </div>
            {poolDimension === 'week' ? (
              <div className="dashboard-range" role="tablist" aria-label="任务池时间范围">
                {[7, 30, 90].map((days) => (
                  <button
                    key={days}
                    type="button"
                    role="tab"
                    aria-selected={poolRange === days}
                    className={`dashboard-range-btn${poolRange === days ? ' is-active' : ''}`}
                    onClick={() => setPoolRange(days as PoolRange)}
                  >
                    {days} 天
                  </button>
                ))}
              </div>
            ) : (
              <span className="dash-pool-hint">
                {poolDimension === 'board' || poolDimension === 'list' || poolDimension === 'label'
                  ? '点柱子可按该组交叉筛选其余图表'
                  : '优先级固定顺序，便于横向对比'}
              </span>
            )}
          </div>

          <PoolChart
            groups={pool.groups}
            maxTotal={Math.max(1, ...pool.groups.map((group) => group.total))}
            clickable={
              poolDimension === 'board' || poolDimension === 'list' || poolDimension === 'label'
            }
            activeDimension={poolDimension as DimensionKey}
            crossFilter={crossFilter}
            onSelect={(key) => {
              const dimension = poolDimension as DimensionKey;
              setCrossFilter((current) =>
                current && current.dimension === dimension && current.key === key
                  ? null
                  : { dimension, key },
              );
            }}
          />
        </section>

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

        <section className="dash-card dash-throughput">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">吞吐节奏</h2>
              <p className="dash-card-desc">按周统计新建与完成，净增为正说明在堆积</p>
            </div>
            <div className="dash-legend">
              <span><i style={{ background: '#0f766e' }} />新建</span>
              <span><i style={{ background: '#e9a23b' }} />完成</span>
            </div>
          </div>
          <ThroughputBars points={data.throughput} />
        </section>

        <section className="dash-card dash-efficiency">
          <div className="dash-card-head">
            <div>
              <h2 className="dash-card-title">效率指标</h2>
              <p className="dash-card-desc">周期时间按创建到完成计算，完成时间以最后更新近似</p>
            </div>
          </div>
          <div className="dash-metrics">
            <Metric label="中位周期" value={`${data.efficiency.medianCycleDays} 天`} />
            <Metric label="平均周期" value={`${round1(data.efficiency.averageCycleDays)} 天`} />
            <Metric label="未完成平均存续" value={`${round1(data.efficiency.avgAgeDays)} 天`} />
            <Metric
              label="积压任务"
              value={String(data.efficiency.backlog)}
              tone={data.efficiency.backlog > 0 ? 'danger' : 'default'}
            />
          </div>
          <AgingChart buckets={data.aging} />
        </section>
      </div>
    </div>
  );
}

const CROSS_DIMENSION_LABELS: Record<DimensionKey, string> = {
  board: '看板',
  list: '列表',
  label: '标签',
};

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function round1(value: number): string {
  return `${Math.round(value * 10) / 10}`;
}

/** 交叉筛选生效时，页面上要能说出「筛的是谁」 */
function crossFilterLabel(data: ReturnType<typeof buildDashboard>): string {
  const filter = data.crossFilter;
  if (!filter) return '';
  const source =
    filter.dimension === 'board'
      ? data.byBoard
      : filter.dimension === 'list'
        ? data.byList
        : data.byLabel;
  return source.find((slice) => slice.key === filter.key)?.label ?? '所选分组';
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

/** 环比行：本期 vs 上期，带增减方向 */
function CompareRow({
  label,
  current,
  previous,
}: {
  label: string;
  current: number;
  previous: number;
}) {
  const delta = current - previous;
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  return (
    <span className="dash-compare-row">
      <span className="dash-compare-label">{label}</span>
      <span className="dash-compare-value">{current}</span>
      <span className={`dash-compare-delta is-${direction}`}>
        {direction === 'flat' ? '持平' : `${delta > 0 ? '+' : ''}${delta}`}
      </span>
      <span className="dash-compare-prev">上期 {previous}</span>
    </span>
  );
}

/** 吞吐节奏：每周两根柱（新建 / 完成），上方标净增 */
function ThroughputBars({ points }: { points: ThroughputPoint[] }) {
  const max = Math.max(1, ...points.flatMap((point) => [point.created, point.completed]));
  if (points.length === 0) {
    return <p className="dash-empty-text">还没有可统计的周数据。</p>;
  }
  return (
    <div className="dash-throughput-chart">
      {points.map((point) => (
        <div className="dash-throughput-col" key={point.weekStart}>
          <span
            className={`dash-throughput-net${point.net > 0 ? ' is-up' : point.net < 0 ? ' is-down' : ''}`}
          >
            {signed(point.net)}
          </span>
          <div className="dash-throughput-bars">
            <span
              className="dash-throughput-bar is-created"
              style={{ height: `${(point.created / max) * 100}%` }}
              title={`新建 ${point.created} 个`}
            />
            <span
              className="dash-throughput-bar is-completed"
              style={{ height: `${(point.completed / max) * 100}%` }}
              title={`完成 ${point.completed} 个`}
            />
          </div>
          <span className="dash-throughput-label">{point.weekStart.slice(5).replace('-', '/')}</span>
        </div>
      ))}
    </div>
  );
}

/** 效率指标的一格 */
function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <div className="dash-metric">
      <span className="dash-metric-label">{label}</span>
      <strong className={`dash-metric-value${tone === 'danger' ? ' is-danger' : ''}`}>{value}</strong>
    </div>
  );
}

/** 任务年龄分布：横向堆叠条，越往右挂得越久 */
function AgingChart({ buckets }: { buckets: AgingBucket[] }) {
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  if (total === 0) {
    return <p className="dash-empty-text">没有未完成的任务，积压为零。</p>;
  }
  return (
    <div className="dash-aging">
      <div className="dash-aging-bar">
        {buckets.map((bucket) =>
          bucket.count === 0 ? null : (
            <span
              key={bucket.key}
              className={`dash-aging-seg is-${bucket.key}`}
              style={{ width: `${(bucket.count / total) * 100}%` }}
              title={`${bucket.label}：${bucket.count} 个`}
            />
          ),
        )}
      </div>
      <ul className="dash-aging-legend">
        {buckets.map((bucket) => (
          <li key={bucket.key}>
            <i className={`dash-aging-dot is-${bucket.key}`} aria-hidden="true" />
            <span>{bucket.label}</span>
            <strong>{bucket.count}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 统计范围选择器：全部看板 / 看板集 / 自定义多选 */
function ScopePicker({
  scope,
  boards,
  boardSets,
  onChange,
}: {
  scope: BoardScope;
  boards: ReadonlyArray<{ id: string; title: string }>;
  boardSets: ReadonlyArray<{ id: string; title: string; boardIds: string[] }>;
  onChange: Dispatch<SetStateAction<BoardScope>>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const label =
    scope.kind === 'all'
      ? '全部看板'
      : scope.kind === 'set'
        ? boardSets.find((set) => set.id === scope.id)?.title ?? '看板集'
        : `已选 ${scope.ids.length} 个看板`;

  const manualIds = scope.kind === 'manual' ? scope.ids : [];

  // 连续点选多个看板时，若基于渲染时的 scope 快照计算，后一次会覆盖前一次；
  // 用函数式更新拿到上一份选择，才能正确累加 / 取消。
  const toggleBoard = (id: string) => {
    onChange((current) => {
      const currentIds = current.kind === 'manual' ? current.ids : [];
      const next = currentIds.includes(id)
        ? currentIds.filter((item) => item !== id)
        : [...currentIds, id];
      // 清空选择等同于回到「全部看板」，避免出现 0 块板的空池
      return next.length === 0 ? { kind: 'all' } : { kind: 'manual', ids: next };
    });
  };

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className="dashboard-scope-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="选择统计范围"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="layout-grid" size={13} />
        <span className="dashboard-scope-label">{label}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open ? (
        <div className="menu-pop left dashboard-scope-pop" role="dialog" aria-label="统计范围">
          <button
            type="button"
            className={`menu-item${scope.kind === 'all' ? ' is-active' : ''}`}
            onClick={() => onChange({ kind: 'all' })}
          >
            <Icon name={scope.kind === 'all' ? 'check' : 'layers'} size={14} />
            <span>全部看板</span>
          </button>
          {boardSets.length > 0 ? <div className="menu-sep" /> : null}
          {boardSets.map((set) => (
            <button
              key={set.id}
              type="button"
              className={`menu-item${
                scope.kind === 'set' && scope.id === set.id ? ' is-active' : ''
              }`}
              onClick={() => onChange({ kind: 'set', id: set.id })}
            >
              <Icon name={scope.kind === 'set' && scope.id === set.id ? 'check' : 'layers'} size={14} />
              <span>{set.title}</span>
              <span className="dashboard-scope-count">{set.boardIds.length}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <div className="dashboard-scope-group-title">自定义选择</div>
          <div className="dashboard-scope-list">
            {boards.map((board) => {
              const checked = manualIds.includes(board.id);
              return (
                <button
                  key={board.id}
                  type="button"
                  className={`menu-item${checked ? ' is-active' : ''}`}
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggleBoard(board.id)}
                >
                  <span className={`dashboard-scope-check${checked ? ' is-on' : ''}`}>
                    {checked ? <Icon name="check" size={10} /> : null}
                  </span>
                  <span>{board.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 池总览：维度无关的全量视角 —— 总量、已完成、完成率、陈积 */
function PoolOverview({ pool }: { pool: ReturnType<typeof buildPoolBreakdown> }) {
  const empty = pool.total === 0;
  return (
    <div className="dash-pool-overview">
      <div className="dash-pool-stats">
        <span className="dash-pool-stat">
          <span className="dash-pool-stat-label">池总量</span>
          <strong className="dash-pool-stat-value">{pool.total}</strong>
        </span>
        <span className="dash-pool-stat">
          <span className="dash-pool-stat-label">已完成</span>
          <strong className="dash-pool-stat-value is-done">{pool.done}</strong>
        </span>
        <span className="dash-pool-stat">
          <span className="dash-pool-stat-label">完成率</span>
          <strong className="dash-pool-stat-value">{percent(pool.completionRate)}</strong>
        </span>
        <span className="dash-pool-stat">
          <span className="dash-pool-stat-label">陈积 30 天+</span>
          <strong className={`dash-pool-stat-value${pool.stale > 0 ? ' is-danger' : ''}`}>
            {pool.stale}
          </strong>
        </span>
      </div>
      <div
        className="dash-pool-meter"
        role="img"
        aria-label={empty ? '任务池为空' : `池内已完成 ${pool.done} / ${pool.total}`}
      >
        {empty ? (
          <span className="dash-pool-meter-empty">池子为空</span>
        ) : (
          <span className="dash-pool-meter-done" style={{ width: `${pool.completionRate * 100}%` }} />
        )}
      </div>
    </div>
  );
}

/** 堆叠柱：每根柱 = 一个分组的池子大小，段内从下到上按风险递增 */
function PoolChart({
  groups,
  maxTotal,
  clickable,
  activeDimension,
  crossFilter,
  onSelect,
}: {
  groups: PoolGroup[];
  maxTotal: number;
  clickable: boolean;
  activeDimension: DimensionKey;
  crossFilter: CrossFilter | null;
  onSelect: (key: string) => void;
}) {
  if (groups.length === 0) {
    return <p className="dash-empty-text">当前范围内没有任务，池子为空。</p>;
  }
  // 列太多时压缩间距，保证 90 天周视图仍然可读
  const dense = groups.length > 12;
  return (
    <div className={`dash-pool-chart${dense ? ' is-dense' : ''}`} role="img" aria-label="任务池堆积图">
      {groups.map((group) => {
        const selected =
          clickable && crossFilter?.dimension === activeDimension && crossFilter.key === group.key;
        const height = (group.total / maxTotal) * 100;
        return (
          <button
            key={group.key}
            type="button"
            className={`dash-pool-col${selected ? ' is-selected' : ''}${clickable ? ' is-clickable' : ''}`}
            disabled={!clickable || group.total === 0}
            onClick={() => onSelect(group.key)}
            aria-pressed={clickable ? selected : undefined}
            title={`${group.label}：池 ${group.total} 个 · 已完成 ${group.done} 个 · 逾期 ${group.overdue} 个 · 本周到期 ${group.dueSoon} 个 · 正常推进 ${group.open} 个（完成率 ${percent(group.completionRate)}）`}
          >
            <span className="dash-pool-rate">
              {group.total === 0 ? '' : percent(group.completionRate)}
            </span>
            <span className="dash-pool-track">
              <span
                className="dash-pool-stack"
                style={{ height: `${group.total === 0 ? 2 : Math.max(2, height)}%` }}
              >
                {POOL_SEGMENTS.map((segment) =>
                  group[segment.key] === 0 ? null : (
                    <span
                      key={segment.key}
                      className={`dash-pool-seg is-${segment.key}`}
                      style={{ flexGrow: group[segment.key] }}
                    />
                  ),
                )}
              </span>
            </span>
            <span className="dash-pool-col-label">{group.label}</span>
          </button>
        );
      })}
    </div>
  );
}
