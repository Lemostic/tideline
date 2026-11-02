/**
 * 任务树纯函数（V0.14.0）。
 *
 * 子任务即 `cards.parent_card_id` 非空的卡片；快照保持扁平，视图与统计通过本模块
 * 统一建树，避免各处散落 `parentCardId` 判断。所有函数都容忍脏数据（缺父、成环），
 * 不会无限循环。
 */
import type { Card } from './types';

/** 技术层级上限：防止脏数据/异常备份构造超深任务链。 */
export const MAX_TASK_DEPTH = 100;

export function childrenOf(cards: Card[], parentId: string): Card[] {
  return cards
    .filter((card) => card.parentCardId === parentId)
    .sort(
      (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
    );
}

export function rootCards(cards: Card[]): Card[] {
  return cards.filter((card) => card.parentCardId === null);
}

export function isSubtask(card: Card): boolean {
  return card.parentCardId !== null;
}

/** 全部后代（深度优先、按 position 排序）；容忍环与断链。 */
export function descendantsOf(cards: Card[], cardId: string): Card[] {
  const result: Card[] = [];
  const seen = new Set<string>([cardId]);
  const walk = (parentId: string) => {
    for (const child of childrenOf(cards, parentId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      result.push(child);
      if (result.length >= 10000) return;
      walk(child.id);
    }
  };
  walk(cardId);
  return result;
}

/** 父任务进度：按全部后代统计，未删除的任务由快照保证。 */
export function subtaskProgress(
  cards: Card[],
  cardId: string,
): { done: number; total: number; percent: number } {
  const all = descendantsOf(cards, cardId);
  const done = all.filter((card) => card.completed).length;
  return {
    done,
    total: all.length,
    percent: all.length === 0 ? 0 : Math.round((done / all.length) * 100),
  };
}

/** 从根任务到当前任务的面包屑；遇到断链或环时返回已收集到的部分。 */
export function breadcrumbOf(cards: Card[], cardId: string): Card[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const chain: Card[] = [];
  const seen = new Set<string>();
  let current = byId.get(cardId);
  while (current && !seen.has(current.id) && chain.length <= MAX_TASK_DEPTH) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentCardId ? byId.get(current.parentCardId) : undefined;
  }
  return chain;
}

/** 当前任务深度：主任务为 0；断链时按已知链长度计算。 */
export function cardDepth(cards: Card[], cardId: string): number {
  const chain = breadcrumbOf(cards, cardId);
  return chain.length === 0 ? 0 : chain.length - 1;
}

/** 按父 id 建立子任务索引，供表格/详情一次遍历渲染。 */
export function buildChildrenIndex(cards: Card[]): Map<string | null, Card[]> {
  const index = new Map<string | null, Card[]>();
  for (const card of cards) {
    const key = card.parentCardId;
    const list = index.get(key) ?? [];
    list.push(card);
    index.set(key, list);
  }
  for (const list of index.values()) {
    list.sort(
      (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
    );
  }
  return index;
}
