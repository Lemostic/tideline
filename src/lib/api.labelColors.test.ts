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

describe('browser board label colors', () => {
  it('persists board-wide label overrides after a snapshot reload', async () => {
    const board = await api.createBoard({ title: '看板' });
    await api.updateBoard({ id: board.id, patch: { labelColors: { 研发: 'rose' } } });
    expect((await api.getSnapshot()).boards.find((item) => item.id === board.id)?.labelColors).toEqual({ 研发: 'rose' });
  });

  it('normalizes boards created before label colors existed', async () => {
    const board = await api.createBoard({ title: '旧看板' });
    const db = JSON.parse(storage.get('tideline.db.v1')!);
    delete db.boards[0].labelColors;
    storage.set('tideline.db.v1', JSON.stringify(db));
    expect((await api.getSnapshot()).boards.find((item) => item.id === board.id)?.labelColors).toEqual({});
  });
});
