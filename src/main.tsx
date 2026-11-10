import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyCardSize } from './lib/cardLayout';
import { applyTheme } from './lib/theme';
import { useSettingsStore } from './store/settingsStore';
import './styles/tokens.css';
import './styles/base.css';
import './styles/page-head.css';
import './styles/overlays.css';
import './styles/glass.css';

// 首帧前恢复主题与全局卡片尺寸，避免启动时先闪一下默认布局。
const initialSettings = useSettingsStore.getState();
applyTheme(initialSettings.themeId, initialSettings.customTheme);
applyCardSize(initialSettings.cardSize);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
