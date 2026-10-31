/**
 * 任务详情里的「重复任务」与「最近活动」（V0.11）。
 *
 * 重复配置决定这张任务完成后是否自动生成下一次；
 * 活动日志展示任务字段的变化历史，方便回溯「谁在什么时候改了什么」。
 */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { formatRelativeTime } from '@/lib/date';
import {
  RECURRENCE_FREQUENCY_LABEL,
  WEEKDAY_LABELS,
  describeActivity,
  describeRecurrence,
} from '@/lib/automation';
import type { Card, CardActivity, RecurrenceFrequency } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';

interface RecurrenceSectionProps {
  card: Card;
}

export function RecurrenceSection({ card }: RecurrenceSectionProps) {
  const snapshot = useSnapshot();
  const createRecurrence = useAppStore((state) => state.createRecurrence);
  const updateRecurrence = useAppStore((state) => state.updateRecurrence);
  const deleteRecurrence = useAppStore((state) => state.deleteRecurrence);

  const recurrence = useMemo(
    () => snapshot.recurrences.find((item) => item.cardId === card.id),
    [snapshot.recurrences, card.id],
  );

  const [frequency, setFrequency] = useState<RecurrenceFrequency>('daily');
  const [intervalDays, setIntervalDays] = useState(2);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // 打开已有配置时把表单同步成当前值
  useEffect(() => {
    if (!recurrence) return;
    setFrequency(recurrence.frequency);
    setIntervalDays(recurrence.intervalValue);
    setWeekdays(recurrence.weekdays);
  }, [recurrence?.id, recurrence?.frequency, recurrence?.intervalValue, recurrence?.weekdays]);

  const toggleWeekday = (day: number) => {
    setWeekdays((current) =>
      current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort(),
    );
  };

  const submit = async () => {
    if (frequency === 'weekly' && weekdays.length === 0) {
      setNote('每周重复至少要选择一个星期');
      return;
    }
    if (frequency === 'interval' && intervalDays < 1) {
      setNote('自定义间隔至少是 1 天');
      return;
    }
    setNote(null);
    try {
      if (recurrence) {
        await updateRecurrence(recurrence.id, {
          frequency,
          intervalValue: intervalDays,
          weekdays,
        });
      } else {
        await createRecurrence({
          cardId: card.id,
          frequency,
          intervalValue: intervalDays,
          weekdays,
        });
      }
      setExpanded(false);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

  if (!recurrence && !expanded) {
    return (
      <div className="td-section">
        <div className="td-section-head">
          <div className="drawer-section-title">
            <Icon name="refresh" size={13} />
            重复任务
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-quiet td-inline-action"
          onClick={() => setExpanded(true)}
        >
          <Icon name="plus" size={13} />
          设置重复
        </button>
      </div>
    );
  }

  return (
    <div className="td-section">
      <div className="td-section-head">
        <div className="drawer-section-title">
          <Icon name="refresh" size={13} />
          重复任务
        </div>
        {recurrence ? (
          <span className="td-section-meta">
            {describeRecurrence(recurrence)}
            {recurrence.nextDueDate ? ` · 下次 ${recurrence.nextDueDate}` : ''}
          </span>
        ) : null}
      </div>

      {recurrence ? (
        <div className="td-inline-row">
          <button
            type="button"
            className={`btn btn-sm${recurrence.enabled ? ' btn-primary' : ' btn-quiet'}`}
            onClick={() =>
              void updateRecurrence(recurrence.id, { enabled: !recurrence.enabled })
            }
          >
            {recurrence.enabled ? '已启用' : '已停用'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-quiet"
            onClick={() => setExpanded((current) => !current)}
          >
            <Icon name="pencil" size={12} />
            修改
          </button>
          <button
            type="button"
            className="btn btn-sm btn-quiet"
            onClick={() => void deleteRecurrence(recurrence.id)}
          >
            <Icon name="trash" size={12} />
            取消重复
          </button>
        </div>
      ) : null}

      {expanded ? (
        <div className="td-recurrence-form">
          <label className="td-inline-field">
            <span>重复频率</span>
            <select
              className="select"
              value={frequency}
              onChange={(event) => setFrequency(event.target.value as RecurrenceFrequency)}
              aria-label="重复频率"
            >
              {(Object.keys(RECURRENCE_FREQUENCY_LABEL) as RecurrenceFrequency[]).map((key) => (
                <option key={key} value={key}>
                  {RECURRENCE_FREQUENCY_LABEL[key]}
                </option>
              ))}
            </select>
          </label>

          {frequency === 'weekly' ? (
            <div className="td-weekday-group" role="group" aria-label="选择星期">
              {WEEKDAY_LABELS.map((label, day) => (
                <button
                  key={day}
                  type="button"
                  className={`td-weekday-btn${weekdays.includes(day) ? ' on' : ''}`}
                  aria-pressed={weekdays.includes(day)}
                  onClick={() => toggleWeekday(day)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          {frequency === 'interval' ? (
            <label className="td-inline-field">
              <span>间隔天数</span>
              <input
                className="input"
                type="number"
                min={1}
                max={365}
                value={intervalDays}
                onChange={(event) => setIntervalDays(Math.max(1, Number(event.target.value) || 1))}
                aria-label="间隔天数"
              />
            </label>
          ) : null}

          {note ? (
            <p className="td-inline-note" role="status">
              {note}
            </p>
          ) : null}

          <div className="td-inline-row">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void submit()}>
              保存
            </button>
            <button
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={() => {
                setExpanded(false);
                setNote(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface ActivitySectionProps {
  cardId: string;
}

/** 最近活动：倒序展示字段变化，最多 20 条。 */
export function ActivitySection({ cardId }: ActivitySectionProps) {
  const snapshot = useSnapshot();
  const loadCardActivity = useAppStore((state) => state.loadCardActivity);
  const [activities, setActivities] = useState<CardActivity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadCardActivity(cardId)
      .then((result) => {
        if (!cancelled) {
          setActivities(result);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cardId, loadCardActivity, snapshot.cards]);

  const listTitle = (listId: string) =>
    snapshot.lists.find((list) => list.id === listId)?.title;

  return (
    <div className="td-section">
      <div className="td-section-head">
        <div className="drawer-section-title">
          <Icon name="clock" size={13} />
          最近活动
        </div>
        {activities.length > 0 ? (
          <span className="td-section-meta">{activities.length} 条</span>
        ) : null}
      </div>

      {error ? (
        <p className="td-inline-note" role="status">
          {error}
        </p>
      ) : null}

      {!error && activities.length === 0 ? (
        <p className="td-dependency-empty">
          {loading ? '正在读取活动记录…' : '暂无活动记录，任务的每次改动都会记在这里。'}
        </p>
      ) : null}

      {activities.length > 0 ? (
        <ul className="td-activity-list">
          {activities.slice(0, 20).map((activity) => (
            <li className="td-activity" key={activity.id}>
              <span className="td-activity-dot" />
              <span className="td-activity-text">
                {describeActivity(
                  activity,
                  activity.field === 'listId' ? listTitle(activity.newValue) : undefined,
                )}
              </span>
              <span className="td-activity-time">
                {formatRelativeTime(activity.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
