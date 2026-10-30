/**
 * 全局应用状态（Zustand）
 *
 * 约定：
 * - `snapshot` 是唯一数据源，UI 从中派生出看板 / 列表 / 任务；
 * - 所有写操作都先调 `api`，成功后再更新本地快照，保证持久化优先；
 * - 选择器只返回稳定引用（对象/数组字段），派生数组请在组件内用 useMemo，
 *   避免 useSyncExternalStore 因每次新建数组而反复渲染。
 */
import { create } from 'zustand';
import { api } from '@/lib/api';
import { toDateKey } from '@/lib/date';
import type {
  Board,
  BoardPatch,
  Card,
  CardPatch,
  InboxItem,
  List,
  ListPatch,
  NewBoardInput,
  NewCardInput,
  Snapshot,
} from '@/lib/types';

const EMPTY_SNAPSHOT: Snapshot = {
  boards: [],
  lists: [],
  cards: [],
  inbox: [],
  dependencies: [],
};
const SEED_FLAG = 'tideline.seeded';

function dateKeyOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

export interface AppState {
  snapshot: Snapshot;
  /** 回收站中的任务（软删除），由回收站页面按需加载 */
  trash: Card[];
  loaded: boolean;
  error: string | null;
  init: () => Promise<void>;
  /** 备份恢复后重新拉取快照，并清空按需加载的回收站缓存 */
  reloadSnapshot: () => Promise<void>;
  clearError: () => void;

  createBoard: (input: NewBoardInput) => Promise<Board>;
  updateBoard: (id: string, patch: BoardPatch) => Promise<void>;
  deleteBoard: (id: string) => Promise<void>;
  toggleStar: (id: string) => Promise<void>;

  createList: (boardId: string, title: string) => Promise<List>;
  updateList: (id: string, patch: ListPatch) => Promise<void>;
  deleteList: (id: string) => Promise<void>;

  createCard: (input: NewCardInput) => Promise<Card>;
  updateCard: (id: string, patch: CardPatch) => Promise<void>;
  deleteCard: (id: string) => Promise<void>;
  moveCard: (cardId: string, toListId: string, toIndex: number) => Promise<void>;
  /** 整体替换某张任务的前置任务（V0.4） */
  setDependencies: (cardId: string, dependsOn: string[]) => Promise<void>;

  /** 看板内批量操作（V0.4）：顺序写入后刷新快照 */
  bulkMoveCards: (cardIds: string[], toListId: string) => Promise<void>;
  bulkDeleteCards: (cardIds: string[]) => Promise<void>;
  bulkUpdateCards: (cardIds: string[], patch: CardPatch) => Promise<void>;

  loadTrash: () => Promise<void>;
  restoreCard: (id: string) => Promise<void>;
  purgeCard: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;

  addInbox: (content: string) => Promise<void>;
  deleteInbox: (id: string) => Promise<void>;
  convertInbox: (id: string, boardId: string, listId?: string) => Promise<Card>;
}

