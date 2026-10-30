/**
 * 任务依赖（V0.4）的纯函数工具。
 *
 * 语义：`dependencies` 中每条 `{ cardId, dependsOnCardId }` 表示 cardId 被
 * dependsOnCardId（前置任务）阻塞；前置任务全部完成后才算解除阻塞。
 */
import type { Card, CardDependency } from './types';

export function blockersFor(
  cardId: string,
  dependencies: CardDependency[],
  cards: Card[],
): Card[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return dependencies
    .filter((dependency) => dependency.cardId === cardId)
    .map((dependency) => byId.get(dependency.dependsOnCardId))
    .filter((card): card is Card => Boolean(card));
}

export function isBlocked(
  cardId: string,
  dependencies: CardDependency[],
  cards: Card[],
): boolean {
  return blockersFor(cardId, dependencies, cards).some((blocker) => !blocker.completed);
}

export function blockerIds(cardId: string, dependencies: CardDependency[]): string[] {
  return dependencies
    .filter((dependency) => dependency.cardId === cardId)
    .map((dependency) => dependency.dependsOnCardId);
}

/** 直接或间接依赖 `cardId` 的任务（用于避免循环依赖）。 */
export function dependentIds(
  cardId: string,
  dependencies: CardDependency[],
): Set<string> {
  const edges = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const bucket = edges.get(dependency.dependsOnCardId) ?? [];
    bucket.push(dependency.cardId);
    edges.set(dependency.dependsOnCardId, bucket);
  }
  const result = new Set<string>();
  const stack = [...(edges.get(cardId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (result.has(current)) continue;
    result.add(current);
    stack.push(...(edges.get(current) ?? []));
  }
  return result;
}

/**
 * 可以作为「前置任务」的候选：同看板、未删除、非自己、未重复添加，
 * 且不能是依赖自己的任务（否则会形成环）。
 */
export function dependencyCandidates(
  card: Card,
  boardCards: Card[],
  dependencies: CardDependency[],
): Card[] {
  const existing = new Set(blockerIds(card.id, dependencies));
  const dependents = dependentIds(card.id, dependencies);
  return boardCards.filter(
    (item) =>
      item.boardId === card.boardId &&
      item.id !== card.id &&
      !existing.has(item.id) &&
      !dependents.has(item.id),
  );
}
