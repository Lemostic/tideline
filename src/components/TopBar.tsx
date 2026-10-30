import { useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';

const SECTION_LABELS: Record<string, string> = {
  '/': '首页',
  '/tasks': '我的任务',
  '/inbox': '收件箱',
  '/templates': '模板中心',
  '/trash': '回收站',
  '/data': '数据备份',
  '/settings': '设置',
  '/dashboard': '仪表盘',
  '/board-sets': '看板集',
  '/goals': '目标',
};

export function TopBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const openSearch = useUiStore((state) => state.openSearch);
  const openNewBoard = useUiStore((state) => state.openNewBoard);
  const snapshot = useSnapshot();

  const boardId = pathname.startsWith('/board/') ? pathname.slice('/board/'.length) : null;
  const board = boardId ? snapshot.boards.find((item) => item.id === boardId) : undefined;
  const boardSetId = pathname.startsWith('/board-sets/')
    ? pathname.slice('/board-sets/'.length)
    : null;
  const boardSet = boardSetId
    ? snapshot.boardSets.find((item) => item.id === boardSetId)
    : undefined;
  const crumb = board ? (
    <>
      <button className="btn btn-icon" onClick={() => navigate('/')} aria-label="返回首页">
        <Icon name="arrow-left" size={15} />
      </button>
      <span>首页</span>
      <Icon name="chevron-right" size={12} />
      <strong>{board.title}</strong>
    </>
  ) : boardSet ? (
    <>
      <button className="btn btn-icon" onClick={() => navigate('/board-sets')} aria-label="返回看板集">
        <Icon name="arrow-left" size={15} />
      </button>
      <span>看板集</span>
      <Icon name="chevron-right" size={12} />
      <strong>{boardSet.title}</strong>
    </>
  ) : (
    <>
      <Icon name="layout-grid" size={14} />
      <strong>{SECTION_LABELS[pathname] ?? '潮线'}</strong>
    </>
  );

  return (
    <header className="topbar">
      <div className="topbar-crumb">{crumb}</div>
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        <button className="search-trigger" onClick={openSearch} aria-label="搜索">
          <Icon name="search" size={15} />
          <span>搜索看板或任务</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button className="btn btn-primary btn-sm" onClick={openNewBoard}>
          <Icon name="plus" size={14} />
          新建看板
        </button>
        <span className="local-pill" title="所有数据只保存在这台设备上">
          <Icon name="database" size={13} />
          仅本机
        </span>
        <div className="avatar" title="本地用户">
          L
        </div>
      </div>
    </header>
  );
}
