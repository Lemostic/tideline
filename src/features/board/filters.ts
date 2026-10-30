import type { Card, Priority } from '@/lib/types';

/** 看板内筛选条件：关键词 + 完成状态 + 优先级 + 标签，跨视图共用 */
export interface BoardFilters {
  keyword: string;
  status: 'all' | 'active' | 'completed';
  /** 空数组 = 不限优先级（多选之间是 OR） */
  priorities: Priority[];
  /** 空数组 = 不限标签（多选之间是 AND，需要全部命中） */
  labels: string[];
}

export const EMPTY_FILTERS: BoardFilters = {
  keyword: '',
  status: 'all',
  priorities: [],
  labels: [],
};

/** 状态分段的顺序与文案，筛选条与测试共用 */
export const FILTER_STATUS_OPTIONS: ReadonlyArray<{
  key: BoardFilters['status'];
  label: string;
}> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '未完成' },
  { key: 'completed', label: '已完成' },
];

/** 关键词（去首尾空格、忽略大小写）判断是否有内容 */
function normalizedKeyword(filters: BoardFilters): string {
  return filters.keyword.trim().toLowerCase();
}

/**
 * 看板内出现过的全部标签（去重、按出现次数降序，同次数按名称升序）。
 * 同一个任务里重复的标签只计一次；空白标签直接忽略，避免筛选面板出现空行。
 */
export function collectLabels(cards: Card[]): string[] {
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
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label);
}

/** 是否处于「有筛选」状态，用于给筛选按钮/清除入口加高亮 */
export function hasActiveFilters(filters: BoardFilters): boolean {
  return (
    normalizedKeyword(filters) !== '' ||
    filters.status !== 'all' ||
    filters.priorities.length > 0 ||
    filters.labels.length > 0
  );
}

/** 激活的筛选维度数量（关键词 / 状态 / 优先级 / 标签各算一项） */
export function countActiveFilters(filters: BoardFilters): number {
  let count = 0;
  if (normalizedKeyword(filters)) count += 1;
  if (filters.status !== 'all') count += 1;
  if (filters.priorities.length > 0) count += 1;
  if (filters.labels.length > 0) count += 1;
  return count;
}

/** 多选优先级：已选则移除，未选则追加（返回新对象，不修改入参） */
export function togglePriority(filters: BoardFilters, priority: Priority): BoardFilters {
  const selected = filters.priorities.includes(priority);
  return {
    ...filters,
    priorities: selected
      ? filters.priorities.filter((item) => item !== priority)
      : [...filters.priorities, priority],
  };
}

/** 多选标签：已选则移除，未选则追加（返回新对象，不修改入参） */
export function toggleLabel(filters: BoardFilters, label: string): BoardFilters {
  const selected = filters.labels.includes(label);
  return {
    ...filters,
    labels: selected ? filters.labels.filter((item) => item !== label) : [...filters.labels, label],
  };
}

/**
 * 按筛选条件过滤任务。
 * - 关键词：trim + 忽略大小写，匹配标题 / 描述 / 标签；
 * - 状态：全部 / 未完成 / 已完成；
 * - 优先级：多选之间 OR，未设置优先级视为不命中；
 * - 标签：多选之间 AND，需要全部命中。
 *
 * 没有任何生效条件时原样返回（引用稳定，方便上层 useMemo 复用）。
 */
export function filterCards(cards: Card[], filters: BoardFilters): Card[] {
  const keyword = normalizedKeyword(filters);
  const priorities = new Set(filters.priorities);
  const labels = filters.labels.map((label) => label.trim()).filter(Boolean);

  if (
    !keyword &&
    filters.status === 'all' &&
    priorities.size === 0 &&
    labels.length === 0
  ) {
    return cards;
  }

  return cards.filter((card) => {
    if (filters.status === 'active' && card.completed) return false;
    if (filters.status === 'completed' && !card.completed) return false;

    if (priorities.size > 0 && (!card.priority || !priorities.has(card.priority))) {
      return false;
    }

    if (labels.length > 0) {
      const cardLabels = new Set(
        card.labels.map((label) => label.trim()).filter(Boolean),
      );
      if (!labels.every((label) => cardLabels.has(label))) return false;
    }

    if (keyword) {
      const haystack = `${card.title}\n${card.description}\n${card.labels.join(' ')}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }

    return true;
  });
}
