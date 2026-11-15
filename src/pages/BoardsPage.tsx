import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { BoardCard, NewBoardCard } from '@/features/home/BoardCard';
import { DeleteBoardDialog, RenameBoardDialog } from '@/features/home/BoardDialogs';
import { rootCards } from '@/lib/taskTree';
import type { Board } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import './boards.css';

export function BoardsPage() {
  const snapshot = useSnapshot();
  const toggleStar = useAppStore((state) => state.toggleStar);
  const openNewBoard = useUiStore((state) => state.openNewBoard);
  const [renameTarget, setRenameTarget] = useState<Board | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Board | null>(null);
  const taskCards = useMemo(() => rootCards(snapshot.cards), [snapshot.cards]);
  const countByBoard = useMemo(() => {
    const map = new Map<string, number>();
    for (const card of taskCards) map.set(card.boardId, (map.get(card.boardId) ?? 0) + 1);
    return map;
  }, [taskCards]);

  return (
    <div className="page boards-page">
      <header className="boards-head">
        <div>
          <span className="boards-kicker">BOARD DECK</span>
          <h1>看板</h1>
          <p>
            {snapshot.boards.length} 个看板 · {taskCards.length} 项任务 · 全部保存在本机
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={openNewBoard}>
          <Icon name="plus" size={14} />
          新建看板
        </button>
      </header>

      <div className="boards-grid">
        {snapshot.boards.map((board) => (
          <BoardCard
            key={board.id}
            board={board}
            taskCount={countByBoard.get(board.id) ?? 0}
            onToggleStar={(target) => void toggleStar(target.id).catch(() => undefined)}
            onRename={setRenameTarget}
            onDelete={setDeleteTarget}
          />
        ))}
        <NewBoardCard onClick={openNewBoard} />
      </div>

      {renameTarget ? (
        <RenameBoardDialog board={renameTarget} onClose={() => setRenameTarget(null)} />
      ) : null}
      {deleteTarget ? (
        <DeleteBoardDialog
          board={deleteTarget}
          listCount={
            snapshot.lists.filter((list) => list.boardId === deleteTarget.id).length
          }
          taskCount={countByBoard.get(deleteTarget.id) ?? 0}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </div>
  );
}
