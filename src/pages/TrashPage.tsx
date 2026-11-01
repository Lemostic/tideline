import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { dueBucket, formatDueLabel, formatRelativeTime } from '@/lib/date';
import { boardColorValue, PRIORITY_META, type Card } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import './trash.css';

type RowAction = 'restore' | 'purge';

interface PendingAction {
  id: string;
  action: RowAction;
}

/** 单条最多展示的标签数，其余折叠成 +N */
const MAX_VISIBLE_LABELS = 4;

/**
 * 回收站（V0.3）：只读展示被软删除的任务，可恢复回原看板或彻底删除。
 * 恢复与彻底删除都走行内二次确认，清空回收站走弹窗确认，全站不发协作通知。
 */
export function TrashPage() {
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const trash = useAppStore((state) => state.trash);
  const loadTrash = useAppStore((state) => state.loadTrash);
  const restoreCard = useAppStore((state) => state.restoreCard);
  const purgeCard = useAppStore((state) => state.purgeCard);
  const emptyTrash = useAppStore((state) => state.emptyTrash);
  const notify = useUiStore((state) => state.notify);
  const requestConfirm = useUiStore((state) => state.requestConfirm);

  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadTrash()
      .catch(() => {
        /* 失败信息由全局提示条统一展示 */
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadTrash]);

  const boardMap = useMemo(
    () => new Map(snapshot.boards.map((board) => [board.id, board])),
    [snapshot.boards],
  );
  const listMap = useMemo(
    () => new Map(snapshot.lists.map((list) => [list.id, list.title])),
    [snapshot.lists],
  );

  const filtered = useMemo(() => {
    const term = keyword.trim().toLowerCase();
    if (!term) return trash;
    return trash.filter(
      (card) =>
        card.title.toLowerCase().includes(term) ||
        card.labels.some((label) => label.toLowerCase().includes(term)),
    );
  }, [trash, keyword]);

  const handleRestore = async (card: Card) => {
    const boardName = boardMap.get(card.boardId)?.title ?? '原看板';
    const listName = listMap.get(card.listId) ?? '原列表';
    setPending(null);
    setBusyId(card.id);
    try {
      await restoreCard(card.id);
    } catch {
      return;
    } finally {
      setBusyId(null);
    }
    notify(`已恢复到 ${boardName} 的「${listName}」`, 'success');
  };

  const handlePurge = async (card: Card) => {
    setPending(null);
    setBusyId(card.id);
    try {
      await purgeCard(card.id);
    } catch {
      return;
    } finally {
      setBusyId(null);
    }
    notify(`已彻底删除「${card.title}」`);
  };

  const handleEmpty = async () => {
    const count = trash.length;
    const confirmed = await requestConfirm({
      title: '清空回收站',
      description: '回收站里的任务会从本机数据库里永久删除，删除后无法恢复。',
      details: [`将彻底删除 ${count} 个任务`],
      confirmLabel: '确认清空',
      tone: 'danger',
    });
    if (!confirmed) return;
    setEmptying(true);
    try {
      await emptyTrash();
    } catch {
      return;
    } finally {
      setEmptying(false);
    }
    notify(`已清空回收站（${count} 个任务）`);
  };

  return (
    <div className="page trash-page">
      <div className="page-head trash-head">
        <h1 className="page-title">回收站</h1>
        <span className="trash-pill">{loading ? '读取中…' : `${trash.length} 个任务`}</span>
        <p className="page-sub">删除的任务会先放在这里，确认不需要了再彻底删除。</p>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void handleEmpty()}
            disabled={loading || emptying || trash.length === 0}
          >
            <Icon name="trash" size={13} />
            清空回收站
          </button>
        </div>
      </div>

      {loading ? (
        <div className="trash-skeleton" role="status" aria-label="正在加载回收站">
          {[0, 1, 2].map((index) => (
            <div className="trash-skeleton-row" key={index}>
              <span className="skeleton trash-skeleton-title" />
              <span className="skeleton trash-skeleton-meta" />
            </div>
          ))}
        </div>
      ) : trash.length === 0 ? (
        <EmptyState
          icon={<Icon name="trash" size={22} />}
          title="回收站是空的"
          description="在看板或我的任务里删除的任务会先放到这里，可以随时恢复到原来的看板。"
          action={
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/tasks')}>
              <Icon name="check-circle" size={13} />
              去我的任务看看
            </button>
          }
        />
      ) : (
        <>
          <div className="trash-toolbar">
            <label className="trash-search">
              <Icon name="search" size={14} />
              <input
                className="trash-search-input"
                type="search"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="按标题或标签搜索"
                aria-label="搜索回收站"
              />
              {keyword ? (
                <button
                  type="button"
                  className="trash-search-clear"
                  onClick={() => setKeyword('')}
                  aria-label="清除搜索"
                >
                  <Icon name="x" size={12} />
                </button>
              ) : null}
            </label>
            <span className="trash-toolbar-count">
              {keyword ? `${filtered.length} / ${trash.length} 条` : `${trash.length} 条待处理`}
            </span>
          </div>

          {filtered.length === 0 ? (
            <div className="trash-no-match">
              <Icon name="search" size={18} />
              <p>没有找到匹配「{keyword.trim()}」的已删除任务</p>
              <button className="btn btn-ghost btn-sm" onClick={() => setKeyword('')}>
                清除搜索
              </button>
            </div>
          ) : (
            <ul className="trash-list">
              {filtered.map((card) => {
                const board = boardMap.get(card.boardId);
                const listTitle = listMap.get(card.listId);
                const priority = PRIORITY_META.find((item) => item.key === card.priority) ?? null;
                const subtaskTotal = card.subtasks.length;
                const subtaskDone = card.subtasks.filter((item) => item.done).length;
                const subtaskPercent =
                  subtaskTotal === 0 ? 0 : Math.round((subtaskDone / subtaskTotal) * 100);
                const rowAction = pending?.id === card.id ? pending.action : null;
                const busy = busyId === card.id;
                const dueTone = card.dueDate ? dueBucket(card.dueDate) : 'none';
                const dueText = card.dueDate
                  ? dueTone === 'overdue'
                    ? `已${formatDueLabel(card.dueDate)}`
                    : dueTone === 'today'
                      ? '今天到期'
                      : `截止 ${formatDueLabel(card.dueDate)}`
                  : '';

                return (
                  <li className={`trash-item${busy ? ' is-busy' : ''}`} key={card.id}>
                    <div className="trash-item-body">
                      <div className="trash-item-title-row">
                        <span className={`trash-item-title${card.completed ? ' is-done' : ''}`}>
                          {card.title}
                        </span>
                        {card.completed ? <span className="trash-completed">已完成</span> : null}
                        {card.labels.length > 0 ? (
                          <span className="trash-labels">
                            {card.labels.slice(0, MAX_VISIBLE_LABELS).map((label) => (
                              <span className="trash-label" key={label}>
                                {label}
                              </span>
                            ))}
                            {card.labels.length > MAX_VISIBLE_LABELS ? (
                              <span
                                className="trash-label"
                                title={card.labels.slice(MAX_VISIBLE_LABELS).join('、')}
                              >
                                +{card.labels.length - MAX_VISIBLE_LABELS}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </div>

                      <div className="trash-item-meta">
                        <span className="trash-origin">
                          <span
                            className="trash-origin-dot"
                            style={{
                              background: board
                                ? boardColorValue(board.color)
                                : 'var(--line-strong)',
                            }}
                          />
                          <span className="trash-origin-name">{board?.title ?? '已删除看板'}</span>
                          <Icon name="chevron-right" size={11} />
                          <span className="trash-origin-name">{listTitle ?? '已删除列表'}</span>
                        </span>

                        <span className="trash-meta-sep" aria-hidden="true">
                          ·
                        </span>
                        <span
                          className="trash-meta"
                          title={
                            card.deletedAt
                              ? new Date(card.deletedAt).toLocaleString('zh-CN')
                              : undefined
                          }
                        >
                          <Icon name="clock" size={11} />
                          删除于 {card.deletedAt ? formatRelativeTime(card.deletedAt) : '—'}
                        </span>

                        {priority ? (
                          <>
                            <span className="trash-meta-sep" aria-hidden="true">
                              ·
                            </span>
                            <span className="trash-meta">
                              <span
                                className="trash-priority-dot"
                                style={{ background: priority.color }}
                              />
                              {priority.label}优先级
                            </span>
                          </>
                        ) : null}

                        {card.dueDate ? (
                          <>
                            <span className="trash-meta-sep" aria-hidden="true">
                              ·
                            </span>
                            <span className="trash-meta">
                              <Icon
                                name={dueTone === 'overdue' ? 'clock' : 'calendar'}
                                size={11}
                              />
                              {dueText}
                            </span>
                          </>
                        ) : null}

                        {subtaskTotal > 0 ? (
                          <>
                            <span className="trash-meta-sep" aria-hidden="true">
                              ·
                            </span>
                            <span
                              className="trash-meta trash-subtasks"
                              title={`子任务完成 ${subtaskDone} / ${subtaskTotal}`}
                            >
                              <span className="trash-subtasks-track">
                                <span
                                  className="trash-subtasks-fill"
                                  style={{ width: `${subtaskPercent}%` }}
                                />
                              </span>
                              子任务 {subtaskDone} / {subtaskTotal}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="trash-item-actions">
                      {rowAction ? (
                        <div className={`trash-confirm${rowAction === 'purge' ? ' is-danger' : ''}`}>
                          <span className="trash-confirm-text">
                            {rowAction === 'restore' ? '恢复到原看板？' : '彻底删除后不可恢复'}
                          </span>
                          <button
                            type="button"
                            className={`btn btn-sm ${
                              rowAction === 'restore' ? 'btn-primary' : 'btn-danger'
                            }`}
                            disabled={busy}
                            onClick={() =>
                              void (rowAction === 'restore' ? handleRestore(card) : handlePurge(card))
                            }
                          >
                            {busy ? '处理中…' : rowAction === 'restore' ? '确认恢复' : '彻底删除'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-quiet"
                            disabled={busy}
                            onClick={() => setPending(null)}
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost trash-restore-btn"
                            disabled={busy}
                            onClick={() => setPending({ id: card.id, action: 'restore' })}
                            title="恢复到原看板"
                          >
                            <Icon name="rotate-ccw" size={13} />
                            恢复
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-quiet trash-purge-btn"
                            disabled={busy}
                            onClick={() => setPending({ id: card.id, action: 'purge' })}
                          >
                            <Icon name="trash" size={13} />
                            彻底删除
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

    </div>
  );
}
