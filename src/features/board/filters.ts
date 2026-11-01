import {
  normalizeSavedViewFilters,
  savedViewFiltersEqual,
} from '@/lib/savedViews';
import type {
  Card,
  CardFieldValue,
  FilterStatus,
  Priority,
  SavedViewFieldFilter,
  SavedViewFilters,
} from '@/lib/types';

/**
 * 看板内筛选条件：关键词 + 完成状态 + 优先级 + 标签 + 自定义字段，跨视图共用。
 *
 * V0.13.1 起新增 fieldFilters（按自定义字段过滤）与 blocked（只看被阻塞的任务）。
 */
export interface BoardFilters {
  keyword: string;
  status: FilterStatus;
  /** 空数组 = 不限优先级（多选之间是 OR） */
  priorities: Priority[];
  /** 空数组 = 不限标签（多选之间是 AND，需要全部命中） */
  labels: string[];
  /** 自定义字段筛选条件：单选多值、数值区间 */
  fieldFilters: SavedViewFieldFilter[];
  /** 只看被阻塞的任务 */
  blocked: boolean;
}

export const EMPTY_FILTERS: BoardFilters = {
  keyword: '',
  status: 'all',
  priorities: [],
  labels: [],
  fieldFilters: [],
  blocked: false,
};

/** 筛选需要的额外上下文：字段取值与被阻塞的任务 */
export interface FilterContext {
  /** 任务在自定义字段上的取值（V0.13.1） */
  cardFieldValues?: CardFieldValue[];
  /** 被阻塞的任务 id 集合（V0.13.1） */
  blockedCardIds?: Set<string>;
}

/** 状态分段的顺序与文案，筛选条与测试共用 */
export const FILTER_STATUS_OPTIONS: ReadonlyArray<{
  key: FilterStatus;
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
    filters.labels.length > 0 ||
    filters.fieldFilters.length > 0 ||
    filters.blocked
  );
}

