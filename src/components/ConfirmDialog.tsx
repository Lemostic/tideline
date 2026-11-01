/**
 * 应用内确认框。
 *
 * 取代浏览器原生 window.confirm：原生弹窗会打断工作流、样式无法统一，
 * 也说不出「这次操作会造成什么后果」。这里给出标题、后果说明和关键细节，
 * 危险操作的确认按钮用危险色。
 */
import { useEffect, useRef } from 'react';
import { Icon } from '@/components/Icon';
import { useUiStore } from '@/store/uiStore';

export function ConfirmDialog() {
  const confirm = useUiStore((state) => state.confirm);
  const settleConfirm = useUiStore((state) => state.settleConfirm);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirm) return;
    // 危险操作不默认聚焦确认按钮，避免误按 Enter 直接删除
    const target = confirm.tone === 'danger'
      ? panelRef.current?.querySelector<HTMLElement>('.modal-foot .btn-quiet')
      : confirmRef.current;
    target?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        settleConfirm(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [confirm, settleConfirm]);

  if (!confirm) return null;

  const isDanger = confirm.tone === 'danger';

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) settleConfirm(false);
      }}
    >
      <div
        className="modal confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={confirm.title}
        ref={panelRef}
      >
        <div className="confirm-head">
          <span className={`confirm-icon${isDanger ? ' is-danger' : ''}`}>
            <Icon name={isDanger ? 'trash' : 'info'} size={16} />
          </span>
          <h2 className="modal-title">{confirm.title}</h2>
        </div>

        <div className="modal-body confirm-body">
          {confirm.description ? <p className="confirm-desc">{confirm.description}</p> : null}
          {confirm.details && confirm.details.length > 0 ? (
            <ul className="confirm-details">
              {confirm.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => settleConfirm(false)}
          >
            {confirm.cancelLabel ?? '取消'}
          </button>
          <button
            type="button"
            className={`btn ${isDanger ? 'btn-danger' : 'btn-primary'}`}
            ref={confirmRef}
            onClick={() => settleConfirm(true)}
          >
            {confirm.confirmLabel ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}
