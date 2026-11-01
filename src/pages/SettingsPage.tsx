import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import { PageHeadBand } from '@/components/PageHeadBand';
import { AutomationSettings } from '@/components/AutomationSettings';
import { api } from '@/lib/api';
import { CARD_SIZE_OPTIONS } from '@/lib/cardLayout';
import { DEFAULT_CUSTOM_THEME, THEME_PRESETS, type ThemeBaseColors } from '@/lib/theme';
import { formatRelativeTime } from '@/lib/date';
import { RELEASES_PAGE } from '@/lib/update';
import type { AutoStartInfo, StorageInfo } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUpdateStore } from '@/store/updateStore';
import { DataPage } from './DataPage';
import './settings.css';

interface PendingStorage {
  mode: 'custom' | 'default';
  path: string;
}

/** 设置管理（V0.5）：全局偏好 + 自定义数据目录，修改立即生效。 */
export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'data' ? 'data' : 'preferences';
  const snapshot = useSnapshot();
  const settings = useSettingsStore();
  const reset = useSettingsStore((state) => state.reset);
  const reloadSnapshot = useAppStore((state) => state.reloadSnapshot);
  const loadTrash = useAppStore((state) => state.loadTrash);
  const updateResult = useUpdateStore((state) => state.result);
  const updateChecking = useUpdateStore((state) => state.checking);
  const updateError = useUpdateStore((state) => state.error);
  const updateCheckedAt = useUpdateStore((state) => state.lastCheckedAt);
  const checkUpdates = useUpdateStore((state) => state.check);

  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [autoStart, setAutoStart] = useState<AutoStartInfo | null>(null);
  const [autoStartBusy, setAutoStartBusy] = useState(false);
  const [autoStartError, setAutoStartError] = useState<string | null>(null);
  const [pendingStorage, setPendingStorage] = useState<PendingStorage | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageFlash, setStorageFlash] = useState<string | null>(null);
  const [updateActionError, setUpdateActionError] = useState<string | null>(null);

  const updateThemeColor = (key: keyof ThemeBaseColors, value: string) => {
    settings.update({
      themeId: 'custom',
      customTheme: { ...settings.customTheme, [key]: value },
    });
  };

  const handleOpenRelease = async () => {    setUpdateActionError(null);
    const url = updateResult?.latest?.url ?? RELEASES_PAGE;
    try {
      await api.openExternal(url);
    } catch (error) {
      setUpdateActionError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void api
      .getStorageInfo()
      .then(setStorage)
      .catch((error: unknown) => setStorageError(String(error)));
  }, []);

  useEffect(() => {
    void api
      .getAutoStart()
      .then(setAutoStart)
      .catch((error: unknown) => {
        setAutoStart({ supported: false, enabled: false });
        setAutoStartError(error instanceof Error ? error.message : String(error));
      });
  }, []);

  const toggleAutoStart = async () => {
    if (!autoStart?.supported || autoStartBusy) return;
    setAutoStartBusy(true);
    setAutoStartError(null);
    try {
      const next = await api.setAutoStart(!autoStart.enabled);
      setAutoStart(next);
    } catch (error) {
      setAutoStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setAutoStartBusy(false);
    }
  };

  const chooseDirectory = async () => {
    if (!storage?.editable) return;
    setStorageError(null);
    try {
      const path = await api.pickDataDirectory();
      if (path) setPendingStorage({ mode: 'custom', path });
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmStorageChange = async () => {
    if (!pendingStorage) return;
    setStorageBusy(true);
    setStorageError(null);
    try {
      const next =
        pendingStorage.mode === 'default'
          ? await api.resetDataDirectory()
          : await api.changeDataDirectory(pendingStorage.path);
      setStorage(next);
      await reloadSnapshot();
      await loadTrash().catch(() => undefined);
      setStorageFlash(
        pendingStorage.mode === 'default'
          ? '已恢复默认数据目录，应用正在使用新位置'
          : '数据目录已切换，应用正在使用新位置',
      );
      setPendingStorage(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    } finally {
      setStorageBusy(false);
    }
  };

  return (
    <div className="page settings-page">
      <PageHeadBand
        eyebrow="设置"
        title="设置"
        description={
          tab === 'data'
            ? '导出或恢复本机全部数据。备份文件完全离线，不包含账号、网络或设备信息。'
            : '设置自动保存在本机，不随备份导入导出。修改后立即生效，并对后续打开的所有看板生效。'
        }
      />

      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'preferences'}
          className={`settings-tab${tab === 'preferences' ? ' is-active' : ''}`}
          onClick={() => setSearchParams({})}
        >
          <Icon name="sliders" size={14} />
          偏好设置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'data'}
          className={`settings-tab${tab === 'data' ? ' is-active' : ''}`}
          onClick={() => setSearchParams({ tab: 'data' })}
        >
          <Icon name="database" size={14} />
          数据与备份
        </button>
      </div>

      {tab === 'preferences' ? (
        <>
      {storageFlash ? <div className="settings-flash">{storageFlash}</div> : null}
      {storageError ? <div className="settings-flash is-error">{storageError}</div> : null}

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
              <option value="/">工作台</option>
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

          <label className="settings-row">
            <span className="settings-row-label">
              <span>启动时检查更新</span>
              <span className="settings-row-hint">每 24 小时最多检查一次 GitHub 正式版本</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.autoCheckUpdates}
              className={`settings-switch${settings.autoCheckUpdates ? ' is-on' : ''}`}
              onClick={() => settings.update({ autoCheckUpdates: !settings.autoCheckUpdates })}
              aria-label="启动时检查更新"
            >
              <span className="settings-switch-knob" />
            </button>
          </label>

          <label className="settings-row">
            <span className="settings-row-label">
              <span>开机自动启动</span>
              <span className="settings-row-hint">
                {autoStart?.supported
                  ? '登录 Windows 后自动打开潮线'
                  : '仅桌面安装版支持，浏览器开发模式不可用'}
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={autoStart?.enabled ?? false}
              className={`settings-switch${autoStart?.enabled ? ' is-on' : ''}`}
              onClick={() => void toggleAutoStart()}
              disabled={!autoStart?.supported || autoStartBusy}
              aria-label="开机自动启动"
            >
              <span className="settings-switch-knob" />
            </button>
          </label>
          {autoStartError ? <p className="settings-row-error">{autoStartError}</p> : null}
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
              <span>卡片尺寸</span>
              <span className="settings-row-hint">统一影响模板中心、工作台看板卡片与看板集卡片</span>
            </span>
            <select
              className="select settings-select"
              value={settings.cardSize}
              onChange={(event) =>
                settings.update({ cardSize: event.target.value as typeof settings.cardSize })
              }
              aria-label="卡片尺寸"
            >
              {CARD_SIZE_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
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

          <label className="settings-row">
            <span className="settings-row-label">
              <span>任务链连线</span>
              <span className="settings-row-hint">看板中用虚线箭头标出前置 → 后置任务关系</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.showDependencyLines}
              className={`settings-switch${settings.showDependencyLines ? ' is-on' : ''}`}
              onClick={() =>
                settings.update({ showDependencyLines: !settings.showDependencyLines })
              }
              aria-label="任务链连线"
            >
              <span className="settings-switch-knob" />
            </button>
          </label>
        </section>

        <section className="settings-card settings-theme-card">
          <div className="settings-card-head">
            <span className="settings-card-icon is-theme">
              <Icon name="palette" size={17} />
            </span>
            <div>
              <h2 className="settings-card-title">主题外观</h2>
              <p className="settings-card-desc">
                选择一套预设配色，或自行配置主色、强调色与背景色，立即生效并保存在本机。
              </p>
            </div>
            <span className="settings-theme-current">
              当前：{settings.themeId === 'custom' ? '自定义' : THEME_PRESETS.find((preset) => preset.id === settings.themeId)?.name ?? '自定义'}
            </span>
          </div>

          <div className="theme-preset-grid">
            {THEME_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`theme-preset${settings.themeId === preset.id ? ' is-active' : ''}`}
                onClick={() => settings.update({ themeId: preset.id })}
                aria-pressed={settings.themeId === preset.id}
                aria-label={`主题：${preset.name}`}
              >
                <span className="theme-preset-swatches">
                  <span style={{ background: preset.colors.background }} />
                  <span style={{ background: preset.colors.primary }} />
                  <span style={{ background: preset.colors.accent }} />
                </span>
                <span className="theme-preset-main">
                  <strong>{preset.name}</strong>
                  <small>{preset.description}</small>
                </span>
                {settings.themeId === preset.id ? (
                  <span className="theme-preset-check">
                    <Icon name="check" size={12} />
                  </span>
                ) : null}
              </button>
            ))}
            <button
              type="button"
              className={`theme-preset theme-preset-custom${settings.themeId === 'custom' ? ' is-active' : ''}`}
              onClick={() => settings.update({ themeId: 'custom' })}
              aria-pressed={settings.themeId === 'custom'}
              aria-label="主题：自定义"
            >
              <span className="theme-preset-swatches">
                <span style={{ background: settings.customTheme.background }} />
                <span style={{ background: settings.customTheme.primary }} />
                <span style={{ background: settings.customTheme.accent }} />
              </span>
              <span className="theme-preset-main">
                <strong>自定义</strong>
                <small>用 5 个基础色生成完整配色</small>
              </span>
              {settings.themeId === 'custom' ? (
                <span className="theme-preset-check">
                  <Icon name="check" size={12} />
                </span>
              ) : null}
            </button>
          </div>

          <div className={`theme-custom-panel${settings.themeId === 'custom' ? ' is-active' : ''}`}>
            <div className="theme-custom-head">
              <div>
                <h3>自定义配色</h3>
                <p>改任一颜色会自动切到「自定义」主题。</p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  settings.update({
                    themeId: 'custom',
                    customTheme: { ...DEFAULT_CUSTOM_THEME },
                  })
                }
              >
                恢复自定义默认
              </button>
            </div>
            <div className="theme-color-grid">
              {[
                { key: 'primary', label: '主色', hint: '按钮 / 导航 / 进度' },
                { key: 'accent', label: '强调色', hint: '星标 / 提醒 / 点缀' },
                { key: 'background', label: '背景色', hint: '窗口 / 侧边栏底色' },
                { key: 'surface', label: '卡片色', hint: '卡片 / 弹窗表面' },
                { key: 'text', label: '文字色', hint: '正文与标题' },
              ].map((field) => (
                <label className="theme-color-field" key={field.key}>
                  <span className="theme-color-swatch">
                    <input
                      type="color"
                      value={settings.customTheme[field.key as keyof ThemeBaseColors]}
                      onChange={(event) =>
                        updateThemeColor(field.key as keyof ThemeBaseColors, event.target.value)
                      }
                      aria-label={`自定义主题${field.label}`}
                    />
                  </span>
                  <span className="theme-color-text">
                    <strong>{field.label}</strong>
                    <small>{field.hint}</small>
                  </span>
                  <code>{settings.customTheme[field.key as keyof ThemeBaseColors]}</code>
                </label>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <span className="settings-card-icon is-data">
              <Icon name="database" size={17} />
            </span>
            <div>
              <h2 className="settings-card-title">数据与存储</h2>
              <p className="settings-card-desc">数据只在本机，建议定期导出备份。</p>
            </div>
          </div>

          <div className="settings-data-stats">
            <span>{snapshot.boards.length} 个看板</span>
            <span>{snapshot.cards.length} 个任务</span>
            <span>{snapshot.inbox.length} 条收件箱</span>
          </div>

          <div className="settings-storage">
            <div className="settings-storage-head">
              <span>数据存储目录</span>
              <span className={`settings-badge${storage?.isCustom ? ' is-custom' : ''}`}>
                {storage?.isCustom ? '自定义' : '默认'}
              </span>
            </div>
            <code className="settings-storage-path">
              {storage?.dbPath ?? '%APPDATA%\\com.lemostic.tideline\\tideline.db'}
            </code>
            {storage?.editable ? (
              <div className="settings-storage-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void chooseDirectory()}
                  disabled={storageBusy}
                >
                  <Icon name="folder" size={13} />
                  更改目录…
                </button>
                {storage.isCustom ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setPendingStorage({ mode: 'default', path: storage.defaultDir })
                    }
                    disabled={storageBusy}
                  >
                    恢复默认目录
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="settings-storage-hint">浏览器开发模式使用 localStorage，不支持自定义目录。</p>
            )}
          </div>

          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setSearchParams({ tab: 'data' })}
            >
              <Icon name="database" size={14} />
              打开数据与备份
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
              <strong>
                v{__APP_VERSION__}
                {updateResult?.hasUpdate && updateResult.latest ? (
                  <span className="settings-update-badge">可更新</span>
                ) : null}
              </strong>
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

          <div className="settings-update">
            <div className="settings-update-head">
              <span>更新检查</span>
              {updateResult?.latest ? (
                updateResult.hasUpdate ? (
                  <span className="settings-update-badge">新版本 v{updateResult.latest.version}</span>
                ) : (
                  <span className="settings-update-muted">已是最新</span>
                )
              ) : null}
            </div>

            {updateError ? (
              <p className="settings-update-error">{updateError}</p>
            ) : updateResult?.latest ? (
              <div className="settings-update-result">
                {updateResult.hasUpdate ? (
                  <>
                    <p className="settings-update-title">
                      发现新版本 v{updateResult.latest.version}
                      {updateResult.latest.name && updateResult.latest.name !== updateResult.latest.version
                        ? ` · ${updateResult.latest.name}`
                        : ''}
                    </p>
                    {updateResult.latest.notes ? (
                      <p className="settings-update-notes">
                        {updateResult.latest.notes.slice(0, 180)}
                        {updateResult.latest.notes.length > 180 ? '…' : ''}
                      </p>
                    ) : null}
                    {updateResult.latest.publishedAt ? (
                      <p className="settings-update-meta">
                        发布于 {updateResult.latest.publishedAt.slice(0, 10)}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="settings-update-title">
                    当前已是最新版本（v{updateResult.latest.version}）
                  </p>
                )}
              </div>
            ) : updateResult ? (
              <p className="settings-update-muted">
                仓库还没有正式发布版本，可打开发布页查看后续更新。
              </p>
            ) : (
              <p className="settings-update-muted">
                安装包签名完成前不会静默下载安装；检查到新版本后请从发布页手动下载安装包。
              </p>
            )}

            {updateActionError ? (
              <p className="settings-update-error">{updateActionError}</p>
            ) : null}

            <div className="settings-update-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void checkUpdates().catch(() => undefined)}
                disabled={updateChecking}
              >
                <Icon name="download" size={13} />
                {updateChecking ? '检查中…' : '检查更新'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handleOpenRelease()}>
                <Icon name="link" size={13} />
                打开发布页
              </button>
            </div>

            {updateCheckedAt ? (
              <p className="settings-update-meta">
                上次检查：{formatRelativeTime(updateCheckedAt)}
              </p>
            ) : null}
          </div>

          <div className="settings-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>
              恢复默认设置
            </button>
          </div>
        </section>

        <AutomationSettings />
      </div>

      <p className="settings-note">
        默认值：启动页为工作台、看板视图为看板、每周周一开始、不隐藏已完成。恢复默认只影响偏好，不会改动任何任务数据。
      </p>

      {pendingStorage ? (
        <Modal
          title={pendingStorage.mode === 'default' ? '恢复默认数据目录？' : '更改数据存储目录？'}
          subtitle="数据库会复制到新目录，当前任务数据不变"
          onClose={() => (storageBusy ? undefined : setPendingStorage(null))}
          footer={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setPendingStorage(null)}
                disabled={storageBusy}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void confirmStorageChange()}
                disabled={storageBusy}
              >
                {storageBusy ? '正在迁移…' : '迁移并切换'}
              </button>
            </>
          }
        >
          <div className="settings-storage-confirm">
            <p>将把当前数据库复制到下面的目录，并立即切换过去：</p>
            <code>{pendingStorage.path}</code>
            <p className="settings-storage-confirm-hint">
              旧目录中的数据库文件会在切换成功后删除；任务、看板、备份文件不受影响。请不要在迁移过程中强制退出应用。
            </p>
          </div>
        </Modal>
      ) : null}
        </>
      ) : (
        <DataPage embedded />
      )}
    </div>
  );
}
