import { useEffect, useRef } from 'react';
import { HashRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BrandMark } from '@/components/Icon';
import { NewBoardModal } from '@/components/NewBoardModal';
import { SearchDialog } from '@/components/SearchDialog';
import { Sidebar } from '@/components/Sidebar';
import { TaskDrawer } from '@/components/TaskDrawer';
import { TopBar } from '@/components/TopBar';
import { BoardPage } from '@/pages/BoardPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { DataPage } from '@/pages/DataPage';
import { HomePage } from '@/pages/HomePage';
import { InboxPage } from '@/pages/InboxPage';
import { MyTasksPage } from '@/pages/MyTasksPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { TemplatesPage } from '@/pages/TemplatesPage';
import { TrashPage } from '@/pages/TrashPage';
import { VipFeaturePage } from '@/pages/VipFeaturePage';
import { useAppStore } from '@/store/appStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';

export default function App() {
  const init = useAppStore((state) => state.init);
  const loaded = useAppStore((state) => state.loaded);
  const error = useAppStore((state) => state.error);
  const clearError = useAppStore((state) => state.clearError);
  const openSearch = useUiStore((state) => state.openSearch);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMod = event.ctrlKey || event.metaKey;
      if (isMod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openSearch]);

  if (!loaded) {
    return (
      <div className="boot-screen">
        <div className="boot-mark">
          <BrandMark size={24} />
        </div>
        <div className="boot-text">正在打开你的本地工作台…</div>
      </div>
    );
  }

  return (
    <HashRouter>
      <div className="app-shell">
        <Sidebar />
        <div className="app-main">
          <TopBar />
          {error ? (
            <div className="app-error-bar">
              <IconAlert />
              <span>操作未完成：{error}</span>
              <button onClick={clearError}>知道了</button>
            </div>
          ) : null}
          <div className="app-content">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/tasks" element={<MyTasksPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/trash" element={<TrashPage />} />
              <Route path="/data" element={<DataPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/board/:boardId" element={<BoardPage />} />
              <Route path="/board-sets" element={<VipFeaturePage feature="board-sets" />} />
              <Route path="/goals" element={<VipFeaturePage feature="goals" />} />
              <Route path="*" element={<HomePage />} />
            </Routes>
          </div>
        </div>
        <NewBoardModal />
        <TaskDrawer />
        <SearchDialog />
        <StartupRedirect />
      </div>
    </HashRouter>
  );
}

/** 启动页偏好：只在应用首次挂载时把首页重定向到用户选择的启动页。 */
function StartupRedirect() {
  const startPage = useSettingsStore((state) => state.startPage);
  const navigate = useNavigate();
  const location = useLocation();
  const redirected = useRef(false);

  useEffect(() => {
    if (redirected.current) return;
    redirected.current = true;
    if (startPage !== '/' && (location.pathname === '/' || location.pathname === '')) {
      navigate(startPage, { replace: true });
    }
  }, [location.pathname, navigate, startPage]);

  return null;
}

function IconAlert() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6" />
      <path d="M12 17h.01" />
    </svg>
  );
}
