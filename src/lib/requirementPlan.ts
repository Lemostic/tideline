/**
 * 需求拆解计划（V0.9）
 *
 * 把解析出来的层级树转成「要创建哪些任务卡」的清单。
 * 纯函数：不写库、不调用 AI，只做结构映射。
 *
 * 两种模式：
 * - `nested`（单任务承载子任务）：顶层节点变成任务卡，其下的层级收进子任务清单；
 * - `sections`（按章节拆成多个任务）：深度范围内的每一层节点各自变成一张任务卡。
 *
 * 深度（1–4）控制「结构化到第几层」：
 * 超出深度的节点不会被丢弃，而是折叠进所属任务的描述里，保持原文可追溯。
 */

import type { RequirementNode } from './requirementParser';

export type BreakdownMode = 'nested' | 'sections';

export interface BreakdownModeMeta {
  key: BreakdownMode;
  label: string;
  hint: string;
}

/** 拆解模式选项（顺序即界面展示顺序） */
export const BREAKDOWN_MODES: ReadonlyArray<BreakdownModeMeta> = [
  {
    key: 'nested',
    label: '单任务承载子任务',
    hint: '顶层章节变成任务，子层级收进该任务的子任务清单',
  },
  {
    key: 'sections',
    label: '按章节拆成多个任务',
    hint: '每一层章节各自变成一张任务，适合按章节认领',
  },
];

/** 可选的拆解深度 */
export const BREAKDOWN_DEPTHS: ReadonlyArray<number> = [1, 2, 3, 4];

export interface BreakdownOptions {
  mode: BreakdownMode;
  /** 1–4；超出范围的取值会被收敛 */
  depth: number;
  /** 目标看板里已有的任务标题，用于同名提示 */
  existingTitles?: string[];
}

export interface PlannedCard {
  /** 任务标题 */
  title: string;
  /** 任务描述：原文段落 + 折叠进来的深层内容 */
  description: string;
  /** 子任务标题（仅 nested 模式） */
  subtasks: string[];
  /** 原文位置，例如「1 › 1.2 › 登录」 */
  path: string;
  /** 在原文中的层级 */
  level: number;
  /** 与目标看板已有任务同名 */
  duplicate: boolean;
}

export interface BreakdownPlan {
  cards: PlannedCard[];
  /** 子任务总数 */
  subtaskCount: number;
  /** 因超出深度而折叠进描述的节点数 */
  foldedCount: number;
  /** 同名任务数 */
  duplicateCount: number;
}

/** 标题归一化：用于同名比对 */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 行内标签：保留原文编号 */
function inlineLabel(node: RequirementNode): string {
  return node.marker ? `${node.marker} ${node.title}` : node.title;
}

/** 子任务标题：编号保留编号，无编号时用全角空格表达缩进层级 */
function subtaskLabel(node: RequirementNode): string {
  if (node.marker) return `${node.marker} ${node.title}`;
  const indent = '\u3000'.repeat(Math.max(0, node.level - 2));
  return `${indent}${node.title}`;
}

/** 原文位置路径 */
function pathOf(node: RequirementNode, parentPath: string): string {
  const segment = node.marker || node.title;
  return parentPath ? `${parentPath} › ${segment}` : segment;
}

/** 收集某个节点的全部后代（深度优先） */
function descendants(node: RequirementNode): RequirementNode[] {
  const result: RequirementNode[] = [];
  const walk = (current: RequirementNode) => {
    for (const child of current.children) {
      result.push(child);
      walk(child);
    }
  };
  walk(node);
  return result;
}

/** 收集超出深度的「最外层」节点，它们的子树由大纲递归展开 */
function collectDeep(node: RequirementNode, depth: number): RequirementNode[] {
  const result: RequirementNode[] = [];
  const walk = (current: RequirementNode) => {
    for (const child of current.children) {
      if (child.level > depth) result.push(child);
      else walk(child);
    }
  };
  walk(node);
  return result;
}

/** 统计整棵树里超出深度的节点数 */
function countDeep(root: RequirementNode, depth: number): number {
  let count = 0;
  const walk = (current: RequirementNode) => {
    for (const child of current.children) {
      if (child.level > depth) count += 1;
      walk(child);
    }
  };
  walk(root);
  return count;
}

