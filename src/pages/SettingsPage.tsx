import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { useSettingsStore } from '@/store/settingsStore';
import { useSnapshot } from '@/store/appStore';
import './settings.css';

/** 设置管理（V0.4）：全局偏好，立即保存并作用到看板 / 我的任务 / 日历。 */
export function SettingsPage() {
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const settings = useSettingsStore();
  const reset = useSettingsStore((state) => state.reset);

  return (
    <div className="page settings-page">
      <header className="settings-head">
        <div className="page-eyebrow">偏好设置</div>
        <h1 className="settings-title">设置</h1>
        <p className="settings-sub">
          设置自动保存在本机，不随备份导入导出。修改后立即生效，并对后续打开的所有看板生效。
        </p>
      </header>

      <div className="settings-grid">
        <section className="settings-card">
          <div className="settings-card-head">
            <span className="settings-card-icon">
              <Icon name="home" size={17} />
            </span>
            <div>
              <h2 className="settings-card-title">启动与导航</h2>
              <p className="settings-card-desc">打开应用和看板时的默认落点。</p>
            </div>
          </div>

          <label className="settings-row">
            <span className="settings-row-label">
              <span>启动页</span>
              <span className="settings-row-hint">每次打开应用进入的页面</span>
            </span>
            <select
              className="select settings-select"
              value={settings.startPage}
              onChange={(event) =>
                settings.update({ startPage: event.target.value as '/' | '/tasks' | '/inbox' })
              }
              aria-label="启动页"
            >
              <option value="/">首页</option>
              <option value="/tasks">我的任务</option>
              <option value="/inbox">收件箱</option>
            </select>
          </label>

          <label className="settings-row">
            <span className="settings-row-label">
              <span>默认看板视图</span>
              <span className="settings-row-hint">打开看板时优先显示的视图</span>
            </span>
            <select
              className="select settings-select"
              value={settings.defaultView}
              onChange={(event) =>
                settings.update({ defaultView: event.target.value as typeof settings.defaultView })
              }
              aria-label="默认看板视图"
            >
              <option value="board">看板</option>
              <option value="table">表格</option>
              <option value="gantt">甘特</option>
              <option value="calendar">日历</option>
            </select>
          </label>
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <span className="settings-card-icon">
              <Icon name="sliders" size={17} />
            </span>
            <div>
              <h2 className="settings-card-title">显示偏好</h2>
              <p className="settings-card-desc">影响任务列表和日历的默认展示。</p>
            </div>
          </div>

          <label className="settings-row">
            <span className="settings-row-label">
              <span>每周起始日</span>
              <span className="settings-row-hint">影响「我的任务」本周分桶与日历列顺序</span>
            </span>
            <select
              className="select settings-select"
              value={settings.weekStartsOn}
              onChange={(event) =>
                settings.update({ weekStartsOn: Number(event.target.value) === 0 ? 0 : 1 })
              }
              aria-label="每周起始日"
            >
              <option value={1}>周一</option>
              <option value={0}>周日</option>
            </select>
          </label>

          <label className="settings-row">
            <span className="settings-row-label">
              <span>默认隐藏已完成</span>
              <span className="settings-row-hint">我的任务 / 表格首次打开时不显示已完成任务</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.hideCompletedByDefault}
              className={`settings-switch${settings.hideCompletedByDefault ? ' is-on' : ''}`}
              onClick={() =>
                settings.update({ hideCompletedByDefault: !settings.hideCompletedByDefault })
              }
              aria-label="默认隐藏已完成"
            >
              <span className="settings-switch-knob" />
            </button>
          </label>
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <span className="settings-card-icon is-data">
              <Icon name="database" size={17} />
            </span>
            <div>
              <h2 className="settings-card-title">数据</h2>
              <p className="settings-card-desc">数据只在本机，建议定期导出备份。</p>
            </div>
          </div>

          <div className="settings-data-stats">
            <span>{snapshot.boards.length} 个看板</span>
            <span>{snapshot.cards.length} 个任务</span>
            <span>{snapshot.inbox.length} 条收件箱</span>
          </div>
          <p className="settings-path">
            数据库：<code>%APPDATA%\com.lemostic.tideline\tideline.db</code>
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => navigate('/data')}
            >
              <Icon name="database" size={14} />
              打开数据备份
            </button>
          </div>
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <span className="settings-card-icon">
              <Icon name="info" size={17} />
            </span>
            <div>
              <h2 className="settings-card-title">关于潮线</h2>
              <p className="settings-card-desc">本地优先的个人看板，数据完全属于你。</p>
            </div>
          </div>

          <div className="settings-about">
            <div className="settings-about-row">
              <span>版本</span>
              <strong>v{__APP_VERSION__}</strong>
            </div>
            <div className="settings-about-row">
              <span>技术栈</span>
              <span>Tauri 2 · React · SQLite</span>
            </div>
            <div className="settings-about-row">
              <span>许可证</span>
              <span>MIT · 开源免费</span>
            </div>
          </div>

          <div className="settings-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>
              恢复默认设置
            </button>
          </div>
        </section>
      </div>

      <p className="settings-note">
        默认值：启动页为首页、看板视图为看板、每周周一开始、不隐藏已完成。恢复默认只影响偏好，不会改动任何任务数据。
      </p>
    </div>
  );
}
