import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useAppStore } from '@/store/appStore';

interface AddCardComposerProps {
  boardId: string;
  listId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 列表底部的行内新增卡片：
 * Enter 提交并保持打开（连续添加），Shift+Enter 换行，Esc 取消。
 */
export function AddCardComposer({ boardId, listId, open, onOpenChange }: AddCardComposerProps) {
  const createCard = useAppStore((state) => state.createCard);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const close = () => {
    setTitle('');
    setBusy(false);
    onOpenChange(false);
  };

  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await createCard({ boardId, listId, title: value });
      setTitle('');
    } catch {
      // 错误由全局错误条提示，保留输入方便重试
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  if (!open) {
    return (
      <button type="button" className="add-card-trigger" onClick={() => onOpenChange(true)}>
        <Icon name="plus" size={14} />
        添加任务
      </button>
    );
  }

  return (
    <div className="add-card-composer">
      <textarea
        ref={inputRef}
        className="add-card-input"
        rows={2}
        value={title}
        placeholder="输入任务标题，回车添加"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
      />
      <div className="add-card-actions">
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
        <span className="add-card-hint">Enter 添加</span>
      </div>
    </div>
  );
}
