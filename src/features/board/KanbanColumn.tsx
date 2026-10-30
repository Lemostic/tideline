import { useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Icon } from '@/components/Icon';
import type { Card, List } from '@/lib/types';
import { useAppStore } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import { AddCardComposer } from './AddCardComposer';
import { InlineEdit } from './InlineEdit';
import { PopMenu } from './PopMenu';
import { TaskCard } from './TaskCard';

interface KanbanColumnProps {
  boardId: string;
  list: List;
  cards: Card[];
  accentColor: string;
  draggingCardId: string | null;
  /** 落点下标（按当前渲染顺序，含被拖拽卡片自身）；null 表示不是目标列 */
  dropIndex: number | null;
  isDropActive: boolean;
  onDragOverColumn: (
    listId: string,
    event: DragEvent<HTMLElement>,
    body: HTMLElement | null,
  ) => void;
  onDropColumn: (listId: string, event: DragEvent<HTMLElement>, body: HTMLElement | null) => void;
  onCardDragStart: (cardId: string) => void;
  onCardDragEnd: () => void;
}

/** 看板列：列表头（内联改名 / 任务数 / 添加 / 更多）+ 可滚动卡片区 + 行内新增卡片 */
export function KanbanColumn({
  boardId,
  list,
  cards,
  accentColor,
  draggingCardId,
  dropIndex,
  isDropActive,
  onDragOverColumn,
  onDropColumn,
  onCardDragStart,
  onCardDragEnd,
}: KanbanColumnProps) {
  const updateList = useAppStore((state) => state.updateList);
  const deleteList = useAppStore((state) => state.deleteList);
  const openCard = useUiStore((state) => state.openCard);
  const [editingTitle, setEditingTitle] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const columnStyle = { '--column-accent': accentColor } as CSSProperties;

  const handleDelete = async () => {
    const confirmed = window.confirm(
      `确定删除列表「${list.title}」及其中 ${cards.length} 个任务吗？此操作不可恢复。`,
    );
    if (!confirmed) return;
    try {
      await deleteList(list.id);
    } catch {
      // 错误由全局错误条提示
    }
  };

  return (
    <section
      className={`board-column${isDropActive ? ' is-drop-over' : ''}`}
      style={columnStyle}
      aria-label={`列表：${list.title}`}
      // 拖拽事件挂在整列上：卡片下方空白、列头、底部区域都能接收放置，
      // 不再受「卡片区高度只到内容高度」影响。
      onDragOver={(event) => onDragOverColumn(list.id, event, bodyRef.current)}
      onDrop={(event) => onDropColumn(list.id, event, bodyRef.current)}
    >
      <header className="board-column-head">
        <InlineEdit
          value={list.title}
          editing={editingTitle}
          onEditingChange={setEditingTitle}
          onCommit={(next) => void updateList(list.id, { title: next })}
          ariaLabel="列表名称"
          displayClassName="column-title-btn"
          inputClassName="column-title-input"
          maxLength={60}
          title="点击重命名列表"
        />
        <span className="column-count" title={`${cards.length} 个任务`}>
          {cards.length}
        </span>
        <div className="column-head-actions">
          <button
            type="button"
            className="btn btn-icon column-icon-btn"
            onClick={() => setComposerOpen(true)}
            aria-label="添加任务"
            title="添加任务"
          >
            <Icon name="plus" size={15} />
          </button>
          <PopMenu
            ariaLabel="列表更多操作"
            entries={[
              {
                kind: 'item',
                label: '重命名列表',
                icon: 'pencil',
                onSelect: () => setEditingTitle(true),
              },
              { kind: 'sep' },
              {
                kind: 'item',
                label: '删除列表',
                icon: 'trash',
                danger: true,
                onSelect: () => void handleDelete(),
              },
            ]}
          />
        </div>
      </header>

      <div className="board-column-body" ref={bodyRef}>
        {cards.map((card, index) => (
          <TaskCard
            key={card.id}
            card={card}
            dragging={draggingCardId === card.id}
            dropSide={
              dropIndex === index
                ? 'before'
                : dropIndex === cards.length && index === cards.length - 1
                  ? 'end'
                  : null
            }
            onOpen={() => openCard(card.id)}
            onCardDragStart={onCardDragStart}
            onCardDragEnd={onCardDragEnd}
          />
        ))}
        {cards.length === 0 ? (
          <div className={`column-empty${isDropActive ? ' is-target' : ''}`}>
            {isDropActive ? '松开，把任务放到这里' : '暂无任务'}
          </div>
        ) : null}
      </div>

      <footer className="board-column-foot">
        <AddCardComposer
          boardId={boardId}
          listId={list.id}
          open={composerOpen}
          onOpenChange={setComposerOpen}
        />
      </footer>
    </section>
  );
}
