import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

interface ModalProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: 'normal' | 'wide';
}

/** 通用弹窗：Esc 关闭、点击遮罩关闭、打开时聚焦第一个输入控件 */
export function Modal({ title, subtitle, children, footer, onClose, width = 'normal' }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // onClose 通常是父组件每次渲染新建的函数，放进 ref 避免它变化导致「挂载副作用」重跑，
  // 否则每次输入触发重渲染都会把焦点抢到弹窗里的第一个按钮（关闭按钮）上。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    // 优先聚焦表单控件；没有输入控件的确认类弹窗再退回到主操作按钮
    const panel = panelRef.current;
    const field = panel?.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
    );
    const primary = panel?.querySelector<HTMLElement>('.modal-foot .btn-primary, .modal-foot .btn-danger');
    const firstButton = panel?.querySelector<HTMLElement>('.modal-foot button, .modal-body button');
    (field ?? primary ?? firstButton)?.focus();

    return () => document.removeEventListener('keydown', handleKeyDown);
    // 只在挂载时执行一次：后续重渲染不能抢走用户正在输入的焦点
  }, []);

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal${width === 'wide' ? ' modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
      >
        <div className="modal-head">
          <div className="modal-head-text">
            <h2 className="modal-title">{title}</h2>
            {subtitle ? <p className="modal-sub">{subtitle}</p> : null}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="empty">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <div className="empty-title">{title}</div>
      {description ? <div className="empty-sub">{description}</div> : null}
      {action ? <div style={{ marginTop: 10 }}>{action}</div> : null}
    </div>
  );
}
