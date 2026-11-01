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

async function makeBoard(title = '看板') {
  const board = await api.createBoard({ title });
  const list = await api.createList({ boardId: board.id, title: '待办' });
  return { board, list };
}

describe('自定义字段（V0.13.0）', () => {
  it('创建单选字段后选项内容与顺序保持不变', async () => {
    const { board } = await makeBoard();
    const field = await api.createCustomField({
      boardId: board.id,
      name: '优先级',
      fieldType: 'select',
      options: [
        { id: 'opt_high', label: '高', color: '#b91c1c' },
        { id: 'opt_low', label: '低', color: '#0f766e' },
      ],
    });
    expect(field.name).toBe('优先级');
    expect(field.options.map((option) => option.label)).toEqual(['高', '低']);
    expect((await api.getSnapshot()).customFields).toHaveLength(1);
  });

  it('同一看板内不允许同名字段，跨看板允许', async () => {
    const first = await makeBoard('看板甲');
    const second = await makeBoard('看板乙');
    await api.createCustomField({
      boardId: first.board.id,
      name: '评分',
      fieldType: 'number',
      options: [],
    });
    await expect(
      api.createCustomField({
        boardId: first.board.id,
        name: '评分',
        fieldType: 'number',
        options: [],
      }),
    ).rejects.toThrow('同名字段');
    await expect(
      api.createCustomField({
        boardId: second.board.id,
        name: '评分',
        fieldType: 'number',
        options: [],
      }),
    ).resolves.toBeTruthy();
  });

  it('数值字段不允许带选项，单选字段至少要一个选项', async () => {
    const { board } = await makeBoard();
    await expect(
      api.createCustomField({
        boardId: board.id,
        name: '评分',
        fieldType: 'number',
        options: [{ id: 'o1', label: '一', color: '#000000' }],
      }),
    ).rejects.toThrow('不支持选项');
    await expect(
      api.createCustomField({
        boardId: board.id,
        name: '阶段',
        fieldType: 'select',
        options: [],
      }),
    ).rejects.toThrow('至少需要一个选项');
  });

  it('写入并读回单选与数值两种取值', async () => {
    const { board, list } = await makeBoard();
    const card = await api.createCard({ boardId: board.id, listId: list.id, title: '任务' });
    const select = await api.createCustomField({
      boardId: board.id,
      name: '阶段',
      fieldType: 'select',
      options: [{ id: 'opt_a', label: '甲', color: '#0f766e' }],
    });
    const number = await api.createCustomField({
      boardId: board.id,
      name: '评分',
      fieldType: 'number',
      options: [],
    });
    await api.setCardFieldValues({
      cardId: card.id,
      values: [
        { fieldId: select.id, valueText: 'opt_a' },
        { fieldId: number.id, valueNumber: 4.5 },
      ],
    });
    const snapshot = await api.getSnapshot();
    const values = snapshot.cardFieldValues.filter((value) => value.cardId === card.id);
    expect(values).toHaveLength(2);
    expect(values.find((value) => value.fieldId === select.id)?.valueText).toBe('opt_a');
    expect(values.find((value) => value.fieldId === number.id)?.valueNumber).toBe(4.5);
  });

  it('拒绝非法选项、非有限数字与跨看板赋值', async () => {
    const { board, list } = await makeBoard();
    const other = await makeBoard('另一个看板');
    const card = await api.createCard({ boardId: board.id, listId: list.id, title: '任务' });
    const select = await api.createCustomField({
      boardId: board.id,
      name: '阶段',
      fieldType: 'select',
      options: [{ id: 'opt_a', label: '甲', color: '#0f766e' }],
    });
    const number = await api.createCustomField({
      boardId: board.id,
      name: '评分',
      fieldType: 'number',
      options: [],
    });
    const foreign = await api.createCustomField({
      boardId: other.board.id,
      name: '他看板字段',
      fieldType: 'number',
      options: [],
    });
    await expect(
      api.setCardFieldValues({
        cardId: card.id,
        values: [{ fieldId: select.id, valueText: 'opt_missing' }],
      }),
    ).rejects.toThrow('选项不存在');
    await expect(
      api.setCardFieldValues({
        cardId: card.id,
        values: [{ fieldId: number.id, valueNumber: Number.NaN }],
      }),
    ).rejects.toThrow('有限数字');
    await expect(
      api.setCardFieldValues({
        cardId: card.id,
        values: [{ fieldId: foreign.id, valueNumber: 1 }],
      }),
    ).rejects.toThrow('其它看板');
  });

  it('移除选项后指向它的取值被清理，保留选项的取值不受影响', async () => {
    const { board, list } = await makeBoard();
    const card = await api.createCard({ boardId: board.id, listId: list.id, title: '任务' });
    const field = await api.createCustomField({
      boardId: board.id,
      name: '阶段',
      fieldType: 'select',
      options: [
        { id: 'opt_a', label: '甲', color: '#0f766e' },
        { id: 'opt_b', label: '乙', color: '#2f6fd0' },
      ],
    });
    await api.setCardFieldValues({
      cardId: card.id,
      values: [{ fieldId: field.id, valueText: 'opt_a' }],
    });
    await api.updateCustomField({
      id: field.id,
      patch: { options: [{ id: 'opt_a', label: '甲（改名）', color: '#0f766e' }] },
    });
    const snapshot = await api.getSnapshot();
    const value = snapshot.cardFieldValues.find((item) => item.fieldId === field.id);
    expect(value?.valueText).toBe('opt_a');
    expect(snapshot.customFields[0].options[0].label).toBe('甲（改名）');
  });

  it('删除字段后相关取值被彻底清理', async () => {
    const { board, list } = await makeBoard();
    const card = await api.createCard({ boardId: board.id, listId: list.id, title: '任务' });
    const field = await api.createCustomField({
      boardId: board.id,
      name: '阶段',
      fieldType: 'select',
      options: [{ id: 'opt_a', label: '甲', color: '#0f766e' }],
    });
    await api.setCardFieldValues({
      cardId: card.id,
      values: [{ fieldId: field.id, valueText: 'opt_a' }],
    });
    await api.deleteCustomField({ id: field.id });
    const snapshot = await api.getSnapshot();
    expect(snapshot.customFields).toHaveLength(0);
    expect(snapshot.cardFieldValues).toHaveLength(0);
  });

  it('清空取值会删除该字段的值行', async () => {
    const { board, list } = await makeBoard();
    const card = await api.createCard({ boardId: board.id, listId: list.id, title: '任务' });
    const field = await api.createCustomField({
      boardId: board.id,
      name: '评分',
      fieldType: 'number',
      options: [],
    });
    await api.setCardFieldValues({
      cardId: card.id,
      values: [{ fieldId: field.id, valueNumber: 3 }],
    });
    await api.setCardFieldValues({
      cardId: card.id,
      values: [{ fieldId: field.id, valueNumber: null, valueText: null }],
    });
    expect((await api.getSnapshot()).cardFieldValues).toHaveLength(0);
  });

  it('删除任务后不残留字段取值', async () => {
    const { board, list } = await makeBoard();
    const card = await api.createCard({ boardId: board.id, listId: list.id, title: '任务' });
    const field = await api.createCustomField({
      boardId: board.id,
      name: '评分',
      fieldType: 'number',
      options: [],
    });
    await api.setCardFieldValues({
      cardId: card.id,
      values: [{ fieldId: field.id, valueNumber: 8 }],
    });
    await api.deleteCard({ id: card.id });
    expect((await api.getSnapshot()).cardFieldValues).toHaveLength(0);
  });

  it('旧数据缺少自定义字段时补空数组', async () => {
    const { board } = await makeBoard();
    const db = JSON.parse(storage.get('tideline.db.v1')!);
    delete db.customFields;
    delete db.cardFieldValues;
    storage.set('tideline.db.v1', JSON.stringify(db));
    const snapshot = await api.getSnapshot();
    expect(snapshot.customFields).toEqual([]);
    expect(snapshot.cardFieldValues).toEqual([]);
    expect(snapshot.boards.find((item) => item.id === board.id)).toBeTruthy();
  });
});