export const useAppStore = create<AppState>((set, get) => {
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    set({ error: message });
    throw error;
  };

  return {
    snapshot: EMPTY_SNAPSHOT,
    trash: [],
    loaded: false,
    error: null,

    clearError: () => set({ error: null }),

    init: async () => {
      if (get().loaded) return;
      try {
        const snapshot = await api.getSnapshot();
        set({ snapshot, loaded: true });
        const seeded = await seedDemoIfNeeded();
        if (seeded) set({ snapshot: await api.getSnapshot() });
      } catch (error) {
        fail(error);
      }
    },

    reloadSnapshot: async () => {
      try {
        const snapshot = await api.getSnapshot();
        set({ snapshot, trash: [] });
      } catch (error) {
        fail(error);
      }
    },

    createBoard: async (input) => {
      try {
        const board = await api.createBoard(input);
        // 新看板自带三条默认列表，避免用户面对空白画布
        const defaults = ['待办', '进行中', '已完成'];
        for (const title of defaults) {
          await api.createList({ boardId: board.id, title });
        }
        const snapshot = await api.getSnapshot();
        set({ snapshot });
        return board;
      } catch (error) {
        return fail(error);
      }
    },

    updateBoard: async (id, patch) => {
      try {
        const board = await api.updateBoard({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            boards: state.snapshot.boards.map((b) => (b.id === id ? board : b)),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteBoard: async (id) => {
      try {
        await api.deleteBoard({ id });
        set((state) => {
          const removedListIds = new Set(
            state.snapshot.lists.filter((l) => l.boardId === id).map((l) => l.id),
          );
          const removedCardIds = new Set(
            state.snapshot.cards
              .filter((c) => removedListIds.has(c.listId) || c.boardId === id)
              .map((c) => c.id),
          );
          return {
            snapshot: {
              boards: state.snapshot.boards.filter((b) => b.id !== id),
              lists: state.snapshot.lists.filter((l) => l.boardId !== id),
              cards: state.snapshot.cards.filter((c) => !removedListIds.has(c.listId)),
              inbox: state.snapshot.inbox,
              dependencies: state.snapshot.dependencies.filter(
                (d) => !removedCardIds.has(d.cardId) && !removedCardIds.has(d.dependsOnCardId),
              ),
            },
          };
        });
      } catch (error) {
        fail(error);
      }
    },

    toggleStar: async (id) => {
      const board = get().snapshot.boards.find((b) => b.id === id);
      if (!board) return;
      await get().updateBoard(id, { starred: !board.starred });
    },

    createList: async (boardId, title) => {
      try {
        const list = await api.createList({ boardId, title });
        set((state) => ({
          snapshot: { ...state.snapshot, lists: [...state.snapshot.lists, list] },
        }));
        return list;
      } catch (error) {
        return fail(error);
      }
    },

    updateList: async (id, patch) => {
      try {
        const list = await api.updateList({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            lists: state.snapshot.lists.map((l) => (l.id === id ? list : l)),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteList: async (id) => {
      try {
        await api.deleteList({ id });
        set((state) => {
          const removedCardIds = new Set(
            state.snapshot.cards.filter((c) => c.listId === id).map((c) => c.id),
          );
          return {
            snapshot: {
              ...state.snapshot,
              lists: state.snapshot.lists.filter((l) => l.id !== id),
              cards: state.snapshot.cards.filter((c) => c.listId !== id),
              dependencies: state.snapshot.dependencies.filter(
                (d) => !removedCardIds.has(d.cardId) && !removedCardIds.has(d.dependsOnCardId),
              ),
            },
          };
        });
      } catch (error) {
        fail(error);
      }
    },

    createCard: async (input) => {
      try {
        const card = await api.createCard(input);
        set((state) => ({
          snapshot: { ...state.snapshot, cards: [...state.snapshot.cards, card] },
        }));
        return card;
      } catch (error) {
        return fail(error);
      }
    },

    updateCard: async (id, patch) => {
      try {
        const card = await api.updateCard({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            cards: state.snapshot.cards.map((c) => (c.id === id ? card : c)),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteCard: async (id) => {
      try {
        await api.deleteCard({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            cards: state.snapshot.cards.filter((c) => c.id !== id),
            dependencies: state.snapshot.dependencies.filter(
              (d) => d.cardId !== id && d.dependsOnCardId !== id,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    // ---------- 回收站：软删除任务 ----------
    loadTrash: async () => {
      try {
        const items = await api.getTrash();
        set({ trash: items });
      } catch (error) {
        fail(error);
      }
    },

    restoreCard: async (id) => {
      try {
        const card = await api.restoreCard({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            cards: state.snapshot.cards.some((item) => item.id === id)
              ? state.snapshot.cards
              : [...state.snapshot.cards, card],
          },
          trash: state.trash.filter((item) => item.id !== id),
        }));
      } catch (error) {
        fail(error);
      }
    },

    purgeCard: async (id) => {
      try {
        await api.purgeCard({ id });
        set((state) => ({ trash: state.trash.filter((item) => item.id !== id) }));
      } catch (error) {
        fail(error);
      }
    },

    emptyTrash: async () => {
      try {
        await api.emptyTrash();
        set({ trash: [] });
      } catch (error) {
        fail(error);
      }
    },

    moveCard: async (cardId, toListId, toIndex) => {
      try {
        const moved = await api.moveCard({ cardId, toListId, toIndex });
        set((state) => {
          const others = state.snapshot.cards.filter((c) => c.id !== cardId);
          const target = others
            .filter((c) => c.listId === toListId)
            .sort((a, b) => a.position - b.position);
          const rest = others.filter((c) => c.listId !== toListId);
          const nextTarget = [...target];
          nextTarget.splice(Math.max(0, Math.min(toIndex, nextTarget.length)), 0, moved);
          return {
            snapshot: {
              ...state.snapshot,
              cards: [...rest, ...nextTarget.map((card, index) => ({ ...card, position: index }))],
            },
          };
        });
      } catch (error) {
        fail(error);
      }
    },

    setDependencies: async (cardId, dependsOn) => {
      try {
        const dependencies = await api.setCardDependencies({ cardId, dependsOn });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            dependencies: [
              ...state.snapshot.dependencies.filter((dependency) => dependency.cardId !== cardId),
              ...dependencies,
            ],
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    bulkMoveCards: async (cardIds, toListId) => {
      try {
        const existingTargetCount = get().snapshot.cards.filter(
          (card) => card.listId === toListId && !cardIds.includes(card.id),
        ).length;
        for (let index = 0; index < cardIds.length; index += 1) {
          await api.moveCard({
            cardId: cardIds[index],
            toListId,
            toIndex: existingTargetCount + index,
          });
        }
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    bulkDeleteCards: async (cardIds) => {
      try {
        for (const cardId of cardIds) {
          await api.deleteCard({ id: cardId });
        }
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    bulkUpdateCards: async (cardIds, patch) => {
      try {
        for (const cardId of cardIds) {
          await api.updateCard({ id: cardId, patch });
        }
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    addInbox: async (content) => {
      try {
        const item = await api.addInboxItem({ content });
        set((state) => ({
          snapshot: { ...state.snapshot, inbox: [item, ...state.snapshot.inbox] },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteInbox: async (id) => {
      try {
        await api.deleteInboxItem({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            inbox: state.snapshot.inbox.filter((item: InboxItem) => item.id !== id),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    convertInbox: async (id, boardId, listId) => {
      try {
        const card = await api.convertInboxItem({ id, boardId, listId });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            cards: [...state.snapshot.cards, card],
            inbox: state.snapshot.inbox.filter((item) => item.id !== id),
          },
        }));
        return card;
      } catch (error) {
        return fail(error);
      }
    },
  };
});

/** 便捷选择器：只订阅快照本身，派生数据请在组件内 useMemo */
export const useSnapshot = (): Snapshot => useAppStore((state) => state.snapshot);

export function useBoard(boardId: string | undefined): Board | undefined {
  return useAppStore((state) =>
    boardId ? state.snapshot.boards.find((board) => board.id === boardId) : undefined,
  );
}

/**
 * 首次启动写入一套演示数据：
 * 让用户打开应用就能看到星标 / 最近 / 我的任务 / 收件箱的真实形态。
 * 用户清空后不再重播（用 seeded 标记控制）。
 */
async function seedDemoIfNeeded(): Promise<boolean> {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(SEED_FLAG)) return false;
    if (typeof localStorage !== 'undefined') localStorage.setItem(SEED_FLAG, '1');
  } catch {
    return false;
  }

  try {
    const snapshot = await api.getSnapshot();
    if (snapshot.boards.length > 0) return false;

    const product = await api.createBoard({
      title: '产品发布 · V0.2',
      color: 'blue',
      description: '把潮线第二版做出来：表格 + 甘特 + 更完整的任务抽屉。',
    });
    await api.updateBoard({ id: product.id, patch: { starred: true } });

    const productTodo = await api.createList({ boardId: product.id, title: '待办' });
    const productDoing = await api.createList({ boardId: product.id, title: '进行中' });
    const productDone = await api.createList({ boardId: product.id, title: '已完成' });

    await api.createCard({
      boardId: product.id,
      listId: productTodo.id,
      title: '补充本地数据库索引',
      description:
        '为 `cards.list_id`、`cards.due_date` 建索引，数据量大时查询更稳。\n\n验收标准：\n- 10 万条任务下列表查询 < 50ms\n- 迁移脚本可重复执行',
      startDate: dateKeyOffset(-5),
      dueDate: dateKeyOffset(-2),
      priority: 'high',
      labels: ['研发', '性能'],
      subtasks: [
        { id: 's_db_1', title: '排查慢查询', done: true },
        { id: 's_db_2', title: '写索引迁移脚本', done: false },
        { id: 's_db_3', title: '压测验证', done: false },
      ],
    });
    await api.createCard({
      boardId: product.id,
      listId: productTodo.id,
      title: '编写 V0.2 发布说明',
      description: '整理 V0.2 的功能清单与已知限制，发布到 GitHub Release。',
      startDate: dateKeyOffset(1),
      dueDate: dateKeyOffset(6),
      priority: 'medium',
      labels: ['文档'],
      subtasks: [
        { id: 's_doc_1', title: '整理功能清单', done: true },
        { id: 's_doc_2', title: '补截图与动图', done: false },
      ],
    });
    await api.createCard({
      boardId: product.id,
      listId: productTodo.id,
      title: '补充导出/备份入口',
      description: '把 SQLite 文件一键复制到用户选择的位置。',
      startDate: dateKeyOffset(7),
      dueDate: dateKeyOffset(12),
      labels: ['研发'],
    });
    await api.createCard({
      boardId: product.id,
      listId: productDoing.id,
      title: '实现表格视图',
      description: '表格视图带行内编辑与筛选排序，和看板共用同一套任务数据。',
      startDate: dateKeyOffset(-2),
      dueDate: dateKeyOffset(0),
      priority: 'high',
      labels: ['研发', '体验'],
      subtasks: [
        { id: 's_table_1', title: '字段表格', done: true },
        { id: 's_table_2', title: '行内编辑', done: true },
        { id: 's_table_3', title: '筛选与排序', done: false },
      ],
    });
    await api.createCard({
      boardId: product.id,
      listId: productDoing.id,
      title: '接入 SQLite 持久化',
      description: 'Rust 侧用 rusqlite 建库，前端启动时加载全量快照。',
      startDate: dateKeyOffset(-1),
      dueDate: dateKeyOffset(2),
      priority: 'medium',
      labels: ['研发', '数据'],
      subtasks: [{ id: 's_db_4', title: '建表与迁移', done: true }],
    });
    await api.createCard({
      boardId: product.id,
      listId: productDone.id,
      title: '确定技术选型',
      description: 'Tauri 2 + React + TypeScript，本地优先。',
      priority: 'low',
      labels: ['决策'],
      subtasks: [{ id: 's_arch_1', title: '对比 Electron / Tauri', done: true }],
    });
    const doneCard = await api.createCard({
      boardId: product.id,
      listId: productDone.id,
      title: '搭建工程骨架',
      description: 'Vite + React + TypeScript + 设计令牌。',
    });
    await api.updateCard({ id: doneCard.id, patch: { completed: true } });

    const life = await api.createBoard({
      title: '生活与灵感',
      color: 'amber',
      description: '工作之外的输入与充电。',
    });
    const lifeThisWeek = await api.createList({ boardId: life.id, title: '本周想做' });
    const lifeIdeas = await api.createList({ boardId: life.id, title: '灵感池' });
    await api.createCard({
      boardId: life.id,
      listId: lifeThisWeek.id,
      title: '读完《深度工作》第三章',
      dueDate: dateKeyOffset(3),
    });
    await api.createCard({
      boardId: life.id,
      listId: lifeThisWeek.id,
      title: '周末骑行 30 公里',
      dueDate: dateKeyOffset(4),
    });
    await api.createCard({
      boardId: life.id,
      listId: lifeIdeas.id,
      title: '做一个潮汐白噪音页面',
      description: '低饱和配色 + 真实潮汐数据，作为潮线的彩蛋页面。',
    });
    await api.createCard({
      boardId: life.id,
      listId: lifeIdeas.id,
      title: '收集独立开发者访谈',
    });

    const content = await api.createBoard({
      title: '内容创作计划',
      color: 'violet',
      description: '选题、写作、发布，把想法稳定地变成内容。',
    });
    const contentIdeas = await api.createList({ boardId: content.id, title: '选题池' });
    const contentWriting = await api.createList({ boardId: content.id, title: '写作中' });
    const contentDone = await api.createList({ boardId: content.id, title: '已发布' });
    await api.createCard({
      boardId: content.id,
      listId: contentIdeas.id,
      title: '《本地优先软件为什么值得做》',
      dueDate: dateKeyOffset(9),
      priority: 'medium',
    });
    await api.createCard({
      boardId: content.id,
      listId: contentIdeas.id,
      title: '整理 10 个看板工具的使用场景',
    });
    await api.createCard({
      boardId: content.id,
      listId: contentWriting.id,
      title: '写一篇 V0.2 开发复盘',
      description: '记录从看板到表格、甘特两版视图的取舍：为什么先不做协作。',
      startDate: dateKeyOffset(0),
      dueDate: dateKeyOffset(5),
      priority: 'high',
      labels: ['写作'],
      subtasks: [
        { id: 's_post_1', title: '列提纲', done: true },
        { id: 's_post_2', title: '写完初稿', done: false },
        { id: 's_post_3', title: '配图与校对', done: false },
      ],
    });
    const published = await api.createCard({
      boardId: content.id,
      listId: contentDone.id,
      title: '产品定位与差异化梳理',
    });
    await api.updateCard({ id: published.id, patch: { completed: true } });

    const reading = await api.createBoard({
      title: '读书与学习',
      color: 'green',
      description: '慢慢读，认真记。',
    });
    const readingNow = await api.createList({ boardId: reading.id, title: '在读' });
    const readingList = await api.createList({ boardId: reading.id, title: '书单' });
    await api.createCard({
      boardId: reading.id,
      listId: readingNow.id,
      title: '《卡片笔记写作法》第 2 章',
      dueDate: dateKeyOffset(7),
    });
    await api.createCard({
      boardId: reading.id,
      listId: readingList.id,
      title: '《Rust 程序设计语言》第 4 章',
    });

    await api.addInboxItem({ content: '研究 Tauri 2 自动更新与签名方案' });
    await api.addInboxItem({ content: '收集竞品定价页截图，整理差异化卖点' });
    await api.addInboxItem({ content: '周五复盘会前整理本周数据' });
    return true;
  } catch (error) {
    console.warn('演示数据写入失败（不影响使用）', error);
    return false;
  }
}
