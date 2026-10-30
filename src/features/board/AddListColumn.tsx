import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useAppStore } from '@/store/appStore';

/** 画布末尾的「+ 添加列表」幽灵列：Enter 创建并保持打开，Esc 取消 */
export function AddListColumn({ boardId }: { boardId: string }) {
  const createList = useAppStore((state) => state.createList);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const close = () => {
    setTitle('');
    setBusy(false);
    setOpen(false);
  };

  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await createList(boardId, value);
      setTitle('');
    } catch {
      // 错误由全局错误条提示
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  if (!open) {
    return (
      <div className="board-add-list">
        <button type="button" className="board-add-list-btn" onClick={() => setOpen(true)}>
          <Icon name="plus" size={15} />
          添加列表
        </button>
      </div>
    );
  }

  return (
    <div className="board-add-list">
      <div className="board-add-list-form">
        <input
          ref={inputRef}
          className="input input-inline"
          placeholder="列表名称，回车添加"
          value={title}
          maxLength={60}
          aria-label="新列表名称"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        />
        <div className="board-add-list-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void submit()}
            disabled={busy || !title.trim()}
          >
            {busy ? '添加中…' : '添加'}
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={close}>
            取消
          </button>
        </div>
        <div className="field-hint">Esc 取消 · 可连续添加多个列表</div>
      </div>
    </div>
  );
}
