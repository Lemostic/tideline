/**
 * 需求文档解析（V0.9）
 *
 * 纯前端、纯函数：把 Markdown / 纯文本需求文档解析成层级树，
 * 不调用任何 AI 服务，也不触碰数据库。
 *
 * 支持的结构：
 * - Markdown 标题 `#` ~ `######`：标题层级即任务层级；
 * - 有序列表 `1.`、`1.1.`、`1.1.1`：按编号层级或缩进层级嵌套；
 * - 无序列表 `- * +`：按缩进层级嵌套；
 * - 普通段落：归属到当前最近的节点，作为「原文正文」原样保留。
 *
 * 约定：
 * - 结构层级（level）从 1 开始，根节点为 0；
 * - 空行之后、且没有更深缩进的段落视为「列表已结束」，归到章节而不是最后一个列表项；
 * - 文档只有一个 `#` 一级标题时，把它当作「文档标题」上提一层，
 *   让标题下的章节/列表成为顶层任务（见 promoteDocumentTitle）。
 */

export interface RequirementNode {
  /** 解析期生成的稳定 id，形如 `r1`、`r2` */
  id: string;
  /** 节点标题：标题行文本或列表项文本（去掉编号） */
  title: string;
  /** 结构层级：根为 0，顶层内容为 1 */
  level: number;
  /** 原文编号，例如 `1`、`1.2`；标题节点为空 */
  marker: string;
  /** 节点来源：Markdown 标题或列表项 */
  kind: 'heading' | 'item';
  /** 节点下方的原文段落（Markdown 源码） */
  body: string;
  children: RequirementNode[];
}

/** 解析过程中的可变节点 */
interface DraftNode {
  id: string;
  title: string;
  level: number;
  marker: string;
  kind: 'heading' | 'item';
  /** Markdown 标题的 `#` 个数；列表项为 0 */
  headingLevel: number;
  bodyLines: string[];
  children: DraftNode[];
}

/** 行首空白宽度：空格按 1 计，Tab 按 4 计 */
function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

function createDraft(
  title: string,
  level: number,
  marker: string,
  kind: 'heading' | 'item',
  headingLevel = 0,
): DraftNode {
  return { id: '', title, level, marker, kind, headingLevel, bodyLines: [], children: [] };
}

/** 把正文行数组拼成段落文本：保留空行作为段落分隔，去掉首尾空行 */
function joinBody(lines: string[]): string {
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n').trim();
}

/**
 * 解析需求文档，返回根节点（根的 children 即顶层内容）。
 *
 * 空文档或没有可识别结构时，返回一个没有子节点的根。
 */
