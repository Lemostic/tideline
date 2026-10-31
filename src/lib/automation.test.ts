import { describe, expect, it } from 'vitest';
import {
  RECURRENCE_FREQUENCY_LABEL,
  applyRuleActions,
  daysInMonth,
  describeActivity,
  describeRecurrence,
  nextRecurrenceDate,
  nextRecurrenceDateFor,
  priorityLabel,
  validateRuleActions,
} from './automation';
import type { Card, RuleAction } from './types';

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'c_1',
    boardId: 'b_1',
    listId: 'l_1',
    title: '写周报',
    description: '',
    dueDate: null,
    startDate: null,
    priority: null,
    completed: false,
    deletedAt: null,
    labels: [],
    subtasks: [],
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    recurrenceId: null,
    generatedFromId: null,
    ...overrides,
  };
}

describe('重复日期推算', () => {
  it('每天往后推一天', () => {
    expect(nextRecurrenceDate('daily', '2026-01-31')).toBe('2026-02-01');
  });

  it('每月在短月收敛到月末', () => {
    expect(nextRecurrenceDate('monthly', '2026-01-31')).toBe('2026-02-28');
    expect(nextRecurrenceDate('monthly', '2028-01-31')).toBe('2028-02-29');
    expect(nextRecurrenceDate('monthly', '2026-12-15')).toBe('2027-01-15');
  });

  it('每周往后找最近的指定星期', () => {
    // 2026-01-05 是周一
    expect(nextRecurrenceDate('weekly', '2026-01-05', { weekdays: [1] })).toBe('2026-01-12');
    // 基准日当天命中时往后找，而不是回到当天
    expect(nextRecurrenceDate('weekly', '2026-01-05', { weekdays: [5] })).toBe('2026-01-09');
    // 没有选星期视为非法
    expect(nextRecurrenceDate('weekly', '2026-01-05', { weekdays: [] })).toBeNull();
  });

  it('自定义间隔按天数往后推', () => {
    expect(nextRecurrenceDate('interval', '2026-01-05', { intervalDays: 10 })).toBe(
      '2026-01-15',
    );
    expect(nextRecurrenceDate('interval', '2026-01-05', { intervalDays: 0 })).toBeNull();
  });

  it('基准日期非法时返回 null', () => {
    expect(nextRecurrenceDate('daily', '不是日期')).toBeNull();
  });

  it('按重复配置计算下一次日期', () => {
    expect(
      nextRecurrenceDateFor(
        { frequency: 'weekly', intervalValue: 1, weekdays: [1] },
        '2026-01-05',
      ),
    ).toBe('2026-01-12');
  });

  it('取某月天数与频率文案', () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(RECURRENCE_FREQUENCY_LABEL.daily).toBe('每天');
  });

  it('生成重复配置的中文摘要', () => {
    expect(
      describeRecurrence({
        id: 'r_1',
        cardId: 'c_1',
        frequency: 'weekly',
        intervalValue: 1,
        weekdays: [3, 1],
        nextDueDate: null,
        enabled: true,
        createdAt: '',
        updatedAt: '',
      }),
    ).toBe('每周一、三');
    expect(
      describeRecurrence({
        id: 'r_1',
        cardId: 'c_1',
        frequency: 'interval',
        intervalValue: 5,
        weekdays: [],
        nextDueDate: null,
        enabled: true,
        createdAt: '',
        updatedAt: '',
      }),
    ).toBe('每 5 天');
  });
});

describe('规则动作校验', () => {
  it('没有动作时报错', () => {
    expect(validateRuleActions([])).toBe('规则至少需要一个动作');
  });

  it('日期偏移必须是 -365 到 365 的整数', () => {
    expect(
      validateRuleActions([{ kind: 'set_due_date_offset', offsetDays: 400 }]),
    ).toContain('日期偏移');
    expect(
      validateRuleActions([{ kind: 'set_due_date_offset', offsetDays: 1.5 }]),
    ).toContain('日期偏移');
    expect(validateRuleActions([{ kind: 'set_due_date_offset', offsetDays: 3 }])).toBeNull();
  });

  it('标签不能为空且长度受限', () => {
    expect(validateRuleActions([{ kind: 'add_labels', labels: [] }])).toContain('标签');
    expect(
      validateRuleActions([{ kind: 'add_labels', labels: ['这个标签太长了超过了十二个字'] }]),
    ).toContain('标签');
    expect(validateRuleActions([{ kind: 'add_labels', labels: ['研发'] }])).toBeNull();
  });

  it('子任务标题不能为空', () => {
    expect(validateRuleActions([{ kind: 'append_subtasks', subtasks: [' '] }])).toContain(
      '子任务',
    );
    expect(validateRuleActions([{ kind: 'append_subtasks', subtasks: ['第一步'] }])).toBeNull();
  });

  it('设置优先级必须选一个优先级', () => {
    expect(validateRuleActions([{ kind: 'set_priority' }])).toContain('优先级');
    expect(validateRuleActions([{ kind: 'set_priority', priority: 'high' }])).toBeNull();
  });

  it('清除日期动作不需要额外参数', () => {
    expect(validateRuleActions([{ kind: 'clear_due_date' }])).toBeNull();
  });
});

