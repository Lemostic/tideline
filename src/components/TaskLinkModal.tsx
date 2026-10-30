import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import { boardColorValue, type Board, type Card, type List } from '@/lib/types';

interface TaskLinkModalProps {
  open: boolean;
  cards: Card[];
  boards: Board[];
  lists: List[];
  initialCardIds: string[];
  onClose: () => void;
  onSave: (cardIds: string[]) => Promise<void>;
}

/** 从全部活动任务里勾选要关联到目标的条目。 */
export function TaskLinkModal({
  open,
  cards,
  boards,
  lists,
  initialCardIds,
  onClose,
  onSave,
}: TaskLinkModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [boardFilter, setBoardFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(initialCardIds));
    setQuery('');
    setBoardFilter('all');
    setBusy(false);
    setError(null);
  }, [open, initialCardIds]);

  const boardById = useMemo(() => new Map(boards.map((board) => [board.id, board])), [boards]);
  const listById = useMemo(() => new Map(lists.map((list) => [list.id, list])), [lists]);

  const visibleCards = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return cards.filter((card) => {
      if (boardFilter !== 'all' && card.boardId !== boardFilter) return false;
      if (!keyword) return true;
      return (
        card.title.toLowerCase().includes(keyword) ||
        card.labels.some((label) => label.toLowerCase().includes(keyword))
      );
    });
  }, [cards, query, boardFilter]);

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ordered = cards.filter((card) => selected.has(card.id)).map((card) => card.id);
      await onSave(ordered);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="关联任务"
      subtitle="勾选后的任务完成情况会自动汇总成目标进度"
      onClose={() => (busy ? undefined : onClose())}
      width="wide"
      footer={
        <>
          <span className="goal-link-count">已选 {selected.size} 个任务</span>
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={busy}>
            {busy ? '保存中…' : '保存关联'}
          </button>
        </>
      }
    >
      <div className="goal-link-toolbar">
        <label className="tbl-search goal-link-search">
          <Icon name="search" size={14} className="tbl-search-icon" />
          <input
            className="tbl-search-input"
            value={query}
            placeholder="搜索任务或标签"
            aria-label="搜索可关联任务"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          className="select goal-link-board"
          value={boardFilter}
          onChange={(event) => setBoardFilter(event.target.value)}
          aria-label="按看板筛选任务"
        >
          <option value="all">全部看板</option>
          {boards.map((board) => (
            <option key={board.id} value={board.id}>
              {board.title}
            </option>
          ))}
        </select>
      </div>

      <div className="goal-link-list">
        {visibleCards.length === 0 ? (
          <p className="goal-link-empty">没有匹配的任务。</p>
        ) : (
          visibleCards.map((card) => {
            const board = boardById.get(card.boardId);
            const checked = selected.has(card.id);
            return (
              <label key={card.id} className={`goal-link-row${checked ? ' is-checked' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(card.id)}
                  aria-label={`关联任务「${card.title}」`}
                />
                <span
                  className="goal-link-dot"
                  style={{ background: board ? boardColorValue(board.color) : 'var(--faint)' }}
                />
                <span className="goal-link-main">
                  <span className={`goal-link-title${card.completed ? ' is-completed' : ''}`}>
                    {card.title}
                  </span>
                  <span className="goal-link-meta">
                    {board?.title ?? '未知看板'} · {listById.get(card.listId)?.title ?? '未知列表'}
                  </span>
                </span>
                {card.completed ? <span className="goal-link-done">已完成</span> : null}
              </label>
            );
          })
        )}
      </div>

      {error ? <p className="goal-form-error">{error}</p> : null}
    </Modal>
  );
}
