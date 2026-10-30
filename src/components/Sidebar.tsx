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
  { to: '/trash', label: '回收站', icon: 'trash' },
  { to: '/dashboard', label: '仪表盘', icon: 'chart' },
  { to: '/board-sets', label: '看板集', icon: 'layers' },
  { to: '/goals', label: '目标', icon: 'target' },
  { to: '/data', label: '数据备份', icon: 'database' },
  { to: '/settings', label: '设置', icon: 'sliders' },
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
        <div className="storage-status">
          <span className="storage-dot" />
          数据保存在本机
        </div>
        <div className="sidebar-version">v{__APP_VERSION__} · 开源免费</div>
      </div>
    </aside>
  );
}