describe('规则动作计算', () => {
  it('设置日期偏移按今天计算', () => {
    const patch = applyRuleActions(card(), [{ kind: 'set_due_date_offset', offsetDays: 3 }], '2026-01-05');
    expect(patch.dueDate).toBe('2026-01-08');
  });

  it('清除日期写入 null', () => {
    const patch = applyRuleActions(card({ dueDate: '2026-01-05' }), [{ kind: 'clear_due_date' }], '2026-01-05');
    expect(patch.dueDate).toBeNull();
  });

  it('追加标签去重，不重复写入已有标签', () => {
    const patch = applyRuleActions(
      card({ labels: ['研发'] }),
      [{ kind: 'add_labels', labels: ['研发', '高风险'] }],
      '2026-01-05',
    );
    expect(patch.labels).toEqual(['研发', '高风险']);
  });

  it('没有真实变化时不返回该字段', () => {
    const patch = applyRuleActions(
      card({ labels: ['研发'] }),
      [{ kind: 'add_labels', labels: ['研发'] }],
      '2026-01-05',
    );
    expect(patch.labels).toBeUndefined();
  });

  it('追加子任务跳过同名项', () => {
    const patch = applyRuleActions(
      card({ subtasks: [{ id: 's_1', title: '第一步', done: false }] }),
      [{ kind: 'append_subtasks', subtasks: ['第一步', '第二步'] }],
      '2026-01-05',
    );
    expect(patch.subtasks?.map((item) => item.title)).toEqual(['第一步', '第二步']);
  });

  it('多个动作按顺序叠加', () => {
    const actions: RuleAction[] = [
      { kind: 'set_due_date_offset', offsetDays: 1 },
      { kind: 'set_priority', priority: 'high' },
    ];
    const patch = applyRuleActions(card(), actions, '2026-01-05');
    expect(patch.dueDate).toBe('2026-01-06');
    expect(patch.priority).toBe('high');
  });
});

describe('活动日志文案', () => {
  it('事件级动作直接用事件名', () => {
    expect(describeActivity({ eventType: 'created', field: '', oldValue: '', newValue: '' })).toBe(
      '创建了任务',
    );
    expect(
      describeActivity({ eventType: 'recurrence', field: '', oldValue: '', newValue: 'c_1' }),
    ).toBe('重复任务生成了下一次');
  });

  it('移动到列表时带列表名', () => {
    expect(
      describeActivity(
        { eventType: 'updated', field: 'listId', oldValue: 'l_1', newValue: 'l_2' },
        '进行中',
      ),
    ).toBe('移动到「进行中」');
  });

  it('完成状态与日期有专门文案', () => {
    expect(
      describeActivity({ eventType: 'updated', field: 'completed', oldValue: 'false', newValue: 'true' }),
    ).toBe('标记为已完成');
    expect(
      describeActivity({ eventType: 'updated', field: 'dueDate', oldValue: '', newValue: '2026-01-08' }),
    ).toBe('截止日期改为 2026-01-08');
    expect(
      describeActivity({ eventType: 'updated', field: 'dueDate', oldValue: '2026-01-08', newValue: '' }),
    ).toBe('清除了截止日期');
  });

  it('优先级用中文名展示', () => {
    expect(
      describeActivity({ eventType: 'updated', field: 'priority', oldValue: '', newValue: 'high' }),
    ).toBe('优先级改为「高」');
    expect(priorityLabel(null)).toBe('无');
    expect(priorityLabel('medium')).toBe('中');
  });
});
