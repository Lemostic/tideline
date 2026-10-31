/**
 * 主题系统（V0.8.5）：内置主题 + 自定义配色。
 *
 * 所有颜色最终落到 CSS 变量上，组件只使用变量，因此切换主题不需要改组件。
 * 自定义主题只让用户配置 5 个基础色，其余描边/柔和色/阴影由颜色混合自动派生，
 * 避免用户配置几十个令牌。
 */

export type ThemeId =
  | 'mistblue'
  | 'pine'
  | 'chestnut'
  | 'tech'
  | 'minimal'
  | 'fresh'
  | 'mint'
  | 'seasalt'
  | 'sakura'
  | 'lavender'
  | 'custom';

export interface ThemeBaseColors {
  primary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  /** 可选：侧边栏底色；不填时跟随 background */
  sidebar?: string;
}

export interface ThemePreset {
  id: Exclude<ThemeId, 'custom'>;
  name: string;
  description: string;
  colors: ThemeBaseColors;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'mistblue',
    name: '雾蓝白',
    description: '冷白背景、纯白卡片与清透蓝，干净通透',
    colors: {
      primary: '#2f6fd0',
      accent: '#e8844f',
      background: '#f5f6f8',
      surface: '#ffffff',
      sidebar: '#ffffff',
      text: '#171a24',
    },
  },
  {
    id: 'chestnut',
    name: '板栗鹅黄',
    description: '暖米背景与板栗棕，柔和耐看',
    colors: {
      primary: '#a86f2d',
      accent: '#d99a2b',
      background: '#faf3df',
      surface: '#fffdf6',
      text: '#3b3226',
    },
  },
  {
    id: 'tech',
    name: '科技蓝',
    description: '浅蓝底与高饱和蓝，清爽理性',
    colors: {
      primary: '#2563eb',
      accent: '#06b6d4',
      background: '#eef4fc',
      surface: '#ffffff',
      text: '#172033',
    },
  },
  {
    id: 'minimal',
    name: '简约白',
    description: '近白背景与中性灰，安静克制',
    colors: {
      primary: '#475569',
      accent: '#94a3b8',
      background: '#f7f8fa',
      surface: '#ffffff',
      text: '#111827',
    },
  },
  {
    id: 'fresh',
    name: '清新绿',
    description: '薄荷底与青绿主色，轻盈自然',
    colors: {
      primary: '#1f9d72',
      accent: '#f0b429',
      background: '#eef8f3',
      surface: '#ffffff',
      text: '#163a2c',
    },
  },
  {
    id: 'mint',
    name: '薄荷青',
    description: '雾感薄荷绿，清爽不刺眼',
    colors: {
      primary: '#2f8a7a',
      accent: '#e8b86a',
      background: '#edf8f3',
      surface: '#ffffff',
      text: '#1e3834',
    },
  },
  {
    id: 'seasalt',
    name: '海盐蓝',
    description: '浅海盐蓝，安静通透',
    colors: {
      primary: '#3d7ea6',
      accent: '#87c6c9',
      background: '#eef7fb',
      surface: '#ffffff',
      text: '#1b3440',
    },
  },
  {
    id: 'sakura',
    name: '樱花粉',
    description: '低饱和樱花粉，柔和轻盈',
    colors: {
      primary: '#b85c79',
      accent: '#e3a56d',
      background: '#fdf1f4',
      surface: '#fffdfd',
      text: '#3d2a31',
    },
  },
  {
    id: 'lavender',
    name: '雾紫',
    description: '雾面紫罗兰，柔和安静',
    colors: {
      primary: '#7566a8',
      accent: '#e0a878',
      background: '#f4f1fa',
      surface: '#ffffff',
      text: '#2b273b',
    },
  },
  {
    id: 'pine',
    name: '竹青',
    description: '潮线原始深绿主题',
    colors: {
      primary: '#0f766e',
      accent: '#e9a23b',
      background: '#f3f5f2',
      surface: '#ffffff',
      text: '#1e2a2f',
    },
  },
];

export const DEFAULT_CUSTOM_THEME: ThemeBaseColors = {
  ...THEME_PRESETS[0].colors,
};

export const DEFAULT_THEME_ID: ThemeId = 'mistblue';

const THEME_IDS: ThemeId[] = [
  ...THEME_PRESETS.map((preset) => preset.id),
  'custom',
];

export function normalizeThemeId(value: unknown): ThemeId {
  return THEME_IDS.includes(value as ThemeId) ? (value as ThemeId) : DEFAULT_THEME_ID;
}

function normalizeHex(value: string, fallback: string): string {
  const raw = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return fallback;
}

