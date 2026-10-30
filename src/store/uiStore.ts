import { create } from 'zustand';

/** 全局 UI 状态：弹窗、抽屉、搜索面板，不进入持久化 */
export interface UiState {
  newBoardOpen: boolean;
  searchOpen: boolean;
  editingCardId: string | null;
  openNewBoard: () => void;
  closeNewBoard: () => void;
  openSearch: () => void;
  closeSearch: () => void;
  openCard: (cardId: string) => void;
  closeCard: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  newBoardOpen: false,
  searchOpen: false,
  editingCardId: null,
  openNewBoard: () => set({ newBoardOpen: true }),
  closeNewBoard: () => set({ newBoardOpen: false }),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  openCard: (cardId) => set({ editingCardId: cardId }),
  closeCard: () => set({ editingCardId: null }),
}));
