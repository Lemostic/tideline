import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { boardColorValue, type BoardView, type Card } from '@/lib/types';
import { useSnapshot } from '@/store/appStore';
import { BoardFilterBar } from '@/features/board/BoardFilterBar';
import { BoardHeader } from '@/features/board/BoardHeader';
import { CalendarView } from '@/features/board/CalendarView';
import { EmptyBoard } from '@/features/board/EmptyBoard';
import { EMPTY_FILTERS, filterCards, type BoardFilters } from '@/features/board/filters';
import { GanttView } from '@/features/board/GanttView';
import { KanbanBoard } from '@/features/board/KanbanBoard';
import { TableView } from '@/features/board/TableView';
import './board.css';

/**
 * 看板详情：头部（标题 / 星标 / 视图切换）+ 筛选条 + 各视图。
 * V0.3 起：看板 / 表格 / 甘特 / 日历均已实现，筛选条件跨视图生效。
 * 页面撑满内容区（topbar 56px 以下），横向滚动交给视图自身，纵向滚动交给每一列。
 */
export function BoardPage() {
  const { boardId } = useParams();
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const [view, setView] = useState<BoardView>('board');
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);

  const board = useMemo(
    () => (boardId ? snapshot.boards.find((item) => item.id === boardId) : undefined),
    [snapshot.boards, boardId],
  );

  const lists = useMemo(() => {
    if (!boardId) return [];
    return snapshot.lists
      .filter((list) => list.boardId === boardId)
      .sort((a, b) => a.position - b.position);
  }, [snapshot.lists, boardId]);

  const boardCards = useMemo(
    () => (boardId ? snapshot.cards.filter((card) => card.boardId === boardId) : []),
    [snapshot.cards, boardId],
  );

  // 筛选跨视图生效：看板列、表格、甘特、日历都只看过滤后的任务
  const visibleCards = useMemo(() => filterCards(boardCards, filters), [boardCards, filters]);

  // 按列表分组并按 position 升序；排序后的数组只在这里派生一次
  const cardsByList = useMemo(() => {
    const map = new Map<string, Card[]>();
    for (const list of lists) map.set(list.id, []);
    for (const card of visibleCards) {
      const bucket = map.get(card.listId);
      if (bucket) bucket.push(card);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [visibleCards, lists]);

  const stats = useMemo(() => {
    let completed = 0;
    for (const card of boardCards) {
      if (card.completed) completed += 1;
    }
    return { total: boardCards.length, completed };
  }, [boardCards]);

  if (!board) {
    return (
      <div className="page">
        <EmptyState
          icon={<Icon name="layout-grid" size={22} />}
          title="看板不存在"
          description="它可能已经被删除，返回首页看看其他看板吧。"
          action={
            <button type="button" className="btn btn-ghost" onClick={() => navigate('/')}>
              返回首页
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="board-page">
      <BoardHeader
        board={board}
        view={view}
        onViewChange={setView}
        totalCards={stats.total}
        completedCards={stats.completed}
      />
      <BoardFilterBar
        filters={filters}
        onChange={setFilters}
        cards={boardCards}
        visibleCount={visibleCards.length}
        totalCount={boardCards.length}
      />
      {view === 'board' ? (
        lists.length === 0 ? (
          <EmptyBoard boardId={board.id} />
        ) : (
          <KanbanBoard
            board={board}
            lists={lists}
            cardsByList={cardsByList}
            accentColor={boardColorValue(board.color)}
          />
        )
      ) : view === 'table' ? (
        <TableView board={board} lists={lists} cards={visibleCards} />
      ) : view === 'gantt' ? (
        <GanttView board={board} lists={lists} cards={visibleCards} />
      ) : (
        <CalendarView board={board} lists={lists} cards={visibleCards} />
      )}
    </div>
  );
}
