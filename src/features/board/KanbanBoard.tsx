import { useState, type DragEvent } from 'react';
import type { Board, Card, List } from '@/lib/types';
import { useAppStore } from '@/store/appStore';
import { AddListColumn } from './AddListColumn';
import { KanbanColumn } from './KanbanColumn';

const EMPTY_CARDS: Card[] = [];
const AUTOSCROLL_EDGE = 48;
const AUTOSCROLL_STEP = 14;

interface DropTarget {
  listId: string;
  /** 当前渲染顺序下的落点下标（包含被拖拽卡片自身） */
  index: number;
}

interface KanbanBoardProps {
  board: Board;
  lists: List[];
  cardsByList: Map<string, Card[]>;
  accentColor: string;
}

/** 根据指针位置计算插入下标：把每张卡片看作上下两半 */
function indexFromPointer(container: HTMLElement, clientY: number): number {
  const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-card-id]'));
  for (let index = 0; index < cards.length; index += 1) {
    const rect = cards[index].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return index;
  }
  return cards.length;
}

/**
 * 看板画布：横向滚动，列内独立纵向滚动。
 * 原生 HTML5 拖拽：dragstart 记录卡片 id，dragover 计算落点画指示线，
 * drop 时把「视觉下标」换算成 moveCard 需要的「移除自身后的下标」。
 */
export function KanbanBoard({ board, lists, cardsByList, accentColor }: KanbanBoardProps) {
  const moveCard = useAppStore((state) => state.moveCard);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const handleCardDragStart = (cardId: string) => {
    setDraggingCardId(cardId);
    setDropTarget(null);
  };

  const handleCardDragEnd = () => {
    setDraggingCardId(null);
    setDropTarget(null);
  };

  const handleDragOverColumn = (
    listId: string,
    event: DragEvent<HTMLElement>,
    body: HTMLElement | null,
  ) => {
    if (!draggingCardId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const scroller = body ?? event.currentTarget;
    const index = indexFromPointer(scroller, event.clientY);

    // 长列表拖拽时靠近卡片区上下边缘自动滚动
    const rect = scroller.getBoundingClientRect();
    if (event.clientY < rect.top + AUTOSCROLL_EDGE) {
      scroller.scrollTop -= AUTOSCROLL_STEP;
    } else if (event.clientY > rect.bottom - AUTOSCROLL_EDGE) {
      scroller.scrollTop += AUTOSCROLL_STEP;
    }

    setDropTarget((prev) =>
      prev && prev.listId === listId && prev.index === index ? prev : { listId, index },
    );
  };

  const handleDropColumn = (
    listId: string,
    event: DragEvent<HTMLElement>,
    body: HTMLElement | null,
  ) => {
    event.preventDefault();
    const cardId = draggingCardId ?? event.dataTransfer.getData('text/plain');
    const reset = () => {
      setDraggingCardId(null);
      setDropTarget(null);
    };
    if (!cardId) {
      reset();
      return;
    }

    const targetCards = cardsByList.get(listId) ?? EMPTY_CARDS;
    const scroller = body ?? event.currentTarget;
    const visualIndex =
      dropTarget && dropTarget.listId === listId
        ? dropTarget.index
        : indexFromPointer(scroller, event.clientY);
    const fromIndex = targetCards.findIndex((card) => card.id === cardId);
    // moveCard 的 toIndex 是「移除被拖拽卡片之后」的下标
    const toIndex = fromIndex >= 0 && visualIndex > fromIndex ? visualIndex - 1 : visualIndex;

    reset();
    void moveCard(cardId, listId, toIndex).catch(() => undefined);
  };

  return (
    <div
      className="board-canvas-wrap"
      onDragOver={(event) => {
        if (!draggingCardId) return;
        // 拖到画布左右边缘时横向自动滚动，方便跨列
        const wrap = event.currentTarget;
        const rect = wrap.getBoundingClientRect();
        if (event.clientX < rect.left + AUTOSCROLL_EDGE) {
          wrap.scrollLeft -= AUTOSCROLL_STEP + 6;
        } else if (event.clientX > rect.right - AUTOSCROLL_EDGE) {
          wrap.scrollLeft += AUTOSCROLL_STEP + 6;
        }
      }}
    >
      <div className="board-canvas">
        {lists.map((list) => (
          <KanbanColumn
            key={list.id}
            boardId={board.id}
            list={list}
            cards={cardsByList.get(list.id) ?? EMPTY_CARDS}
            accentColor={accentColor}
            draggingCardId={draggingCardId}
            dropIndex={dropTarget?.listId === list.id ? dropTarget.index : null}
            isDropActive={dropTarget?.listId === list.id}
            onDragOverColumn={handleDragOverColumn}
            onDropColumn={handleDropColumn}
            onCardDragStart={handleCardDragStart}
            onCardDragEnd={handleCardDragEnd}
          />
        ))}
        <AddListColumn boardId={board.id} />
      </div>
    </div>
  );
}
