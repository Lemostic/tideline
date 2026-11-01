import { describe, expect, it } from 'vitest';
import { labelColorKey, labelStyle } from './labelColors';

const board = {
  id: 'b', title: 'Board', description: '', color: 'blue' as const,
  starred: false, createdAt: '', updatedAt: '', labelColors: { urgent: 'rose' as const },
};

describe('label colors', () => {
  it('assigns deterministic vivid defaults to labels', () => {
    expect(labelColorKey('研发')).toBe(labelColorKey('研发'));
    expect(labelStyle('研发').color).toBe('#ffffff');
    expect(new Set(['研发', '测试', '高风险', '设计', '发布'].map((name) => labelColorKey(name))).size).toBeGreaterThan(1);
  });

  it('uses a board override for the same label on all cards', () => {
    expect(labelColorKey('urgent', board)).toBe('rose');
    expect(labelColorKey('urgent', { ...board, labelColors: {} })).toBe(labelColorKey('urgent'));
  });
});
