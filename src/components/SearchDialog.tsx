import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { breadcrumbOf } from '@/lib/taskTree';
import { useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';

/**
 * 全局搜索：看板 + 任务标题模糊匹配。
 * Ctrl/Cmd + K 唤起；回车打开第一条结果。
 */
export function SearchDialog() {
  const open = useUiStore((state) => state.searchOpen);
  const close = useUiStore((state) => state.closeSearch);
  const openCard = useUiStore((state) => state.openCard);
  const snapshot = useSnapshot();
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    if (open) setKeyword('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  const { boards, cards } = useMemo(() => {
    const term = keyword.trim().toLowerCase();
    if (!term) return { boards: [], cards: [] };
    return {
      boards: snapshot.boards.filter((board) => board.title.toLowerCase().includes(term)).slice(0, 5),
      cards: snapshot.cards
        .filter((card) => card.title.toLowerCase().includes(term))
        .slice(0, 8),
    };
  }, [keyword, snapshot.boards, snapshot.cards]);

  if (!open) return null;

  const boardName = (boardId: string) =>
    snapshot.boards.find((board) => board.id === boardId)?.title ?? '未知看板';

  const goBoard = (boardId: string) => {
    close();
    navigate(`/board/${boardId}`);
  };

  const goCard = (cardId: string, boardId: string) => {
    close();
    navigate(`/board/${boardId}`);
    openCard(cardId);
  };

  const firstResult = boards[0]
    ? () => goBoard(boards[0].id)
    : cards[0]
      ? () => goCard(cards[0].id, cards[0].boardId)
      : null;

  return (
    <div
      className="overlay"
      style={{ alignItems: 'flex-start', paddingTop: '12vh' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="搜索">
        <div className="search-panel-head">
          <Icon name="search" size={17} />
          <input
            className="search-panel-input"
            placeholder="搜索看板或任务…"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && firstResult) firstResult();
            }}
            autoFocus
          />
          <span className="kbd">ESC</span>
        </div>

        <div className="search-results">
          {!keyword.trim() ? (
            <div className="search-empty">输入关键词，开始搜索全部看板与任务</div>
          ) : boards.length === 0 && cards.length === 0 ? (
            <div className="search-empty">没有找到「{keyword.trim()}」相关内容</div>
          ) : (
            <>
              {boards.length > 0 ? (
                <>
                  <div className="search-group-label">看板</div>
                  {boards.map((board) => (
                    <button key={board.id} className="search-result" onClick={() => goBoard(board.id)}>
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 3,
                          background: 'var(--primary)',
                          flex: '0 0 auto',
                        }}
                      />
                      <span className="search-result-main">
                        <span className="search-result-title">{board.title}</span>
                        <span className="search-result-meta">打开看板</span>
                      </span>
                      <Icon name="chevron-right" size={14} />
                    </button>
                  ))}
                </>
              ) : null}
              {cards.length > 0 ? (
                <>
                  <div className="search-group-label">任务</div>
                  {cards.map((card) => (
                    <button
                      key={card.id}
                      className="search-result"
                      onClick={() => goCard(card.id, card.boardId)}
                    >
                      <Icon name="check-circle" size={15} />
                      <span className="search-result-main">
                        <span className="search-result-title">{card.title}</span>
                        <span className="search-result-meta">
                          {[
                            boardName(card.boardId),
                            ...breadcrumbOf(snapshot.cards, card.id)
                              .slice(0, -1)
                              .map((node) => node.title),
                          ].join(' › ')}
                        </span>
                      </span>
                      <Icon name="arrow-up-right" size={13} />
                    </button>
                  ))}
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