export function parseRequirementDocument(source: string): RequirementNode {
  const root = createDraft('', 0, '', 'heading');
  /** Markdown 标题栈：最后一项是当前所属标题 */
  const headings: Array<{ node: DraftNode; level: number }> = [];
  /** 列表项栈：最后一项是当前所属列表项 */
  const items: Array<{
    node: DraftNode;
    depth: number;
    indent: number;
    parent: DraftNode;
  }> = [];

  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let bodyOwner: DraftNode = root;
  let inCode = false;
  let codeBuffer: string[] = [];
  let codeFence = '';
  let sequence = 0;
  /** 上一行是否是空行：用来区分「段落紧跟列表项」与「段落结束列表」 */
  let lastLineWasBlank = false;

  const nextId = () => {
    sequence += 1;
    return `r${sequence}`;
  };

  for (const raw of lines) {
    if (inCode) {
      if (raw.trim().startsWith('```')) {
        inCode = false;
        bodyOwner.bodyLines.push(codeFence, ...codeBuffer, '```');
        codeBuffer = [];
      } else {
        codeBuffer.push(raw);
      }
      continue;
    }
    if (raw.trim().startsWith('```')) {
      inCode = true;
      codeFence = raw.trim();
      codeBuffer = [];
      continue;
    }

    if (raw.trim() === '') {
      lastLineWasBlank = true;
      const last = bodyOwner.bodyLines[bodyOwner.bodyLines.length - 1];
      if (bodyOwner.bodyLines.length > 0 && last !== undefined && last.trim() !== '') {
        bodyOwner.bodyLines.push('');
      }
      continue;
    }

    // Markdown 标题
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      while (headings.length > 0 && headings[headings.length - 1].level >= level) {
        headings.pop();
      }
      const parent = headings.length > 0 ? headings[headings.length - 1].node : root;
      const node = createDraft(title, parent.level + 1, '', 'heading', level);
      node.id = nextId();
      parent.children.push(node);
      headings.push({ node, level });
      // 新标题开启新的列表上下文
      items.length = 0;
      bodyOwner = node;
      lastLineWasBlank = false;
      continue;
    }

    // 有序列表（1. / 1.1 / 1.1.1）与无序列表（- * +）
    const ordered = /^(\s*)(\d+(?:\.\d+)*)[.)]\s+(.+)$/.exec(raw);
    const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(raw);
    if (ordered || bullet) {
      const indent = indentWidth(raw);
      const indentDepth = Math.floor(indent / 2) + 1;
      let depth = indentDepth;
      let marker = '';
      let title = '';
      if (ordered) {
        const parts = ordered[2].split('.');
        // 编号层级与缩进层级取更深的一个，兼容两种写法
        depth = Math.max(parts.length, indentDepth);
        marker = ordered[2];
        title = ordered[3].trim();
      } else {
        title = (bullet as RegExpExecArray)[2].trim();
      }

      while (items.length > 0 && items[items.length - 1].depth >= depth) {
        items.pop();
      }
      const parent =
        items.length > 0
          ? items[items.length - 1].node
          : headings.length > 0
            ? headings[headings.length - 1].node
            : root;
      const node = createDraft(title, parent.level + 1, marker, 'item');
      node.id = nextId();
      parent.children.push(node);
      items.push({ node, depth, indent, parent });
      bodyOwner = node;
      lastLineWasBlank = false;
      continue;
    }

    // 普通段落：默认归到当前最近的节点。
    // 空行之后出现、且没有更深缩进的段落说明列表已经结束，
    // 这段话属于列表的父级（章节），而不是最后一个列表项。
    if (
      items.length > 0 &&
      lastLineWasBlank &&
      indentWidth(raw) <= items[items.length - 1].indent
    ) {
      bodyOwner = items[items.length - 1].parent;
    }
    bodyOwner.bodyLines.push(raw.trim());
    lastLineWasBlank = false;
  }

  if (inCode && codeBuffer.length > 0) {
    bodyOwner.bodyLines.push(codeFence, ...codeBuffer);
  }

  return toRequirementNode(promoteDocumentTitle(root));
}

/** Draft 树 → 对外结构 */
function toRequirementNode(draft: DraftNode): RequirementNode {
  return {
    id: draft.id,
    title: draft.title,
    level: draft.level,
    marker: draft.marker,
    kind: draft.kind,
    body: joinBody(draft.bodyLines),
    children: draft.children.map(toRequirementNode),
  };
}

/**
 * 文档标题上提：整篇文档只有一个 `#` 一级标题，且它下面还有内容时，
 * 把这个标题当作「文档标题」，让它的子节点上升为顶层任务。
 */
function promoteDocumentTitle(root: DraftNode): DraftNode {
  if (root.children.length !== 1) return root;
  const only = root.children[0];
  if (only.kind !== 'heading' || only.headingLevel !== 1 || only.children.length === 0) {
    return root;
  }
  return {
    ...root,
    children: only.children.map((child) => shiftLevels(child, -1)),
  };
}

/** 整棵子树层级平移 */
function shiftLevels(node: DraftNode, delta: number): DraftNode {
  return {
    ...node,
    level: Math.max(1, node.level + delta),
    children: node.children.map((child) => shiftLevels(child, delta)),
  };
}

/** 统计树里的节点总数（不含根） */
export function countRequirementNodes(root: RequirementNode): number {
  return root.children.reduce((total, child) => total + 1 + countRequirementNodes(child), 0);
}

/** 树的最大层级（顶层为 1；空树为 0） */
export function maxRequirementLevel(root: RequirementNode): number {
  let max = 0;
  const walk = (node: RequirementNode) => {
    for (const child of node.children) {
      if (child.level > max) max = child.level;
      walk(child);
    }
  };
  walk(root);
  return max;
}
