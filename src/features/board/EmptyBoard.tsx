import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useAppStore } from '@/store/appStore';

const SUGGESTIONS = ['待办', '进行中', '已完成'] as const;

/** 空看板引导：没有列表时给一个明确的创建入口，而不是空白画布 */
export function EmptyBoard({ boardId }: { boardId: string }) {
  const createList = useAppStore((state) => state.createList);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  return (
    <div className="board-empty">
      <div className="board-empty-card">
        <div className="board-empty-icon">
          <Icon name="columns" size={22} />
        </div>
        <div className="empty-title">这个看板还没有列表</div>
        <div className="empty-sub">
          列表是任务的容器。先创建「待办 / 进行中 / 已完成」这样的列表，再把任务放进去。
        </div>
        <div className="board-empty-form">
          <input
            ref={inputRef}
            className="input"
            placeholder="列表名称，例如：待办"
            value={title}
            maxLength={60}
            aria-label="新列表名称"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={busy || !title.trim()}
          >
            {busy ? '创建中…' : '创建列表'}
          </button>
        </div>
        <div className="board-empty-presets">
          <span className="field-hint">快速添加：</span>
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                void createList(boardId, suggestion).catch(() => undefined);
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
