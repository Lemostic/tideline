import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '@/components/Icon';
import { boardColorValue, type Board, type BoardView } from '@/lib/types';
import { useAppStore } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import { InlineEdit } from './InlineEdit';
import { PopMenu } from './PopMenu';

const VIEW_TABS: ReadonlyArray<{ key: BoardView; label: string; icon: IconName }> = [
  { key: 'board', label: '看板', icon: 'columns' },
  { key: 'table', label: '表格', icon: 'table' },
  { key: 'gantt', label: '甘特', icon: 'gantt' },
  { key: 'calendar', label: '日历', icon: 'calendar-view' },
];

interface BoardHeaderProps {
  board: Board;
  view: BoardView;
  onViewChange: (view: BoardView) => void;
  totalCards: number;
  completedCards: number;
  batchMode: boolean;
  onToggleBatchMode: () => void;
  showDependencyLegend?: boolean;
  /** 打开看板的自定义字段管理弹窗 */
  onOpenCustomFields: () => void;
}

/** 看板头部：主题色点 + 可编辑标题 + 星标 + 更多菜单 + 视图 Tabs */
export function BoardHeader({
  board,
  view,
  onViewChange,
  totalCards,
  completedCards,
  batchMode,
  onToggleBatchMode,
  showDependencyLegend = false,
  onOpenCustomFields,
}: BoardHeaderProps) {
  const navigate = useNavigate();
  const updateBoard = useAppStore((state) => state.updateBoard);
  const toggleStar = useAppStore((state) => state.toggleStar);
  const deleteBoard = useAppStore((state) => state.deleteBoard);
  const requestConfirm = useUiStore((state) => state.requestConfirm);
  const [editingTitle, setEditingTitle] = useState(false);

  const accent = boardColorValue(board.color);

  const handleDelete = async () => {
    const confirmed = await requestConfirm({
      title: `删除看板「${board.title}」`,
      description: '看板和其中的任务会一起删除，之后无法恢复。',
      details: totalCards > 0 ? [`其中有 ${totalCards} 个任务`] : undefined,
      confirmLabel: '删除看板',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await deleteBoard(board.id);
      navigate('/');
    } catch {
      // 错误由全局错误条提示
    }
  };

  return (
    <header className="board-header">
      <div className="board-header-main">
        <span className="board-color-dot" style={{ background: accent }} title="看板主题色" />
        <InlineEdit
          value={board.title}
          editing={editingTitle}
          onEditingChange={setEditingTitle}
          onCommit={(next) => void updateBoard(board.id, { title: next })}
          ariaLabel="看板名称"
          displayClassName="board-title-btn"
          inputClassName="board-title-input"
          maxLength={60}
          title="点击重命名看板"
        />
        <button
          type="button"
          className={`btn btn-icon board-star${board.starred ? ' is-on' : ''}`}
          onClick={() => void toggleStar(board.id)}
          aria-label={board.starred ? '取消星标' : '添加星标'}
          title={board.starred ? '取消星标' : '添加星标'}
        >
          <Icon name={board.starred ? 'star-filled' : 'star'} size={16} />
        </button>
        <PopMenu
          ariaLabel="看板更多操作"
          entries={[
            {
              kind: 'item',
              label: '重命名看板',
              icon: 'pencil',
              onSelect: () => setEditingTitle(true),
            },
            { kind: 'sep' },
            {
              kind: 'item',
              label: '自定义字段',
              icon: 'sliders',
              onSelect: () => onOpenCustomFields(),
            },
            { kind: 'sep' },
            {
              kind: 'item',
              label: '删除看板',
              icon: 'trash',
              danger: true,
              onSelect: () => void handleDelete(),
            },
          ]}
        />
        <span className="grow" />
        {showDependencyLegend ? (
          <span className="board-dependency-legend" title="虚线从黄色圆点的前置任务指向箭头所在的后置任务">
            <span className="board-dependency-dot" />
            前置任务 → 后置任务
          </span>
        ) : null}
        <span className="board-readout">
          {totalCards === 0 ? (
            <span className="board-readout-empty">还没有任务</span>
          ) : (
            <>
              <span className="board-readout-item">
                <span className="board-readout-label">任务</span>
                <span className="board-readout-value">{totalCards}</span>
              </span>
              {completedCards > 0 ? (
                <>
                  <span className="board-readout-divider" aria-hidden="true" />
                  <span className="board-readout-item">
                    <span className="board-readout-label">已完成</span>
                    <span className="board-readout-value is-success">{completedCards}</span>
                  </span>
                </>
              ) : null}
            </>
          )}
        </span>
      </div>

      <div className="board-toolbar">
        <div className="board-tabs" role="tablist" aria-label="切换视图">
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={view === tab.key}
              className={`board-tab${view === tab.key ? ' is-active' : ''}`}
              onClick={() => onViewChange(tab.key)}
            >
              <Icon name={tab.icon} size={14} />
              {tab.label}
            </button>
          ))}
        </div>
        {view === 'board' ? (
          <button
            type="button"
            className={`btn btn-sm board-batch-btn${batchMode ? ' is-active' : ''}`}
            onClick={onToggleBatchMode}
            aria-pressed={batchMode}
            title={batchMode ? '退出批量选择' : '进入批量选择'}
          >
            <Icon name="check-circle" size={14} />
            {batchMode ? '退出批量' : '批量操作'}
          </button>
        ) : null}
        <span className="grow" />
        {board.description ? (
          <span className="board-desc" title={board.description}>
            {board.description}
          </span>
        ) : (
          <span className="board-toolbar-hint">拖动卡片可在列表之间移动</span>
        )}
      </div>
    </header>
  );
}
