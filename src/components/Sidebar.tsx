import { NavLink } from 'react-router-dom';
import { BrandMark, Icon, type IconName } from '@/components/Icon';
import { dueBucket } from '@/lib/date';
import { useSnapshot } from '@/store/appStore';

interface NavEntry {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

const WORKSPACE_NAV: NavEntry[] = [
  { to: '/', label: '工作台', icon: 'home', end: true },
  { to: '/tasks', label: '我的任务', icon: 'check-circle' },
  { to: '/inbox', label: '收件箱', icon: 'inbox' },
  { to: '/templates', label: '模板中心', icon: 'layout-grid' },
  { to: '/requirements', label: '需求拆解', icon: 'file-text' },
  { to: '/import', label: '导入看板', icon: 'download' },
  { to: '/dashboard', label: '仪表盘', icon: 'chart' },
  { to: '/board-sets', label: '看板集', icon: 'layers' },
  { to: '/goals', label: '目标', icon: 'target' },
  { to: '/team', label: '项目管理', icon: 'users' },
];

export function Sidebar() {
  const snapshot = useSnapshot();
  const overdueCount = snapshot.cards.filter(
    (card) => !card.completed && dueBucket(card.dueDate) === 'overdue',
  ).length;
  const inboxCount = snapshot.inbox.length;

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">
          <BrandMark size={19} />
        </div>
        <div className="brand-text">
          <span className="brand-name">潮线</span>
          <span className="brand-sub">tideline</span>
        </div>
      </div>

      <nav className="nav" aria-label="工作台">
        {WORKSPACE_NAV.map((entry) => (
          <NavLink
            key={entry.to}
            to={entry.to}
            end={entry.end}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            title={entry.label}
          >
            <span className="nav-icon">
              <Icon name={entry.icon} size={17} />
            </span>
            <span className="nav-label">{entry.label}</span>
            {entry.to === '/tasks' && overdueCount > 0 ? (
              <span className="nav-count">{overdueCount > 99 ? '99+' : overdueCount}</span>
            ) : null}
            {entry.to === '/inbox' && inboxCount > 0 ? (
              <span className="nav-meta">{inboxCount}</span>
            ) : null}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <NavLink
          to="/trash"
          className={({ isActive }) => `sidebar-utility-link${isActive ? ' is-active' : ''}`}
          title="回收站：恢复已删除的任务"
          aria-label="回收站"
        >
          <Icon name="trash" size={14} />
          <span>回收站</span>
          <small>恢复已删除任务</small>
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) => `sidebar-profile${isActive ? ' is-active' : ''}`}
          title="设置（Ctrl + ,）"
          aria-label="设置"
        >
          <span className="sidebar-profile-avatar" aria-hidden="true">L</span>
          <span className="sidebar-profile-text">
            <strong>Lemostic</strong>
            <small>本机用户 · 设置</small>
          </span>
        </NavLink>
      </div>
    </aside>
  );
}
