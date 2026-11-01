import { useEffect, useRef } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BrandMark } from '@/components/Icon';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { NewBoardModal } from '@/components/NewBoardModal';
import { SearchDialog } from '@/components/SearchDialog';
import { Sidebar } from '@/components/Sidebar';
import { TaskDrawer } from '@/components/TaskDrawer';
import { ToastStack } from '@/components/ToastStack';
import { TopBar } from '@/components/TopBar';
import { BoardPage } from '@/pages/BoardPage';
import { BoardSetDetailPage } from '@/pages/BoardSetDetailPage';
import { BoardSetsPage } from '@/pages/BoardSetsPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { GoalDetailPage } from '@/pages/GoalDetailPage';
import { GoalsPage } from '@/pages/GoalsPage';
import { InboxPage } from '@/pages/InboxPage';
import { MyTasksPage } from '@/pages/MyTasksPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { TeamPage } from '@/pages/TeamPage';
import { ProjectDetailPage } from '@/pages/ProjectDetailPage';
import { RequirementPage } from '@/pages/RequirementPage';
import { TemplatesPage } from '@/pages/TemplatesPage';
import { TrashPage } from '@/pages/TrashPage';
import { WorkbenchPage } from '@/pages/WorkbenchPage';
import { useAppStore } from '@/store/appStore';
import { applyCardSize } from '@/lib/cardLayout';
import { applyTheme } from '@/lib/theme';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import { isUpdateCheckDue, useUpdateStore } from '@/store/updateStore';

export default function App() {
  const init = useAppStore((state) => state.init);
  const loaded = useAppStore((state) => state.loaded);
  const error = useAppStore((state) => state.error);
  const clearError = useAppStore((state) => state.clearError);
  const openSearch = useUiStore((state) => state.openSearch);
  const themeId = useSettingsStore((state) => state.themeId);
  const customTheme = useSettingsStore((state) => state.customTheme);
  const cardSize = useSettingsStore((state) => state.cardSize);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    applyTheme(themeId, customTheme);
  }, [themeId, customTheme]);

  useEffect(() => {
    applyCardSize(cardSize);
  }, [cardSize]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMod = event.ctrlKey || event.metaKey;
      if (isMod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
      if (isMod && event.key === ',') {
        event.preventDefault();
        window.location.hash = '#/settings';
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
              <Route path="/" element={<WorkbenchPage />} />
              <Route path="/tasks" element={<MyTasksPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/requirements" element={<RequirementPage />} />
              <Route path="/trash" element={<TrashPage />} />
              <Route path="/data" element={<Navigate to="/settings?tab=data" replace />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              {/* 使用统计已下线（偏离看板工具定位）；保留路由重定向，旧链接不会 404 */}
              <Route path="/usage" element={<Navigate to="/" replace />} />
              <Route path="/board/:boardId" element={<BoardPage />} />
              <Route path="/board-sets" element={<BoardSetsPage />} />
              <Route path="/board-sets/:setId" element={<BoardSetDetailPage />} />
              <Route path="/goals" element={<GoalsPage />} />
              <Route path="/goals/:goalId" element={<GoalDetailPage />} />
              <Route path="/team" element={<TeamPage />} />
              <Route path="/team/:projectId" element={<ProjectDetailPage />} />
              <Route path="*" element={<WorkbenchPage />} />
            </Routes>
          </div>
        </div>
        <NewBoardModal />
        <TaskDrawer />
        <SearchDialog />
        <ConfirmDialog />
        <ToastStack />
        <StartupRedirect />
        <AutoUpdateCheck />
      </div>
    </HashRouter>
  );
}

/** 启动时检查更新：用户开启后每 24 小时最多访问一次 GitHub。 */
function AutoUpdateCheck() {
  const autoCheckUpdates = useSettingsStore((state) => state.autoCheckUpdates);
  const lastCheckedAt = useUpdateStore((state) => state.lastCheckedAt);
  const check = useUpdateStore((state) => state.check);

  useEffect(() => {
    if (!autoCheckUpdates) return;
    if (!isUpdateCheckDue(lastCheckedAt)) return;
    void check().catch(() => undefined);
  }, [autoCheckUpdates, lastCheckedAt, check]);

  return null;
}

/** 启动页偏好：只在应用首次挂载时把工作台重定向到用户选择的启动页。 */
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
