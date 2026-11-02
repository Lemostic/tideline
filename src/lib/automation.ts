/**
 * 自动化（V0.11）的纯逻辑：重复日期推算、规则动作计算与校验。
 *
 * 这里不碰数据库与界面，只做可测试的日期与字段计算；
 * Rust 侧 `src-tauri/src/automation.rs` 保持同一套语义。
 */
import { addDaysKey, parseDateKey, toDateKey } from './date';
import type {
  Card,
  Priority,
  Recurrence,
  RecurrenceFrequency,
  RuleAction,
} from './types';

/** 重复频率的中文文案 */
export const RECURRENCE_FREQUENCY_LABEL: Record<RecurrenceFrequency, string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  interval: '自定义间隔',
};

/** 星期几的短文案，索引与 `Date.getDay()` 一致（0=周日） */
export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 取某月的天数（month 为 1–12） */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** 把 `YYYY-MM-DD` 解析成 { year, month, day }；非法输入返回 null */
function parseParts(dateKey: string): { year: number; month: number; day: number } | null {
  const date = parseDateKey(dateKey);
  if (!date) return null;
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/**
 * 计算下一次到期日期。
 *
 * - daily：基准日 + 1 天
 * - weekly：基准日之后最近的指定星期
 * - monthly：基准月的下一个月同一天；当月没有该日时收敛到当月最后一天
 * - interval：基准日 + 间隔天数
 *
 * 基准日非法或频率非法时返回 null。
 */
export function nextRecurrenceDate(
  frequency: RecurrenceFrequency,
  baseDate: string,
  options: { intervalDays?: number; weekdays?: number[] } = {},
): string | null {
  const base = parseParts(baseDate);
  if (!base) return null;

  if (frequency === 'daily') {
    return addDaysKey(baseDate, 1);
  }

  if (frequency === 'interval') {
    const days = Math.floor(options.intervalDays ?? 1);
    if (!Number.isFinite(days) || days < 1) return null;
    return addDaysKey(baseDate, days);
  }

  if (frequency === 'weekly') {
    const weekdays = (options.weekdays ?? []).filter((day) => day >= 0 && day <= 6);
    if (weekdays.length === 0) return null;
    const baseDateObj = parseDateKey(baseDate);
    if (!baseDateObj) return null;
    // 从基准日次日开始往后找 7 天，命中指定星期即止
    for (let offset = 1; offset <= 7; offset += 1) {
      const candidate = parseDateKey(addDaysKey(baseDate, offset));
      if (candidate && weekdays.includes(candidate.getDay())) {
        return toDateKey(candidate);
      }
    }
    return null;
  }

  // monthly：下个月的同一天，月末收敛
  const targetDay = base.day;
  let year = base.year;
  let month = base.month + 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  const maxDay = daysInMonth(year, month);
  const day = Math.min(targetDay, maxDay);
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

/** 根据重复配置计算下一次到期日期 */
export function nextRecurrenceDateFor(
  recurrence: Pick<Recurrence, 'frequency' | 'intervalValue' | 'weekdays'>,
  baseDate: string,
): string | null {
  return nextRecurrenceDate(recurrence.frequency, baseDate, {
    intervalDays: recurrence.intervalValue,
    weekdays: recurrence.weekdays,
  });
}

/** 重复配置的文案摘要，例如「每周一、三」 */
export function describeRecurrence(recurrence: Recurrence): string {
  if (recurrence.frequency === 'weekly') {
    const days = [...recurrence.weekdays].sort((a, b) => a - b);
    if (days.length === 0) return '每周';
    return `每周${days.map((day) => WEEKDAY_LABELS[day]).join('、')}`;
  }
  if (recurrence.frequency === 'interval') {
    return `每 ${recurrence.intervalValue} 天`;
  }
  if (recurrence.frequency === 'monthly') return '每月';
  return '每天';
}

/** 规则动作的校验：返回可读错误；合法时返回 null */
export function validateRuleActions(actions: RuleAction[]): string | null {
  if (actions.length === 0) return '规则至少需要一个动作';
  for (const action of actions) {
    switch (action.kind) {
      case 'set_due_date_offset': {
        const offset = action.offsetDays ?? 0;
        if (!Number.isInteger(offset) || offset < -365 || offset > 365) {
          return '日期偏移必须是 -365 到 365 之间的整数天';
        }
        break;
      }
      case 'clear_due_date':
        break;
      case 'set_priority': {
        if (!action.priority) return '设置优先级动作需要选择一个优先级';
        break;
      }
      case 'add_labels': {
        const labels = action.labels ?? [];
        if (labels.length === 0) return '添加标签动作至少需要一个标签';
        if (labels.some((label) => label.trim() === '' || label.length > 12)) {
          return '标签不能为空，且单个标签最多 12 个字';
        }
        break;
      }
      case 'append_subtasks': {
        const subtasks = action.subtasks ?? [];
        if (subtasks.length === 0) return '追加子任务动作至少需要一个子任务';
        if (subtasks.some((title) => title.trim() === '' || title.length > 60)) {
          return '子任务标题不能为空，且单个子任务最多 60 个字';
        }
        break;
      }
      default:
        return '存在不支持的规则动作';
    }
  }
  return null;
}

/**
 * 计算规则动作对任务产生的字段变更。
 *
 * 只返回真正发生变化的字段：标签按「追加且去重」处理；
 * 追加子任务改为返回待创建的子任务标题（V0.14.0 起子任务是真实卡片）。
 */
export function applyRuleActions(
  card: Card,
  actions: RuleAction[],
  today: string,
): {
  patch: Partial<Pick<Card, 'dueDate' | 'priority' | 'labels'>>;
  subtaskTitles: string[];
} {
  const patch: Partial<Pick<Card, 'dueDate' | 'priority' | 'labels'>> = {};

  let labels = [...card.labels];
  const subtaskTitles: string[] = [];

  for (const action of actions) {
    switch (action.kind) {
      case 'set_due_date_offset': {
        const offset = action.offsetDays ?? 0;
        patch.dueDate = addDaysKey(today, offset);
        break;
      }
      case 'clear_due_date': {
        patch.dueDate = null;
        break;
      }
      case 'set_priority': {
        if (action.priority) patch.priority = action.priority;
        break;
      }
      case 'add_labels': {
        for (const label of action.labels ?? []) {
          const value = label.trim();
          if (value && !labels.includes(value)) labels.push(value);
        }
        break;
      }
      case 'append_subtasks': {
        for (const title of action.subtasks ?? []) {
          const value = title.trim();
          if (value && !subtaskTitles.includes(value)) subtaskTitles.push(value);
        }
        break;
      }
      default:
        break;
    }
  }

  if (labels.length !== card.labels.length) patch.labels = labels;
  return { patch, subtaskTitles };
}

/** 活动日志字段的中文名 */
const ACTIVITY_FIELD_LABEL: Record<string, string> = {
  title: '标题',
  description: '描述',
  listId: '所属列表',
  completed: '完成状态',
  dueDate: '截止日期',
  startDate: '开始日期',
  priority: '优先级',
  accent: '卡片颜色',
  labels: '标签',
  subtasks: '子任务',
};

/** 活动日志的事件级文案 */
const ACTIVITY_EVENT_LABEL: Record<string, string> = {
  created: '创建了任务',
  moved: '移动了任务',
  completed: '标记完成',
  uncompleted: '取消了完成',
  deleted: '移入回收站',
  restored: '从回收站恢复',
  recurrence: '重复任务生成了下一次',
};

/** 优先级中文名 */
export function priorityLabel(priority: Priority | null | undefined): string {
  if (priority === 'high') return '高';
  if (priority === 'medium') return '中';
  if (priority === 'low') return '低';
  return '无';
}

/** 生成活动日志的中文描述 */
export function describeActivity(
  activity: { eventType: string; field: string; oldValue: string; newValue: string },
  listTitle?: string,
): string {
  const eventLabel = ACTIVITY_EVENT_LABEL[activity.eventType];
  if (eventLabel && !activity.field) return eventLabel;

  const fieldLabel = ACTIVITY_FIELD_LABEL[activity.field] ?? activity.field;
  switch (activity.field) {
    case 'completed':
      return activity.newValue === 'true' ? '标记为已完成' : '取消了完成状态';
    case 'listId':
      return listTitle
        ? `移动到「${listTitle}」`
        : `移动了所属列表（${activity.newValue || '未知'}）`;
    case 'priority':
      return `优先级改为「${priorityLabel(
        activity.newValue === 'high'
          ? 'high'
          : activity.newValue === 'medium'
            ? 'medium'
            : activity.newValue === 'low'
              ? 'low'
              : null,
      )}」`;
    case 'labels':
      return `更新了标签（${activity.newValue || '无'}）`;
    case 'subtasks':
      return `更新了子任务（${activity.newValue || '无'}）`;
    case 'dueDate':
      return activity.newValue ? `截止日期改为 ${activity.newValue}` : '清除了截止日期';
    case 'startDate':
      return activity.newValue ? `开始日期改为 ${activity.newValue}` : '清除了开始日期';
    default:
      return `修改了${fieldLabel}`;
  }
}
