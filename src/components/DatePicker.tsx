import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/Icon';
import { parseDateKey, toDateKey, todayKey } from '@/lib/date';
import { useSettingsStore } from '@/store/settingsStore';
import '@/styles/date-picker.css';

interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 接受 2026-10-31 / 2026/10/31 / 2026.10.31；空串表示清空。 */
function parseTypedDate(raw: string): string | null {
  const text = raw.trim();
  if (!text) return '';
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const date = new Date(year, month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

export function DatePicker({
  value,
  onChange,
  ariaLabel,
  placeholder = '选择日期',
  disabled = false,
  className = '',
}: DatePickerProps) {
  const weekStartsOn = useSettingsStore((state) => state.weekStartsOn);
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<CSSProperties>({});
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const selected = parseDateKey(value);
  const [view, setView] = useState(() => {
    const base = selected ?? new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });

  useEffect(() => {
    setText(value);
    if (value) {
      const date = parseDateKey(value);
      if (date) setView({ year: date.getFullYear(), month: date.getMonth() });
    }
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (wrapperRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const openPicker = () => {
    if (disabled) return;
    const base = selected ?? new Date();
    setView({ year: base.getFullYear(), month: base.getMonth() });
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 286;
      const height = 336;
      const left = Math.min(
        Math.max(8, window.innerWidth - width - 8),
        Math.max(8, rect.left),
      );
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
      setPopStyle({ left, top, width });
    }
    setOpen(true);
  };

  const cells = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const firstDow = first.getDay();
    const offset = weekStartsOn === 1 ? (firstDow + 6) % 7 : firstDow;
    const start = new Date(view.year, view.month, 1 - offset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      return {
        key: toDateKey(date),
        day: date.getDate(),
        month: date.getMonth(),
        year: date.getFullYear(),
      };
    });
  }, [view, weekStartsOn]);

  const weekdays = weekStartsOn === 1 ? WEEKDAY_LABELS : ['日', ...WEEKDAY_LABELS.slice(0, 6)];
  const today = todayKey();

  const pick = (key: string) => {
    onChange(key);
    setText(key);
    setOpen(false);
  };

  return (
    <div className={`date-picker${disabled ? ' is-disabled' : ''}`} ref={wrapperRef}>
      <input
        className={`input date-picker-input ${className}`.trim()}
        value={text}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="off"
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const parsed = parseTypedDate(next);
          if (parsed !== null) onChange(parsed);
        }}
        onBlur={() => {
          if (parseTypedDate(text) === null) setText(value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
      />
      <button
        type="button"
        className="date-picker-trigger"
        aria-label="打开日期选择器"
        disabled={disabled}
        onClick={openPicker}
      >
        <Icon name="calendar" size={13} />
      </button>

      {open
        ? createPortal(
            <div
              className="date-picker-pop"
              ref={popRef}
              style={popStyle}
              role="dialog"
              aria-label="日期选择"
            >
              <div className="date-picker-head">
                <button
                  type="button"
                  className="date-picker-nav"
                  aria-label="上个月"
                  onClick={() => setView((current) => shiftMonth(current.year, current.month, -1))}
                >
                  <Icon name="chevron-left" size={14} />
                </button>
                <strong>
                  {view.year} 年 {view.month + 1} 月
                </strong>
                <button
                  type="button"
                  className="date-picker-nav"
                  aria-label="下个月"
                  onClick={() => setView((current) => shiftMonth(current.year, current.month, 1))}
                >
                  <Icon name="chevron-right" size={14} />
                </button>
              </div>
              <div className="date-picker-weekdays">
                {weekdays.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
              <div className="date-picker-grid">
                {cells.map((cell) => (
                  <button
                    key={cell.key}
                    type="button"
                    className={[
                      'date-picker-day',
                      cell.month !== view.month ? 'is-outside' : '',
                      cell.key === today ? 'is-today' : '',
                      cell.key === value ? 'is-selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => pick(cell.key)}
                  >
                    {cell.day}
                  </button>
                ))}
              </div>
              <div className="date-picker-foot">
                <button type="button" className="date-picker-today" onClick={() => pick(today)}>
                  今天
                </button>
                <button
                  type="button"
                  className="date-picker-clear"
                  onClick={() => {
                    onChange('');
                    setText('');
                    setOpen(false);
                  }}
                >
                  清除
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
