import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './api';

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });
});

const emptyFilters = {
  keyword: '',
  status: 'all' as const,
  priorities: [],
  labels: [],
  fieldFilters: [],
  blocked: false,
};

async function makeBoard(title = '看板') {
  const board = await api.createBoard({ title });
  await api.createList({ boardId: board.id, title: '待办' });
  return board;
}

describe('保存的筛选视图（V0.13.1）', () => {
  it('新建看板自动补齐三个内置视图', async () => {
    const board = await makeBoard();
    const views = (await api.getSnapshot()).savedViews.filter(
      (view) => view.boardId === board.id,
    );

    expect(views.map((view) => view.name)).toEqual(['全部', '我的任务', '最近更新']);
    expect(views.every((view) => view.isBuiltin)).toBe(true);
  });

  it('保存视图后写入快照，筛选条件与排序一起存', async () => {
    const board = await makeBoard();
    const field = await api.createCustomField({
      boardId: board.id,
      name: '阶段',
      fieldType: 'select',
      options: [{ id: 'opt_a', label: '甲', color: '#0f766e' }],
    });
    const created = await api.createSavedView({
      boardId: board.id,
      name: '高优先级',
      viewType: 'table',
      filters: {
        ...emptyFilters,
        priorities: ['high'],
        fieldFilters: [
          { fieldId: field.id, optionIds: ['opt_a'], min: null, max: null },
        ],
      },
      sort: { key: 'priority', direction: 'asc' },
    });

    expect(created.name).toBe('高优先级');
    expect(created.viewType).toBe('table');
    expect(created.filters.priorities).toEqual(['high']);
    expect(created.sort.key).toBe('priority');

    const snapshot = await api.getSnapshot();
    const stored = snapshot.savedViews.find((view) => view.id === created.id);
    expect(stored).toBeDefined();
    expect(stored?.filters.fieldFilters).toHaveLength(1);
  });

  it('同一看板不允许同名视图', async () => {
    const board = await makeBoard();
    await api.createSavedView({ boardId: board.id, name: '待办' });

    await expect(
      api.createSavedView({ boardId: board.id, name: '待办' }),
    ).rejects.toThrow('同名视图');
  });

  it('视图名称不能为空', async () => {
    const board = await makeBoard();
    await expect(api.createSavedView({ boardId: board.id, name: '   ' })).rejects.toThrow(
      '视图名称',
    );
  });

  it('内置视图不能改名也不能删除', async () => {
    const board = await makeBoard();
    const builtin = (await api.getSnapshot()).savedViews.find(
      (view) => view.boardId === board.id && view.isBuiltin,
    );
    expect(builtin).toBeDefined();

    await expect(api.updateSavedView({ id: builtin!.id, patch: { name: '改名' } })).rejects.toThrow(
      '内置视图不可修改',
    );
    await expect(api.deleteSavedView({ id: builtin!.id })).rejects.toThrow('内置视图不可删除');
  });

  it('用户视图可以改名与删除', async () => {
    const board = await makeBoard();
    const created = await api.createSavedView({ boardId: board.id, name: '临时' });

    const renamed = await api.updateSavedView({ id: created.id, patch: { name: '长期' } });
    expect(renamed.name).toBe('长期');

    await api.deleteSavedView({ id: created.id });
    const snapshot = await api.getSnapshot();
    expect(snapshot.savedViews.some((view) => view.id === created.id)).toBe(false);
  });

  it('字段被删除后视图里的字段条件自动降级', async () => {
    const board = await makeBoard();
    const field = await api.createCustomField({
      boardId: board.id,
      name: '阶段',
      fieldType: 'select',
      options: [{ id: 'opt_a', label: '甲', color: '#0f766e' }],
    });
    const created = await api.createSavedView({
      boardId: board.id,
      name: '按阶段',
      filters: {
        ...emptyFilters,
        fieldFilters: [
          { fieldId: field.id, optionIds: ['opt_a'], min: null, max: null },
        ],
      },
    });

    await api.deleteCustomField({ id: field.id });

    const stored = (await api.getSnapshot()).savedViews.find((view) => view.id === created.id);
    expect(stored?.filters.fieldFilters).toEqual([]);
  });
});