import { describe, expect, it } from 'vitest';
import { dependencyPath, type CardBox } from './dependencyLayout';

const box = (
  left: number,
  top: number,
  width: number,
  height: number,
): CardBox => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

describe('dependency path layout', () => {
  it('左右分列时从右边缘连到左边缘', () => {
    const d = dependencyPath(box(0, 0, 200, 100), box(300, 120, 200, 100));
    expect(d).not.toBeNull();
    expect(d).toContain('M 199.0 50.0');
    expect(d).toContain('301.0 170.0');
    expect(d).toContain('C ');
  });

  it('反向分列时从左边缘连到右边缘', () => {
    const d = dependencyPath(box(300, 0, 200, 100), box(0, 120, 200, 100));
    expect(d).toContain('M 301.0 50.0');
    expect(d).toContain('199.0 170.0');
  });

  it('同一列上下时从右侧绕出弧线', () => {
    const d = dependencyPath(box(0, 0, 200, 100), box(0, 200, 200, 100));
    expect(d).toContain('M 199.0 50.0');
    expect(d).toContain('199.0 250.0');
    // 控制点在卡片右侧，形成弧线
    expect(d).toContain('228.0');
  });

  it('同一列反向时依然从右侧绕出', () => {
    const d = dependencyPath(box(0, 200, 200, 100), box(0, 0, 200, 100));
    expect(d).toContain('M 199.0 250.0');
    expect(d).toContain('199.0 50.0');
    expect(d).toContain('228.0');
  });
});
