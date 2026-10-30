import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '@/components/Icon';
import { boardColorValue, type Board, type BoardView } from '@/lib/types';
import { useAppStore } from '@/store/appStore';
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
}

/** 看板头部：主题色点 + 可编辑标题 + 星标 + 更多菜单 + 视图 Tabs */
export function BoardHeader({
  board,
  view,
  onViewChange,
  totalCards,
  completedCards,
}: BoardHeaderProps) {
  const navigate = useNavigate();
  const updateBoard = useAppStore((state) => state.updateBoard);
  const toggleStar = useAppStore((state) => state.toggleStar);
  const deleteBoard = useAppStore((state) => state.deleteBoard);
  const [editingTitle, setEditingTitle] = useState(false);

  const accent = boardColorValue(board.color);
  const statText = useMemo(() => {
    if (totalCards === 0) return '还没有任务';
    if (completedCards > 0) return `共 ${totalCards} 个任务 · 已完成 ${completedCards}`;
    return `共 ${totalCards} 个任务`;
  }, [totalCards, completedCards]);

  const handleDelete = async () => {
    const confirmed = window.confirm(
      `确定删除看板「${board.title}」吗？其中的 ${totalCards} 个任务会一起删除，且无法恢复。`,
    );
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
              label: '删除看板',
              icon: 'trash',
              danger: true,
              onSelect: () => void handleDelete(),
            },
          ]}
        />
        <span className="grow" />
        <span className="board-stat">{statText}</span>
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
