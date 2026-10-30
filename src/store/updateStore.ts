/**
 * 更新检查状态：只在用户点击或开启「启动时检查更新」后访问 GitHub。
 * 结果不写入数据库；仅记录最近检查时间，避免启动时频繁请求。
 */
import { create } from 'zustand';
import { checkForUpdate, type UpdateCheck } from '@/lib/update';

export const UPDATE_LAST_CHECK_KEY = 'tideline.update.lastCheckAt';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateState {
  result: UpdateCheck | null;
  checking: boolean;
  error: string | null;
  lastCheckedAt: string | null;
  check: () => Promise<UpdateCheck>;
}

function readLastCheckedAt(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(UPDATE_LAST_CHECK_KEY);
  } catch {
    return null;
  }
}

function writeLastCheckedAt(value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(UPDATE_LAST_CHECK_KEY, value);
  } catch {
    // 存储不可用时只保留内存态
  }
}

export const useUpdateStore = create<UpdateState>((set) => ({
  result: null,
  checking: false,
  error: null,
  lastCheckedAt: readLastCheckedAt(),
  check: async () => {
    set({ checking: true, error: null });
    try {
      const result = await checkForUpdate(__APP_VERSION__);
      writeLastCheckedAt(result.checkedAt);
      set({ result, checking: false, lastCheckedAt: result.checkedAt });
      return result;
    } catch (error) {
      set({
        checking: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
}));

/** 自动检查是否到期（24 小时一次）。 */
export function isUpdateCheckDue(lastCheckedAt: string | null, now = Date.now()): boolean {
  if (!lastCheckedAt) return true;
  const timestamp = Date.parse(lastCheckedAt);
  if (!Number.isFinite(timestamp)) return true;
  return now - timestamp >= UPDATE_CHECK_INTERVAL_MS;
}
