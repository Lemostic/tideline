/**
 * 本地规则与提醒设置（V0.11）。
 *
 * 规则默认关闭、需要逐条启用；所有动作都在本机执行，不联网、不发脚本。
 * 提醒走系统通知，桌面端才会真正弹出；浏览器预览模式只保存设置。
 */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { isTauri } from '@/lib/api';
import { validateRuleActions } from '@/lib/automation';
import type {
  AutomationRule,
  List,
  NotificationSettings,
  Priority,
  RuleAction,
  RuleTrigger,
} from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';

const TRIGGER_LABEL: Record<RuleTrigger, string> = {
  move_to_list: '移动到指定列表时',
  complete: '任务完成时',
};

const PRIORITY_OPTIONS: Array<{ key: Priority; label: string }> = [
  { key: 'high', label: '高' },
  { key: 'medium', label: '中' },
  { key: 'low', label: '低' },
];

/** 规则卡片：展示触发条件、动作与失败提示，并提供启停与删除。 */
function RuleCard({
  rule,
  lists,
  onToggle,
  onDelete,
  onEdit,
}: {
  rule: AutomationRule;
  lists: List[];
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const listTitle = rule.listId
    ? (lists.find((list) => list.id === rule.listId)?.title ?? '未知列表')
    : null;
  const actions = rule.actions.map((action) => {
    switch (action.kind) {
      case 'set_due_date_offset':
        return `截止日期设为今天${(action.offsetDays ?? 0) >= 0 ? '+' : ''}${action.offsetDays ?? 0} 天`;
      case 'clear_due_date':
        return '清除截止日期';
      case 'set_priority':
        return `设为${PRIORITY_OPTIONS.find((item) => item.key === action.priority)?.label ?? '无'}优先级`;
      case 'add_labels':
        return `添加标签 ${(action.labels ?? []).join('、')}`;
      case 'append_subtasks':
        return `追加子任务 ${(action.subtasks ?? []).join('、')}`;
      default:
        return '未知动作';
    }
  });

  return (
    <div className={`auto-rule${rule.enabled ? ' is-on' : ''}`}>
      <div className="auto-rule-head">
        <div className="auto-rule-title">
          <span className="auto-rule-name">{rule.name}</span>
          <span className="auto-rule-trigger">
            {TRIGGER_LABEL[rule.trigger]}
            {rule.trigger === 'move_to_list' && listTitle ? `「${listTitle}」` : ''}
          </span>
        </div>
        <div className="auto-rule-actions">
          <button
            type="button"
            className={`btn btn-sm${rule.enabled ? ' btn-primary' : ' btn-quiet'}`}
            onClick={onToggle}
          >
            {rule.enabled ? '已启用' : '已停用'}
          </button>
          <button type="button" className="btn btn-sm btn-quiet" onClick={onEdit}>
            <Icon name="pencil" size={12} />
            编辑
          </button>
          <button type="button" className="btn btn-sm btn-quiet" onClick={onDelete}>
            <Icon name="trash" size={12} />
          </button>
        </div>
      </div>
      <ul className="auto-rule-actions-list">
        {actions.map((text, index) => (
          <li key={`${rule.id}-${index}`}>{text}</li>
        ))}
      </ul>
      {rule.lastError ? (
        <p className="auto-rule-error" role="status">
          <Icon name="info" size={12} />
          {rule.lastError}
        </p>
      ) : null}
    </div>
  );
}

export function AutomationSettings() {
  const snapshot = useSnapshot();
  const createAutomationRule = useAppStore((state) => state.createAutomationRule);
  const updateAutomationRule = useAppStore((state) => state.updateAutomationRule);
  const deleteAutomationRule = useAppStore((state) => state.deleteAutomationRule);
  const loadNotificationSettings = useAppStore((state) => state.loadNotificationSettings);
  const updateNotificationSettings = useAppStore(
    (state) => state.updateNotificationSettings,
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<RuleTrigger>('complete');
  const [listId, setListId] = useState('');
  const [offsetDays, setOffsetDays] = useState(0);
  const [setDueDate, setSetDueDate] = useState(false);
  const [priority, setPriority] = useState<Priority | null>(null);
  const [labels, setLabels] = useState('');
  const [subtasks, setSubtasks] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [notification, setNotification] = useState<NotificationSettings | null>(null);

  // 规则可以作用于任意看板的列表，这里给出全部列表并标注所属看板
  const lists = useMemo(() => snapshot.lists, [snapshot.lists]);
  const boardTitle = (boardId: string) =>
    snapshot.boards.find((board) => board.id === boardId)?.title ?? '未知看板';

  useEffect(() => {
    void loadNotificationSettings().then(setNotification).catch(() => setNotification(null));
  }, [loadNotificationSettings]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setTrigger('complete');
    setListId('');
    setOffsetDays(0);
    setSetDueDate(false);
    setPriority(null);
    setLabels('');
    setSubtasks('');
    setNote(null);
  };

  const startEdit = (rule: AutomationRule) => {
    setEditingId(rule.id);
    setName(rule.name);
    setTrigger(rule.trigger);
    setListId(rule.listId ?? '');
    const offsetAction = rule.actions.find((item) => item.kind === 'set_due_date_offset');
    setSetDueDate(Boolean(offsetAction));
    setOffsetDays(offsetAction?.offsetDays ?? 0);
    const priorityAction = rule.actions.find((item) => item.kind === 'set_priority');
    setPriority(priorityAction?.priority ?? null);
    const labelAction = rule.actions.find((item) => item.kind === 'add_labels');
    setLabels((labelAction?.labels ?? []).join('、'));
    const subtaskAction = rule.actions.find((item) => item.kind === 'append_subtasks');
    setSubtasks((subtaskAction?.subtasks ?? []).join('、'));
    setNote(null);
  };

  const collectActions = (): RuleAction[] => {
    const actions: RuleAction[] = [];
    if (setDueDate) actions.push({ kind: 'set_due_date_offset', offsetDays });
    if (priority) actions.push({ kind: 'set_priority', priority });
    const labelList = labels
      .split(/[、,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (labelList.length > 0) actions.push({ kind: 'add_labels', labels: labelList });
    const subtaskList = subtasks
      .split(/[、,，\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (subtaskList.length > 0) actions.push({ kind: 'append_subtasks', subtasks: subtaskList });
    return actions;
  };

  const submit = async () => {
    const actions = collectActions();
    const error = validateRuleActions(actions);
    if (error) {
      setNote(error);
      return;
    }
    if (trigger === 'move_to_list' && !listId) {
      setNote('移动触发需要选择一个目标列表');
      return;
    }
    setSaving(true);
    setNote(null);
    try {
      if (editingId) {
        await updateAutomationRule(editingId, {
          name: name.trim() || '未命名规则',
          trigger,
          listId: trigger === 'move_to_list' ? listId : null,
          actions,
        });
      } else {
        await createAutomationRule({
          name: name.trim() || '未命名规则',
          trigger,
          listId: trigger === 'move_to_list' ? listId : null,
          actions,
          // 新建规则保持关闭，用户确认后再启用
          enabled: false,
        });
      }
      resetForm();
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const patchNotification = (patch: Partial<NotificationSettings>) => {
    if (!notification) return;
    const next = { ...notification, ...patch };
    setNotification(next);
    void updateNotificationSettings(patch);
  };

  return (
    <>
      <section className="settings-card">
        <div className="settings-card-head">
          <span className="settings-card-icon">
            <Icon name="sparkles" size={17} />
          </span>
          <div>
            <h2 className="settings-card-title">本地规则</h2>
            <p className="settings-card-desc">
              规则只在本机执行，不联网、不运行脚本。默认全部关闭，启用后才会生效。
            </p>
          </div>
        </div>

        {snapshot.automationRules.length > 0 ? (
          <div className="auto-rule-list">
            {snapshot.automationRules.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                lists={lists}
                onToggle={() =>
                  void updateAutomationRule(rule.id, { enabled: !rule.enabled })
                }
                onDelete={() => void deleteAutomationRule(rule.id)}
                onEdit={() => startEdit(rule)}
              />
            ))}
          </div>
        ) : (
          <p className="auto-empty">还没有规则。新建一条规则，让任务在被移动或完成时自动补齐字段。</p>
        )}

        <div className="auto-form">
          <div className="auto-form-head">
            <strong>{editingId ? '编辑规则' : '新建规则'}</strong>
            {editingId ? (
              <button type="button" className="btn btn-sm btn-quiet" onClick={resetForm}>
                取消编辑
              </button>
            ) : null}
          </div>

          <label className="auto-field">
            <span>规则名称</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：移动到「已完成」时打上标签"
              maxLength={40}
            />
          </label>

          <label className="auto-field">
            <span>触发时机</span>
            <select
              className="select"
              value={trigger}
              onChange={(event) => setTrigger(event.target.value as RuleTrigger)}
            >
              {(Object.keys(TRIGGER_LABEL) as RuleTrigger[]).map((key) => (
                <option key={key} value={key}>
                  {TRIGGER_LABEL[key]}
                </option>
              ))}
            </select>
          </label>

          {trigger === 'move_to_list' ? (
            <label className="auto-field">
              <span>目标列表</span>
              <select className="select" value={listId} onChange={(event) => setListId(event.target.value)}>
                <option value="">选择列表…</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {boardTitle(list.boardId)} · {list.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="auto-field">
            <span>执行动作</span>
            <div className="auto-actions">
              <label className="auto-action">
                <input
                  type="checkbox"
                  checked={setDueDate}
                  onChange={(event) => setSetDueDate(event.target.checked)}
                />
                设置截止日期
                <input
                  className="input auto-offset"
                  type="number"
                  min={-365}
                  max={365}
                  value={offsetDays}
                  disabled={!setDueDate}
                  onChange={(event) => setOffsetDays(Number(event.target.value) || 0)}
                  aria-label="截止日期偏移天数"
                />
                天后
              </label>
              <label className="auto-action">
                <input
                  type="checkbox"
                  checked={priority !== null}
                  onChange={(event) => setPriority(event.target.checked ? 'medium' : null)}
                />
                设置优先级
                <select
                  className="select auto-priority"
                  value={priority ?? ''}
                  disabled={priority === null}
                  onChange={(event) =>
                    setPriority((event.target.value || null) as Priority | null)
                  }
                  aria-label="优先级"
                >
                  <option value="">无</option>
                  {PRIORITY_OPTIONS.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="auto-action">
                添加标签
                <input
                  className="input"
                  value={labels}
                  onChange={(event) => setLabels(event.target.value)}
                  placeholder="用「、」分隔"
                />
              </label>
              <label className="auto-action">
                追加子任务
                <input
                  className="input"
                  value={subtasks}
                  onChange={(event) => setSubtasks(event.target.value)}
                  placeholder="用「、」分隔"
                />
              </label>
            </div>
          </div>

          {note ? (
            <p className="auto-error" role="status">
              {note}
            </p>
          ) : null}

          <div className="auto-form-foot">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={saving}
              onClick={() => void submit()}
            >
              {editingId ? '保存修改' : '创建规则（默认关闭）'}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-card-head">
          <span className="settings-card-icon">
            <Icon name="bell" size={17} />
          </span>
          <div>
            <h2 className="settings-card-title">本地提醒</h2>
            <p className="settings-card-desc">
              {isTauri()
                ? '到点后用系统通知提醒，全部默认关闭，不打扰。'
                : '浏览器预览模式不会弹出系统通知，这里的设置只保存在本机。'}
            </p>
          </div>
        </div>

        {notification ? (
          <div className="auto-notify">
            <label className="auto-notify-row">
              <input
                type="checkbox"
                checked={notification.dueEnabled}
                onChange={(event) => patchNotification({ dueEnabled: event.target.checked })}
              />
              <span>
                到期提醒
                <span className="auto-hint">任务在提醒日前到期时通知一次</span>
              </span>
            </label>
            <label className="auto-notify-row">
              <input
                type="checkbox"
                checked={notification.overdueEnabled}
                onChange={(event) => patchNotification({ overdueEnabled: event.target.checked })}
              />
              <span>
                逾期提醒
                <span className="auto-hint">任务过了截止日期还没完成时通知一次</span>
              </span>
            </label>
            <label className="auto-notify-row">
              <input
                type="checkbox"
                checked={notification.dailySummaryEnabled}
                onChange={(event) =>
                  patchNotification({ dailySummaryEnabled: event.target.checked })
                }
              />
              <span>
                每日摘要
                <span className="auto-hint">每天固定时间汇总今天要做的事</span>
              </span>
            </label>

            <label className="auto-notify-row">
              <span>
                摘要时间
                <span className="auto-hint">到点后弹出一条当天任务汇总</span>
              </span>
              <input
                className="input auto-time"
                type="time"
                value={notification.dailySummaryTime}
                disabled={!notification.dailySummaryEnabled}
                onChange={(event) => patchNotification({ dailySummaryTime: event.target.value })}
                aria-label="每日摘要时间"
              />
            </label>

            <label className="auto-notify-row">
              <span>
                提前天数
                <span className="auto-hint">提前几天开始提醒即将到期</span>
              </span>
              <input
                className="input auto-lead"
                type="number"
                min={0}
                max={30}
                value={notification.leadDays}
                disabled={!notification.dueEnabled}
                onChange={(event) =>
                  patchNotification({ leadDays: Math.min(30, Math.max(0, Number(event.target.value) || 0)) })
                }
                aria-label="提前天数"
              />
            </label>
          </div>
        ) : (
          <p className="auto-empty">读取提醒设置失败。</p>
        )}
      </section>
    </>
  );
}
