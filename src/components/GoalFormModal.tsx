import { useEffect, useMemo, useState } from 'react';
import { DatePicker } from '@/components/DatePicker';
import { Modal } from '@/components/Modal';
import { descendantGoalIds } from '@/lib/goals';
import type { Goal, GoalScope, GoalStatus } from '@/lib/types';

const SCOPE_OPTIONS: Array<{ key: GoalScope; label: string }> = [
  { key: 'company', label: '公司' },
  { key: 'team', label: '团队' },
  { key: 'personal', label: '个人' },
];

const STATUS_OPTIONS: Array<{ key: GoalStatus; label: string }> = [
  { key: 'active', label: '进行中' },
  { key: 'completed', label: '已达成' },
  { key: 'archived', label: '已归档' },
];

interface GoalFormModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  initial?: Goal | null;
  /** 新建子目标时预填的父目标 */
  parentId?: string | null;
  goals: Goal[];
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    description: string;
    scope: GoalScope;
    status: GoalStatus;
    startDate: string | null;
    dueDate: string | null;
    manualProgress: number;
    parentId: string | null;
  }) => Promise<void>;
}

interface ParentOption {
  goal: Goal;
  depth: number;
  disabled: boolean;
}

/** 新建 / 编辑目标：层级、周期、状态与手动进度。 */
export function GoalFormModal({
  open,
  mode,
  initial,
  parentId,
  goals,
  onClose,
  onSubmit,
}: GoalFormModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<GoalScope>('team');
  const [status, setStatus] = useState<GoalStatus>('active');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [manualProgress, setManualProgress] = useState(0);
  const [parent, setParent] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? '');
    setDescription(initial?.description ?? '');
    setScope(initial?.scope ?? 'team');
    setStatus(initial?.status ?? 'active');
    setStartDate(initial?.startDate ?? '');
    setDueDate(initial?.dueDate ?? '');
    setManualProgress(initial?.manualProgress ?? 0);
    setParent(initial?.parentId ?? parentId ?? '');
    setError(null);
    setBusy(false);
  }, [open, initial, parentId]);

  const parentOptions = useMemo<ParentOption[]>(() => {
    const invalidIds = initial ? descendantGoalIds(initial.id, goals) : new Set<string>();
    if (initial) invalidIds.add(initial.id);
    const options: ParentOption[] = [];

    const walk = (parentIdValue: string | null, depth: number) => {
      goals
        .filter((goal) => goal.parentId === parentIdValue)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .forEach((goal) => {
          options.push({ goal, depth, disabled: invalidIds.has(goal.id) });
          walk(goal.id, depth + 1);
        });
    };
    // 包含父目标已被删除的孤儿目标，避免它们在选择器里消失。
    const roots = goals.filter(
      (goal) => goal.parentId === null || !goals.some((item) => item.id === goal.parentId),
    );
    roots
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .forEach((goal) => {
        options.push({ goal, depth: 0, disabled: invalidIds.has(goal.id) });
        walk(goal.id, 1);
      });
    return options;
  }, [goals, initial]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim(),
        scope,
        status,
        startDate: startDate || null,
        dueDate: dueDate || null,
        manualProgress,
        parentId: parent || null,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === 'create' ? (parent ? '新建子目标' : '新建目标') : '编辑目标'}
      subtitle="目标可以关联任务，进度会按任务完成度自动回写"
      onClose={() => (busy ? undefined : onClose())}
      width="wide"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? '保存中…' : '保存目标'}
          </button>
        </>
      }
    >
      <div className="goal-form">
        <label className="goal-form-field">
          <span>目标名称</span>
          <input
            className="input"
            value={title}
            autoFocus
            maxLength={80}
            placeholder="比如：Q4 完成产品 1.0 发布"
            onChange={(event) => setTitle(event.target.value)}
            aria-label="目标名称"
          />
        </label>

        <label className="goal-form-field">
          <span>描述</span>
          <textarea
            className="input goal-form-textarea"
            value={description}
            maxLength={240}
            placeholder="目标背景、成功标准或关键结果"
            onChange={(event) => setDescription(event.target.value)}
            aria-label="目标描述"
          />
        </label>

        <div className="goal-form-grid">
          <label className="goal-form-field">
            <span>层级</span>
            <select
              className="select"
              value={scope}
              onChange={(event) => setScope(event.target.value as GoalScope)}
              aria-label="目标层级"
            >
              {SCOPE_OPTIONS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="goal-form-field">
            <span>状态</span>
            <select
              className="select"
              value={status}
              onChange={(event) => setStatus(event.target.value as GoalStatus)}
              aria-label="目标状态"
            >
              {STATUS_OPTIONS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="goal-form-field">
            <span>开始日期</span>
            <DatePicker
              value={startDate}
              onChange={setStartDate}
              ariaLabel="目标开始日期"
            />
          </label>
          <label className="goal-form-field">
            <span>截止日期</span>
            <DatePicker
              value={dueDate}
              onChange={setDueDate}
              ariaLabel="目标截止日期"
            />
          </label>
        </div>

        <label className="goal-form-field">
          <span>父目标（可选）</span>
          <select
            className="select"
            value={parent}
            onChange={(event) => setParent(event.target.value)}
            aria-label="父目标"
          >
            <option value="">无（顶层目标）</option>
            {parentOptions.map(({ goal, depth, disabled }) => (
              <option key={goal.id} value={goal.id} disabled={disabled}>
                {`${'　'.repeat(depth)}${depth > 0 ? '└ ' : ''}${goal.title}`}
              </option>
            ))}
          </select>
        </label>

        <div className="goal-form-field">
          <span>
            手动进度：{manualProgress}%
            <em className="goal-form-hint">
              有子目标或关联任务时，进度会自动计算并覆盖手动值
            </em>
          </span>
          <div className="goal-form-progress">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={manualProgress}
              onChange={(event) => setManualProgress(Number(event.target.value))}
              aria-label="手动进度"
            />
            <span className="goal-form-progress-value">{manualProgress}%</span>
          </div>
        </div>

        {error ? <p className="goal-form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}

/** 目标状态徽标 */
export function goalStatusLabel(status: GoalStatus): string {
  return STATUS_OPTIONS.find((item) => item.key === status)?.label ?? '进行中';
}

export function goalScopeLabel(scope: GoalScope): string {
  return SCOPE_OPTIONS.find((item) => item.key === scope)?.label ?? '团队';
}
