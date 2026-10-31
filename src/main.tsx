import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme } from './lib/theme';
import { useSettingsStore } from './store/settingsStore';
import './styles/tokens.css';
import './styles/base.css';

// 首帧前恢复主题，避免启动时先闪一下默认配色。
const initialSettings = useSettingsStore.getState();
applyTheme(initialSettings.themeId, initialSettings.customTheme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
