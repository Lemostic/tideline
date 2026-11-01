import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { PRIORITY_META, boardColorValue, type BoardView, type Card } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
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
  const defaultView = useSettingsStore((state) => state.defaultView);
  const showDependencyLines = useSettingsStore((state) => state.showDependencyLines);
  const bulkMoveCards = useAppStore((state) => state.bulkMoveCards);
  const bulkDeleteCards = useAppStore((state) => state.bulkDeleteCards);
  const requestConfirm = useUiStore((state) => state.requestConfirm);
  const bulkUpdateCards = useAppStore((state) => state.bulkUpdateCards);
  const [view, setView] = useState<BoardView>(() => defaultView);
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

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

  const hasBoardDependencies = useMemo(() => {
    if (!showDependencyLines || !boardId) return false;
    const ids = new Set(boardCards.map((card) => card.id));
    return snapshot.dependencies.some(
      (dependency) =>
        ids.has(dependency.cardId) && ids.has(dependency.dependsOnCardId),
    );
  }, [boardCards, boardId, showDependencyLines, snapshot.dependencies]);

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

  const selectedCardIds = useMemo(() => [...selectedIds], [selectedIds]);
  const busySelection = selectedCardIds.length === 0;
  const exitBatch = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
  };
  const changeView = (next: BoardView) => {
    if (next !== 'board') exitBatch();
    setView(next);
  };
  const toggleBatchMode = () => {
    if (batchMode) exitBatch();
    else setBatchMode(true);
  };
  const toggleSelect = (cardId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  };
  const selectAllVisible = () => {
    setSelectedIds(new Set(visibleCards.map((card) => card.id)));
  };
  const runBulk = async (action: () => Promise<void>) => {
    if (busySelection) return;
    try {
      await action();
      setSelectedIds(new Set());
    } catch {
      // 错误由全局错误条提示
    }
  };
  const handleBulkMove = async (toListId: string) => {
    if (!toListId || busySelection) return;
    await runBulk(() => bulkMoveCards(selectedCardIds, toListId));
  };
  const handleBulkPriority = async (value: string) => {
    if (!value || busySelection) return;
    const priority = value === 'none' ? null : (value as 'low' | 'medium' | 'high');
    await runBulk(() => bulkUpdateCards(selectedCardIds, { priority }));
  };
  const handleBulkComplete = async () => {
    await runBulk(() => bulkUpdateCards(selectedCardIds, { completed: true }));
  };
  const handleBulkDelete = async () => {
    if (busySelection) return;
    const confirmed = await requestConfirm({
      title: `移入回收站 ${selectedCardIds.length} 个任务`,
      description: '这些任务会进入回收站，需要时可以在回收站恢复。',
      confirmLabel: '移入回收站',
    });
    if (!confirmed) return;
    await runBulk(() => bulkDeleteCards(selectedCardIds));
  };

  if (!board) {
    return (
      <div className="page">
        <EmptyState
          icon={<Icon name="layout-grid" size={22} />}
          title="看板不存在"
          description="它可能已经被删除，返回工作台看看其他看板吧。"
          action={
            <button type="button" className="btn btn-ghost" onClick={() => navigate('/')}>
              返回工作台
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
        onViewChange={changeView}
        totalCards={stats.total}
        completedCards={stats.completed}
        batchMode={batchMode}
        onToggleBatchMode={toggleBatchMode}
        showDependencyLegend={view === 'board' && hasBoardDependencies}
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
            batchMode={batchMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
          />
        )
      ) : view === 'table' ? (
        <TableView board={board} lists={lists} cards={visibleCards} />
      ) : view === 'gantt' ? (
        <GanttView board={board} lists={lists} cards={visibleCards} />
      ) : (
        <CalendarView board={board} lists={lists} cards={visibleCards} />
      )}

      {batchMode && view === 'board' ? (
        <div className="bulk-bar" role="region" aria-label="批量操作">
          <span className="bulk-count">已选 {selectedIds.size} 个任务</span>
          <div className="bulk-bar-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={selectAllVisible}>
              全选当前视图
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSelectedIds(new Set())}
              disabled={selectedIds.size === 0}
            >
              清除
            </button>
            <label className="bulk-select">
              <span className="sr-only">移动到列表</span>
              <select
                aria-label="移动到列表"
                value=""
                disabled={busySelection}
                onChange={(event) => {
                  const value = event.target.value;
                  event.target.value = '';
                  void handleBulkMove(value);
                }}
              >
                <option value="">移动到…</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="bulk-select">
              <span className="sr-only">设置优先级</span>
              <select
                aria-label="设置优先级"
                value=""
                disabled={busySelection}
                onChange={(event) => {
                  const value = event.target.value;
                  event.target.value = '';
                  void handleBulkPriority(value);
                }}
              >
                <option value="">优先级…</option>
                {PRIORITY_META.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}优先级
                  </option>
                ))}
                <option value="none">清除优先级</option>
              </select>
            </label>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void handleBulkComplete()}
              disabled={busySelection}
            >
              标记完成
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => void handleBulkDelete()}
              disabled={busySelection}
            >
              <Icon name="trash" size={13} />
              删除
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={exitBatch}>
              退出
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
