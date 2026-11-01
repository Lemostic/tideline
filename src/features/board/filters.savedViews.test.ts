import { describe, expect, it } from 'vitest';
import {
  degradeSavedViewFieldFilters,
  normalizeSavedViewFilters,
  normalizeSavedViewSort,
  normalizeSortKey,
  savedViewFiltersEqual,
} from '@/lib/savedViews';
import type { Card, CardFieldValue, CustomField } from '@/lib/types';
import {
  boardFiltersToSavedViewFilters,
  clearFieldFilter,
  EMPTY_FILTERS,
  fieldFilterOf,
  filterCards,
  filtersEqual,
  savedViewFiltersToBoardFilters,
  setFieldRange,
  toggleFieldOption,
  type BoardFilters,
} from './filters';

function makeCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    boardId: 'board-1',
    listId: 'list-1',
    title: `任务 ${id}`,
    description: '',
    dueDate: null,
    startDate: null,
    estimatedMinutes: null,
    actualMinutes: null,
    priority: null,
    completed: false,
    deletedAt: null,
    labels: [],
    subtasks: [],
    position: 0,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

function withFilters(overrides: Partial<BoardFilters>): BoardFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

function value(cardId: string, fieldId: string, text: string | null, num: number | null): CardFieldValue {
  return { cardId, fieldId, valueText: text, valueNumber: num };
}

const selectField: CustomField = {
  id: 'cf_stage',
  boardId: 'board-1',
  name: '阶段',
  fieldType: 'select',
  options: [{ id: 'opt_a', label: '甲', color: '#0f766e' }],
  sortOrder: 0,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};

