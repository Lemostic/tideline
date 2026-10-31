import { useCallback, useEffect, useMemo, useState } from 'react';
import { DatePicker } from '@/components/DatePicker';
import { Icon } from '@/components/Icon';
import { EmptyState, Modal } from '@/components/Modal';
import { api, isTauri } from '@/lib/api';
import { formatDateCN } from '@/lib/date';
import {
  buildUsageRange,
  clampIdleThreshold,
  fillDailyRange,
  formatDuration,
  formatShare,
  formatUsageRangeLabel,
  summarizeUsage,
  usageSharePercent,
  USAGE_IDLE_MAX_SECONDS,
  USAGE_IDLE_MIN_SECONDS,
  type UsageRangeKind,
} from '@/lib/usage';
import type { UsageApp, UsageOverview, UsageSettings } from '@/lib/types';
import './usage.css';

const RANGE_OPTIONS: ReadonlyArray<{ kind: UsageRangeKind; label: string }> = [
  { kind: 'today', label: '今天' },
  { kind: 'week', label: '本周' },
  { kind: 'last7', label: '最近 7 天' },
  { kind: 'custom', label: '自定义' },
];

/** 趋势图最多展示的天数，避免超长区间把图表挤扁 */
const TREND_MAX_DAYS = 31;

export function UsagePage() {
  const desktop = isTauri();

  const [rangeKind, setRangeKind] = useState<UsageRangeKind>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [apps, setApps] = useState<UsageApp[]>([]);
  const [settings, setSettings] = useState<UsageSettings | null>(null);
  const [idleDraft, setIdleDraft] = useState('');

  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const range = useMemo(
    () =>
      buildUsageRange(
        rangeKind,
        new Date(),
        rangeKind === 'custom' ? { from: customFrom, to: customTo } : undefined,
      ),
    [rangeKind, customFrom, customTo],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [overviewData, appsData, settingsData] = await Promise.all([
        api.getUsageOverview({ from: range.from, to: range.to }),
        api.getUsageApps(),
        api.getUsageSettings(),
      ]);
      setOverview(overviewData);
      setApps(appsData);
      setSettings(settingsData);
      setLoaded(true);
      // 用户正在编辑阈值时不覆盖输入框
      setIdleDraft((prev) => {
        const parsed = Number(prev);
        return prev && Number.isFinite(parsed) && parsed > 0
          ? prev
          : String(settingsData.idleThresholdSeconds);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取使用统计失败');
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(
    () =>
      summarizeUsage(
        overview ?? {
          rangeFrom: range.from,
          rangeTo: range.to,
          totalSeconds: 0,
          trackedApps: 0,
          apps: [],
          daily: [],
        },
      ),
    [overview, range.from, range.to],
  );

  const daily = useMemo(
    () => fillDailyRange(overview?.daily ?? [], range.from, range.to),
    [overview, range.from, range.to],
  );

  const chartDaily = useMemo(
    () => (daily.length > TREND_MAX_DAYS ? daily.slice(-TREND_MAX_DAYS) : daily),
    [daily],
  );

  const peakSeconds = chartDaily.reduce((max, item) => Math.max(max, item.seconds), 0);

  const runAction = useCallback(
    async (action: () => Promise<void>, successText: string) => {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        await action();
        setNotice(successText);
      } catch (e) {
        setError(e instanceof Error ? e.message : '操作失败');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const togglePause = useCallback(() => {
    const next = !(settings?.paused ?? false);
    void runAction(async () => {
      const updated = await api.setUsageSettings({ paused: next });
      setSettings(updated);
      await load();
    }, next ? '已暂停统计' : '已继续统计');
  }, [settings, runAction, load]);

  const saveThreshold = useCallback(() => {
    const seconds = clampIdleThreshold(Number(idleDraft));
    void runAction(async () => {
      const updated = await api.setUsageSettings({ idleThresholdSeconds: seconds });
      setSettings(updated);
      setIdleDraft(String(seconds));
      await load();
    }, '空闲阈值已更新');
  }, [idleDraft, runAction, load]);

  const toggleIncluded = useCallback(
    (app: UsageApp) => {
      void runAction(async () => {
        const updated = await api.setUsageAppIncluded({
          appKey: app.appKey,
          included: !app.included,
        });
        setApps((prev) =>
          prev.map((item) => (item.appKey === updated.appKey ? { ...item, ...updated } : item)),
        );
        await load();
      }, includedNotice(app));
    },
    [runAction, load],
  );

  const clearRecords = useCallback(() => {
    setConfirmClear(false);
    void runAction(async () => {
      await api.clearUsageRecords();
      await load();
    }, '使用记录已清空');
  }, [runAction, load]);

  const paused = settings?.paused ?? false;
  const idleThreshold = settings?.idleThresholdSeconds ?? USAGE_IDLE_MIN_SECONDS;

  return (
    <div className="page usage-page">
      <header className="usage-head">
        <div className="usage-head-text">
          <div className="page-eyebrow">本地统计</div>
          <h1 className="usage-title">使用统计</h1>
          <p className="usage-sub">
            统计你在电脑上使用各应用的时间。数据只保存在本机数据库里，不会上传到任何服务器。
          </p>
        </div>
        <div className="usage-controls">
          <div className="usage-range" role="tablist" aria-label="统计区间">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.kind}
                type="button"
                role="tab"
                aria-selected={rangeKind === option.kind}
                className={`usage-range-btn${rangeKind === option.kind ? ' is-active' : ''}`}
                onClick={() => setRangeKind(option.kind)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {rangeKind === 'custom' ? (
            <div className="usage-custom">
              <DatePicker value={customFrom} onChange={setCustomFrom} ariaLabel="开始日期" />
              <span className="usage-custom-sep">至</span>
              <DatePicker value={customTo} onChange={setCustomTo} ariaLabel="结束日期" />
            </div>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm" onClick={togglePause} disabled={busy}>
            {paused ? '继续统计' : '暂停统计'}
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-sm usage-clear-btn"
            onClick={() => setConfirmClear(true)}
            disabled={busy}
          >
            <Icon name="trash" size={14} />
            清空记录
          </button>
        </div>
      </header>

      {!desktop ? (
        <div className="usage-notice">
          <Icon name="info" size={15} />
          <div className="usage-notice-text">
            <strong>本功能需要桌面端运行</strong>
            <span>浏览器预览模式不会采集前台应用的使用时长，这里展示的是空数据。</span>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="usage-error">
          <Icon name="info" size={15} />
          <span>{error}</span>
        </div>
      ) : null}
      {notice && !error ? (
        <div className="usage-notice usage-notice-success">
          <Icon name="check-circle" size={15} />
          <div className="usage-notice-text">
            <span>{notice}</span>
          </div>
        </div>
      ) : null}

      <section className="usage-kpis">
        <div className="usage-kpi">
          <span className="usage-kpi-label">区间总时长</span>
          <strong className="usage-kpi-value">{formatDuration(summary.totalSeconds)}</strong>
          <span className="usage-kpi-hint">{formatUsageRangeLabel(range.from, range.to)}</span>
        </div>
        <div className="usage-kpi">
          <span className="usage-kpi-label">纳入统计应用</span>
          <strong className="usage-kpi-value">{summary.trackedApps}</strong>
          <span className="usage-kpi-hint">个应用</span>
        </div>
        <div className="usage-kpi">
          <span className="usage-kpi-label">统计状态</span>
          <strong className={`usage-kpi-value usage-status${paused ? ' is-paused' : ''}`}>
            {paused ? '已暂停' : '运行中'}
          </strong>
          <span className="usage-kpi-hint">{paused ? '不会继续记录' : '正在记录前台应用'}</span>
        </div>
        <div className="usage-kpi">
          <span className="usage-kpi-label">空闲阈值</span>
          <div className="usage-kpi-threshold">
            <input
              className="input usage-threshold-input"
              type="number"
              min={USAGE_IDLE_MIN_SECONDS}
              max={USAGE_IDLE_MAX_SECONDS}
              step={30}
              value={idleDraft}
              aria-label="空闲阈值（秒）"
              onChange={(event) => setIdleDraft(event.target.value)}
            />
            <span className="usage-kpi-unit">秒</span>
          </div>
          <button
            type="button"
            className="btn btn-quiet btn-sm usage-kpi-save"
            onClick={saveThreshold}
            disabled={busy}
          >
            保存阈值
          </button>
          <span className="usage-kpi-hint">
            当前 {idleThreshold} 秒（可设 {USAGE_IDLE_MIN_SECONDS}–{USAGE_IDLE_MAX_SECONDS} 秒）
          </span>
        </div>
      </section>

      {loading && !loaded ? (
        <div className="usage-loading">
          <span className="usage-spinner" aria-hidden="true" />
          <span>正在读取使用统计…</span>
        </div>
      ) : (
        <div className="usage-grid">
          <section className="usage-card usage-rank">
            <div className="usage-card-head">
              <h2 className="usage-card-title">应用时长排行</h2>
              <span className="usage-card-sub">
                {formatDateCN(range.from)} — {formatDateCN(range.to)}
              </span>
            </div>
            {summary.topApps.length === 0 ? (
              <EmptyState
                icon="clock"
                title="这个区间还没有使用记录"
                description="切换到更长的时间范围，或确认统计没有被暂停。"
              />
            ) : (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>应用</th>
                    <th className="usage-cell-num">时长</th>
                    <th className="usage-cell-share">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.topApps.map((item) => (
                    <tr key={item.appKey}>
                      <td className="usage-app-name">{item.appName}</td>
                      <td className="usage-cell-num">{formatDuration(item.seconds)}</td>
                      <td className="usage-cell-share">
                        <div className="usage-share">
                          <div className="usage-share-track">
                            <span style={{ width: `${usageSharePercent(item.share)}%` }} />
                          </div>
                          <span className="usage-share-value">{formatShare(item.share)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="usage-card usage-trend-card">
            <div className="usage-card-head">
              <h2 className="usage-card-title">每日时长趋势</h2>
              <span className="usage-card-sub">
                {peakSeconds > 0 ? `峰值 ${formatDuration(peakSeconds)}` : '暂无数据'}
              </span>
            </div>
            {chartDaily.length === 0 ? (
              <EmptyState icon="chart" title="暂无趋势数据" description="选择其它区间后再看看。" />
            ) : (
              <div className="usage-trend">
                {chartDaily.map((item) => (
                  <div
                    className="usage-trend-col"
                    key={item.day}
                    title={`${item.day} · ${formatDuration(item.seconds)}`}
                  >
                    <div className="usage-trend-bar-wrap">
                      <div
                        className="usage-trend-bar"
                        style={{
                          height:
                            peakSeconds > 0
                              ? `${Math.max(2, Math.round((item.seconds / peakSeconds) * 100))}%`
                              : '2%',
                        }}
                      />
                    </div>
                    <span className="usage-trend-label">{item.day.slice(5).replace('-', '/')}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="usage-card usage-apps">
            <div className="usage-card-head">
              <h2 className="usage-card-title">应用清单</h2>
              <span className="usage-card-sub">取消勾选后不再统计该应用</span>
            </div>
            {apps.length === 0 ? (
              <EmptyState
                icon="layers"
                title="还没有采集到应用"
                description="桌面端运行一段时间后，这里会列出本机使用过的应用。"
              />
            ) : (
              <ul className="usage-app-list">
                {apps.map((app) => (
                  <li className="usage-app-row" key={app.appKey}>
                    <label className="usage-app-check">
                      <input
                        type="checkbox"
                        checked={app.included}
                        disabled={busy}
                        onChange={() => toggleIncluded(app)}
                      />
                      <span className="usage-app-meta">
                        <span className="usage-app-name">{app.appName}</span>
                        <span className="usage-app-path">{app.exePath || '未知路径'}</span>
                      </span>
                    </label>
                    <span className="usage-app-total">{formatDuration(app.totalSeconds)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {confirmClear ? (
        <Modal
          title="清空使用记录"
          subtitle="此操作不可撤销"
          onClose={() => setConfirmClear(false)}
          footer={
            <div className="usage-modal-actions">
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirmClear(false)}>
                取消
              </button>
              <button type="button" className="btn btn-danger btn-sm" onClick={clearRecords}>
                确认清空
              </button>
            </div>
          }
        >
          <p className="usage-modal-text">
            清空后将删除本机记录的全部应用使用时长，统计会从零重新开始。统计设置（暂停状态、空闲阈值）会保留。
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/** 切换纳入状态后的提示文案 */
function includedNotice(app: UsageApp): string {
  return app.included ? `已停止统计 ${app.appName}` : `已纳入 ${app.appName}`;
}
