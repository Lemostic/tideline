/**
 * 全局卡片尺寸配置（V0.8.14）。
 *
 * 卡片画廊（模板中心、工作台看板列表、看板集）统一引用这组 CSS 变量，
 * 避免每处各自写 minmax/间距导致尺寸漂移。选择保存在设置里。
 */

export type CardSize = 'compact' | 'standard' | 'large';

export interface CardSizeOption {
  key: CardSize;
  label: string;
  description: string;
  minWidth: number;
  gap: number;
  minHeight: number;
  coverHeight: number;
}

export const CARD_SIZE_OPTIONS: CardSizeOption[] = [
  {
    key: 'compact',
    label: '紧凑',
    description: '一屏显示更多卡片',
    minWidth: 220,
    gap: 10,
    minHeight: 120,
    coverHeight: 78,
  },
  {
    key: 'standard',
    label: '标准',
    description: '与工作台看板卡片一致',
    minWidth: 252,
    gap: 14,
    minHeight: 140,
    coverHeight: 98,
  },
  {
    key: 'large',
    label: '宽松',
    description: '更大的封面与留白',
    minWidth: 300,
    gap: 16,
    minHeight: 160,
    coverHeight: 112,
  },
];

export const DEFAULT_CARD_SIZE: CardSize = 'standard';

export function normalizeCardSize(value: unknown): CardSize {
  return CARD_SIZE_OPTIONS.some((option) => option.key === value)
    ? (value as CardSize)
    : DEFAULT_CARD_SIZE;
}

export function cardSizeOption(size: CardSize): CardSizeOption {
  return CARD_SIZE_OPTIONS.find((option) => option.key === size) ?? CARD_SIZE_OPTIONS[1];
}

export function applyCardSize(size: CardSize): void {
  if (typeof document === 'undefined') return;
  const option = cardSizeOption(size);
  const root = document.documentElement;
  root.style.setProperty('--card-min-width', `${option.minWidth}px`);
  root.style.setProperty('--card-gap', `${option.gap}px`);
  root.style.setProperty('--card-min-height', `${option.minHeight}px`);
  root.style.setProperty('--card-cover-height', `${option.coverHeight}px`);
  root.dataset.cardSize = size;
}
