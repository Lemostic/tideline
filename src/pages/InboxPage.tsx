import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { EmptyState, Modal } from '@/components/Modal';
import { formatRelativeTime } from '@/lib/date';
import type { InboxItem } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import './inbox.css';

/**
 * 收件箱：先把念头记下来，再挑一条转成看板任务。
 * 全部操作都走本地快照，新增后清空输入并保持焦点，方便连续记录。
 */
export function InboxPage() {
  const snapshot = useSnapshot();
  const addInbox = useAppStore((state) => state.addInbox);
  const deleteInbox = useAppStore((state) => state.deleteInbox);

  const [text, setText] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [convertTarget, setConvertTarget] = useState<InboxItem | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const items = useMemo(
    () => [...snapshot.inbox].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [snapshot.inbox],
  );
  const hasBoards = snapshot.boards.length > 0;

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 5200);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const submit = async () => {
    const content = text.trim();
    if (!content) return;
    setText('');
    try {
      await addInbox(content);
    } catch {
      setText(content);
      return;
    }
    textareaRef.current?.focus();
  };

  const remove = async (id: string) => {
    setConfirmId(null);
    try {
      await deleteInbox(id);
    } catch {
      /* 失败信息由全局提示条统一展示 */
    }
  };

  return (
    <div className="page inbox-page">
      <div className="page-head">
        <h1 className="page-title">收件箱</h1>
        <p className="page-sub">先把念头记下来，不用想清楚属于哪个看板</p>
        <div className="page-actions">
          <span className={`inbox-pill${items.length === 0 ? ' is-empty' : ''}`}>
            <Icon name="inbox" size={13} />
            {items.length} 条待整理
          </span>
        </div>
      </div>

      <div className="inbox-composer">
        <textarea
          ref={textareaRef}
          className="inbox-textarea"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="记点什么……比如：研究 Tauri 2 的自动更新方案"
          aria-label="快速记录"
        />
        <div className="inbox-composer-foot">
          <span className="inbox-hint">
            <span className="kbd">Ctrl</span>
            <span aria-hidden="true">+</span>
            <span className="kbd">Enter</span>
            <span>快速记录</span>
          </span>
          <span className="grow" />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void submit()}
            disabled={!text.trim()}
          >
            <Icon name="plus" size={13} />
            记下来
          </button>
        </div>
      </div>

      {!hasBoards ? (
        <div className="inbox-note">
          <Icon name="info" size={14} />
          <span>还没有看板，暂时只能收集。创建看板后，这里的条目就能一键转成任务。</span>
        </div>
      ) : null}

      {flash ? (
        <div className="inbox-flash" role="status">
          <Icon name="check-circle" size={14} />
          <span className="inbox-flash-text">{flash}</span>
          <button
            type="button"
            className="inbox-flash-close"
            onClick={() => setFlash(null)}
            aria-label="关闭提示"
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="section-head inbox-section-head">
          <span className="section-title">待整理</span>
          <span className="section-count">{items.length} 条</span>
          <div className="section-actions">
            <span className="inbox-hint">按记录时间倒序</span>
          </div>
        </div>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon={<Icon name="inbox" size={22} />}
          title="收件箱是空的"
          description="把脑子里冒出来的念头先丢进来——不用想它属于哪个看板，整理时再一键变成任务。"
        />
      ) : (
        <ul className="inbox-list">
          {items.map((item) => (
            <li className="inbox-item" key={item.id}>
              <div className="inbox-item-body">
                <p className="inbox-item-text">{item.content}</p>
                <div className="inbox-item-meta">
                  <Icon name="clock" size={11} />
                  <span>{formatRelativeTime(item.createdAt)}</span>
                </div>
              </div>

              <div className="inbox-item-actions">
                {confirmId === item.id ? (
                  <span className="inbox-confirm">
                    <span className="inbox-confirm-text">删除这条？</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => void remove(item.id)}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-quiet"
                      onClick={() => setConfirmId(null)}
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm inbox-convert-btn"
                      onClick={() => setConvertTarget(item)}
                    >
                      <Icon name="arrow-up-right" size={13} />
                      转为任务
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon inbox-delete-btn"
                      onClick={() => setConfirmId(item.id)}
                      aria-label="删除这条记录"
                      title="删除"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {convertTarget ? (
        <ConvertInboxDialog
          item={convertTarget}
          onClose={() => setConvertTarget(null)}
          onConverted={(message) => {
            setConvertTarget(null);
            setFlash(message);
          }}
        />
      ) : null}
    </div>
  );
}

interface ConvertInboxDialogProps {
  item: InboxItem;
  onClose: () => void;
  onConverted: (message: string) => void;
}

/** 转为任务：选择看板 + 列表；看板或列表缺失时给出引导而不是直接报错 */
function ConvertInboxDialog({ item, onClose, onConverted }: ConvertInboxDialogProps) {
  const snapshot = useSnapshot();
  const convertInbox = useAppStore((state) => state.convertInbox);

  const boards = snapshot.boards;
  const [boardId, setBoardId] = useState(boards[0]?.id ?? '');
  const [listId, setListId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const lists = useMemo(
    () =>
      snapshot.lists
        .filter((list) => list.boardId === boardId)
        .sort((a, b) => a.position - b.position),
    [snapshot.lists, boardId],
  );
  // 切换看板后原列表可能已不属于该看板，回落到第一个列表
  const activeListId = lists.some((list) => list.id === listId) ? listId : (lists[0]?.id ?? '');
  const canSubmit = Boolean(boardId) && Boolean(activeListId) && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const card = await convertInbox(item.id, boardId, activeListId);
      const board = snapshot.boards.find((entry) => entry.id === boardId);
      const list = snapshot.lists.find((entry) => entry.id === activeListId);
      onConverted(
        `已转为任务「${card.title}」，放入 ${board?.title ?? '看板'} · ${list?.title ?? '列表'}`,
      );
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="转为任务"
      subtitle="选择要放入的看板与列表"
      onClose={onClose}
      footer={
        boards.length === 0 ? (
          <button className="btn btn-ghost" onClick={onClose}>
            知道了
          </button>
        ) : (
          <>
            <button className="btn btn-quiet" onClick={onClose}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              {submitting ? '正在转换…' : '转为任务'}
            </button>
          </>
        )
      }
    >
      <div className="inbox-convert-quote">{item.content}</div>

      {boards.length === 0 ? (
        <div className="inbox-convert-empty">
          <Icon name="info" size={15} />
          <div>
            <p className="inbox-convert-empty-title">还没有看板</p>
            <p className="inbox-convert-empty-sub">
              先到工作台创建一个看板，收件箱的内容会一直保留在这里，之后再来转换。
            </p>
          </div>
        </div>
      ) : (
        <>
          <label className="field">
            <span className="field-label">放入看板</span>
            <select
              className="select"
              value={boardId}
              onChange={(event) => setBoardId(event.target.value)}
              aria-label="选择看板"
            >
              {boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.title}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span className="field-label">放入列表</span>
            {lists.length > 0 ? (
              <select
                className="select"
                value={activeListId}
                onChange={(event) => setListId(event.target.value)}
                aria-label="选择列表"
              >
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.title}
                  </option>
                ))}
              </select>
            ) : (
              <p className="inbox-convert-nolist">这个看板还没有列表，先在里面添加一个列表吧。</p>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
