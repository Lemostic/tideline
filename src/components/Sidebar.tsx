import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { BrandMark, Icon, type IconName } from '@/components/Icon';
import { dueBucket } from '@/lib/date';
import { useSnapshot } from '@/store/appStore';

interface NavEntry {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

const PRIMARY_NAV: NavEntry[] = [
  { to: '/', label: '驾驶舱', icon: 'home', end: true },
  { to: '/boards', label: '看板', icon: 'layout-grid' },
  { to: '/timeline', label: '时间线', icon: 'gantt' },
  { to: '/insights', label: '洞察', icon: 'chart' },
];

interface DockSection {
  title: string;
  items: NavEntry[];
}

const DOCK_SECTIONS: DockSection[] = [
  {
    title: '作业',
    items: [
      { to: '/tasks', label: '我的任务', icon: 'check-circle' },
      { to: '/inbox', label: '收件箱', icon: 'inbox' },
      { to: '/board-sets', label: '看板集', icon: 'layers' },
      { to: '/goals', label: '目标', icon: 'target' },
    ],
  },
  {
    title: '工坊',
    items: [
      { to: '/templates', label: '模板中心', icon: 'layout-grid' },
      { to: '/requirements', label: '需求拆解', icon: 'file-text' },
      { to: '/import', label: '导入看板', icon: 'download' },
      { to: '/team', label: '项目管理', icon: 'users' },
    ],
  },
];

export function Sidebar() {
  const { pathname } = useLocation();
  const snapshot = useSnapshot();
  const [dockOpen, setDockOpen] = useState(false);
  const dockButtonRef = useRef<HTMLButtonElement>(null);
  const dockPanelRef = useRef<HTMLDivElement>(null);
  const dockCloseRef = useRef<HTMLButtonElement>(null);
  const overdueCount = snapshot.cards.filter(
    (card) => !card.completed && dueBucket(card.dueDate) === 'overdue',
  ).length;
  const inboxCount = snapshot.inbox.length;

  useEffect(() => {
    if (!dockOpen) return;
    dockCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDockOpen(false);
        dockButtonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab' || !dockPanelRef.current) return;
      const focusable = Array.from(
        dockPanelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dockOpen]);

  useEffect(() => {
    setDockOpen(false);
  }, [pathname]);

  const isBoardSection = pathname.startsWith('/board/');

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">
          <BrandMark size={19} />
        </div>
      </div>

      <nav className="nav" aria-label="主航道">
        {PRIMARY_NAV.map((entry) => (
          <NavLink
            key={entry.to}
            to={entry.to}
            end={entry.end}
            className={({ isActive }) =>
              `rail-item${isActive || (entry.to === '/boards' && isBoardSection) ? ' active' : ''}`
            }
            title={entry.label}
          >
            <span className="rail-icon">
              <Icon name={entry.icon} size={19} />
            </span>
            <span className="rail-label">{entry.label}</span>
            {entry.to === '/' && overdueCount > 0 ? (
              <span className="rail-badge">{overdueCount > 99 ? '99+' : overdueCount}</span>
            ) : null}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button
          ref={dockButtonRef}
          type="button"
          className={`rail-item rail-dock${dockOpen ? ' active' : ''}`}
          onClick={() => setDockOpen((open) => !open)}
          aria-expanded={dockOpen}
          aria-haspopup="dialog"
          title="船坞：更多工具与档案"
        >
          <span className="rail-icon">
            <Icon name="layers" size={19} />
          </span>
          <span className="rail-label">船坞</span>
          {inboxCount > 0 ? <span className="rail-dot" aria-hidden="true" /> : null}
        </button>
        <NavLink
          to="/settings"
          className={({ isActive }) => `rail-item${isActive ? ' active' : ''}`}
          title="设置（Ctrl + ,）"
          aria-label="设置"
        >
          <span className="rail-icon">
            <Icon name="settings" size={18} />
          </span>
          <span className="rail-label">设置</span>
        </NavLink>
      </div>

      {dockOpen ? (
        <>
          <div
            className="dock-scrim"
            onClick={() => {
              setDockOpen(false);
              dockButtonRef.current?.focus();
            }}
          />
          <div
            ref={dockPanelRef}
            className="dock-panel"
            role="dialog"
            aria-modal="true"
            aria-label="船坞"
          >
            <div className="dock-head">
              <div>
                <span className="dock-kicker">DOCK</span>
                <strong>船坞</strong>
                <small>工具、汇总与档案</small>
              </div>
              <button
                ref={dockCloseRef}
                className="btn btn-icon"
                onClick={() => {
                  setDockOpen(false);
                  dockButtonRef.current?.focus();
                }}
                aria-label="关闭船坞"
              >
                <Icon name="x" size={15} />
              </button>
            </div>
            {DOCK_SECTIONS.map((section) => (
              <section key={section.title} className="dock-section">
                <h3>{section.title}</h3>
                <div className="dock-links">
                  {section.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className={({ isActive }) => `dock-link${isActive ? ' active' : ''}`}
                    >
                      <Icon name={item.icon} size={16} />
                      <span>{item.label}</span>
                      {item.to === '/inbox' && inboxCount > 0 ? (
                        <em>{inboxCount}</em>
                      ) : null}
                      {item.to === '/tasks' && overdueCount > 0 ? (
                        <em className="is-danger">{overdueCount}</em>
                      ) : null}
                    </NavLink>
                  ))}
                </div>
              </section>
            ))}
            <footer className="dock-foot">
              <NavLink to="/trash" className="dock-link">
                <Icon name="trash" size={16} />
                <span>回收站</span>
                <small>恢复已删除任务</small>
              </NavLink>
              <span className="dock-local">
                <Icon name="database" size={13} /> 数据只在本机
              </span>
            </footer>
          </div>
        </>
      ) : null}
    </aside>
  );
}
