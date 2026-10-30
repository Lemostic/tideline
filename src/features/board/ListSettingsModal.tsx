import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import { BOARD_COLORS, type BoardColor, type List, type ListPatch } from '@/lib/types';

interface ListSettingsModalProps {
  open: boolean;
  list: List;
  onClose: () => void;
  onSubmit: (patch: ListPatch) => Promise<void>;
}

/** 列表个性化（V0.7）：主题色与 WIP 在制品上限。 */
export function ListSettingsModal({ open, list, onClose, onSubmit }: ListSettingsModalProps) {
  const [color, setColor] = useState<BoardColor>(list.color);
  const [wip, setWip] = useState(list.wipLimit ? String(list.wipLimit) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setColor(list.color);
    setWip(list.wipLimit ? String(list.wipLimit) : '');
    setBusy(false);
    setError(null);
  }, [open, list.color, list.wipLimit]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (busy) return;
    const trimmed = wip.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed))) {
      setError('WIP 上限需要是大于 0 的整数，留空表示不限制');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ color, wipLimit: parsed });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="列表设置"
      subtitle={list.title}
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="list-settings">
        <div className="list-settings-field">
          <span className="list-settings-label">
            <Icon name="flag" size={13} />
            列主题色
          </span>
          <div className="list-color-grid">
            {BOARD_COLORS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`list-color-swatch${color === item.key ? ' is-active' : ''}`}
                style={{ background: item.value }}
                title={item.label}
                aria-label={`列颜色：${item.label}`}
                aria-pressed={color === item.key}
                onClick={() => setColor(item.key)}
              >
                {color === item.key ? <Icon name="check" size={12} /> : null}
              </button>
            ))}
          </div>
        </div>

        <label className="list-settings-field">
          <span className="list-settings-label">
            <Icon name="columns" size={13} />
            WIP 在制品上限
          </span>
          <input
            className="input"
            type="number"
            min={1}
            step={1}
            value={wip}
            placeholder="留空表示不限制"
            onChange={(event) => setWip(event.target.value)}
            aria-label="WIP 在制品上限"
          />
          <span className="list-settings-hint">
            超过上限时列头会变成警示色，但不会阻止移动任务。
          </span>
        </label>

        {error ? <p className="list-settings-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
