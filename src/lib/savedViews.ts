import type {
  BoardSortKey,
  SavedViewFieldFilter,
  SavedViewFilters,
  SavedViewSort,
  SortDirection,
} from './types';

/**
 * 保存的筛选视图（V0.13.1）的纯函数工具。
 *
 * 这里只处理「后端 / 备份里的数据形状」与「前端用的形状」之间的转换，
 * 不依赖具体视图组件，方便 API 层与界面层共用。
 */

/** 后端 / 备份里的排序键 → 前端排序键；无法识别的键回退到默认排序 */
export function normalizeSortKey(rawKey: string, rawDirection: string): BoardSortKey {
  const key = (rawKey ?? '').trim();
  const direction: SortDirection = rawDirection === 'desc' ? 'desc' : 'asc';
  switch (key) {
    case 'due-asc':
      return 'due-asc';
    case 'due-desc':
      return 'due-desc';
    case 'due':
      return direction === 'desc' ? 'due-desc' : 'due-asc';
    case 'priority':
      return 'priority';
    case 'created-desc':
      return 'created-desc';
    case 'created-asc':
      return 'created-asc';
    case 'created':
      return direction === 'desc' ? 'created-desc' : 'created-asc';
    case 'updated':
    case 'updatedAt':
    case 'updated-at':
    case 'updated-desc':
      return 'updated-desc';
    default:
      return 'due-asc';
  }
}

/** 排序键自带的顺序 */
export function sortDirectionOf(key: BoardSortKey): SortDirection {
  return key.endsWith('-desc') ? 'desc' : 'asc';
}

/**
 * 把后端 / 备份里的排序条件归一化。
 * 入参刻意放宽成字符串：旧数据或后端可能给出前端词表之外的排序键，这里统一收口。
 */
export function normalizeSavedViewSort(
  raw: { key?: string; direction?: string } | undefined,
): SavedViewSort {
  const key = normalizeSortKey(raw?.key ?? '', raw?.direction ?? 'asc');
  return { key, direction: sortDirectionOf(key) };
}

/** 把后端 / 备份里的筛选条件归一化（缺失字段补默认值） */
export function normalizeSavedViewFilters(
  raw: Partial<SavedViewFilters> | undefined,
): SavedViewFilters {
  const status =
    raw?.status === 'active' || raw?.status === 'completed' ? raw.status : 'all';
  return {
    keyword: typeof raw?.keyword === 'string' ? raw.keyword : '',
    status,
    priorities: Array.isArray(raw?.priorities) ? raw.priorities : [],
    labels: Array.isArray(raw?.labels) ? raw.labels : [],
    fieldFilters: Array.isArray(raw?.fieldFilters)
      ? raw.fieldFilters.map((item) => ({
          fieldId: item.fieldId,
          optionIds: Array.isArray(item.optionIds) ? item.optionIds : [],
          min: typeof item.min === 'number' && Number.isFinite(item.min) ? item.min : null,
          max: typeof item.max === 'number' && Number.isFinite(item.max) ? item.max : null,
        }))
      : [],
    blocked: raw?.blocked === true,
  };
}


/**
 * 字段或选项被删除后，视图里指向它们的条件自动降级：
 * 字段没了就丢掉整条条件，选项没了就去掉那个选项 id。
 *
 * 后端读取视图时同样按这套规则降级，前后端行为必须一致，
 * 否则同一个视图在桌面端与浏览器端会筛出不同的结果。
 */
export function degradeSavedViewFieldFilters(
  filters: SavedViewFilters,
  fields: ReadonlyArray<{ id: string; options: ReadonlyArray<{ id: string }> }>,
): SavedViewFilters {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const fieldFilters = filters.fieldFilters
    .map((filter) => {
      const field = byId.get(filter.fieldId);
      if (!field) return null;
      if (filter.optionIds.length === 0) return filter;
      const valid = new Set(field.options.map((option) => option.id));
      const optionIds = filter.optionIds.filter((id) => valid.has(id));
      if (optionIds.length === 0) return null;
      return { ...filter, optionIds };
    })
    .filter((item): item is SavedViewFieldFilter => item !== null);
  return { ...filters, fieldFilters };
}

/** 两组保存视图筛选条件是否等价 */
export function savedViewFiltersEqual(a: SavedViewFilters, b: SavedViewFilters): boolean {
  if (
    a.keyword.trim() !== b.keyword.trim() ||
    a.status !== b.status ||
    a.blocked !== b.blocked ||
    a.priorities.length !== b.priorities.length ||
    a.labels.length !== b.labels.length ||
    a.fieldFilters.length !== b.fieldFilters.length
  ) {
    return false;
  }
  if (!a.priorities.every((item) => b.priorities.includes(item))) return false;
  if (!a.labels.every((item) => b.labels.includes(item))) return false;
  return a.fieldFilters.every((filter) => {
    const other = b.fieldFilters.find((item) => item.fieldId === filter.fieldId);
    if (!other) return false;
    if (filter.min !== other.min || filter.max !== other.max) return false;
    if (filter.optionIds.length !== other.optionIds.length) return false;
    return filter.optionIds.every((id) => other.optionIds.includes(id));
  });
}
