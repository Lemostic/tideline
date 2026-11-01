/**
 * 任务关系（V0.4 起为依赖，V0.12 起带类型）的纯函数工具。
 *
 * 语义：`dependencies` 中每条 `{ cardId, dependsOnCardId, relationType }` 表示
 * cardId 与 dependsOnCardId 之间的关系。只有 `blocks`（前置）类型参与阻塞判定
 * 与循环依赖检测，`relates`（相关）与 `duplicates`（重复）只表达关联。
 */
import { isBlockingRelation, type Card, type CardDependency, type RelationType } from './types';

/** 关系的类型；旧数据没有该字段时按「前置」处理。 */
export function relationTypeOf(dependency: CardDependency): RelationType {
  return dependency.relationType ?? 'blocks';
}

/** 只保留阻塞型（前置）关系。 */
export function blockingRelations(dependencies: CardDependency[]): CardDependency[] {
  return dependencies.filter((dependency) => isBlockingRelation(dependency.relationType));
}

/**
 * 阻塞型关系里指向本任务的前置任务。
 * 只有这类关系会让卡片进入「被阻塞」状态。
 */
export function blockersFor(
  cardId: string,
  dependencies: CardDependency[],
  cards: Card[],
): Card[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return dependencies
    .filter(
      (dependency) =>
        dependency.cardId === cardId && isBlockingRelation(dependency.relationType),
    )
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

/** 全部关系目标 id（含非阻塞型），用于去重与候选过滤。 */
export function relatedIds(cardId: string, dependencies: CardDependency[]): string[] {
  return dependencies
    .filter((dependency) => dependency.cardId === cardId)
    .map((dependency) => dependency.dependsOnCardId);
}

/** 阻塞型关系里指向本任务的前置任务 id。 */
export function blockerIds(cardId: string, dependencies: CardDependency[]): string[] {
  return dependencies
    .filter(
      (dependency) =>
        dependency.cardId === cardId && isBlockingRelation(dependency.relationType),
    )
    .map((dependency) => dependency.dependsOnCardId);
}

/**
 * 直接或间接依赖 `cardId` 的任务（用于避免循环依赖）。
 *
 * 只沿阻塞型（前置）关系传播：相关与重复关系不构成阻塞链，
 * 不应因为互相指向而被判为循环。
 */
export function dependentIds(
  cardId: string,
  dependencies: CardDependency[],
): Set<string> {
  const edges = new Map<string, string[]>();
  for (const dependency of blockingRelations(dependencies)) {
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
 * 可以作为关系目标的候选任务：未删除、非自己、未重复添加，
 * 且不能是依赖自己的任务（否则会形成环）。
 *
 * V0.12 起放开跨看板限制——看板集本就是跨看板容器，
 * 「A 看板的交付物阻塞 B 看板的任务」是真实存在的需求。
 */
export function dependencyCandidates(
  card: Card,
  boardCards: Card[],
  dependencies: CardDependency[],
): Card[] {
  const existing = new Set(relatedIds(card.id, dependencies));
  const dependents = dependentIds(card.id, dependencies);
  return boardCards.filter(
    (item) =>
      item.boardId === card.boardId &&
      item.id !== card.id &&
      !existing.has(item.id) &&
      !dependents.has(item.id),
  );
}

/**
 * 跨看板关系候选：与 {@link dependencyCandidates} 同样的过滤规则，
 * 但不限制看板归属。
 */
export function crossBoardRelationCandidates(
  card: Card,
  allCards: Card[],
  dependencies: CardDependency[],
): Card[] {
  const existing = new Set(relatedIds(card.id, dependencies));
  const dependents = dependentIds(card.id, dependencies);
  return allCards.filter(
    (item) =>
      item.id !== card.id &&
      !existing.has(item.id) &&
      !dependents.has(item.id),
  );
}