/** 激活的筛选维度数量（关键词 / 状态 / 优先级 / 标签 / 字段 / 被阻塞各算一项） */
export function countActiveFilters(filters: BoardFilters): number {
  let count = 0;
  if (normalizedKeyword(filters)) count += 1;
  if (filters.status !== 'all') count += 1;
  if (filters.priorities.length > 0) count += 1;
  if (filters.labels.length > 0) count += 1;
  if (filters.fieldFilters.length > 0) count += 1;
  if (filters.blocked) count += 1;
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

/** 某个字段当前的筛选条件 */
export function fieldFilterOf(
  filters: BoardFilters,
  fieldId: string,
): SavedViewFieldFilter | undefined {
  return filters.fieldFilters.find((item) => item.fieldId === fieldId);
}

/** 写回某个字段的筛选条件；条件为空时移除该字段 */
function withFieldFilter(
  filters: BoardFilters,
  fieldId: string,
  next: SavedViewFieldFilter | null,
): BoardFilters {
  const rest = filters.fieldFilters.filter((item) => item.fieldId !== fieldId);
  return {
    ...filters,
    fieldFilters: next ? [...rest, next] : rest,
  };
}

/**
 * 单选字段：切换某个选项是否命中。
 * 取消最后一个选项时整条字段条件一并移除，避免留下「等于空集」的死条件。
 */
export function toggleFieldOption(
  filters: BoardFilters,
  fieldId: string,
  optionId: string,
): BoardFilters {
  const current = fieldFilterOf(filters, fieldId);
  const optionIds = current?.optionIds ?? [];
  const selected = optionIds.includes(optionId);
  const nextOptionIds = selected
    ? optionIds.filter((item) => item !== optionId)
    : [...optionIds, optionId];
  if (nextOptionIds.length === 0) {
    return withFieldFilter(filters, fieldId, null);
  }
  return withFieldFilter(filters, fieldId, {
    fieldId,
    optionIds: nextOptionIds,
    min: null,
    max: null,
  });
}

/** 数值字段：设置区间；上下限都为 null 时移除该字段的条件 */
export function setFieldRange(
  filters: BoardFilters,
  fieldId: string,
  min: number | null,
  max: number | null,
): BoardFilters {
  if (min === null && max === null) {
    return withFieldFilter(filters, fieldId, null);
  }
  return withFieldFilter(filters, fieldId, {
    fieldId,
    optionIds: [],
    min,
    max,
  });
}

/** 清除某个字段的筛选条件 */
export function clearFieldFilter(filters: BoardFilters, fieldId: string): BoardFilters {
  return withFieldFilter(filters, fieldId, null);
}

/** 字段取值索引：cardId → (fieldId → 取值) */
function buildFieldValueIndex(
  cardFieldValues: CardFieldValue[],
): Map<string, Map<string, CardFieldValue>> {
  const index = new Map<string, Map<string, CardFieldValue>>();
  for (const value of cardFieldValues) {
    let bucket = index.get(value.cardId);
    if (!bucket) {
      bucket = new Map();
      index.set(value.cardId, bucket);
    }
    bucket.set(value.fieldId, value);
  }
  return index;
}

/**
 * 某个任务是否满足全部字段筛选条件。
 * - 单选字段：取值必须落在命中的选项集合里；
 * - 数值字段：取值必须落在区间内；
 * - 没有具体条件的字段：视为无约束，直接跳过。
 */
function matchesFieldFilters(
  cardId: string,
  fieldFilters: SavedViewFieldFilter[],
  index: Map<string, Map<string, CardFieldValue>>,
): boolean {
  for (const filter of fieldFilters) {
    const value = index.get(cardId)?.get(filter.fieldId);
    if (!value) return false;
    const optionIds = filter.optionIds ?? [];
    const hasMin = filter.min !== null && filter.min !== undefined;
    const hasMax = filter.max !== null && filter.max !== undefined;
    if (optionIds.length > 0) {
      if (!value.valueText || !optionIds.includes(value.valueText)) return false;
    } else if (hasMin || hasMax) {
      if (value.valueNumber === null || value.valueNumber === undefined) return false;
      if (hasMin && value.valueNumber < (filter.min as number)) return false;
      if (hasMax && value.valueNumber > (filter.max as number)) return false;
    } else {
      // 没有具体条件的字段视为无约束（字段或选项被删除后视图会自动降级成这种状态）
      continue;
    }
  }
  return true;
}

/**
 * 按筛选条件过滤任务。
 * - 关键词：trim + 忽略大小写，匹配标题 / 描述 / 标签；
 * - 状态：全部 / 未完成 / 已完成；
 * - 优先级：多选之间 OR，未设置优先级视为不命中；
 * - 标签：多选之间 AND，需要全部命中；
 * - 自定义字段：单选多值 OR、数值区间；
 * - 被阻塞：只看被前置任务卡住的任务。
 *
 * 没有任何生效条件时原样返回（引用稳定，方便上层 useMemo 复用）。
 */
export function filterCards(
  cards: Card[],
  filters: BoardFilters,
  context: FilterContext = {},
): Card[] {
  const keyword = normalizedKeyword(filters);
  const priorities = new Set(filters.priorities);
  const labels = filters.labels.map((label) => label.trim()).filter(Boolean);
  const fieldFilters = filters.fieldFilters ?? [];
  const blockedIds = context.blockedCardIds;

  if (
    !keyword &&
    filters.status === 'all' &&
    priorities.size === 0 &&
    labels.length === 0 &&
    fieldFilters.length === 0 &&
    !filters.blocked
  ) {
    return cards;
  }

  const fieldIndex =
    fieldFilters.length > 0 ? buildFieldValueIndex(context.cardFieldValues ?? []) : null;

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

    if (fieldFilters.length > 0 && fieldIndex) {
      if (!matchesFieldFilters(card.id, fieldFilters, fieldIndex)) return false;
    }

    if (filters.blocked) {
      if (!blockedIds || !blockedIds.has(card.id)) return false;
    }

    if (keyword) {
      const haystack = `${card.title}\n${card.description}\n${card.labels.join(' ')}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }

    return true;
  });
}

/* ---------- 保存视图（V0.13.1）与筛选条件的互转 ---------- */

/** 把后端 / 备份里的筛选条件归一化成看板筛选条件 */
export function savedViewFiltersToBoardFilters(
  raw: Partial<SavedViewFilters> | undefined,
): BoardFilters {
  const normalized = normalizeSavedViewFilters(raw);
  return {
    keyword: normalized.keyword,
    status: normalized.status,
    priorities: normalized.priorities,
    labels: normalized.labels,
    fieldFilters: normalized.fieldFilters,
    blocked: normalized.blocked,
  };
}

/** 把看板筛选条件转成保存视图用的筛选条件 */
export function boardFiltersToSavedViewFilters(filters: BoardFilters): SavedViewFilters {
  return {
    keyword: filters.keyword,
    status: filters.status,
    priorities: [...filters.priorities],
    labels: [...filters.labels],
    fieldFilters: filters.fieldFilters.map((item) => ({
      fieldId: item.fieldId,
      optionIds: [...item.optionIds],
      min: item.min,
      max: item.max,
    })),
    blocked: filters.blocked,
  };
}

/** 两组筛选条件是否等价（用于判断当前筛选是否已经偏离某个视图） */
export function filtersEqual(a: BoardFilters, b: BoardFilters): boolean {
  return savedViewFiltersEqual(
    boardFiltersToSavedViewFilters(a),
    boardFiltersToSavedViewFilters(b),
  );
}
