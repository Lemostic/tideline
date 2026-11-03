import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { PageHeadBand } from '@/components/PageHeadBand';
import { api } from '@/lib/api';
import { readImportFile } from '@/lib/excelFile';
import { parseImportRows, summarizeImport, type ImportParseResult } from '@/lib/excelImport';
import { buildTemplateBytes, TEMPLATE_FILE_NAME } from '@/lib/excelTemplate';
import { BOARD_COLORS, type BoardColor } from '@/lib/types';
import { useAppStore } from '@/store/appStore';
import './import.css';

const TITLE_MAX = 60;
const PREVIEW_LIMIT = 50;
const STEP_LABELS = ['看板信息', '选择文件', '预览并生成'];

/** 字节数组转 base64，用于把模板传给桌面端的保存命令 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** 优先级中文名 */
const PRIORITY_TEXT: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/**
 * 导入看板（V0.15.0）
 *
 * 三步向导：先定看板信息 → 选 Excel/CSV → 预览确认后生成。
 * 解析与模板生成全部在本机完成，文件不会离开这台电脑。
 */
export function ImportPage() {
  const navigate = useNavigate();
  const createBoardWithLists = useAppStore((state) => state.createBoardWithLists);
  const createCard = useAppStore((state) => state.createCard);
  const reloadSnapshot = useAppStore((state) => state.reloadSnapshot);

  const [step, setStep] = useState(1);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<BoardColor>('blue');
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ImportParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [created, setCreated] = useState<{ boardId: string; title: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 下载导入模板 */
  const handleDownloadTemplate = async () => {
    setError(null);
    setDownloading(true);
    try {
      const bytes = await buildTemplateBytes();
      const saved = await api.saveBinaryFile({
        fileName: TEMPLATE_FILE_NAME,
        base64: toBase64(bytes),
      });
      setFlash(
        saved.path
          ? `模板已保存到 ${saved.path}`
          : '模板已下载，按里面的表头填写后再导入即可',
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDownloading(false);
    }
  };

  /** 选择文件并解析 */
  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setFlash(null);
    setParsing(true);
    try {
      const loaded = await readImportFile(file);
      const parsed = parseImportRows(loaded.rows);
      setFileName(loaded.fileName);
      setResult(parsed);
      if (parsed.cards.length === 0) {
        setError(parsed.warnings[0] ?? '这个文件里没有可导入的任务');
        setStep(2);
        return;
      }
      setStep(3);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setParsing(false);
    }
  };

  /** 生成看板 */
  const handleGenerate = async () => {
    if (!result || result.cards.length === 0) return;
    const boardTitle = title.trim();
    if (!boardTitle) {
      setError('先给看板起个名字');
      setStep(1);
      return;
    }

    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: result.cards.length });
    let boardId = '';
    try {
      const createdBoard = await createBoardWithLists({
        title: boardTitle.slice(0, TITLE_MAX),
        description: description.trim(),
        color,
        listTitles: result.listTitles,
      });
      if (!createdBoard) throw new Error('创建看板失败');
      boardId = createdBoard.board.id;

      const listByTitle = new Map(createdBoard.lists.map((list) => [list.title, list.id]));
      for (const [index, card] of result.cards.entries()) {
        const listId = listByTitle.get(card.listTitle);
        if (!listId) throw new Error(`看板列「${card.listTitle}」缺失，导入已中断`);
        const made = await createCard({
          boardId: createdBoard.board.id,
          listId,
          title: card.title,
          description: card.description,
          startDate: card.startDate,
          dueDate: card.dueDate,
          priority: card.priority,
          labels: card.labels,
          estimatedMinutes: card.estimatedMinutes,
        });
        if (!made) throw new Error('创建任务失败，导入已中断');
        setProgress({ done: index + 1, total: result.cards.length });
      }

      setCreated({ boardId: createdBoard.board.id, title: boardTitle });
      setStep(3);
      setFlash(
        `已生成看板「${boardTitle}」：${createdBoard.lists.length} 列、${result.cards.length} 个任务`,
      );
    } catch (reason) {
      // 导入失败不留半成品：把刚建的看板删掉
      if (boardId) {
        await api.deleteBoard({ id: boardId }).catch(() => undefined);
        await reloadSnapshot();
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  /** 重新开始一次导入 */
  const handleReset = () => {
    setResult(null);
    setFileName('');
    setError(null);
    setFlash(null);
    setCreated(null);
    setProgress({ done: 0, total: 0 });
    setStep(2);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const previewCards = result?.cards.slice(0, PREVIEW_LIMIT) ?? [];
  const canGenerate = Boolean(result && result.cards.length > 0) && !busy;

  return (
    <div className="page imp-page">
      <PageHeadBand
        eyebrow="导入看板"
        title="从 Excel 一次生成一个看板"
        description="先给看板起个名字，再把填好的 Excel 或 CSV 导进来：表头自动对齐，一次生成看板列和全部任务。文件只在本机解析，不会上传到任何服务器。"
        readouts={[
          {
            label: '待导入任务',
            value: result ? result.cards.length : 0,
            tone: result && result.cards.length > 0 ? 'default' : 'muted',
          },
          {
            label: '看板列',
            value: result ? result.listTitles.length : 0,
            tone: 'muted',
          },
        ]}
      />

      <div className="imp-steps" role="list" aria-label="导入步骤">
        {STEP_LABELS.map((label, index) => {
          const number = index + 1;
          const state = number < step ? 'done' : number === step ? 'active' : 'todo';
          return (
            <div key={label} className={`imp-step is-${state}`} role="listitem">
              <span className="imp-step-index">{state === 'done' ? '✓' : number}</span>
              <span className="imp-step-label">{label}</span>
            </div>
          );
        })}
      </div>

      {flash ? <div className="imp-flash">{flash}</div> : null}
      {error ? <div className="imp-flash is-error">{error}</div> : null}

      {created ? (
        <section className="imp-panel imp-panel-done">
          <div className="imp-done-icon">
            <Icon name="check" size={18} />
          </div>
          <div className="imp-done-text">
            <h2 className="imp-done-title">导入完成</h2>
            <p className="imp-done-desc">
              看板「{created.title}」已经建好，任务也都放进去了。
            </p>
          </div>
          <div className="imp-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => navigate(`/board/${created.boardId}`)}
            >
              <Icon name="arrow-up-right" size={14} />
              去看板
            </button>
            <button type="button" className="btn btn-ghost" onClick={handleReset}>
              再导入一个
            </button>
          </div>
        </section>
      ) : null}

      {!created && step === 1 ? (
        <section className="imp-panel">
          <div className="imp-panel-head">
            <span className="imp-panel-title">
              <Icon name="sliders" size={14} />
              看板信息
            </span>
            <span className="imp-panel-meta">先定好看板，导入的任务都会放进这个看板</span>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="import-board-title">
              看板名称
            </label>
            <input
              id="import-board-title"
              className="input"
              maxLength={TITLE_MAX}
              placeholder="例如：产品发布 · V0.2"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(null);
              }}
              autoFocus
            />
            <span className="field-hint">最多 {TITLE_MAX} 个字符。</span>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="import-board-desc">
              看板描述
            </label>
            <textarea
              id="import-board-desc"
              className="textarea"
              rows={2}
              placeholder="选填：这个看板是做什么的"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="field">
            <span className="field-label">主题色</span>
            <div className="color-picker">
              {BOARD_COLORS.map((item) => (
                <button
                  key={item.key}
                  type="button"
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
          </div>

          <div className="imp-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void handleDownloadTemplate()}
              disabled={downloading}
            >
              <Icon name="download" size={14} />
              {downloading ? '正在生成模板…' : '下载 Excel 模板'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (!title.trim()) {
                  setError('先给看板起个名字');
                  return;
                }
                setError(null);
                setStep(2);
              }}
            >
              下一步：选择文件
              <Icon name="chevron-right" size={14} />
            </button>
          </div>
        </section>
      ) : null}

      {!created && step === 2 ? (
        <section className="imp-panel">
          <div className="imp-panel-head">
            <span className="imp-panel-title">
              <Icon name="folder" size={14} />
              选择文件
            </span>
            <span className="imp-panel-meta">支持 .xlsx 与 .csv，单次最多 5000 行</span>
          </div>

          <div
            className={`imp-drop${dragging ? ' is-dragging' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void handleFile(event.dataTransfer.files?.[0]);
            }}
          >
            <Icon name="file-text" size={22} />
            <p className="imp-drop-title">把 Excel 或 CSV 拖到这里</p>
            <p className="imp-drop-desc">或者点下面的按钮选择文件；表头会自动对齐模板里的 8 个字段</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="sr-only"
              aria-label="选择要导入的文件"
              onChange={(event) => {
                void handleFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={parsing}
            >
              {parsing ? '正在解析…' : '选择文件…'}
            </button>
          </div>

          <div className="imp-actions">
            <button type="button" className="btn btn-quiet" onClick={() => setStep(1)}>
              <Icon name="chevron-left" size={14} />
              上一步
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void handleDownloadTemplate()}
              disabled={downloading}
            >
              <Icon name="download" size={14} />
              {downloading ? '正在生成模板…' : '下载 Excel 模板'}
            </button>
          </div>
        </section>
      ) : null}

      {!created && step === 3 && result ? (
        <>
          <section className="imp-panel">
            <div className="imp-panel-head">
              <span className="imp-panel-title">
                <Icon name="table" size={14} />
                导入预览
              </span>
              <span className="imp-panel-meta">
                {fileName} · {summarizeImport(result)}
              </span>
            </div>

            {result.warnings.length > 0 ? (
              <ul className="imp-notes">
                {result.warnings.map((note) => (
                  <li key={note}>
                    <Icon name="info" size={13} />
                    {note}
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="imp-lists">
              <span className="imp-sub-label">将创建的看板列</span>
              <div className="imp-chips">
                {result.listTitles.map((name) => (
                  <span key={name} className="imp-chip">
                    {name}
                  </span>
                ))}
              </div>
            </div>

            {result.errors.length > 0 ? (
              <div className="imp-errors">
                <span className="imp-sub-label">被跳过的行（{result.errors.length}）</span>
                <ul>
                  {result.errors.slice(0, 20).map((item) => (
                    <li key={`${item.rowNumber}-${item.reason}`}>
                      第 {item.rowNumber} 行：{item.reason}
                    </li>
                  ))}
                </ul>
                {result.errors.length > 20 ? (
                  <span className="imp-hint">还有 {result.errors.length - 20} 行没列出</span>
                ) : null}
              </div>
            ) : null}

            <div className="imp-table-wrap">
              <table className="imp-table">
                <thead>
                  <tr>
                    <th>任务标题</th>
                    <th>所属列</th>
                    <th>开始</th>
                    <th>截止</th>
                    <th>优先级</th>
                    <th>标签</th>
                    <th>工时</th>
                  </tr>
                </thead>
                <tbody>
                  {previewCards.map((card) => (
                    <tr key={`${card.rowNumber}-${card.title}`}>
                      <td className="imp-cell-title">
                        {card.title}
                        {card.warnings.length > 0 ? (
                          <span className="imp-cell-warn" title={card.warnings.join('；')}>
                            <Icon name="info" size={12} />
                          </span>
                        ) : null}
                      </td>
                      <td>{card.listTitle}</td>
                      <td>{card.startDate ?? '—'}</td>
                      <td>{card.dueDate ?? '—'}</td>
                      <td>{card.priority ? PRIORITY_TEXT[card.priority] : '—'}</td>
                      <td>{card.labels.length > 0 ? card.labels.join('、') : '—'}</td>
                      <td>{card.estimatedMinutes === null ? '—' : `${card.estimatedMinutes} 分钟`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result.cards.length > PREVIEW_LIMIT ? (
              <span className="imp-hint">只预览前 {PREVIEW_LIMIT} 条，共 {result.cards.length} 条</span>
            ) : null}

            <div className="imp-actions">
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setCreated(null);
                  setStep(2);
                }}
                disabled={busy}
              >
                <Icon name="chevron-left" size={14} />
                换个文件
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleGenerate()}
                disabled={!canGenerate}
              >
                {busy
                  ? `正在创建 ${progress.done}/${progress.total}…`
                  : `生成看板（${result.cards.length} 个任务）`}
              </button>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
