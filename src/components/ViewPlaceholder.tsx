import { Icon, type IconName } from '@/components/Icon';
import type { BoardView } from '@/lib/types';

const VIEW_META: Record<
  Exclude<BoardView, 'board'>,
  { icon: IconName; name: string; desc: string; version: string }
> = {
  table: {
    icon: 'table',
    name: '表格视图',
    desc: '用表格式的字段列表批量编辑任务：标题、负责人、截止日期、优先级一屏尽览，适合快速录入和整理。',
    version: 'V0.2',
  },
  gantt: {
    icon: 'gantt',
    name: '甘特视图',
    desc: '把任务放到时间轴上，直观看到依赖关系、排期冲突与整体节奏，适合规划有明确起止时间的项目。',
    version: 'V0.3',
  },
  calendar: {
    icon: 'calendar-view',
    name: '日历视图',
    desc: '按天查看截止任务与工作安排，把项目排期和个人日程放在同一张月历里。',
    version: 'V0.3',
  },
};

/** 看板内尚未实现的视图：统一占位，保证菜单完整、用户预期清楚 */
export function ViewPlaceholder({ view }: { view: Exclude<BoardView, 'board'> }) {
  const meta = VIEW_META[view];
  return (
    <div className="view-placeholder">
      <div className="empty-icon">
        <Icon name={meta.icon} size={22} />
      </div>
      <span className="view-placeholder-badge">
        <Icon name="sparkles" size={11} />
        {meta.version} 推出
      </span>
      <div className="empty-title" style={{ marginTop: 4 }}>
        {meta.name}
      </div>
      <div className="empty-sub">{meta.desc}</div>
      <div className="field-hint" style={{ marginTop: 6 }}>
        当前版本专注于把看板、表格与甘特视图打磨扎实，日历排期会在 V0.3 推出。
      </div>
    </div>
  );
}