/** 把深层节点渲染成大纲文本 */
function outlineOf(nodes: RequirementNode[], baseLevel: number): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const indent = '  '.repeat(Math.max(0, node.level - baseLevel));
    lines.push(`${indent}- ${inlineLabel(node)}`);
    lines.push(outlineOf(node.children, baseLevel));
  }
  return lines.join('\n');
}

/** 段落文本压成一行，用于补充说明 */
function flattenBody(body: string): string {
  return body.replace(/\n+/g, ' ').trim();
}

/**
 * 生成拆解计划。
 *
 * @param root 解析后的根节点
 * @param options 模式、深度与已有任务标题
 */
export function buildBreakdownPlan(
  root: RequirementNode,
  options: BreakdownOptions,
): BreakdownPlan {
  const depth = Math.min(Math.max(Math.round(options.depth), 1), BREAKDOWN_DEPTHS.length);
  const existing = new Set((options.existingTitles ?? []).map(normalizeTitle));
  const seen = new Set<string>();

  const cards: PlannedCard[] = [];
  let subtaskCount = 0;

  const registerDuplicate = (title: string): boolean => {
    const key = normalizeTitle(title);
    if (!key) return false;
    const duplicated = existing.has(key) || seen.has(key);
    seen.add(key);
    return duplicated;
  };

  const buildDescription = (parts: Array<string | undefined>): string =>
    parts
      .map((part) => (part ?? '').trim())
      .filter((part) => part.length > 0)
      .join('\n\n');

  const foldedCount = countDeep(root, depth);

  if (options.mode === 'sections') {
    // 深度范围内的每一层节点各自变成一张任务
    const visit = (node: RequirementNode, path: string) => {
      const currentPath = pathOf(node, path);
      const deep = collectDeep(node, depth);
      const card: PlannedCard = {
        title: node.title,
        description: buildDescription([
          currentPath.includes('›') ? `> 来源：${currentPath}` : undefined,
          node.body,
          deep.length > 0 ? outlineOf(deep, depth + 1) : undefined,
        ]),
        subtasks: [],
        path: currentPath,
        level: node.level,
        duplicate: false,
      };
      card.duplicate = registerDuplicate(card.title);
      cards.push(card);
      for (const child of node.children) {
        if (child.level <= depth) visit(child, currentPath);
      }
    };

    for (const child of root.children) {
      if (child.level <= depth) visit(child, '');
    }
  } else {
    // 顶层节点变成任务卡，其余层级收进子任务清单
    for (const node of root.children) {
      const all = descendants(node);
      const withinDepth = all.filter((item) => item.level <= depth);
      const deeper = all.filter((item) => item.level > depth);

      const subtasks = withinDepth.map(subtaskLabel);
      subtaskCount += subtasks.length;

      const notes: string[] = [];
      for (const item of withinDepth) {
        if (!item.body) continue;
        notes.push(`- ${inlineLabel(item)}：${flattenBody(item.body)}`);
      }

      const currentPath = pathOf(node, '');
      const card: PlannedCard = {
        title: node.title,
        description: buildDescription([
          currentPath.includes('›') ? `> 来源：${currentPath}` : undefined,
          node.body,
          notes.length > 0 ? ['补充说明：', ...notes].join('\n') : undefined,
          deeper.length > 0 ? outlineOf(deeper, depth + 1) : undefined,
        ]),
        subtasks,
        path: currentPath,
        level: node.level,
        duplicate: false,
      };
      card.duplicate = registerDuplicate(card.title);
      cards.push(card);
    }
  }

  const duplicateCount = cards.filter((card) => card.duplicate).length;
  return { cards, subtaskCount, foldedCount, duplicateCount };
}

/** 计划摘要，用于界面提示 */
export function summarizePlan(plan: BreakdownPlan): string {
  const parts = [`${plan.cards.length} 个任务`];
  if (plan.subtaskCount > 0) parts.push(`${plan.subtaskCount} 个子任务`);
  if (plan.foldedCount > 0) parts.push(`${plan.foldedCount} 处内容折叠进描述`);
  if (plan.duplicateCount > 0) parts.push(`${plan.duplicateCount} 个同名任务`);
  return parts.join(' · ');
}
