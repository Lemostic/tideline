import { describe, expect, it } from 'vitest';
import {
  countRequirementNodes,
  maxRequirementLevel,
  parseRequirementDocument,
} from '@/lib/requirementParser';

describe('parseRequirementDocument', () => {
  it('按 Markdown 标题层级建树，并把正文挂到所属标题', () => {
    const root = parseRequirementDocument(
      ['# 需求标题', '说明段落', '', '## 模块 A', '模块说明', '### 子模块'].join('\n'),
    );

    expect(root.children).toHaveLength(1);
    const module = root.children[0];
    expect(module.title).toBe('模块 A');
    expect(module.level).toBe(1);
    expect(module.body).toBe('模块说明');
    expect(module.children[0].title).toBe('子模块');
    expect(module.children[0].level).toBe(2);
    expect(countRequirementNodes(root)).toBe(2);
    expect(maxRequirementLevel(root)).toBe(2);
  });

  it('唯一的一级标题当作文档标题，其子节点上升为顶层', () => {
    const root = parseRequirementDocument(['# 需求标题', '正文', '', '## 模块 A', '模块说明'].join('\n'));

    expect(root.children).toHaveLength(1);
    expect(root.children[0].title).toBe('模块 A');
    expect(root.children[0].level).toBe(1);
    expect(root.children[0].body).toBe('模块说明');
  });

  it('只有一个标题且没有子节点时不提升', () => {
    const root = parseRequirementDocument(['# 只有一个标题', '这是正文'].join('\n'));

    expect(root.children).toHaveLength(1);
    expect(root.children[0].title).toBe('只有一个标题');
    expect(root.children[0].body).toBe('这是正文');
  });

  it('多个一级标题保持平级', () => {
    const root = parseRequirementDocument(['# A', '## A1', '# B', '## B1'].join('\n'));

    expect(root.children.map((node) => node.title)).toEqual(['A', 'B']);
    expect(root.children[0].children[0].title).toBe('A1');
    expect(root.children[1].children[0].title).toBe('B1');
  });

  it('按编号层级解析有序列表', () => {
    const root = parseRequirementDocument(
      ['1. 用户登录', '1.1. 输入手机号', '1.2. 输入验证码', '2. 退出登录'].join('\n'),
    );

    expect(root.children.map((node) => node.title)).toEqual(['用户登录', '退出登录']);
    const login = root.children[0];
    expect(login.marker).toBe('1');
    expect(login.children.map((node) => node.marker)).toEqual(['1.1', '1.2']);
    expect(login.children[0].level).toBe(2);
  });

  it('按缩进解析无序列表', () => {
    const root = parseRequirementDocument(['- 登录', '  - 手机号', '    - 验证码'].join('\n'));

    expect(root.children[0].title).toBe('登录');
    expect(root.children[0].children[0].title).toBe('手机号');
    expect(root.children[0].children[0].children[0].title).toBe('验证码');
    expect(maxRequirementLevel(root)).toBe(3);
  });

  it('保留代码块原文', () => {
    const root = parseRequirementDocument(['# 标题', '```js', 'const a = 1;', '```'].join('\n'));

    expect(root.children[0].body).toBe('```js\nconst a = 1;\n```');
  });

  it('空文档返回空树', () => {
    const root = parseRequirementDocument('   ');

    expect(root.children).toHaveLength(0);
    expect(countRequirementNodes(root)).toBe(0);
  });

  it('空行后的独立段落归属章节，而不是最后一个列表项', () => {
    const root = parseRequirementDocument(
      ['## 积分体系', '来源说明。', '', '1. 签到', '2. 消费', '', '积分过期规则：年底清零。'].join('\n'),
    );

    const section = root.children[0];
    expect(section.title).toBe('积分体系');
    expect(section.body).toContain('来源说明。');
    expect(section.body).toContain('积分过期规则：年底清零。');
    expect(section.children[1].body).toBe('');
  });

  it('缩进更深的续行仍然跟着列表项', () => {
    const root = parseRequirementDocument(['- 签到', '  连续签到有加成'].join('\n'));

    expect(root.children[0].body).toBe('连续签到有加成');
  });
});
