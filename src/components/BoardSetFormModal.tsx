import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import { boardColorValue, type Board, type BoardSet } from '@/lib/types';

interface BoardSetFormModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  initial?: BoardSet | null;
  boards: Board[];
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    description: string;
    boardIds: string[];
  }) => Promise<void>;
}

/** 新建 / 编辑看板集：标题、描述、成员看板多选。 */
export function BoardSetFormModal({
  open,
  mode,
  initial,
  boards,
  onClose,
  onSubmit,
}: BoardSetFormModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [boardIds, setBoardIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? '');
    setDescription(initial?.description ?? '');
    setBoardIds(initial?.boardIds.filter((id) => boards.some((board) => board.id === id)) ?? []);
    setError(null);
    setBusy(false);
  }, [open, initial, boards]);

  if (!open) return null;

  const toggleBoard = (id: string) => {
    setBoardIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const handleSubmit = async () => {
    if (busy) return;
    if (boardIds.length === 0) {
      setError('请至少选择一个看板');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ title: title.trim(), description: description.trim(), boardIds });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === 'create' ? '新建看板集' : '编辑看板集'}
      subtitle="看板集会把这些看板的任务汇总到一张表里"
      onClose={() => (busy ? undefined : onClose())}
      width="wide"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? '保存中…' : '保存看板集'}
          </button>
        </>
      }
    >
      <div className="set-form">
        <label className="set-form-field">
          <span>看板集名称</span>
          <input
            className="input"
            value={title}
            autoFocus
            maxLength={60}
            placeholder="比如：产品线总览"
            onChange={(event) => setTitle(event.target.value)}
            aria-label="看板集名称"
          />
        </label>

        <label className="set-form-field">
          <span>描述</span>
          <textarea
            className="input set-form-textarea"
            value={description}
            maxLength={200}
            placeholder="这个看板集用来关注什么？"
            onChange={(event) => setDescription(event.target.value)}
            aria-label="看板集描述"
          />
        </label>

        <div className="set-form-field">
          <span>包含看板（{boardIds.length}）</span>
          <div className="set-form-boards">
            {boards.map((board) => {
              const checked = boardIds.includes(board.id);
              return (
                <label key={board.id} className={`set-form-board${checked ? ' is-checked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleBoard(board.id)}
                  />
                  <span className="set-form-board-dot" style={{ background: boardColorValue(board.color) }} />
                  <span className="set-form-board-title">{board.title}</span>
                  {checked ? <Icon name="check" size={12} className="set-form-board-check" /> : null}
                </label>
              );
            })}
          </div>
        </div>

        {error ? <p className="set-form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
