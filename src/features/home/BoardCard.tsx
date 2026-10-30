import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { formatRelativeTime } from '@/lib/date';
import { boardColorValue, type Board } from '@/lib/types';

interface BoardCardProps {
  board: Board;
  /** 看板内任务总数 */
  taskCount: number;
  onToggleStar: (board: Board) => void;
  onRename: (board: Board) => void;
  onDelete: (board: Board) => void;
}

/** 首页看板卡片：点击进入看板，右上角可星标或打开更多菜单 */
export function BoardCard({ board, taskCount, onToggleStar, onRename, onDelete }: BoardCardProps) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const openBoard = () => navigate(`/board/${board.id}`);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openBoard();
    }
  };

  return (
    <article
      className="home-board-card"
      style={{ '--board-color': boardColorValue(board.color) } as CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={`打开看板：${board.title}`}
      onClick={openBoard}
      onKeyDown={handleKeyDown}
    >
      <div className="home-board-head">
        <h3 className="home-board-title ellipsis" title={board.title}>
          {board.title}
        </h3>
        <div
          className="home-board-tools"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={`home-board-star${board.starred ? ' on' : ''}`}
            aria-label={board.starred ? '取消星标' : '加星标'}
            aria-pressed={board.starred}
            title={board.starred ? '取消星标' : '加星标'}
            onClick={() => onToggleStar(board)}
          >
            <Icon name={board.starred ? 'star-filled' : 'star'} size={14} />
          </button>
          <div className="menu" ref={menuRef}>
            <button
              type="button"
              className={`home-board-more${menuOpen ? ' open' : ''}`}
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="更多操作"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Icon name="more" size={15} />
            </button>
            {menuOpen ? (
              <div className="menu-pop right home-board-menu" role="menu">
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onRename(board);
                  }}
                >
                  <Icon name="pencil" size={13} />
                  重命名
                </button>
                <div className="menu-sep" />
                <button
                  type="button"
                  className="menu-item danger"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete(board);
                  }}
                >
                  <Icon name="trash" size={13} />
                  删除看板
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <p className={`home-board-desc${board.description ? '' : ' is-empty'}`}>
        {board.description || '还没有描述，点开看板补充一句吧'}
      </p>

      <div className="home-board-foot">
        <span className="home-board-stat">
          <Icon name="check-circle" size={12} />
          {taskCount} 个任务
        </span>
        <span className="home-board-sep" aria-hidden="true">
          ·
        </span>
        <span className="home-board-time">更新于 {formatRelativeTime(board.updatedAt)}</span>
      </div>
    </article>
  );
}

interface NewBoardCardProps {
  onClick: () => void;
}

/** 全部看板网格末尾的虚线新建卡片 */
export function NewBoardCard({ onClick }: NewBoardCardProps) {
  return (
    <button type="button" className="home-new-board" onClick={onClick}>
      <span className="home-new-board-plus">
        <Icon name="plus" size={18} />
      </span>
      <span className="home-new-board-title">新建看板</span>
      <span className="home-new-board-sub">从一块空白画布开始</span>
    </button>
  );
}
