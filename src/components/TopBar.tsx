import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { formatMonthDay, formatWeekday, todayKey } from '@/lib/date';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import { useUpdateStore } from '@/store/updateStore';

const SECTION_LABELS: Record<string, string> = {
  '/': '驾驶舱',
  '/tasks': '我的任务',
  '/inbox': '收件箱',
  '/templates': '模板中心',
  '/requirements': '需求拆解',
  '/import': '导入看板',
  '/trash': '回收站',
  '/settings': '设置',
  '/workbench': '工作台',
  '/dashboard': '仪表盘',
  '/insights': '洞察',
  '/boards': '看板',
  '/timeline': '时间线',
  '/board-sets': '看板集',
  '/goals': '目标',
  '/team': '项目管理',
};

function sectionLabelFor(pathname: string): string | undefined {
  if (pathname.startsWith('/team')) return '项目管理';
  return SECTION_LABELS[pathname];
}

export function TopBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const openSearch = useUiStore((state) => state.openSearch);
  const openNewBoard = useUiStore((state) => state.openNewBoard);
  const notify = useUiStore((state) => state.notify);
  const addInbox = useAppStore((state) => state.addInbox);
  const snapshot = useSnapshot();
  const update = useUpdateStore((state) => state.result);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureText, setCaptureText] = useState('');
  const captureRef = useRef<HTMLDivElement>(null);
  const captureInputRef = useRef<HTMLTextAreaElement>(null);
  const today = todayKey();
  const overdueCount = snapshot.cards.filter(
    (card) => !card.completed && card.dueDate !== null && card.dueDate < today,
  ).length;

  useEffect(() => {
    if (!captureOpen) return;
    captureInputRef.current?.focus();
    const onMouseDown = (event: MouseEvent) => {
      if (!captureRef.current?.contains(event.target as Node)) setCaptureOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCaptureOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [captureOpen]);

  useEffect(() => {
    setCaptureOpen(false);
  }, [pathname]);

  const submitCapture = () => {
    const content = captureText.trim();
    if (!content) return;
    void addInbox(content)
      .then(() => {
        setCaptureText('');
        setCaptureOpen(false);
        notify('已放入收件箱', 'success');
      })
      .catch(() => undefined);
  };

  const boardId = pathname.startsWith('/board/') ? pathname.slice('/board/'.length) : null;
  const board = boardId ? snapshot.boards.find((item) => item.id === boardId) : undefined;
  const boardSetId = pathname.startsWith('/board-sets/')
    ? pathname.slice('/board-sets/'.length)
    : null;
  const boardSet = boardSetId
    ? snapshot.boardSets.find((item) => item.id === boardSetId)
    : undefined;
  const goalId = pathname.startsWith('/goals/') ? pathname.slice('/goals/'.length) : null;
  const goal = goalId ? snapshot.goals.find((item) => item.id === goalId) : undefined;
  const crumb = board ? (
    <>
      <button className="btn btn-icon" onClick={() => navigate('/')} aria-label="返回驾驶舱">
        <Icon name="arrow-left" size={15} />
      </button>
      <span>驾驶舱</span>
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
  ) : goal ? (
    <>
      <button className="btn btn-icon" onClick={() => navigate('/goals')} aria-label="返回目标">
        <Icon name="arrow-left" size={15} />
      </button>
      <span>目标</span>
      <Icon name="chevron-right" size={12} />
      <strong>{goal.title}</strong>
    </>
  ) : (
    <>
      <Icon name="layout-grid" size={14} />
      <strong>{sectionLabelFor(pathname) ?? '潮线'}</strong>
    </>
  );

  return (
    <header className="topbar topbar--command">
      <div className="topbar-crumb">{crumb}</div>
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        {update?.hasUpdate && update.latest ? (
          <button
            type="button"
            className="topbar-update"
            onClick={() => navigate('/settings')}
            title={`发现新版本 ${update.latest.version}`}
          >
            <Icon name="download" size={13} />
            可更新 v{update.latest.version}
          </button>
        ) : null}
        <button className="search-trigger command-search" onClick={openSearch} aria-label="搜索">
          <Icon name="search" size={15} />
          <span>搜索任务与看板</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="capture-wrap" ref={captureRef}>
          <button
            className="btn btn-ghost btn-sm capture-trigger"
            onClick={() => setCaptureOpen((open) => !open)}
            aria-expanded={captureOpen}
          >
            <Icon name="plus" size={14} />
            捕获
          </button>
          {captureOpen ? (
            <div className="capture-pop" role="dialog" aria-label="快速捕获">
              <div className="capture-pop-head">
                <span>快速捕获</span>
                <kbd>Ctrl Enter</kbd>
              </div>
              <textarea
                ref={captureInputRef}
                className="textarea capture-input"
                rows={3}
                placeholder="想到什么先记下来，稍后再整理进看板"
                value={captureText}
                onChange={(event) => setCaptureText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    submitCapture();
                  }
                }}
              />
              <div className="capture-pop-foot">
                <button className="btn btn-primary btn-sm" onClick={submitCapture}>
                  放入收件箱
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/inbox')}>
                  查看收件箱
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="topbar-status" title="本机时间与逾期任务">
          <strong>{formatMonthDay(today)}</strong>
          <span>{formatWeekday(today)}</span>
          {overdueCount > 0 ? <em>{overdueCount} 逾期</em> : <em className="is-clear">无逾期</em>}
        </div>
        <button className="btn btn-primary btn-sm topbar-new-board" onClick={openNewBoard}>
          <Icon name="plus" size={14} />
          <span>新建看板</span>
        </button>
      </div>
    </header>
  );
}
