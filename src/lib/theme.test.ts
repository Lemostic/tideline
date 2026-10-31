import { describe, expect, it } from 'vitest';
import {
  buildThemePalette,
  DEFAULT_CUSTOM_THEME,
  normalizeCustomTheme,
  normalizeThemeId,
  resolveTheme,
  THEME_PRESETS,
} from '@/lib/theme';

describe('theme helpers', () => {
  it('提供十套内置主题并默认雾蓝白', () => {
    expect(THEME_PRESETS.map((preset) => preset.name)).toEqual([
      '雾蓝白',
      '板栗鹅黄',
      '科技蓝',
      '简约白',
      '清新绿',
      '薄荷青',
      '海盐蓝',
      '樱花粉',
      '雾紫',
      '竹青',
    ]);
    expect(normalizeThemeId(undefined)).toBe('mistblue');
    expect(normalizeThemeId('tech')).toBe('tech');
    expect(normalizeThemeId('mint')).toBe('mint');
    expect(normalizeThemeId('unknown')).toBe('mistblue');
  });

  it('按基础色派生完整主题令牌', () => {
    const palette = buildThemePalette({
      primary: '#2563eb',
      accent: '#06b6d4',
      background: '#eef4fc',
      surface: '#ffffff',
      text: '#172033',
    });
    expect(palette['--primary']).toBe('#2563eb');
    expect(palette['--bg-app']).toBe('#eef4fc');
    expect(palette['--primary-soft']).toBeTypeOf('string');
    expect(palette['--primary-soft']).not.toBe('#2563eb');
    expect(palette['--ink']).toBe('#172033');
    expect(palette['--line']).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('主题解析返回对应名称与颜色', () => {
    const preset = resolveTheme('fresh', DEFAULT_CUSTOM_THEME);
    expect(preset.name).toBe('清新绿');
    expect(preset.colors.primary).toBe('#1f9d72');
    const custom = resolveTheme('custom', {
      primary: '#7c3aed',
      accent: '#f59e0b',
      background: '#f5f0ff',
      surface: '#fffaff',
      text: '#241733',
    });
    expect(custom.name).toBe('自定义');
    expect(custom.palette['--primary']).toBe('#7c3aed');
  });

  it('自定义颜色非法时回退到默认值', () => {
    const colors = normalizeCustomTheme({
      primary: 'not-a-color',
      accent: '#abc',
      background: '#faf3df',
      surface: '#fffdf6',
      text: '#3b3226',
    });
    expect(colors.primary).toBe(DEFAULT_CUSTOM_THEME.primary);
    expect(colors.accent).toBe('#aabbcc');
  });
});
