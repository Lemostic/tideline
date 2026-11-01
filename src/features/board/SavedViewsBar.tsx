import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import type { SavedView } from '@/lib/types';
import { PopMenu } from './PopMenu';
import './saved-views.css';

interface SavedViewsBarProps {
  /** 当前看板的全部视图（内置视图在前） */
  views: SavedView[];
  /** 当前激活的视图 id */
  activeViewId: string | null;
  /** 当前筛选已经偏离激活的视图 */
  dirty: boolean;
  onSelect: (view: SavedView) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (view: SavedView, name: string) => Promise<void>;
  onDelete: (view: SavedView) => void;
}

type DialogState =
  | { kind: 'create'; defaultName: string }
  | { kind: 'rename'; view: SavedView }
  | null;

/**
 * 保存的筛选视图条（V0.13.1）。
 *
 * 视图是看板级的命名快照：记下筛选条件、排序方式与视图类型，
 * 点一下就能切回去。内置视图不可改名也不可删除，用户视图可以。
 */
export function SavedViewsBar({
  views,
  activeViewId,
  dirty,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: SavedViewsBarProps) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dialog) return;
    setName(dialog.kind === 'create' ? dialog.defaultName : dialog.view.name);
    setError(null);
    setBusy(false);
  }, [dialog]);

  /** 新视图的默认名：按已有用户视图数量往后排，重名时继续往后找 */
  const suggestName = () => {
    let index = views.filter((view) => !view.isBuiltin).length + 1;
    let candidate = '视图 ' + index;
    while (views.some((view) => view.name === candidate)) {
      index += 1;
      candidate = '视图 ' + index;
    }
    return candidate;
  };

  const submit = async () => {
    if (!dialog || busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请先填写视图名称');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (dialog.kind === 'create') await onCreate(trimmed);
      else await onRename(dialog.view, trimmed);
      setDialog(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sv-bar" role="tablist" aria-label="保存的筛选视图">
        {views.map((view) => {
          const active = view.id === activeViewId;
          return (
            <div
              key={view.id}
              className={'sv-item' + (active ? ' is-active' : '')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="sv-tab"
                title={
                  view.isBuiltin
                    ? view.name + '（内置视图，不可改名或删除）'
                    : view.name
                }
                onClick={() => onSelect(view)}
              >
                {view.name}
                {active && dirty ? (
                  <span className="sv-dirty" aria-label="当前筛选已改动" />
                ) : null}
              </button>
              {view.isBuiltin ? null : (
                <PopMenu
                  ariaLabel={view.name + ' 的更多操作'}
                  align="right"
                  entries={[
                    {
                      kind: 'item',
                      label: '重命名',
                      icon: 'pencil',
                      onSelect: () => setDialog({ kind: 'rename', view }),
                    },
                    {
                      kind: 'item',
                      label: '删除',
                      icon: 'trash',
                      danger: true,
                      onSelect: () => onDelete(view),
                    },
                  ]}
                />
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="sv-add"
          onClick={() => setDialog({ kind: 'create', defaultName: suggestName() })}
        >
          <Icon name="plus" size={12} />
          保存为视图
        </button>
      </div>

      {dialog ? (
        <Modal
          title={dialog.kind === 'create' ? '保存为视图' : '重命名视图'}
          subtitle="视图会记住当前的筛选条件与排序方式"
          onClose={() => {
            if (!busy) setDialog(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setDialog(null)}
                disabled={busy}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy ? '保存中…' : '保存'}
              </button>
            </>
          }
        >
          <label className="sv-field">
            <span className="sv-label">视图名称</span>
            <input
              className="sv-input"
              value={name}
              maxLength={24}
              aria-label="视图名称"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
            />
          </label>
          {error ? (
            <p className="sv-error" role="alert">
              <Icon name="info" size={12} />
              {error}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}