describe('按自定义字段筛选', () => {
  it('单选字段多选之间是 OR，没填该字段的任务不命中', () => {
    const cards = [makeCard('a'), makeCard('b'), makeCard('c')];
    const values = [
      value('a', 'cf_stage', 'opt_a', null),
      value('b', 'cf_stage', 'opt_b', null),
    ];
    const filters = withFilters({
      fieldFilters: [{ fieldId: 'cf_stage', optionIds: ['opt_a'], min: null, max: null }],
    });

    expect(filterCards(cards, filters, { cardFieldValues: values }).map((c) => c.id)).toEqual([
      'a',
    ]);

    const both = withFilters({
      fieldFilters: [
        { fieldId: 'cf_stage', optionIds: ['opt_a', 'opt_b'], min: null, max: null },
      ],
    });
    expect(filterCards(cards, both, { cardFieldValues: values }).map((c) => c.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('数值字段按区间过滤，边界包含在内', () => {
    const cards = [makeCard('low'), makeCard('mid'), makeCard('high'), makeCard('none')];
    const values = [
      value('low', 'cf_score', null, 1),
      value('mid', 'cf_score', null, 3),
      value('high', 'cf_score', null, 9),
    ];
    const filters = withFilters({
      fieldFilters: [{ fieldId: 'cf_score', optionIds: [], min: 2, max: 5 }],
    });

    expect(filterCards(cards, filters, { cardFieldValues: values }).map((c) => c.id)).toEqual([
      'mid',
    ]);

    const openLeft = withFilters({
      fieldFilters: [{ fieldId: 'cf_score', optionIds: [], min: 3, max: null }],
    });
    expect(filterCards(cards, openLeft, { cardFieldValues: values }).map((c) => c.id)).toEqual([
      'mid',
      'high',
    ]);
  });

  it('多个字段条件之间是 AND', () => {
    const cards = [makeCard('a'), makeCard('b')];
    const values = [
      value('a', 'cf_stage', 'opt_a', null),
      value('a', 'cf_score', null, 4),
      value('b', 'cf_stage', 'opt_a', null),
      value('b', 'cf_score', null, 1),
    ];
    const filters = withFilters({
      fieldFilters: [
        { fieldId: 'cf_stage', optionIds: ['opt_a'], min: null, max: null },
        { fieldId: 'cf_score', optionIds: [], min: 3, max: null },
      ],
    });

    expect(filterCards(cards, filters, { cardFieldValues: values }).map((c) => c.id)).toEqual([
      'a',
    ]);
  });

  it('只看被阻塞的任务', () => {
    const cards = [makeCard('blocked'), makeCard('free')];
    const filters = withFilters({ blocked: true });
    const blockedCardIds = new Set(['blocked']);

    expect(
      filterCards(cards, filters, { blockedCardIds }).map((c) => c.id),
    ).toEqual(['blocked']);
    expect(filterCards(cards, filters, {}).map((c) => c.id)).toEqual([]);
  });

  it('没有生效筛选时仍然原样返回同一数组引用', () => {
    const cards = [makeCard('a')];
    expect(filterCards(cards, EMPTY_FILTERS, { cardFieldValues: [] })).toBe(cards);
  });
});

describe('字段筛选条件的增删改', () => {
  it('切换选项会写入新的条件并返回新对象', () => {
    const base = EMPTY_FILTERS;
    const added = toggleFieldOption(base, 'cf_stage', 'opt_a');

    expect(added).not.toBe(base);
    expect(fieldFilterOf(added, 'cf_stage')?.optionIds).toEqual(['opt_a']);
    expect(base.fieldFilters).toEqual([]);
  });

  it('取消最后一个选项时整条字段条件一并移除', () => {
    const added = toggleFieldOption(EMPTY_FILTERS, 'cf_stage', 'opt_a');
    const removed = toggleFieldOption(added, 'cf_stage', 'opt_a');

    expect(removed.fieldFilters).toEqual([]);
  });

  it('数值区间上下限都为空时移除条件', () => {
    const ranged = setFieldRange(EMPTY_FILTERS, 'cf_score', 1, 5);
    expect(fieldFilterOf(ranged, 'cf_score')).toEqual({
      fieldId: 'cf_score',
      optionIds: [],
      min: 1,
      max: 5,
    });

    expect(setFieldRange(ranged, 'cf_score', null, null).fieldFilters).toEqual([]);
  });

  it('清除字段条件只影响该字段', () => {
    const both = toggleFieldOption(setFieldRange(EMPTY_FILTERS, 'cf_score', 1, 5), 'cf_stage', 'opt_a');
    const cleared = clearFieldFilter(both, 'cf_stage');

    expect(cleared.fieldFilters.map((item) => item.fieldId)).toEqual(['cf_score']);
  });
});

describe('筛选条件与保存视图之间的互转', () => {
  it('保存视图的筛选条件能还原成看板筛选条件', () => {
    const filters = withFilters({
      keyword: 'sqlite',
      status: 'active',
      priorities: ['high'],
      labels: ['研发'],
      fieldFilters: [{ fieldId: 'cf_stage', optionIds: ['opt_a'], min: null, max: null }],
      blocked: true,
    });

    const saved = boardFiltersToSavedViewFilters(filters);
    expect(saved.status).toBe('active');
    expect(saved.blocked).toBe(true);
    expect(saved.fieldFilters).toHaveLength(1);

    const restored = savedViewFiltersToBoardFilters(saved);
    expect(restored).toEqual(filters);
  });

  it('旧数据缺少字段时补上默认值', () => {
    const restored = savedViewFiltersToBoardFilters({ keyword: 'x' });

    expect(restored).toEqual({
      keyword: 'x',
      status: 'all',
      priorities: [],
      labels: [],
      fieldFilters: [],
      blocked: false,
    });
  });

  it('筛选条件等价判断覆盖数组与区间', () => {
    const a = withFilters({
      priorities: ['high'],
      fieldFilters: [{ fieldId: 'cf_score', optionIds: [], min: 1, max: 5 }],
    });
    const b = withFilters({
      priorities: ['high'],
      fieldFilters: [{ fieldId: 'cf_score', optionIds: [], min: 1, max: 5 }],
    });
    const c = withFilters({
      priorities: ['high'],
      fieldFilters: [{ fieldId: 'cf_score', optionIds: [], min: 1, max: 6 }],
    });

    expect(filtersEqual(a, b)).toBe(true);
    expect(filtersEqual(a, c)).toBe(false);
    expect(filtersEqual(a, withFilters({ blocked: true }))).toBe(false);
  });
});

describe('排序键归一化', () => {
  it('后端的 updatedAt 能落到前端的更新时间排序', () => {
    expect(normalizeSortKey('updatedAt', 'desc')).toBe('updated-desc');
    expect(normalizeSortKey('updated', 'desc')).toBe('updated-desc');
    expect(normalizeSortKey('due', 'desc')).toBe('due-desc');
    expect(normalizeSortKey('due', 'asc')).toBe('due-asc');
    expect(normalizeSortKey('未知', 'asc')).toBe('due-asc');
  });

  it('归一化后的方向与排序键一致', () => {
    expect(normalizeSavedViewSort({ key: 'updatedAt', direction: 'desc' })).toEqual({
      key: 'updated-desc',
      direction: 'desc',
    });
    expect(normalizeSavedViewSort({ key: 'created', direction: 'asc' })).toEqual({
      key: 'created-asc',
      direction: 'asc',
    });
  });
});

describe('字段被删除后的降级', () => {
  it('字段没了就丢掉整条条件', () => {
    const filters = normalizeSavedViewFilters({
      fieldFilters: [{ fieldId: 'cf_gone', optionIds: ['opt_a'], min: null, max: null }],
    });

    expect(degradeSavedViewFieldFilters(filters, []).fieldFilters).toEqual([]);
  });

  it('选项没了就只留还存在的选项', () => {
    const filters = normalizeSavedViewFilters({
      fieldFilters: [
        { fieldId: 'cf_stage', optionIds: ['opt_a', 'opt_b'], min: null, max: null },
      ],
    });

    const degraded = degradeSavedViewFieldFilters(filters, [selectField]);
    expect(degraded.fieldFilters).toHaveLength(1);
    expect(degraded.fieldFilters[0].optionIds).toEqual(['opt_a']);
  });

  it('选项全被删光时整条条件消失', () => {
    const filters = normalizeSavedViewFilters({
      fieldFilters: [{ fieldId: 'cf_stage', optionIds: ['opt_b'], min: null, max: null }],
    });

    const degraded = degradeSavedViewFieldFilters(filters, [selectField]);
    expect(degraded.fieldFilters).toEqual([]);
  });
});

describe('savedViewFiltersEqual', () => {
  it('忽略顺序但要求集合一致', () => {
    const a = normalizeSavedViewFilters({ priorities: ['high', 'low'], labels: ['a', 'b'] });
    const b = normalizeSavedViewFilters({ priorities: ['low', 'high'], labels: ['b', 'a'] });

    expect(savedViewFiltersEqual(a, b)).toBe(true);
    expect(savedViewFiltersEqual(a, normalizeSavedViewFilters({ priorities: ['high'] }))).toBe(
      false,
    );
  });
});