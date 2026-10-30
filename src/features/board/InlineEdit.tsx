import { useEffect, useRef, useState } from 'react';

interface InlineEditProps {
  value: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onCommit: (next: string) => void;
  ariaLabel: string;
  placeholder?: string;
  maxLength?: number;
  displayClassName: string;
  inputClassName: string;
  title?: string;
}

/**
 * 看板标题 / 列表名称的内联编辑：
 * 点击进入编辑，Enter 或失焦提交，Esc 取消。
 * `editing` 由父组件持有，便于「更多菜单 → 重命名」直接切到编辑态。
 */
export function InlineEdit({
  value,
  editing,
  onEditingChange,
  onCommit,
  ariaLabel,
  placeholder,
  maxLength,
  displayClassName,
  inputClassName,
  title,
}: InlineEditProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    setDraft(value);
    settledRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing, value]);

  if (!editing) {
    return (
      <button
        type="button"
        className={displayClassName}
        title={title}
        aria-label={`${ariaLabel}：${value}，点击编辑`}
        onClick={() => onEditingChange(true)}
      >
        {value}
      </button>
    );
  }

  const finish = (commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    const next = draft.trim();
    if (commit && next && next !== value) onCommit(next);
    onEditingChange(false);
  };

  return (
    <input
      ref={inputRef}
      className={inputClassName}
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          settledRef.current = true;
          onEditingChange(false);
        }
      }}
    />
  );
}
