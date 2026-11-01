/**
 * 顶部轻提示：操作结果的简短回执。
 *
 * 只说发生了什么，不做推销。成功用主色，失败用危险色，默认是中性色。
 */
import { Icon } from '@/components/Icon';
import { useUiStore } from '@/store/uiStore';

export function ToastStack() {
  const toasts = useUiStore((state) => state.toasts);
  const dismissToast = useUiStore((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast toast-${toast.tone}`}
          onClick={() => dismissToast(toast.id)}
        >
          {toast.tone === 'success' ? <Icon name="check" size={13} /> : null}
          {toast.tone === 'danger' ? <Icon name="info" size={13} /> : null}
          <span>{toast.message}</span>
        </button>
      ))}
    </div>
  );
}
