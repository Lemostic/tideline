import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import { BOARD_COLORS, type BoardColor } from '@/lib/types';
import { useAppStore } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';

const TITLE_MAX = 60;

/** 新建看板：标题 + 主题色。创建后自动带三条默认列表并跳转。 */
export function NewBoardModal() {
  const open = useUiStore((state) => state.newBoardOpen);
  const close = useUiStore((state) => state.closeNewBoard);
  const createBoard = useAppStore((state) => state.createBoard);
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [color, setColor] = useState<BoardColor>('blue');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setTitle('');
    setColor('blue');
    setError(null);
    setSubmitting(false);
  };

  const handleClose = () => {
    reset();
    close();
  };

  const handleSubmit = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('给看板起个名字吧');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const board = await createBoard({ title: trimmed.slice(0, TITLE_MAX), color });
      handleClose();
      navigate(`/board/${board.id}`);
    } catch {
      setError('创建失败，请重试');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建看板"
      subtitle="看板是任务的容器，创建后会自动带「待办 / 进行中 / 已完成」三条列表。"
      onClose={handleClose}
      footer={
        <>
          <button className="btn btn-quiet" onClick={handleClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? '创建中…' : '创建看板'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label" htmlFor="new-board-title">
          看板名称
        </label>
        <input
          id="new-board-title"
          className="input"
          maxLength={TITLE_MAX}
          placeholder="例如：产品发布 · V0.2"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleSubmit();
          }}
          autoFocus
        />
        {error ? <div className="field-hint" style={{ color: 'var(--danger)' }}>{error}</div> : null}
      </div>

      <div className="field">
        <span className="field-label">主题色</span>
        <div className="color-picker">
          {BOARD_COLORS.map((item) => (
            <button
              key={item.key}
              className={`color-swatch${color === item.key ? ' active' : ''}`}
              style={{ background: item.value }}
              onClick={() => setColor(item.key)}
              aria-label={item.label}
              title={item.label}
            >
              {color === item.key ? <Icon name="check" size={13} /> : null}
            </button>
          ))}
        </div>
        <div className="field-hint">主题色会显示在看板封面和列表左侧。</div>
      </div>
    </Modal>
  );
}