export function normalizeCustomTheme(raw: unknown): ThemeBaseColors {
  const value = (raw ?? {}) as Partial<ThemeBaseColors>;
  return {
    primary: normalizeHex(String(value.primary ?? ''), DEFAULT_CUSTOM_THEME.primary),
    accent: normalizeHex(String(value.accent ?? ''), DEFAULT_CUSTOM_THEME.accent),
    background: normalizeHex(String(value.background ?? ''), DEFAULT_CUSTOM_THEME.background),
    surface: normalizeHex(String(value.surface ?? ''), DEFAULT_CUSTOM_THEME.surface),
    text: normalizeHex(String(value.text ?? ''), DEFAULT_CUSTOM_THEME.text),
  };
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const value = normalizeHex(hex, '#000000');
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** weight 是第二个颜色的占比（0–1）。 */
function mix(first: string, second: string, weight: number): string {
  const a = hexToRgb(first);
  const b = hexToRgb(second);
  const t = Math.max(0, Math.min(1, weight));
  return rgbToHex({
    r: a.r * (1 - t) + b.r * t,
    g: a.g * (1 - t) + b.g * t,
    b: a.b * (1 - t) + b.b * t,
  });
}

function alpha(hex: string, opacity: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

export type ThemePalette = Record<string, string>;

/**
 * 由 5 个基础色派生完整设计令牌。所有派生色保持与背景一致的冷暖倾向。
 */
export function buildThemePalette(colors: ThemeBaseColors): ThemePalette {
  const base = normalizeCustomTheme(colors);
  const { primary, accent, background: bg, surface, text: ink } = base;
  const sidebar = colors.sidebar ? normalizeHex(colors.sidebar, bg) : bg;
  const primaryStrong = mix(primary, '#000000', 0.22);
  const primarySoft = mix(primary, '#ffffff', 0.88);
  const primarySoft2 = mix(primary, '#ffffff', 0.74);
  const accentSoft = mix(accent, '#ffffff', 0.84);
  const bgDeep = mix(bg, '#000000', 0.035);
  const surfaceMuted = mix(surface, bg, 0.55);
  const surfaceHover = mix(surface, primary, 0.055);
  const surfaceSunken = mix(bg, '#000000', 0.035);
  const ink2 = mix(ink, bg, 0.24);
  const muted = mix(ink, bg, 0.54);
  const faint = mix(ink, bg, 0.7);
  const line = mix(bg, ink, 0.1);
  const lineStrong = mix(bg, ink, 0.18);
  const success = mix('#1f9d72', primary, 0.22);
  const successSoft = mix('#eaf7f0', bg, 0.25);
  const danger = mix('#d9534a', primary, 0.08);
  const dangerSoft = mix('#fdeceb', bg, 0.22);
  const warn = mix('#c98a24', accent, 0.2);

  return {
    '--bg-app': bg,
    '--bg-app-deep': bgDeep,
    '--sidebar-bg': sidebar,
    '--surface': surface,
    '--surface-muted': surfaceMuted,
    '--surface-hover': surfaceHover,
    '--surface-sunken': surfaceSunken,
    '--ink': ink,
    '--ink-2': ink2,
    '--muted': muted,
    '--faint': faint,
    '--line': line,
    '--line-strong': lineStrong,
    '--primary': primary,
    '--primary-strong': primaryStrong,
    '--primary-soft': primarySoft,
    '--primary-soft-2': primarySoft2,
    '--accent': accent,
    '--accent-soft': accentSoft,
    '--hover-wash': alpha(ink, 0.06),
    '--backdrop': alpha(ink, 0.34),
    '--danger': danger,
    '--danger-soft': dangerSoft,
    '--warn': warn,
    '--success': success,
    '--success-soft': successSoft,
    '--shadow-xs': `0 1px 2px ${alpha(ink, 0.05)}`,
    '--shadow-sm': `0 1px 2px ${alpha(ink, 0.05)}, 0 2px 8px ${alpha(ink, 0.045)}`,
    '--shadow-md': `0 2px 4px ${alpha(ink, 0.05)}, 0 10px 28px ${alpha(ink, 0.08)}`,
    '--shadow-lg': `0 6px 16px ${alpha(ink, 0.09)}, 0 28px 56px ${alpha(ink, 0.13)}`,
  };
}

export function resolveTheme(
  themeId: ThemeId,
  custom: ThemeBaseColors,
): { id: ThemeId; name: string; colors: ThemeBaseColors; palette: ThemePalette } {
  if (themeId === 'custom') {
    const colors = normalizeCustomTheme(custom);
    return {
      id: 'custom',
      name: '自定义',
      colors,
      palette: buildThemePalette(colors),
    };
  }
  const preset = THEME_PRESETS.find((item) => item.id === themeId) ?? THEME_PRESETS[0];
  return {
    id: preset.id,
    name: preset.name,
    colors: preset.colors,
    palette: buildThemePalette(preset.colors),
  };
}

export function applyTheme(themeId: ThemeId, custom: ThemeBaseColors): void {
  if (typeof document === 'undefined') return;
  const theme = resolveTheme(themeId, custom);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.palette)) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = theme.id;
  root.style.colorScheme = 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.colors.background);
}
