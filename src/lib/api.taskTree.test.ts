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

async function seedBoard() {
  const board = await api.createBoard({ title: '看板' });
  const list = await api.createList({ boardId: board.id, title: '待办' });
  return { board, list };
}

describe('任务树（V0.14.0 浏览器模式）', () => {
  it('创建子任务并校验同看板/同列表', async () => {
    const { board, list } = await seedBoard();
    const other = await api.createList({ boardId: board.id, title: '进行中' });
    const parent = await api.createCard({
      boardId: board.id,
      listId: list.id,
      title: '父任务',
    });
    const child = await api.createCard({
      boardId: board.id,
      listId: list.id,
      title: '子任务',
      parentCardId: parent.id,
    });
    expect(child.parentCardId).toBe(parent.id);

    await expect(
      api.createCard({
        boardId: board.id,
        listId: other.id,
        title: '换列子任务',
        parentCardId: parent.id,
      }),
    ).rejects.toThrow('跟随父任务列表');
    await expect(
      api.moveCard({ cardId: child.id, toListId: other.id, toIndex: 0 }),
    ).rejects.toThrow('子任务不能单独移动列表');
  });

  it('移动主任务时整棵子树跟随列表', async () => {
    const { board, list } = await seedBoard();
    const other = await api.createList({ boardId: board.id, title: '进行中' });
    const parent = await api.createCard({ boardId: board.id, listId: list.id, title: '父任务' });
    const child = await api.createCard({
      boardId: board.id,
      listId: list.id,
      title: '子任务',
      parentCardId: parent.id,
    });
    const grand = await api.createCard({
      boardId: board.id,
      listId: list.id,
      title: '孙任务',
      parentCardId: child.id,
    });
    await api.moveCard({ cardId: parent.id, toListId: other.id, toIndex: 0 });
    const snapshot = await api.getSnapshot();
    for (const id of [child.id, grand.id]) {
      expect(snapshot.cards.find((card) => card.id === id)?.listId).toBe(other.id);
    }
  });

  it('删除父任务整树进回收站，恢复子任务连带祖先与后代', async () => {
    const { board, list } = await seedBoard();
    const parent = await api.createCard({ boardId: board.id, listId: list.id, title: '父任务' });
    const child = await api.createCard({
      boardId: board.id,
      listId: list.id,
      title: '子任务',
      parentCardId: parent.id,
    });
    const grand = await api.createCard({
      boardId: board.id,
      listId: list.id,
      title: '孙任务',
      parentCardId: child.id,
    });
    await api.deleteCard({ id: parent.id });
    expect((await api.getSnapshot()).cards).toHaveLength(0);
    expect((await api.getTrash()).map((card) => card.id).sort()).toEqual(
      [parent.id, child.id, grand.id].sort(),
    );

    await api.restoreCard({ id: child.id });
    const restored = await api.getSnapshot();
    expect(restored.cards.map((card) => card.id).sort()).toEqual(
      [parent.id, child.id, grand.id].sort(),
    );

    await api.deleteCard({ id: parent.id });
    await api.purgeCard({ id: parent.id });
    expect((await api.getTrash()).map((card) => card.id)).not.toContain(parent.id);
  });

  it('旧 localStorage 的 subtasks 会展开为真实子任务', async () => {
    const { board, list } = await seedBoard();
    const raw = JSON.parse(storage.get('tideline.db.v1') ?? '{}');
    storage.set(
      'tideline.db.v1',
      JSON.stringify({
        ...raw,
        cards: [
          {
            id: 'legacy_parent',
            boardId: board.id,
            listId: list.id,
            title: '旧父任务',
            description: '',
            dueDate: null,
            startDate: null,
            priority: null,
            accent: null,
            completed: false,
            deletedAt: null,
            labels: [],
            subtasks: [
              { id: 's1', title: '旧子1', done: false },
              { id: 's2', title: '旧子2', done: true },
            ],
            position: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const snapshot = await api.getSnapshot();
    const children = snapshot.cards.filter(
      (card) => card.parentCardId === 'legacy_parent',
    );
    expect(children.map((card) => card.title).sort()).toEqual(['旧子1', '旧子2']);
    expect(children.find((card) => card.title === '旧子2')?.completed).toBe(true);
  });
});
