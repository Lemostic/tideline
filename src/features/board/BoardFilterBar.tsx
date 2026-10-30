import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { PRIORITY_META, type Card, type Priority } from '@/lib/types';
import {
  collectLabels,
  countActiveFilters,
  EMPTY_FILTERS,
  FILTER_STATUS_OPTIONS,
  hasActiveFilters,
  toggleLabel,
  togglePriority,
  type BoardFilters,
} from './filters';
import './filter.css';

interface BoardFilterBarProps {
  filters: BoardFilters;
  onChange: (filters: BoardFilters) => void;
  cards: Card[];
  /** 筛选后的可见任务数 / 全部任务数 */
  visibleCount: number;
  totalCount: number;
}

type PanelKey = 'priority' | 'labels' | null;

/**
 * 看板筛选条（V0.3）：搜索 + 状态分段 + 优先级/标签多选弹层 + chips 摘要。
 *
 * 契约与 BoardPage 保持一致：只通过 `onChange` 回写完整的 BoardFilters，
 * 本组件不持有筛选状态；弹层点外部 / Esc 关闭，选项点击即时生效（可连续多选）。
 */
export function BoardFilterBar({
  filters,
  onChange,
  cards,
  visibleCount,
  totalCount,
}: BoardFilterBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [openPanel, setOpenPanel] = useState<PanelKey>(null);

  useEffect(() => {
    if (!openPanel) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpenPanel(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenPanel(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openPanel]);

  const labels = useMemo(() => collectLabels(cards), [cards]);

  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of cards) {
      const seen = new Set<string>();
      for (const raw of card.labels) {
        const label = raw.trim();
        if (!label || seen.has(label)) continue;
        seen.add(label);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    return counts;
  }, [cards]);

  const priorityCounts = useMemo(() => {
    const counts: Record<Priority, number> = { high: 0, medium: 0, low: 0 };
    for (const card of cards) {
      if (card.priority) counts[card.priority] += 1;
    }
    return counts;
  }, [cards]);

  const active = hasActiveFilters(filters);
  const keyword = filters.keyword.trim();
  const hasChips = keyword !== '' || filters.priorities.length > 0 || filters.labels.length > 0;
  const activeCount = countActiveFilters(filters);

  const patch = (next: Partial<BoardFilters>) => onChange({ ...filters, ...next });

  const togglePanel = (panel: Exclude<PanelKey, null>) => {
    setOpenPanel((current) => (current === panel ? null : panel));
  };

  const priorityMetaOf = (priority: Priority) =>
    PRIORITY_META.find((item) => item.key === priority);

  return (
    <div className="bf-bar" ref={barRef} role="search" aria-label="看板筛选">
      <div className="bf-search">
        <Icon name="search" size={14} className="bf-search-icon" />
        <input
          className="bf-search-input"
          placeholder="搜索任务标题、描述或标签"
          value={filters.keyword}
          aria-label="搜索看板内任务"
          onChange={(event) => patch({ keyword: event.target.value })}
        />
        {filters.keyword ? (
          <button
            type="button"
            className="bf-search-clear"
            aria-label="清除搜索关键词"
            title="清除搜索"
            onClick={() => patch({ keyword: '' })}
          >
            <Icon name="x" size={12} />
          </button>
        ) : null}
      </div>

      <div className="bf-segment" role="group" aria-label="完成状态筛选">
        {FILTER_STATUS_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            className={`bf-seg${filters.status === option.key ? ' is-active' : ''}`}
            aria-pressed={filters.status === option.key}
            onClick={() => patch({ status: option.key })}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="bf-pop-wrap">
        <button
          type="button"
          className={`bf-trigger${filters.priorities.length > 0 ? ' is-on' : ''}${
            openPanel === 'priority' ? ' is-open' : ''
          }`}
          aria-haspopup="true"
          aria-expanded={openPanel === 'priority'}
          onClick={() => togglePanel('priority')}
        >
          <Icon name="flag" size={13} />
          <span>优先级</span>
          {filters.priorities.length > 0 ? (
            <span className="bf-badge">{filters.priorities.length}</span>
          ) : (
            <Icon name="chevron-down" size={12} className="bf-caret" />
          )}
        </button>

        {openPanel === 'priority' ? (
          <div className="bf-pop bf-pop-left" role="group" aria-label="按优先级筛选">
            <div className="bf-pop-head">
              <span>优先级</span>
              {filters.priorities.length > 0 ? (
                <button
                  type="button"
                  className="bf-pop-clear"
                  onClick={() => patch({ priorities: [] })}
                >
                  清除
                </button>
              ) : null}
            </div>
            <div className="bf-pop-body">
              {PRIORITY_META.map((meta) => {
                const checked = filters.priorities.includes(meta.key);
                return (
                  <button
                    key={meta.key}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    className={`bf-option${checked ? ' is-checked' : ''}`}
                    onClick={() => onChange(togglePriority(filters, meta.key))}
                  >
                    <span className="bf-check" aria-hidden="true">
                      {checked ? <Icon name="check" size={10} /> : null}
                    </span>
                    <span
                      className="dot"
                      style={{ background: meta.color }}
                      aria-hidden="true"
                    />
                    <span className="bf-option-label">{meta.label}</span>
                    <span className="bf-option-count">{priorityCounts[meta.key]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {labels.length > 0 ? (
        <div className="bf-pop-wrap">
          <button
            type="button"
            className={`bf-trigger${filters.labels.length > 0 ? ' is-on' : ''}${
              openPanel === 'labels' ? ' is-open' : ''
            }`}
            aria-haspopup="true"
            aria-expanded={openPanel === 'labels'}
            onClick={() => togglePanel('labels')}
          >
            <Icon name="tag" size={13} />
            <span>标签</span>
            {filters.labels.length > 0 ? (
              <span className="bf-badge">{filters.labels.length}</span>
            ) : (
              <Icon name="chevron-down" size={12} className="bf-caret" />
            )}
          </button>

          {openPanel === 'labels' ? (
            <div className="bf-pop bf-pop-right" role="group" aria-label="按标签筛选">
              <div className="bf-pop-head">
                <span>标签</span>
                {filters.labels.length > 0 ? (
                  <button
                    type="button"
                    className="bf-pop-clear"
                    onClick={() => patch({ labels: [] })}
                  >
                    清除
                  </button>
                ) : null}
              </div>
              <div className="bf-pop-body">
                {labels.map((label) => {
                  const checked = filters.labels.includes(label);
                  return (
                    <button
                      key={label}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      className={`bf-option${checked ? ' is-checked' : ''}`}
                      onClick={() => onChange(toggleLabel(filters, label))}
                    >
                      <span className="bf-check" aria-hidden="true">
                        {checked ? <Icon name="check" size={10} /> : null}
                      </span>
                      <span className="bf-option-label">{label}</span>
                      <span className="bf-option-count">{labelCounts.get(label) ?? 0}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {hasChips ? (
        <div className="bf-chips" aria-label="已启用的筛选">
          {keyword ? (
            <button
              type="button"
              className="bf-chip"
              aria-label={`移除关键词筛选：${keyword}`}
              title={`移除关键词：${keyword}`}
              onClick={() => patch({ keyword: '' })}
            >
              <Icon name="search" size={11} />
              <span className="bf-chip-text">{keyword}</span>
              <Icon name="x" size={11} className="bf-chip-x" />
            </button>
          ) : null}

          {filters.priorities.map((priority) => {
            const meta = priorityMetaOf(priority);
            return (
              <button
                key={priority}
                type="button"
                className="bf-chip"
                aria-label={`移除优先级筛选：${meta?.label ?? priority}`}
                title={`移除优先级：${meta?.label ?? priority}`}
                onClick={() => onChange(togglePriority(filters, priority))}
              >
                <span
                  className="dot"
                  style={{ background: meta?.color ?? 'var(--line-strong)' }}
                  aria-hidden="true"
                />
                <span className="bf-chip-text">{meta?.label ?? priority}</span>
                <Icon name="x" size={11} className="bf-chip-x" />
              </button>
            );
          })}

          {filters.labels.map((label) => (
            <button
              key={label}
              type="button"
              className="bf-chip"
              aria-label={`移除标签筛选：${label}`}
              title={`移除标签：${label}`}
              onClick={() => onChange(toggleLabel(filters, label))}
            >
              <Icon name="tag" size={11} />
              <span className="bf-chip-text">{label}</span>
              <Icon name="x" size={11} className="bf-chip-x" />
            </button>
          ))}
        </div>
      ) : (
        <span className="grow" />
      )}

      <span className={`bf-count${active && visibleCount === 0 ? ' is-zero' : ''}`}>
        {active ? `显示 ${visibleCount} / 共 ${totalCount}` : `共 ${totalCount} 个任务`}
      </span>

      {active ? (
        <button
          type="button"
          className="bf-reset"
          title={`清除全部筛选（${activeCount} 项）`}
          onClick={() => onChange(EMPTY_FILTERS)}
        >
          <Icon name="refresh" size={13} />
          清除全部
        </button>
      ) : null}
    </div>
  );
}
