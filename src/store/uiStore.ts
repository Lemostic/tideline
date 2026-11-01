import { create } from 'zustand';

/** 全局 UI 状态：弹窗、抽屉、搜索面板、确认框、轻提示，不进入持久化 */

/** 确认框请求：调用方 await 它的 result */
export interface ConfirmRequest {
  title: string;
  /** 说明这次操作会造成什么后果，一句话说清 */
  description?: string;
  /** 列表形式的细节，例如「将删除 3 个任务」 */
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

export interface ConfirmState extends ConfirmRequest {
  /** 触发确认的按钮文案，用于把焦点还给原按钮 */
  open: boolean;
  resolve: ((confirmed: boolean) => void) | null;
}

/** 轻提示：一次操作结果的简短回执 */
export interface Toast {
  id: number;
  message: string;
  tone: 'default' | 'success' | 'danger';
}

export interface UiState {
  newBoardOpen: boolean;
  searchOpen: boolean;
  editingCardId: string | null;
  confirm: ConfirmState | null;
  toasts: Toast[];
  openNewBoard: () => void;
  closeNewBoard: () => void;
  openSearch: () => void;
  closeSearch: () => void;
  openCard: (cardId: string) => void;
  closeCard: () => void;
  /** 打开确认框并等待结果 */
  requestConfirm: (request: ConfirmRequest) => Promise<boolean>;
  /** 关闭确认框，给出结果 */
  settleConfirm: (confirmed: boolean) => void;
  /** 顶部轻提示 */
  notify: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

export const useUiStore = create<UiState>((set, get) => ({
  newBoardOpen: false,
  searchOpen: false,
  editingCardId: null,
  confirm: null,
  toasts: [],
  openNewBoard: () => set({ newBoardOpen: true }),
  closeNewBoard: () => set({ newBoardOpen: false }),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  openCard: (cardId) => set({ editingCardId: cardId }),
  closeCard: () => set({ editingCardId: null }),
  requestConfirm: (request) =>
    new Promise<boolean>((resolve) => {
      // 同时只允许一个确认框；后来的请求会顶掉前一个（并按取消结算）
      const previous = get().confirm;
      if (previous?.resolve) previous.resolve(false);
      set({
        confirm: {
          ...request,
          open: true,
          resolve,
        },
      });
    }),
  settleConfirm: (confirmed) => {
    const current = get().confirm;
    set({ confirm: null });
    current?.resolve?.(confirmed);
  },
  notify: (message, tone = 'default') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, message, tone }] });
    window.setTimeout(() => {
      set({ toasts: get().toasts.filter((item) => item.id !== id) });
    }, 2600);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((item) => item.id !== id) }),
}));
