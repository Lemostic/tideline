import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import { createId } from '@/lib/ids';
import {
  CUSTOM_FIELD_TYPE_META,
  customFieldTypeMeta,
  type CustomField,
  type CustomFieldOption,
  type CustomFieldType,
} from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useUiStore } from '@/store/uiStore';
import './custom-fields.css';

/** 选项调色板：与看板主题色分开，避免和列色混淆。 */
const OPTION_COLORS = [
  '#0f766e',
  '#2f6fd0',
  '#9a6512',
  '#c2410c',
  '#b91c1c',
  '#7c3aed',
  '#0f9e8e',
  '#64748b',
];

interface OptionDraft {
  id: string;
  label: string;
  color: string;
}

interface CustomFieldsModalProps {
  open: boolean;
  boardId: string;
  boardTitle: string;
  onClose: () => void;
}

/**
 * 看板级自定义字段管理（V0.13.0）。
 *
 * 只提供「单选下拉」与「数值」两种类型：它们覆盖个人场景的绝大多数诉求，
 * 且都不需要公式引擎。字段类型创建后不可更改，避免已有取值失效；
 * 选项可以增删改，改标签保留原 id，指向它的任务取值不会因此丢失。
 */
export function CustomFieldsModal({
  open,
  boardId,
  boardTitle,
  onClose,
}: CustomFieldsModalProps) {
  const snapshot = useSnapshot();
  const createCustomField = useAppStore((state) => state.createCustomField);
  const updateCustomField = useAppStore((state) => state.updateCustomField);
  const deleteCustomField = useAppStore((state) => state.deleteCustomField);
  const requestConfirm = useUiStore((state) => state.requestConfirm);

  const fields = useMemo(
    () =>
      snapshot.customFields
        .filter((field) => field.boardId === boardId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [snapshot.customFields, boardId],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [fieldType, setFieldType] = useState<CustomFieldType>('select');
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setFieldType('select');
    setOptions([{ id: createId('opt'), label: '', color: OPTION_COLORS[0] }]);
    setError(null);
  };

  useEffect(() => {
    if (!open) return;
    resetForm();
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const startEdit = (field: CustomField) => {
    setEditingId(field.id);
    setName(field.name);
    setFieldType(field.fieldType);
    setOptions(
      field.options.length > 0
        ? field.options.map((option) => ({ ...option }))
        : [{ id: createId('opt'), label: '', color: OPTION_COLORS[0] }],
    );
    setError(null);
  };

  const addOption = () => {
    setOptions((prev) => [
      ...prev,
      { id: createId('opt'), label: '', color: OPTION_COLORS[prev.length % OPTION_COLORS.length] },
    ]);
  };

  const patchOption = (id: string, patch: Partial<OptionDraft>) => {
    setOptions((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeOption = (id: string) => {
    setOptions((prev) => prev.filter((item) => item.id !== id));
  };

  const handleSubmit = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请先填写字段名称');
      return;
    }
    const cleaned = options
      .map((option) => ({ id: option.id, label: option.label.trim(), color: option.color }))
      .filter((option) => option.label !== '');
    if (fieldType === 'select' && cleaned.length === 0) {
      setError('单选字段至少需要一个选项');
      return;
    }
    const payload: CustomFieldOption[] = fieldType === 'select' ? cleaned : [];
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        await updateCustomField(editingId, { name: trimmed, options: payload });
      } else {
        await createCustomField({ boardId, name: trimmed, fieldType, options: payload });
      }
      resetForm();
      setBusy(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  const handleDelete = async (field: CustomField) => {
    const confirmed = await requestConfirm({
      title: `删除字段「${field.name}」`,
      description: '这个字段以及任务上对应的取值会一起删除，无法恢复。',
      confirmLabel: '删除字段',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await deleteCustomField(field.id);
      if (editingId === field.id) resetForm();
    } catch {
      // 错误由全局错误条提示
    }
  };

  const move = async (field: CustomField, offset: number) => {
    const index = fields.findIndex((item) => item.id === field.id);
    const target = fields[index + offset];
    if (!target) return;
    try {
      await updateCustomField(field.id, { sortOrder: target.sortOrder });
      await updateCustomField(target.id, { sortOrder: field.sortOrder });
    } catch {
      // 错误由全局错误条提示
    }
  };

  const editing = editingId ? fields.find((field) => field.id === editingId) : undefined;

  return (
    <Modal
      title="自定义字段"
      subtitle={boardTitle}
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            完成
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSubmit()}
            disabled={busy}
          >
            {busy ? '保存中…' : editingId ? '保存修改' : '新建字段'}
          </button>
        </>
      }
    >
      <div className="cf">
        {fields.length > 0 ? (
          <ul className="cf-list">
            {fields.map((field, index) => (
              <li className="cf-item" key={field.id}>
                <div className="cf-item-main">
                  <span className="cf-item-name">{field.name}</span>
                  <span className="cf-badge">{customFieldTypeMeta(field.fieldType).label}</span>
                </div>
                {field.options.length > 0 ? (
                  <div className="cf-chips">
                    {field.options.map((option) => (
                      <span className="cf-chip" key={option.id}>
                        <span className="cf-dot" style={{ background: option.color }} />
                        {option.label}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="cf-actions">
                  <button
                    type="button"
                    className="cf-icon-btn"
                    aria-label={`上移字段：${field.name}`}
                    title="上移"
                    disabled={index === 0}
                    onClick={() => void move(field, -1)}
                  >
                    <Icon name="chevron-up" size={13} />
                  </button>
                  <button
                    type="button"
                    className="cf-icon-btn"
                    aria-label={`下移字段：${field.name}`}
                    title="下移"
                    disabled={index === fields.length - 1}
                    onClick={() => void move(field, 1)}
                  >
                    <Icon name="chevron-down" size={13} />
                  </button>
                  <button
                    type="button"
                    className="cf-icon-btn"
                    aria-label={`编辑字段：${field.name}`}
                    title="编辑"
                    onClick={() => startEdit(field)}
                  >
                    <Icon name="pencil" size={13} />
                  </button>
                  <button
                    type="button"
                    className="cf-icon-btn is-danger"
                    aria-label={`删除字段：${field.name}`}
                    title="删除"
                    onClick={() => void handleDelete(field)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="cf-empty">
            这个看板还没有自定义字段。定义之后，任务详情里就能逐条填写。
          </p>
        )}

        <div className="cf-form">
          <div className="cf-form-head">
            <span className="cf-form-title">
              <Icon name="sliders" size={13} />
              {editingId ? '编辑字段' : '新建字段'}
            </span>
            {editingId ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={resetForm}>
                取消编辑
              </button>
            ) : null}
          </div>

          <label className="cf-field">
            <span className="cf-label">字段名称</span>
            <input
              className="cf-input"
              value={name}
              maxLength={24}
              placeholder="例如：优先级、评分、预计工时"
              aria-label="字段名称"
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <div className="cf-field">
            <span className="cf-label">字段类型</span>
            <div className="cf-types">
              {CUSTOM_FIELD_TYPE_META.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`cf-type${fieldType === item.key ? ' is-active' : ''}`}
                  disabled={Boolean(editing)}
                  title={editing ? '字段类型创建后不可更改' : item.hint}
                  aria-pressed={fieldType === item.key}
                  onClick={() => {
                    setFieldType(item.key);
                    if (item.key === 'number') setOptions([]);
                    else if (options.length === 0) {
                      setOptions([{ id: createId('opt'), label: '', color: OPTION_COLORS[0] }]);
                    }
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="cf-hint">{customFieldTypeMeta(fieldType).hint}</p>
          </div>

          {fieldType === 'select' ? (
            <div className="cf-field">
              <span className="cf-label">选项</span>
              <div className="cf-options">
                {options.map((option) => (
                  <div className="cf-option" key={option.id}>
                    <span className="cf-color-picker">
                      {OPTION_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          className={`cf-swatch${option.color === color ? ' is-active' : ''}`}
                          style={{ background: color }}
                          aria-label={`选项颜色 ${color}`}
                          aria-pressed={option.color === color}
                          onClick={() => patchOption(option.id, { color })}
                        />
                      ))}
                    </span>
                    <input
                      className="cf-input cf-option-input"
                      value={option.label}
                      maxLength={24}
                      placeholder="选项名称"
                      aria-label="选项名称"
                      onChange={(event) => patchOption(option.id, { label: event.target.value })}
                    />
                    <button
                      type="button"
                      className="cf-icon-btn is-danger"
                      aria-label="删除选项"
                      title="删除选项"
                      onClick={() => removeOption(option.id)}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={addOption}>
                <Icon name="plus" size={12} />
                添加选项
              </button>
            </div>
          ) : null}

          {error ? (
            <p className="cf-error" role="alert">
              <Icon name="info" size={12} />
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
