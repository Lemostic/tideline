import { describe, expect, it } from 'vitest';
import { isBlankMarkdown, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('空内容返回空字符串', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n ')).toBe('');
    expect(isBlankMarkdown('  ')).toBe(true);
  });

  it('渲染段落与换行', () => {
    expect(renderMarkdown('第一行\n第二行')).toBe('<p>第一行<br />第二行</p>');
  });

  it('渲染标题、列表与引用', () => {
    const html = renderMarkdown('# 标题\n- 一\n- 二\n> 引用');
    expect(html).toContain('<h3>标题</h3>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>一</li>');
    expect(html).toContain('<blockquote>引用</blockquote>');
  });

  it('渲染行内样式与链接', () => {
    const html = renderMarkdown('**粗体** *斜体* ~~删除~~ `code` [链接](https://example.com)');
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('<em>斜体</em>');
    expect(html).toContain('<del>删除</del>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('href="https://example.com"');
  });

  it('转义 HTML 并拦截 javascript: 链接', () => {
    const html = renderMarkdown('<script>alert(1)</script> [点我](javascript:alert(1))');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });

  it('渲染代码块并转义内容', () => {
    const html = renderMarkdown('```\nconst a = "<b>";\n```');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });
});
