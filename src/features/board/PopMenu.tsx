import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/Icon';

export type PopMenuEntry =
  | { kind: 'sep' }
  | {
      kind: 'item';
      label: string;
      icon?: IconName;
      danger?: boolean;
      onSelect: () => void;
    };

interface PopMenuProps {
  entries: PopMenuEntry[];
  ariaLabel: string;
  trigger?: ReactNode;
  align?: 'left' | 'right';
}

/**
 * 轻量下拉菜单：复用 base.css 的 .menu / .menu-pop 样式。
 * 点击外部或按 Esc 关闭；选择菜单项后先关闭再执行动作。
 */
export function PopMenu({ entries, ariaLabel, trigger, align = 'right' }: PopMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className="btn btn-icon"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger ?? <Icon name="more" size={16} />}
      </button>
      {open ? (
        <div className={`menu-pop ${align}`} role="menu">
          {entries.map((entry, index) =>
            entry.kind === 'sep' ? (
              <div className="menu-sep" key={`sep-${index}`} />
            ) : (
              <button
                key={entry.label}
                type="button"
                role="menuitem"
                className={`menu-item${entry.danger ? ' danger' : ''}`}
                onClick={() => {
                  setOpen(false);
                  entry.onSelect();
                }}
              >
                {entry.icon ? <Icon name={entry.icon} size={14} /> : null}
                <span>{entry.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
