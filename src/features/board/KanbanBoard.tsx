import { useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { dependencyPath, type CardBox } from '@/lib/dependencyLayout';
import type { Board, Card, List } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useSettingsStore } from '@/store/settingsStore';
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

interface DependencyLine {
  key: string;
  d: string;
  done: boolean;
  from: string;
  to: string;
}

interface KanbanBoardProps {
  board: Board;
  lists: List[];
  cardsByList: Map<string, Card[]>;
  accentColor: string;
  batchMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (cardId: string) => void;
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
export function KanbanBoard({
  board,
  lists,
  cardsByList,
  accentColor,
  batchMode,
  selectedIds,
  onToggleSelect,
}: KanbanBoardProps) {
  const moveCard = useAppStore((state) => state.moveCard);
  const snapshot = useSnapshot();
  const showDependencyLines = useSettingsStore((state) => state.showDependencyLines);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [dependencyLines, setDependencyLines] = useState<DependencyLine[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);

  // 任务链连线：按卡片实际 DOM 位置计算曲线路径，滚动 / 缩放 / 筛选后重算。
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!showDependencyLines || !canvas) {
      setDependencyLines([]);
      return;
    }

    const cardsById = new Map(snapshot.cards.map((card) => [card.id, card]));
    let frame = 0;
    const update = () => {
      frame = 0;
      const canvasRect = canvas.getBoundingClientRect();
      const boxes = new Map<string, CardBox>();
      canvas.querySelectorAll<HTMLElement>('[data-card-id]').forEach((element) => {
        const cardId = element.dataset.cardId;
        if (!cardId) return;
        const rect = element.getBoundingClientRect();
        boxes.set(cardId, {
          left: rect.left - canvasRect.left,
          top: rect.top - canvasRect.top,
          right: rect.right - canvasRect.left,
          bottom: rect.bottom - canvasRect.top,
          width: rect.width,
          height: rect.height,
        });
      });

      const next: DependencyLine[] = [];
      for (const dependency of snapshot.dependencies) {
        const from = boxes.get(dependency.dependsOnCardId);
        const to = boxes.get(dependency.cardId);
        if (!from || !to) continue;
        const path = dependencyPath(from, to);
        if (!path) continue;
        next.push({
          key: `${dependency.dependsOnCardId}->${dependency.cardId}`,
          d: path,
          done: cardsById.get(dependency.dependsOnCardId)?.completed === true,
          from: dependency.dependsOnCardId,
          to: dependency.cardId,
        });
      }
      setDependencyLines(next);
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, [cardsByList, showDependencyLines, snapshot.cards, snapshot.dependencies]);

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
      <div className="board-canvas" ref={canvasRef}>
        {lists.map((list) => (
          <KanbanColumn
            key={list.id}
            boardId={board.id}
            list={list}
            cards={cardsByList.get(list.id) ?? EMPTY_CARDS}
            accentColor={accentColor}
            draggingCardId={draggingCardId}
            batchMode={batchMode}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
            dropIndex={dropTarget?.listId === list.id ? dropTarget.index : null}
            isDropActive={dropTarget?.listId === list.id}
            onDragOverColumn={handleDragOverColumn}
            onDropColumn={handleDropColumn}
            onCardDragStart={handleCardDragStart}
            onCardDragEnd={handleCardDragEnd}
          />
        ))}
        <AddListColumn boardId={board.id} />
        {showDependencyLines && dependencyLines.length > 0 ? (
          <svg className="dependency-layer" aria-hidden="true">
            <defs>
              <marker
                id="dependency-arrow"
                viewBox="0 0 12 12"
                refX="10"
                refY="6"
                markerWidth="9"
                markerHeight="9"
                orient="auto"
              >
                <path d="M 1 1 L 11 6 L 1 11 Z" />
              </marker>
              <marker
                id="dependency-start"
                viewBox="0 0 8 8"
                refX="4"
                refY="4"
                markerWidth="5"
                markerHeight="5"
                orient="auto"
              >
                <circle cx="4" cy="4" r="3" />
              </marker>
            </defs>
            {dependencyLines.map((line) => (
              <path
                key={line.key}
                d={line.d}
                className={`dependency-line${line.done ? ' is-done' : ''}`}
                data-dep-from={line.from}
                data-dep-to={line.to}
                markerStart="url(#dependency-start)"
                markerEnd="url(#dependency-arrow)"
              />
            ))}
            </svg>
        ) : null}
      </div>
    </div>
  );
}
