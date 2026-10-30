import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import type { Board } from '@/lib/types';
import { useAppStore } from '@/store/appStore';

const TITLE_MAX = 60;

interface RenameBoardDialogProps {
  board: Board;
  onClose: () => void;
}

/** 重命名看板：只改标题，失焦不保存，点「保存」才写入 */
export function RenameBoardDialog({ board, onClose }: RenameBoardDialogProps) {
  const updateBoard = useAppStore((state) => state.updateBoard);
  const [title, setTitle] = useState(board.title);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleSubmit = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('看板名称不能为空');
      return;
    }
    if (trimmed === board.title) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await updateBoard(board.id, { title: trimmed.slice(0, TITLE_MAX) });
      onClose();
    } catch {
      setSubmitting(false);
      setError('重命名失败，请重试');
    }
  };

  return (
    <Modal
      title="重命名看板"
      subtitle="只修改标题，看板里的列表和任务不受影响。"
      onClose={handleClose}
      footer={
        <>
          <button className="btn btn-quiet" onClick={handleClose} disabled={submitting}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label" htmlFor="rename-board-title">
          看板名称
        </label>
        <input
          id="rename-board-title"
          className="input"
          maxLength={TITLE_MAX}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleSubmit();
          }}
          autoFocus
        />
        {error ? (
          <div className="field-hint" style={{ color: 'var(--danger)' }}>
            {error}
          </div>
        ) : (
          <div className="field-hint">最多 {TITLE_MAX} 个字符，留空将无法保存。</div>
        )}
      </div>
    </Modal>
  );
}

interface DeleteBoardDialogProps {
  board: Board;
  listCount: number;
  taskCount: number;
  onClose: () => void;
}

/** 删除看板二次确认：明确列出会一起删除的内容 */
export function DeleteBoardDialog({
  board,
  listCount,
  taskCount,
  onClose,
}: DeleteBoardDialogProps) {
  const deleteBoard = useAppStore((state) => state.deleteBoard);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleDelete = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await deleteBoard(board.id);
      onClose();
    } catch {
      setSubmitting(false);
      setError('删除失败，请重试');
    }
  };

  return (
    <Modal
      title="删除看板"
      subtitle="删除后无法恢复，请确认。"
      onClose={handleClose}
      footer={
        <>
          <button className="btn btn-quiet" onClick={handleClose} disabled={submitting}>
            取消
          </button>
          <button
            className="btn btn-danger"
            onClick={() => void handleDelete()}
            disabled={submitting}
          >
            {submitting ? '删除中…' : '确认删除'}
          </button>
        </>
      }
    >
      <div className="home-delete-confirm">
        <div className="home-delete-icon">
          <Icon name="trash" size={18} />
        </div>
        <div className="home-delete-text">
          <p>
            确定要删除看板「<strong>{board.title}</strong>」吗？
          </p>
          <p className="home-delete-meta">
            看板下的 {listCount} 个列表和 {taskCount} 个任务会一起删除，且无法撤销。
          </p>
          {error ? <p className="home-delete-error">{error}</p> : null}
        </div>
      </div>
    </Modal>
  );
}
