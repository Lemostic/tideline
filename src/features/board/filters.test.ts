import { describe, expect, it } from 'vitest';
import type { Card } from '@/lib/types';
import {
  collectLabels,
  countActiveFilters,
  EMPTY_FILTERS,
  filterCards,
  hasActiveFilters,
  toggleLabel,
  togglePriority,
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
    parentCardId: null,
    position: 0,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

function withFilters(overrides: Partial<BoardFilters>): BoardFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

describe('filterCards', () => {
  it('没有生效筛选时原样返回同一数组引用', () => {
    const cards = [makeCard('a'), makeCard('b')];
    expect(filterCards(cards, EMPTY_FILTERS)).toBe(cards);
    expect(filterCards(cards, withFilters({ keyword: '   ' }))).toBe(cards);
  });

  it('关键词去除首尾空格并忽略大小写，匹配标题', () => {
    const cards = [
      makeCard('a', { title: '接入 SQLite 持久化' }),
      makeCard('b', { title: '实现看板拖拽' }),
    ];

    expect(filterCards(cards, withFilters({ keyword: '  sqlite ' })).map((c) => c.id)).toEqual(['a']);
    expect(filterCards(cards, withFilters({ keyword: 'SQLITE' })).map((c) => c.id)).toEqual(['a']);
  });

  it('关键词同时匹配描述与标签', () => {
    const cards = [
      makeCard('desc', { description: '用 rusqlite 建库' }),
      makeCard('label', { labels: ['性能', '研发'] }),
      makeCard('other', { title: '无关任务' }),
    ];

    expect(filterCards(cards, withFilters({ keyword: 'rusqlite' })).map((c) => c.id)).toEqual(['desc']);
    expect(filterCards(cards, withFilters({ keyword: '性能' })).map((c) => c.id)).toEqual(['label']);
  });

  it('按完成状态过滤', () => {
    const cards = [
      makeCard('done', { completed: true }),
      makeCard('todo', { completed: false }),
    ];

    expect(filterCards(cards, withFilters({ status: 'active' })).map((c) => c.id)).toEqual(['todo']);
    expect(filterCards(cards, withFilters({ status: 'completed' })).map((c) => c.id)).toEqual(['done']);
    expect(filterCards(cards, withFilters({ status: 'all' }))).toHaveLength(2);
  });

  it('多选优先级之间是 OR，未设置优先级的任务不命中', () => {
    const cards = [
      makeCard('high', { priority: 'high' }),
      makeCard('medium', { priority: 'medium' }),
      makeCard('low', { priority: 'low' }),
      makeCard('none', { priority: null }),
    ];

    expect(
      filterCards(cards, withFilters({ priorities: ['high', 'low'] })).map((c) => c.id),
    ).toEqual(['high', 'low']);
    expect(filterCards(cards, withFilters({ priorities: ['medium'] })).map((c) => c.id)).toEqual([
      'medium',
    ]);
  });

  it('多选标签之间是 AND，需要全部命中', () => {
    const cards = [
      makeCard('both', { labels: ['研发', '性能'] }),
      makeCard('one', { labels: ['研发'] }),
      makeCard('none', { labels: [] }),
    ];

    expect(filterCards(cards, withFilters({ labels: ['研发'] })).map((c) => c.id)).toEqual([
      'both',
      'one',
    ]);
    expect(filterCards(cards, withFilters({ labels: ['研发', '性能'] })).map((c) => c.id)).toEqual([
      'both',
    ]);
  });

  it('关键词 + 状态 + 优先级 + 标签组合筛选', () => {
    const cards = [
      makeCard('hit', {
        title: 'SQLite 索引优化',
        priority: 'high',
        labels: ['研发', '性能'],
      }),
      makeCard('wrong-status', {
        title: 'SQLite 备份',
        priority: 'high',
        labels: ['研发', '性能'],
        completed: true,
      }),
      makeCard('wrong-priority', {
        title: 'SQLite 导出',
        priority: 'medium',
        labels: ['研发', '性能'],
      }),
      makeCard('wrong-label', {
        title: 'SQLite 迁移',
        priority: 'high',
        labels: ['研发'],
      }),
    ];

    const filters = withFilters({
      keyword: 'sqlite',
      status: 'active',
      priorities: ['high'],
      labels: ['研发', '性能'],
    });

    expect(filterCards(cards, filters).map((c) => c.id)).toEqual(['hit']);
  });

  it('没有匹配结果时返回空数组', () => {
    const cards = [makeCard('a', { title: '写周报' })];
    expect(filterCards(cards, withFilters({ keyword: '不存在' }))).toEqual([]);
  });

  it('不修改传入的 cards 与 filters', () => {
    const cards = [makeCard('a', { labels: ['研发'] }), makeCard('b')];
    const filters = withFilters({ priorities: ['high'], labels: ['研发'] });
    const cardsSnapshot = JSON.parse(JSON.stringify(cards));
    const filtersSnapshot = JSON.parse(JSON.stringify(filters));

    filterCards(cards, filters);

    expect(cards).toEqual(cardsSnapshot);
    expect(filters).toEqual(filtersSnapshot);
  });
});

describe('collectLabels', () => {
  it('按出现次数降序、同次数按名称升序返回标签', () => {
    const cards = [
      makeCard('a', { labels: ['alpha', 'beta'] }),
      makeCard('b', { labels: ['alpha'] }),
      makeCard('c', { labels: ['gamma'] }),
    ];

    expect(collectLabels(cards)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('跳过空白标签，并对同一任务内重复标签只计一次', () => {
    const cards = [
      makeCard('a', { labels: ['研发', '研发', '  ', '研发'] }),
      makeCard('b', { labels: ['性能'] }),
    ];

    const labels = collectLabels(cards);
    expect(labels).toHaveLength(2);
    expect(labels).toContain('研发');
    expect(labels).toContain('性能');
    expect(collectLabels([])).toEqual([]);
  });
});

describe('hasActiveFilters / countActiveFilters', () => {
  it('空白关键词不算激活筛选', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters(withFilters({ keyword: '   ' }))).toBe(false);
    expect(countActiveFilters(withFilters({ keyword: '   ' }))).toBe(0);
  });

  it('按激活的维度计数', () => {
    expect(
      countActiveFilters(
        withFilters({ keyword: 'sqlite', status: 'active', priorities: ['high'], labels: ['研发'] }),
      ),
    ).toBe(4);
    expect(countActiveFilters(withFilters({ priorities: ['high', 'low'] }))).toBe(1);
    expect(hasActiveFilters(withFilters({ labels: ['研发'] }))).toBe(true);
  });
});

describe('togglePriority / toggleLabel', () => {
  it('追加与移除都返回新对象，不修改入参', () => {
    const base = withFilters({ priorities: ['high'], labels: ['研发'] });

    const added = togglePriority(base, 'medium');
    expect(added).not.toBe(base);
    expect(added.priorities).toEqual(['high', 'medium']);
    expect(base.priorities).toEqual(['high']);

    const removed = togglePriority(base, 'high');
    expect(removed.priorities).toEqual([]);
    expect(base.priorities).toEqual(['high']);

    const labeled = toggleLabel(base, '性能');
    expect(labeled.labels).toEqual(['研发', '性能']);
    expect(base.labels).toEqual(['研发']);
    expect(toggleLabel(labeled, '性能').labels).toEqual(['研发']);
  });
});
