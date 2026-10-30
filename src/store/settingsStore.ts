/**
 * 全局设置（V0.4 设置管理）。
 *
 * 设置只保存在本机 localStorage，不进入数据库；这样不改变备份文件格式，
 * 也避免把 UI 偏好和任务数据混在一起。导入/导出备份不会覆盖设置。
 */
import { create } from 'zustand';
import type { BoardView } from '@/lib/types';

export type StartPage = '/' | '/tasks' | '/inbox';

export interface Settings {
  /** 打开看板时默认进入的视图 */
  defaultView: BoardView;
  /** 每周起始日：1=周一，0=周日 */
  weekStartsOn: 0 | 1;
  /** 我的任务 / 表格视图默认隐藏已完成 */
  hideCompletedByDefault: boolean;
  /** 看板中显示任务依赖的虚线箭头 */
  showDependencyLines: boolean;
  /** 启动应用后默认进入的页面 */
  startPage: StartPage;
  /** 启动时自动检查 GitHub 正式版本（每 24 小时最多一次） */
  autoCheckUpdates: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultView: 'board',
  weekStartsOn: 1,
  hideCompletedByDefault: false,
  showDependencyLines: true,
  startPage: '/',
  autoCheckUpdates: false,
};

const STORAGE_KEY = 'tideline.settings.v1';

function normalize(raw: unknown): Settings {
  const value = (raw ?? {}) as Partial<Settings>;
  const defaultView: BoardView = ['board', 'table', 'gantt', 'calendar'].includes(
    value.defaultView as string,
  )
    ? (value.defaultView as BoardView)
    : DEFAULT_SETTINGS.defaultView;
  const weekStartsOn = value.weekStartsOn === 0 ? 0 : 1;
  const hideCompletedByDefault = Boolean(value.hideCompletedByDefault);
  const showDependencyLines = value.showDependencyLines !== false;
  const startPage: StartPage = ['/', '/tasks', '/inbox'].includes(value.startPage as string)
    ? (value.startPage as StartPage)
    : DEFAULT_SETTINGS.startPage;
  const autoCheckUpdates = Boolean(value.autoCheckUpdates);
  return {
    defaultView,
    weekStartsOn,
    hideCompletedByDefault,
    showDependencyLines,
    startPage,
    autoCheckUpdates,
  };
}

function loadSettings(): Settings {
  if (typeof localStorage === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(settings: Settings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 本地存储不可用时保持内存态，不影响使用
  }
}

interface SettingsState extends Settings {
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
}

const initial = loadSettings();

export const useSettingsStore = create<SettingsState>((set) => ({
  ...initial,
  update: (patch) =>
    set((state) => {
      const next = normalize({ ...state, ...patch });
      persistSettings(next);
      return next;
    }),
  reset: () => {
    persistSettings(DEFAULT_SETTINGS);
    set({ ...DEFAULT_SETTINGS });
  },
}));
