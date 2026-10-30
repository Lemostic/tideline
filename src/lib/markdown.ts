/**
 * 极简 Markdown 渲染器（无第三方依赖、先转义 HTML 再生成标签）。
 *
 * 仅支持任务描述里真正用的到的语法：
 * 标题、无序/有序列表、引用、代码块、行内代码、粗体、斜体、删除线、链接。
 * 链接只允许 http(s)，避免 javascript: 之类的注入；HTML 全部转义。
 */
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char] ?? char);
}

function renderInline(source: string): string {
  let text = escapeHtml(source);
  // 行内代码先占位，避免内部内容被其它规则改写
  const codes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // 链接：只接受 http(s) 与站内锚点
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, label: string, href: string) => {
      const safe = /^(https?:\/\/|#|\/)/i.test(href) ? href : '#';
      return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>`;
    },
  );
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  text = text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)] ?? '');
  return text;
}

/** 把 Markdown 源码渲染成可安全插入 DOM 的 HTML 字符串 */
export function renderMarkdown(source: string): string {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.trim()) return '';

  const lines = normalized.split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inCode = false;
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map((line) => renderInline(line)).join('<br />')}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.trim().startsWith('```')) {
      flushParagraph();
      closeList();
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (unordered) {
      flushParagraph();
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${renderInline(unordered[1])}</li>`);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${renderInline(ordered[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushParagraph();
  closeList();
  return html.join('\n');
}

/** 判断描述是否只有空白，供「编辑 / 预览」切换时展示占位 */
export function isBlankMarkdown(source: string): boolean {
  return source.trim().length === 0;
}
