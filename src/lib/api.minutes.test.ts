import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './api';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
  });
});

describe('browser card minutes', () => {
  it('creates, edits, clears and persists nullable minutes, including zero', async () => {
    const board = await api.createBoard({ title: '工时' });
    const list = await api.createList({ boardId: board.id, title: '待办' });
    const created = await api.createCard({
      boardId: board.id, listId: list.id, title: '任务',
      estimatedMinutes: 90, actualMinutes: 0,
    });
    expect([created.estimatedMinutes, created.actualMinutes]).toEqual([90, 0]);
    await api.updateCard({ id: created.id, patch: { estimatedMinutes: null, actualMinutes: 45 } });
    const stored = (await api.getSnapshot()).cards.find((card) => card.id === created.id);
    expect([stored?.estimatedMinutes, stored?.actualMinutes]).toEqual([null, 45]);
  });

  it('rejects negative or fractional minutes without changing stored cards', async () => {
    const board = await api.createBoard({ title: '校验' });
    const list = await api.createList({ boardId: board.id, title: '待办' });
    await expect(api.createCard({ boardId: board.id, listId: list.id, title: '非法', estimatedMinutes: -1 }))
      .rejects.toThrow();
    const card = await api.createCard({ boardId: board.id, listId: list.id, title: '合法', actualMinutes: 0 });
    await expect(api.updateCard({ id: card.id, patch: { actualMinutes: 1.5 } })).rejects.toThrow();
    expect((await api.getSnapshot()).cards.find((item) => item.id === card.id)?.actualMinutes).toBe(0);
  });

  it('normalizes older browser cards missing minute fields', async () => {
    const board = await api.createBoard({ title: '旧数据' });
    const list = await api.createList({ boardId: board.id, title: '待办' });
    const card = await api.createCard({ boardId: board.id, listId: list.id, title: '旧任务' });
    const db = JSON.parse(storage.get('tideline.db.v1')!);
    delete db.cards[0].estimatedMinutes;
    delete db.cards[0].actualMinutes;
    storage.set('tideline.db.v1', JSON.stringify(db));
    const restored = (await api.getSnapshot()).cards.find((item) => item.id === card.id);
    expect([restored?.estimatedMinutes, restored?.actualMinutes]).toEqual([null, null]);
  });

  it('keeps estimate but resets actual minutes on recurrence', async () => {
    const board = await api.createBoard({ title: '重复' });
    const list = await api.createList({ boardId: board.id, title: '待办' });
    const card = await api.createCard({
      boardId: board.id, listId: list.id, title: '每日任务',
      dueDate: '2026-10-30', estimatedMinutes: 60, actualMinutes: 25,
    });
    await api.createRecurrence({ cardId: card.id, frequency: 'daily' });
    await api.updateCard({ id: card.id, patch: { completed: true } });
    const generated = (await api.getSnapshot()).cards.find((item) => item.generatedFromId === card.id);
    expect(generated).toBeDefined();
    expect([generated?.estimatedMinutes, generated?.actualMinutes]).toEqual([60, null]);
  });
});
