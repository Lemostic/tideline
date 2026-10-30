import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/Modal';
import { api, isTauri } from '@/lib/api';
import { parseBackup, summarizeBackup } from '@/lib/backup';
import type { BackupExport, BackupSummary } from '@/lib/types';
import { useAppStore, useSnapshot } from '@/store/appStore';
import './data.css';

interface PendingImport {
  fileName: string;
  text: string;
  summary: BackupSummary;
}

/**
 * 数据与备份（V0.4）：把本机全部数据导出为 JSON，或从备份文件整体恢复。
 *
 * 导入采用「先校验、再确认、事务替换」，失败不会破坏现有数据；
 * 恢复成功后重新拉取快照并清空回收站缓存，避免页面继续展示旧数据。
 */
export function DataPage() {
  const snapshot = useSnapshot();
  const trash = useAppStore((state) => state.trash);
  const loadTrash = useAppStore((state) => state.loadTrash);
  const reloadSnapshot = useAppStore((state) => state.reloadSnapshot);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<BackupExport | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [importing, setImporting] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadTrash().catch(() => undefined);
  }, [loadTrash]);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 6000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const handleExport = async () => {
    setError(null);
    setExported(null);
    setExporting(true);
    try {
      const result = await api.exportBackup();
      setExported(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(false);
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setExported(null);
    try {
      const text = await file.text();
      const backup = parseBackup(text);
      setPending({ fileName: file.name, text, summary: summarizeBackup(backup) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleRestore = async () => {
    if (!pending) return;
    setImporting(true);
    setError(null);
    try {
      const summary = await api.importBackup(pending.text);
      await reloadSnapshot();
      await loadTrash().catch(() => undefined);
      setPending(null);
      setFlash(
        `已恢复 ${summary.boards} 个看板、${summary.lists} 个列表、${summary.cards} 个任务（回收站 ${summary.trashed} 个）、${summary.inbox} 条收件箱`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(null);
    } finally {
      setImporting(false);
    }
  };

  const storagePath = isTauri()
    ? '%APPDATA%\\com.lemostic.tideline\\tideline.db'
    : 'localStorage · tideline.db.v1（浏览器开发模式）';

  return (
    <div className="page data-page">
      <header className="data-head">
        <div className="page-eyebrow">数据与备份</div>
        <h1 className="data-title">把数据握在自己手里</h1>
        <p className="data-sub">
          潮线只把数据保存在本机。定期导出一份 JSON 备份，换电脑或误操作时都能完整恢复。
        </p>
      </header>

      {flash ? <div className="data-flash">{flash}</div> : null}
      {error ? <div className="data-flash is-error">{error}</div> : null}

      <div className="data-grid">
        <section className="data-card">
          <div className="data-card-head">
            <span className="data-card-icon">
              <Icon name="database" size={17} />
            </span>
            <div>
              <h2 className="data-card-title">本地数据库</h2>
              <p className="data-card-desc">所有看板、任务和收件箱都在这个文件里。</p>
            </div>
          </div>

          <div className="data-stats">
            <div className="data-stat">
              <span className="data-stat-value">{snapshot.boards.length}</span>
              <span className="data-stat-label">看板</span>
            </div>
            <div className="data-stat">
              <span className="data-stat-value">{snapshot.cards.length}</span>
              <span className="data-stat-label">活动任务</span>
            </div>
            <div className="data-stat">
              <span className="data-stat-value">{trash.length}</span>
              <span className="data-stat-label">回收站</span>
            </div>
            <div className="data-stat">
              <span className="data-stat-value">{snapshot.inbox.length}</span>
              <span className="data-stat-label">收件箱</span>
            </div>
          </div>

          <div className="data-path">
            <span className="data-path-label">存储位置</span>
            <code className="data-path-value">{storagePath}</code>
          </div>
        </section>

        <section className="data-card">
          <div className="data-card-head">
            <span className="data-card-icon is-export">
              <Icon name="download" size={17} />
            </span>
            <div>
              <h2 className="data-card-title">导出备份</h2>
              <p className="data-card-desc">生成一个包含全部数据的 JSON 文件，可复制到网盘或移动硬盘。</p>
            </div>
          </div>

          <ul className="data-points">
            <li>包含看板、列表、任务字段、标签、子任务、回收站与收件箱</li>
            <li>桌面端默认写入「文档」目录；浏览器开发模式会触发文件下载</li>
            <li>建议每周或大量改动前导出一份</li>
          </ul>

          <div className="data-actions">
            <button type="button" className="btn btn-primary" onClick={handleExport} disabled={exporting}>
              <Icon name="download" size={14} />
              {exporting ? '正在导出…' : '导出 JSON 备份'}
            </button>
          </div>

          {exported ? (
            <div className="data-result">
              <div className="data-result-title">备份已生成</div>
              <code className="data-result-path">{exported.path}</code>
              <div className="data-result-meta">
                {exported.summary.boards} 个看板 · {exported.summary.cards} 个任务（回收站{' '}
                {exported.summary.trashed} 个）· {exported.summary.inbox} 条收件箱
              </div>
            </div>
          ) : null}
        </section>

        <section className="data-card is-danger">
          <div className="data-card-head">
            <span className="data-card-icon is-import">
              <Icon name="folder" size={17} />
            </span>
            <div>
              <h2 className="data-card-title">从备份恢复</h2>
              <p className="data-card-desc">选择之前导出的 JSON 文件，恢复后当前全部数据会被替换。</p>
            </div>
          </div>

          <ul className="data-points">
            <li>恢复前会先校验文件结构与引用关系，校验失败不会改动数据</li>
            <li>恢复在单个事务中完成，失败自动回滚</li>
            <li>建议先导出当前数据，再执行恢复</li>
          </ul>

          <div className="data-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              aria-label="选择备份文件"
              onChange={(event) => {
                void handleFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
            >
              <Icon name="folder" size={14} />
              选择备份文件…
            </button>
          </div>
        </section>
      </div>

      <section className="data-note">
        <h2 className="data-note-title">备份说明</h2>
        <ul>
          <li>备份文件是纯 JSON 文本，不含账号、网络或设备信息，可长期保存。</li>
          <li>
            桌面端数据文件位于 <code>%APPDATA%\com.lemostic.tideline\tideline.db</code>；直接复制该文件也能备份，
            但复制前需要先退出应用。
          </li>
          <li>恢复会整体替换当前数据，不会尝试合并；恢复后沿用备份中的看板 / 列表 / 任务 id，索引会重建。</li>
          <li>当前版本不包含应用设置（如窗口大小、筛选条件），这些内容会在后续版本再考虑。</li>
        </ul>
      </section>

      {pending ? (
        <Modal
          title="确认恢复备份？"
          subtitle={`文件：${pending.fileName}`}
          onClose={() => (importing ? undefined : setPending(null))}
          footer={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setPending(null)}
                disabled={importing}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleRestore}
                disabled={importing}
              >
                {importing ? '正在恢复…' : '覆盖并恢复'}
              </button>
            </>
          }
        >
          <div className="data-confirm">
            <p>
              将用这个备份替换当前全部数据（当前数据会被覆盖且不可撤销）：
            </p>
            <div className="data-confirm-stats">
              <span>{pending.summary.boards} 个看板</span>
              <span>{pending.summary.lists} 个列表</span>
              <span>{pending.summary.cards} 个任务（回收站 {pending.summary.trashed} 个）</span>
              <span>{pending.summary.inbox} 条收件箱</span>
            </div>
            <p className="data-confirm-hint">建议先「导出 JSON 备份」保存当前数据。</p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
