import type { Card, Goal } from './types';

export interface GoalProgress {
  /** 0–100 */
  percent: number;
  source: 'tasks' | 'children' | 'manual';
  linkedCount: number;
  completedCount: number;
  childCount: number;
}

export function directGoalChildren(goalId: string, goals: Goal[]): Goal[] {
  return goals.filter((goal) => goal.parentId === goalId);
}

export function topLevelGoals(goals: Goal[]): Goal[] {
  return goals
    .filter((goal) => goal.parentId === null || !goals.some((item) => item.id === goal.parentId))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/**
 * 目标进度回写：
 * 1. 有活动关联任务 → 已完成任务 / 关联任务；
 * 2. 无关联任务但有子目标 → 子目标平均值；
 * 3. 都没有 → 手动进度。
 */
export function goalProgressDetail(
  goal: Goal,
  goals: Goal[],
  cards: Card[],
  visited: Set<string> = new Set(),
): GoalProgress {
  if (visited.has(goal.id)) {
    return {
      percent: goal.manualProgress,
      source: 'manual',
      linkedCount: 0,
      completedCount: 0,
      childCount: 0,
    };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(goal.id);

  const cardById = new Map(cards.map((card) => [card.id, card]));
  const linked = goal.cardIds
    .map((id) => cardById.get(id))
    .filter((card): card is Card => card !== undefined && !card.deletedAt);
  const children = directGoalChildren(goal.id, goals);

  if (linked.length > 0) {
    const completedCount = linked.filter((card) => card.completed).length;
    return {
      percent: Math.round((completedCount / linked.length) * 100),
      source: 'tasks',
      linkedCount: linked.length,
      completedCount,
      childCount: children.length,
    };
  }

  if (children.length > 0) {
    const childPercents = children.map(
      (child) => goalProgressDetail(child, goals, cards, nextVisited).percent,
    );
    return {
      percent: Math.round(childPercents.reduce((sum, value) => sum + value, 0) / children.length),
      source: 'children',
      linkedCount: 0,
      completedCount: 0,
      childCount: children.length,
    };
  }

  return {
    percent: Math.min(100, Math.max(0, Math.round(goal.manualProgress))),
    source: 'manual',
    linkedCount: 0,
    completedCount: 0,
    childCount: 0,
  };
}

export function goalProgress(goal: Goal, goals: Goal[], cards: Card[]): number {
  return goalProgressDetail(goal, goals, cards).percent;
}

export function goalHasChildren(goalId: string, goals: Goal[]): boolean {
  return goals.some((goal) => goal.parentId === goalId);
}

/** 返回目标的所有后代 id，用于禁止把目标移动到自己的子树下。 */
export function descendantGoalIds(goalId: string, goals: Goal[]): Set<string> {
  const result = new Set<string>();
  const stack = [goalId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const child of goals) {
      if (child.parentId === current && !result.has(child.id)) {
        result.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return result;
}

/** 从根到当前目标的路径，用于详情页面包屑。 */
export function goalAncestors(goal: Goal, goals: Goal[]): Goal[] {
  const path: Goal[] = [];
  const seen = new Set<string>();
  let current: Goal | undefined = goal;
  while (current && !seen.has(current.id)) {
    path.unshift(current);
    seen.add(current.id);
    current = current.parentId
      ? goals.find((item) => item.id === current?.parentId)
      : undefined;
  }
  return path;
}
