import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DatePicker } from '@/components/DatePicker';
import { Icon } from '@/components/Icon';
import { formatDateCN, formatRelativeTime, todayKey } from '@/lib/date';
import { blockersFor, dependencyCandidates } from '@/lib/dependencies';
import { createId } from '@/lib/ids';
import { isBlankMarkdown, renderMarkdown } from '@/lib/markdown';
import {
  BOARD_COLORS,
  boardColorValue,
  PRIORITY_META,
  type Card,
  type CardPatch,
  type Priority,
} from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import '../styles/task-drawer.css';

const MAX_LABELS = 10;
const MAX_LABEL_LENGTH = 12;

type DescriptionMode = 'edit' | 'preview';

/**
 * 任务详情弹窗：看板视图 / 我的任务 / 搜索栏共用，居中显示并保持 4:3 比例。
 * 字段改动采用「失焦或按钮点击时保存」，不做输入级防抖，保证本地写入干脆可靠。
 * 子任务、标签、开始日期是 V0.2 新增字段，全部即时写回本地快照。
 */
export function TaskDrawer() {
  const navigate = useNavigate();
  const editingCardId = useUiStore((state) => state.editingCardId);
  const closeCard = useUiStore((state) => state.closeCard);
  const snapshot = useSnapshot();
  const updateCard = useAppStore((state) => state.updateCard);
  const deleteCard = useAppStore((state) => state.deleteCard);
  const setDependencies = useAppStore((state) => state.setDependencies);

  const card = useMemo(
    () => snapshot.cards.find((item) => item.id === editingCardId),
    [snapshot.cards, editingCardId],
  );
  const board = useMemo(
    () => snapshot.boards.find((item) => item.id === card?.boardId),
    [snapshot.boards, card?.boardId],
  );
  const lists = useMemo(
    () => snapshot.lists.filter((item) => item.boardId === card?.boardId),
    [snapshot.lists, card?.boardId],
  );
  const linkedGoals = useMemo(
    () => (card ? snapshot.goals.filter((goal) => goal.cardIds.includes(card.id)) : []),
    [snapshot.goals, card],
  );

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [descriptionMode, setDescriptionMode] = useState<DescriptionMode>('edit');
  const [subtaskDraft, setSubtaskDraft] = useState('');
  const [labelDraft, setLabelDraft] = useState('');
  const [rangeNote, setRangeNote] = useState<string | null>(null);
  const [labelNote, setLabelNote] = useState<string | null>(null);
  const [dependencyPick, setDependencyPick] = useState('');
  const subtaskInputRef = useRef<HTMLInputElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

  /** 当前看板里其它任务用过的标签，供快速点选 */
  const labelSuggestions = useMemo(() => {
    if (!card) return [];
    const seen = new Set<string>();
    for (const entry of snapshot.cards) {
      if (entry.boardId !== card.boardId) continue;
      for (const label of entry.labels) {
        if (!card.labels.includes(label)) seen.add(label);
      }
    }
    return [...seen].slice(0, 6);
  }, [snapshot.cards, card]);

  useEffect(() => {
    setTitle(card?.title ?? '');
    setDescription(card?.description ?? '');
    setDescriptionMode('edit');
    setSubtaskDraft('');
    setLabelDraft('');
    setRangeNote(null);
    setLabelNote(null);
    setDependencyPick('');
    // 只在切换到另一张卡片时重置本地草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id]);

  useEffect(() => {
    if (!editingCardId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeCard();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [editingCardId, closeCard]);

  // 日期联动、标签校验的轻提示会自己消失，不打断编辑
  useEffect(() => {
    if (!rangeNote) return;
    const timer = window.setTimeout(() => setRangeNote(null), 5200);
    return () => window.clearTimeout(timer);
  }, [rangeNote]);

  useEffect(() => {
    if (!labelNote) return;
    const timer = window.setTimeout(() => setLabelNote(null), 3600);
    return () => window.clearTimeout(timer);
  }, [labelNote]);

  if (!card) return null;

  const today = todayKey();
  const overdue = card.dueDate !== null && !card.completed && card.dueDate < today;
  const invalidRange =
    card.startDate !== null && card.dueDate !== null && card.startDate > card.dueDate;

  const status = card.completed
    ? { key: 'done', label: '已完成' }
    : card.startDate !== null && card.startDate <= today
      ? { key: 'doing', label: '进行中' }
      : { key: 'todo', label: '待开始' };

  const subtaskTotal = card.subtasks.length;
  const subtaskDone = card.subtasks.filter((item) => item.done).length;
  const subtaskPercent =
    subtaskTotal === 0 ? 0 : Math.round((subtaskDone / subtaskTotal) * 100);
  const allSubtasksDone = subtaskTotal > 0 && subtaskDone === subtaskTotal;
  const labelLimitReached = card.labels.length >= MAX_LABELS;
  const blockers = blockersFor(card.id, snapshot.dependencies, snapshot.cards);
  const unfinishedBlockers = blockers.filter((blocker) => !blocker.completed);
  const dependencyOptions = dependencyCandidates(
    card,
    snapshot.cards.filter((item) => item.boardId === card.boardId),
    snapshot.dependencies,
  );
  const addBlocker = (blockerId: string) => {
    if (!blockerId) return;
    void setDependencies(card.id, [...blockers.map((blocker) => blocker.id), blockerId]);
    setDependencyPick('');
  };
  const removeBlocker = (blockerId: string) => {
    void setDependencies(
      card.id,
      blockers.filter((blocker) => blocker.id !== blockerId).map((blocker) => blocker.id),
    );
  };

  /** 所有写操作都从最新快照取当前卡片，连续快速点击也不会互相覆盖 */
  const patchCard = (mutate: (current: Card) => CardPatch) => {
    const current = useAppStore.getState().snapshot.cards.find((item) => item.id === card.id);
    if (!current) return;
    void updateCard(current.id, mutate(current));
  };

  const commitTitle = () => {
    const next = title.trim();
    if (!next) {
      setTitle(card.title);
      return;
    }
    if (next !== card.title) void updateCard(card.id, { title: next });
  };

  const commitDescription = () => {
    if (description !== card.description) void updateCard(card.id, { description });
  };

  const setPriority = (priority: Priority | null) => {
    void updateCard(card.id, { priority });
  };

  const changeStartDate = (value: string) => {
    const next = value || null;
    if (next && card.dueDate && next > card.dueDate) {
      void updateCard(card.id, { startDate: next, dueDate: next });
      setRangeNote(`开始日期晚于截止日期，已把截止日期顺延到 ${formatDateCN(next)}`);
      return;
    }
    void updateCard(card.id, { startDate: next });
  };

  const changeDueDate = (value: string) => {
    const next = value || null;
    if (next && card.startDate && next < card.startDate) {
      void updateCard(card.id, { dueDate: next, startDate: next });
      setRangeNote(`截止日期早于开始日期，已把开始日期前移到 ${formatDateCN(next)}`);
      return;
    }
    void updateCard(card.id, { dueDate: next });
  };

  const toggleSubtask = (subtaskId: string) => {
    patchCard((current) => ({
      subtasks: current.subtasks.map((item) =>
        item.id === subtaskId ? { ...item, done: !item.done } : item,
      ),
    }));
  };

  const removeSubtask = (subtaskId: string) => {
    patchCard((current) => ({
      subtasks: current.subtasks.filter((item) => item.id !== subtaskId),
    }));
  };

  const submitSubtask = () => {
    const value = subtaskDraft.trim();
    if (!value) return;
    patchCard((current) => ({
      subtasks: [...current.subtasks, { id: createId('s'), title: value, done: false }],
    }));
    setSubtaskDraft('');
    subtaskInputRef.current?.focus();
  };

  const submitLabel = (raw?: string) => {
    const value = (raw ?? labelDraft).trim();
    if (!value) return;
    const current = useAppStore.getState().snapshot.cards.find((item) => item.id === card.id);
    if (!current) return;
    if ([...value].length > MAX_LABEL_LENGTH) {
      setLabelNote(`单个标签最多 ${MAX_LABEL_LENGTH} 个字`);
      return;
    }
    if (current.labels.includes(value)) {
      setLabelNote('这个标签已经加过了');
      return;
    }
    if (current.labels.length >= MAX_LABELS) {
      setLabelNote(`最多添加 ${MAX_LABELS} 个标签`);
      return;
    }
    void updateCard(current.id, { labels: [...current.labels, value] });
    setLabelDraft('');
    setLabelNote(null);
    labelInputRef.current?.focus();
  };

  const removeLabel = (label: string) => {
    patchCard((current) => ({ labels: current.labels.filter((item) => item !== label) }));
  };

  const openPreview = () => {
    commitDescription();
    setDescriptionMode('preview');
  };

  const handleDelete = () => {
    if (
      !window.confirm(
        `将「${card.title}」移入回收站？\n之后可以在「回收站」里恢复到原看板，确认不再需要时再彻底删除。`,
      )
    ) {
      return;
    }
    void deleteCard(card.id);
    closeCard();
  };

  return (
    <div
      className="task-modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeCard();
      }}
    >
      <aside
        className="drawer drawer-modal"
        role="dialog"
        aria-modal="true"
        aria-label="任务详情"
      >
        <div className="drawer-head">
          <div className="drawer-head-title">
            <span
              className="dot"
              style={{ background: board ? boardColorValue(board.color) : 'var(--line-strong)' }}
            />
            任务详情
          </div>
          <button className="btn btn-icon" onClick={closeCard} aria-label="关闭详情">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="drawer-body">
          <div>
            <div className="drawer-board-crumb">
              <Icon name="layout-grid" size={13} />
              <span>{board?.title ?? '未知看板'}</span>
              <Icon name="chevron-right" size={12} />
              <span>{lists.find((list) => list.id === card.listId)?.title ?? '未知列表'}</span>
            </div>
            <textarea
              className="drawer-title-input"
              rows={2}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  // 中文输入法选词时的回车不当作提交
                  if (event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              placeholder="任务标题"
            />
            <div className="drawer-title-meta">
              <button
                className={`task-toggle${card.completed ? ' on' : ''}`}
                onClick={() => void updateCard(card.id, { completed: !card.completed })}
              >
                <Icon name={card.completed ? 'check-circle' : 'check'} size={13} />
                {card.completed ? '已完成' : '标记完成'}
              </button>
              {overdue ? (
                <span className="chip chip-danger">
                  <Icon name="clock" size={11} />
                  已逾期
                </span>
              ) : null}
              {!card.completed && unfinishedBlockers.length > 0 ? (
                <span className="chip chip-danger" title="前置任务全部完成后才能顺利推进">
                  <Icon name="link" size={11} />
                  被 {unfinishedBlockers.length} 个前置任务阻塞
                </span>
              ) : null}
              <span className="td-created-meta">
                <Icon name="clock" size={11} />
                创建 {formatRelativeTime(card.createdAt)} · 更新 {formatRelativeTime(card.updatedAt)}
              </span>
            </div>
            {linkedGoals.length > 0 ? (
              <div className="drawer-goals">
                <span className="drawer-goals-label">
                  <Icon name="target" size={12} />
                  关联目标
                </span>
                {linkedGoals.map((goal) => (
                  <button
                    key={goal.id}
                    type="button"
                    className="drawer-goal-chip"
                    title={goal.title}
                    onClick={() => {
                      closeCard();
                      navigate(`/goals/${goal.id}`);
                    }}
                  >
                    {goal.title}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="meta-grid">
            <div className="meta-row">
              <div className="meta-label">
                <Icon name="users" size={14} />
                所属列表
              </div>
              <div className="meta-value">
                <select
                  className="select"
                  value={card.listId}
                  onChange={(event) => void updateCard(card.id, { listId: event.target.value })}
                  aria-label="移动到列表"
                >
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="meta-row">
              <div className="meta-label">
                <Icon name="check-circle" size={14} />
                状态
              </div>
              <div className="meta-value">
                <span
                  className={`td-status ${status.key}`}
                  title="由完成状态与开始日期自动推导"
                >
                  <span className="td-status-dot" />
                  {status.label}
                </span>
              </div>
            </div>

            <div className="meta-row">
              <div className="meta-label">
                <Icon name="gantt" size={14} />
                开始日期
              </div>
              <div className="meta-value">
                <DatePicker
                  value={card.startDate ?? ''}
                  onChange={changeStartDate}
                  ariaLabel="开始日期"
                  placeholder="选择开始日期"
                />
                {card.startDate ? (
                  <button
                    className="btn btn-icon"
                    onClick={() => changeStartDate('')}
                    aria-label="清除开始日期"
                  >
                    <Icon name="x" size={13} />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="meta-row">
              <div className="meta-label">
                <Icon name="calendar" size={14} />
                截止日期
              </div>
              <div className="meta-value">
                <DatePicker
                  value={card.dueDate ?? ''}
                  onChange={changeDueDate}
                  ariaLabel="截止日期"
                  placeholder="选择截止日期"
                />
                {card.dueDate ? (
                  <button
                    className="btn btn-icon"
                    onClick={() => changeDueDate('')}
                    aria-label="清除截止日期"
                  >
                    <Icon name="x" size={13} />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="meta-row">
              <div className="meta-label">
                <Icon name="flag" size={14} />
                优先级
              </div>
              <div className="meta-value">
                <div className="priority-group">
                  {PRIORITY_META.map((meta) => (
                    <button
                      key={meta.key}
                      className={`priority-btn${card.priority === meta.key ? ' active' : ''}`}
                      onClick={() => setPriority(card.priority === meta.key ? null : meta.key)}
                    >
                      <span className="dot" style={{ background: meta.color }} />
                      {meta.label}
                    </button>
                  ))}
                  <button
                    className={`priority-btn${card.priority === null ? ' active' : ''}`}
                    onClick={() => setPriority(null)}
                  >
                    无
                  </button>
                </div>
              </div>
            </div>

            <div className="meta-row">
              <div className="meta-label">
                <Icon name="flag" size={14} />
                卡片颜色
              </div>
              <div className="meta-value">
                <div className="card-accent-group">
                  <button
                    type="button"
                    className={`card-accent-none${!card.accent ? ' active' : ''}`}
                    onClick={() => void updateCard(card.id, { accent: null })}
                    title="默认样式"
                  >
                    默认
                  </button>
                  {BOARD_COLORS.map((color) => (
                    <button
                      key={color.key}
                      type="button"
                      className={`card-accent-swatch${card.accent === color.key ? ' active' : ''}`}
                      style={{ background: color.value }}
                      title={color.label}
                      aria-label={`卡片颜色：${color.label}`}
                      aria-pressed={card.accent === color.key}
                      onClick={() => void updateCard(card.id, { accent: color.key })}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          {rangeNote || invalidRange ? (
            <div className={`td-note${invalidRange ? ' warn' : ''}`} role="status">
              <Icon name="info" size={13} />
              <span>
                {invalidRange
                  ? '开始日期晚于截止日期，甘特条会显示异常，请调整其中一项'
                  : rangeNote}
              </span>
            </div>
          ) : null}

          <div className="td-section">
            <div className="td-section-head">
              <div className="drawer-section-title">
                <Icon name="link" size={13} />
                前置任务
              </div>
              {blockers.length > 0 ? (
                <span className="td-progress-value">
                  {blockers.length - unfinishedBlockers.length} / {blockers.length} 已完成
                </span>
              ) : null}
            </div>

            {blockers.length > 0 ? (
              <ul className="td-dependencies">
                {blockers.map((blocker) => (
                  <li className={`td-dependency${blocker.completed ? ' is-done' : ''}`} key={blocker.id}>
                    <Icon
                      name={blocker.completed ? 'check-circle' : 'clock'}
                      size={13}
                      className="td-dependency-icon"
                    />
                    <span className="td-dependency-title" title={blocker.title}>
                      {blocker.title}
                    </span>
                    {blocker.completed ? <span className="td-dependency-state">已完成</span> : null}
                    <button
                      type="button"
                      className="td-dependency-remove"
                      aria-label={`移除前置任务：${blocker.title}`}
                      title="移除前置任务"
                      onClick={() => removeBlocker(blocker.id)}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="td-dependency-empty">暂无前置任务，添加后会在卡片上显示阻塞提示。</p>
            )}

            {unfinishedBlockers.length > 0 ? (
              <p className="td-dependency-warn">
                <Icon name="info" size={12} />
                还有 {unfinishedBlockers.length} 个前置任务未完成
              </p>
            ) : null}

            {dependencyOptions.length > 0 ? (
              <label className="td-dependency-add">
                <Icon name="plus" size={12} />
                <select
                  value={dependencyPick}
                  aria-label="添加前置任务"
                  onChange={(event) => addBlocker(event.target.value)}
                >
                  <option value="">添加前置任务…</option>
                  {dependencyOptions.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="td-dependency-empty">当前看板没有可作为前置的任务。</p>
            )}
          </div>

          <div className="td-section">
            <div className="td-section-head">
              <div className="drawer-section-title">
                <Icon name="list" size={13} />
                子任务
              </div>
              {subtaskTotal > 0 ? (
                <span className={`td-progress-value${allSubtasksDone ? ' is-full' : ''}`}>
                  {`${subtaskDone} / ${subtaskTotal} · ${subtaskPercent}%`}
                </span>
              ) : null}
            </div>

            {subtaskTotal > 0 ? (
              <div
                className="td-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={subtaskTotal}
                aria-valuenow={subtaskDone}
                aria-label="子任务完成进度"
              >
                <div
                  className={`td-progress-fill${allSubtasksDone ? ' is-full' : ''}`}
                  style={{ width: `${subtaskPercent}%` }}
                />
              </div>
            ) : null}

            {subtaskTotal > 0 ? (
              <ul className="td-subtasks">
                {card.subtasks.map((item) => (
                  <li className="td-subtask" key={item.id}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={item.done}
                      aria-label={item.done ? `取消完成：${item.title}` : `完成：${item.title}`}
                      className={`td-check${item.done ? ' on' : ''}`}
                      onClick={() => toggleSubtask(item.id)}
                    >
                      {item.done ? <Icon name="check" size={11} strokeWidth={2.6} /> : null}
                    </button>
                    <span className={`td-subtask-title${item.done ? ' done' : ''}`}>
                      {item.title}
                    </span>
                    <button
                      type="button"
                      className="td-icon-btn td-subtask-del"
                      onClick={() => removeSubtask(item.id)}
                      aria-label={`删除子任务：${item.title}`}
                      title="删除子任务"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="td-subtasks-empty">
                <Icon name="list" size={13} />
                暂无子任务，先添加第一步，把任务拆成能完成的小动作。
              </p>
            )}

            <div className="td-add-row">
              <input
                ref={subtaskInputRef}
                className="td-add-input"
                value={subtaskDraft}
                onChange={(event) => setSubtaskDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitSubtask();
                  } else if (event.key === 'Escape') {
                    event.stopPropagation();
                    setSubtaskDraft('');
                  }
                }}
                placeholder={subtaskTotal > 0 ? '继续添加子任务，回车保存' : '拆出第一步，回车保存'}
                maxLength={120}
                aria-label="添加子任务"
              />
              <button
                type="button"
                className="td-add-btn"
                onClick={submitSubtask}
                disabled={!subtaskDraft.trim()}
                aria-label="添加子任务"
                title="添加子任务"
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
          </div>

          <div className="td-section">
            <div className="td-section-head">
              <div className="drawer-section-title">
                <Icon name="tag" size={13} />
                标签
              </div>
              <span className="td-section-meta">
                {card.labels.length > 0 ? `${card.labels.length} / ${MAX_LABELS}` : ''}
              </span>
            </div>

            {card.labels.length > 0 ? (
              <div className="td-labels">
                {card.labels.map((label) => (
                  <button
                    type="button"
                    key={label}
                    className="td-label"
                    onClick={() => removeLabel(label)}
                    title={`移除标签「${label}」`}
                  >
                    {label}
                    <Icon name="x" size={10} className="td-label-x" />
                  </button>
                ))}
              </div>
            ) : null}

            <div className="td-add-row">
              <input
                ref={labelInputRef}
                className="td-add-input"
                value={labelDraft}
                onChange={(event) => setLabelDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitLabel();
                  } else if (event.key === 'Escape') {
                    event.stopPropagation();
                    setLabelDraft('');
                  }
                }}
                placeholder={
                  labelLimitReached
                    ? `已添加 ${MAX_LABELS} 个标签`
                    : card.labels.length > 0
                      ? '继续添加标签，回车保存'
                      : '添加标签，比如：研发、高风险'
                }
                maxLength={MAX_LABEL_LENGTH}
                disabled={labelLimitReached}
                aria-label="添加标签"
              />
              <button
                type="button"
                className="td-add-btn"
                onClick={() => submitLabel()}
                disabled={!labelDraft.trim() || labelLimitReached}
                aria-label="添加标签"
                title={labelLimitReached ? `最多 ${MAX_LABELS} 个标签` : '添加标签'}
              >
                <Icon name="plus" size={14} />
              </button>
            </div>

            {labelNote ? (
              <p className="td-inline-note" role="status">
                {labelNote}
              </p>
            ) : null}

            {!labelLimitReached && labelSuggestions.length > 0 ? (
              <div className="td-label-suggest">
                <span className="td-label-suggest-label">看板已有</span>
                {labelSuggestions.map((label) => (
                  <button type="button" key={label} onClick={() => submitLabel(label)}>
                    + {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="td-section">
            <div className="td-section-head">
              <div className="drawer-section-title">
                <Icon name="file-text" size={13} />
                描述
              </div>
              <div className="td-seg" role="tablist" aria-label="描述模式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={descriptionMode === 'edit'}
                  className={descriptionMode === 'edit' ? 'on' : ''}
                  onClick={() => setDescriptionMode('edit')}
                >
                  <Icon name="pencil" size={11} />
                  编辑
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={descriptionMode === 'preview'}
                  className={descriptionMode === 'preview' ? 'on' : ''}
                  onClick={openPreview}
                >
                  <Icon name="eye" size={12} />
                  预览
                </button>
              </div>
            </div>

            {descriptionMode === 'edit' ? (
              <>
                <textarea
                  className="textarea drawer-desc"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  onBlur={commitDescription}
                  placeholder="补充背景、验收标准、参考链接……支持 Markdown"
                />
                <p className="td-md-hint">
                  支持 <code>**粗体**</code> <code>*斜体*</code> <code>- 列表</code>{' '}
                  <code>`代码`</code> <code>[链接](https://…)</code>，失焦自动保存
                </p>
              </>
            ) : isBlankMarkdown(description) ? (
              <div className="td-md-empty">还没有描述。切回「编辑」写下背景、验收标准或参考链接。</div>
            ) : (
              <div
                className="td-md"
                // renderMarkdown 会先转义 HTML，只放行 http(s) 链接，可安全插入
                dangerouslySetInnerHTML={{ __html: renderMarkdown(description) }}
              />
            )}
          </div>
        </div>

        <div className="drawer-foot">
          <button
            className="btn btn-sm btn-quiet drawer-delete"
            onClick={handleDelete}
            title="移入回收站，可随时恢复"
          >
            <Icon name="trash" size={13} />
            移入回收站
          </button>
          <span className="grow" />
          <span>修改会自动保存到本机 · 删除可在回收站恢复</span>
        </div>
      </aside>
    </div>
  );
}
