import { describe, expect, it } from 'vitest';
import { parseRequirementDocument } from '@/lib/requirementParser';
import { buildBreakdownPlan, summarizePlan } from '@/lib/requirementPlan';

const NUMBERED_DOC = ['1. 用户登录', '1.1. 输入手机号', '1.2. 输入验证码', '2. 退出登录'].join('\n');

const HEADING_DOC = ['# 需求标题', '## 模块 A', '模块说明', '### 子模块'].join('\n');

describe('buildBreakdownPlan', () => {
  it('nested 模式：顶层变任务，下一层变子任务', () => {
    const root = parseRequirementDocument(NUMBERED_DOC);
    const plan = buildBreakdownPlan(root, { mode: 'nested', depth: 2 });

    expect(plan.cards).toHaveLength(2);
    expect(plan.cards[0].title).toBe('用户登录');
    expect(plan.cards[0].subtasks).toEqual(['1.1 输入手机号', '1.2 输入验证码']);
    expect(plan.subtaskCount).toBe(2);
    expect(plan.foldedCount).toBe(0);
  });

  it('超出深度的内容折叠进任务描述，不丢原文', () => {
    const root = parseRequirementDocument(NUMBERED_DOC);
    const plan = buildBreakdownPlan(root, { mode: 'nested', depth: 1 });

    expect(plan.cards[0].subtasks).toHaveLength(0);
    expect(plan.foldedCount).toBe(2);
    expect(plan.cards[0].description).toContain('1.1 输入手机号');
    expect(plan.cards[0].description).toContain('1.2 输入验证码');
  });

  it('sections 模式：深度范围内每层各自成任务', () => {
    const root = parseRequirementDocument(HEADING_DOC);
    const plan = buildBreakdownPlan(root, { mode: 'sections', depth: 2 });

    expect(plan.cards.map((card) => card.title)).toEqual(['模块 A', '子模块']);
    expect(plan.cards[1].description).toContain('来源');
    expect(plan.subtaskCount).toBe(0);
  });

  it('sections 模式深度为 1 时只生成顶层任务，其余折叠', () => {
    const root = parseRequirementDocument(HEADING_DOC);
    const plan = buildBreakdownPlan(root, { mode: 'sections', depth: 1 });

    expect(plan.cards.map((card) => card.title)).toEqual(['模块 A']);
    expect(plan.foldedCount).toBe(1);
    expect(plan.cards[0].description).toContain('子模块');
  });

  it('标出与目标看板同名的任务', () => {
    const root = parseRequirementDocument(NUMBERED_DOC);
    const plan = buildBreakdownPlan(root, {
      mode: 'nested',
      depth: 2,
      existingTitles: ['用户登录'],
    });

    expect(plan.cards[0].duplicate).toBe(true);
    expect(plan.cards[1].duplicate).toBe(false);
    expect(plan.duplicateCount).toBe(1);
  });

  it('计划内部同名也会被标出', () => {
    const root = parseRequirementDocument(['1. 登录', '2. 登录'].join('\n'));
    const plan = buildBreakdownPlan(root, { mode: 'nested', depth: 1 });

    expect(plan.cards[0].duplicate).toBe(false);
    expect(plan.cards[1].duplicate).toBe(true);
  });

  it('深度会被收敛到 1–4', () => {
    const root = parseRequirementDocument(NUMBERED_DOC);
    const plan = buildBreakdownPlan(root, { mode: 'nested', depth: 99 });

    expect(plan.cards[0].subtasks).toHaveLength(2);
  });

  it('摘要包含任务与子任务数量', () => {
    const root = parseRequirementDocument(NUMBERED_DOC);
    const plan = buildBreakdownPlan(root, { mode: 'nested', depth: 2 });

    expect(summarizePlan(plan)).toContain('2 个任务');
    expect(summarizePlan(plan)).toContain('2 个子任务');
  });
});
