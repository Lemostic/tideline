import { describe, expect, it } from 'vitest';
import {
  CARD_SIZE_OPTIONS,
  cardSizeOption,
  DEFAULT_CARD_SIZE,
  normalizeCardSize,
} from '@/lib/cardLayout';

describe('card layout config', () => {
  it('默认使用标准尺寸，并对未知值回退', () => {
    expect(DEFAULT_CARD_SIZE).toBe('standard');
    expect(normalizeCardSize(undefined)).toBe('standard');
    expect(normalizeCardSize('unknown')).toBe('standard');
    expect(normalizeCardSize('compact')).toBe('compact');
  });

  it('三档尺寸宽度依次增大', () => {
    expect(CARD_SIZE_OPTIONS.map((option) => option.minWidth)).toEqual([220, 252, 300]);
    expect(cardSizeOption('compact').coverHeight).toBe(78);
    expect(cardSizeOption('large').coverHeight).toBe(112);
  });
});
