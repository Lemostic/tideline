import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/Modal';
import { api } from '@/lib/api';
import { createId } from '@/lib/ids';
import {
  countRequirementNodes,
  maxRequirementLevel,
  parseRequirementDocument,
} from '@/lib/requirementParser';
import {
  BREAKDOWN_DEPTHS,
  BREAKDOWN_MODES,
  buildBreakdownPlan,
  summarizePlan,
  type BreakdownMode,
} from '@/lib/requirementPlan';
import { useAppStore, useSnapshot } from '@/store/appStore';
import './requirement.css';

/** 示例需求文档：标题、编号、缩进、段落齐全，方便直接试效果 */
const SAMPLE_DOC = `# 会员中心改版需求

本次改版围绕会员等级与积分体系展开，目标是把会员权益看清楚、把积分用起来。

## 会员等级体系

需要支持四个等级：普通会员、银卡会员、金卡会员、钻石会员。等级由最近 12 个月的累计积分决定。

- 展示当前等级与升级还差多少积分
- 提供等级对比表，说明各等级权益差异
- 等级变更后发送站内通知

## 积分体系

积分来源包括签到、消费、评价与活动奖励。

1. 签到：每日签到得 5 积分
2. 消费：每消费 1 元得 1 积分
3. 评价：发布带图评价得 20 积分

积分过期规则：年底统一清零，清零前 30 天提醒用户。

## 会员中心页面

- 新增会员概览卡片，展示等级、积分与优惠券数量
- 新增权益列表页，按等级分组展示
- 订单页展示本次消费获得的积分
`;

/** 需求拆解：粘贴需求文档 → 本地解析层级 → 预览 → 批量生成任务 */
export function RequirementPage() {
  const navigate = useNavigate();
  const snapshot = useSnapshot();
  const createCard = useAppStore((state) => state.createCard);

  const [source, setSource] = useState('');
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState<BreakdownMode>('nested');
  const [depth, setDepth] = useState(2);
  const [boardId, setBoardId] = useState('');
  const [listId, setListId] = useState('');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);
  const creatingRef = useRef(false);

  const boards = snapshot.boards;
  const lists = useMemo(
    () => snapshot.lists.filter((list) => list.boardId === boardId),
    [snapshot.lists, boardId],
  );

  // 看板 / 列表选择：默认落在第一个看板与它的第一列
  useEffect(() => {
    if (boards.length === 0) {
      setBoardId('');
      return;
    }
    if (!boards.some((board) => board.id === boardId)) {
      setBoardId(boards[0].id);
    }
  }, [boards, boardId]);

  useEffect(() => {
    if (!lists.some((list) => list.id === listId)) {
      setListId(lists[0]?.id ?? '');
    }
  }, [lists, listId]);

  const tree = useMemo(() => parseRequirementDocument(source), [source]);

  const existingTitles = useMemo(
    () => snapshot.cards.filter((card) => card.boardId === boardId).map((card) => card.title),
    [snapshot.cards, boardId],
  );

  const plan = useMemo(
    () => buildBreakdownPlan(tree, { mode, depth, existingTitles }),
    [tree, mode, depth, existingTitles],
  );

  const willCreate = plan.cards.filter((card) => !(skipDuplicates && card.duplicate)).length;
  const canGenerate = willCreate > 0 && boardId !== '' && listId !== '' && !creating;

  const readFile = async () => {
    if (creatingRef.current) return;
    setError(null);
    try {
      const picked = await api.pickRequirementFile();
      if (!picked) return;
      setSource(picked.content);
      setFileName(picked.name);
      setResult(null);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : '读取文件失败');
    }
  };

  const loadSample = () => {
    setSource(SAMPLE_DOC);
    setFileName('示例需求.md');
    setResult(null);
    setError(null);
  };

  const clearAll = () => {
    setSource('');
    setFileName('');
    setResult(null);
    setError(null);
  };

  /** 批量生成任务：逐个写入看板，写完给出结果 */
  const generate = async () => {
    if (!canGenerate || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    setResult(null);

    const targets = plan.cards.filter((card) => !(skipDuplicates && card.duplicate));
    let created = 0;
    try {
      for (const card of targets) {
        await createCard({
          boardId,
          listId,
          title: card.title,
          description: card.description,
          subtasks: card.subtasks.map((title) => ({
            id: createId('s'),
            title,
            done: false,
          })),
        });
        created += 1;
      }
      setResult({ created, skipped: plan.cards.length - created });
    } catch (generateError) {
      setError(
        generateError instanceof Error ? generateError.message : '生成任务失败',
      );
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const nodeCount = countRequirementNodes(tree);
  const deepest = maxRequirementLevel(tree);

  return (
    <div className="page req-page">
      <div className="page-head">
        <h1 className="page-title">需求拆解</h1>
        <p className="page-sub">
          把需求文档贴进来，按标题、编号和缩进拆成看板任务与子任务；解析全部在本机完成，不经过任何 AI 服务。
        </p>
      </div>

      <div className="req-layout">
        <section className="req-panel req-panel-input">
          <div className="req-panel-head">
            <span className="req-panel-title">
              <Icon name="file-text" size={14} />
              需求文档
            </span>
            <div className="req-panel-tools">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void readFile()}>
                读取文件
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={loadSample}>
                填入示例
              </button>
              <button type="button" className="btn btn-quiet btn-sm" onClick={clearAll}>
                清空
              </button>
            </div>
          </div>

          <textarea
            className="textarea req-textarea"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setResult(null);
            }}
            placeholder={'把需求文档粘贴到这里，或点「读取文件」导入 .md / .txt。\n\n支持 Markdown 标题（#）、编号列表（1. / 1.1.）和缩进列表。'}
            spellCheck={false}
          />

          {fileName ? (
            <div className="req-file-name">
              <Icon name="info" size={12} />
              {fileName}
            </div>
          ) : null}

          <div className="req-options">
            <div className="field">
              <span className="field-label">拆解深度</span>
              <div className="req-depth" role="group" aria-label="拆解深度">
                {BREAKDOWN_DEPTHS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`req-depth-btn${depth === value ? ' active' : ''}`}
                    onClick={() => setDepth(value)}
                  >
                    {value} 层
                  </button>
                ))}
              </div>
              <span className="field-hint">结构化到第几层；更深的原文会折叠进任务描述，不会丢失。</span>
            </div>

            <div className="field">
              <span className="field-label">拆解方式</span>
              <div className="req-modes" role="group" aria-label="拆解方式">
                {BREAKDOWN_MODES.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`req-mode${mode === item.key ? ' active' : ''}`}
                    onClick={() => setMode(item.key)}
                  >
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="req-targets">
              <label className="field">
                <span className="field-label">目标看板</span>
                <select
                  className="select"
                  value={boardId}
                  onChange={(event) => setBoardId(event.target.value)}
                >
                  {boards.length === 0 ? <option value="">还没有看板</option> : null}
                  {boards.map((board) => (
                    <option key={board.id} value={board.id}>
                      {board.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">目标列表</span>
                <select
                  className="select"
                  value={listId}
                  onChange={(event) => setListId(event.target.value)}
                >
                  {lists.length === 0 ? <option value="">这个看板还没有列表</option> : null}
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="req-check">
              <input
                type="checkbox"
                checked={skipDuplicates}
                onChange={(event) => setSkipDuplicates(event.target.checked)}
              />
              <span>跳过与看板中已有任务同名的条目</span>
            </label>
          </div>
        </section>

        <section className="req-panel req-panel-preview">
          <div className="req-panel-head">
            <span className="req-panel-title">
              <Icon name="layers" size={14} />
              拆解预览
            </span>
            <span className="req-panel-meta">
              {nodeCount > 0 ? `${nodeCount} 个节点 · 最多 ${deepest} 层` : '等待输入文档'}
            </span>
          </div>

          {nodeCount === 0 ? (
            <EmptyState
              icon={<Icon name="file-text" size={22} />}
              title="还没有可拆解的结构"
              description="文档里需要有标题、编号或缩进列表。贴一段需求试试，或点「填入示例」。"
            />
          ) : plan.cards.length === 0 ? (
            <EmptyState
              icon={<Icon name="layers" size={22} />}
              title="当前设置下没有可生成的任务"
              description="调大拆解深度，或换一种拆解方式再看看。"
            />
          ) : (
            <ul className="req-plan-list">
              {plan.cards.map((card) => (
                <li
                  key={`${card.path}-${card.title}`}
                  className={`req-plan-item${card.duplicate ? ' is-duplicate' : ''}`}
                >
                  <div className="req-plan-head">
                    <span className="req-plan-title">{card.title}</span>
                    {card.duplicate ? <span className="chip chip-danger">同名</span> : null}
                    {card.subtasks.length > 0 ? (
                      <span className="chip">{card.subtasks.length} 个子任务</span>
                    ) : null}
                    <span className="chip chip-soft">第 {card.level} 层</span>
                  </div>
                  <div className="req-plan-path">{card.path}</div>
                  {card.description ? (
                    <p className="req-plan-desc">{firstLine(card.description)}</p>
                  ) : null}
                  {card.subtasks.length > 0 ? (
                    <ul className="req-plan-subs">
                      {card.subtasks.slice(0, 6).map((subtask) => (
                        <li key={subtask}>{subtask}</li>
                      ))}
                      {card.subtasks.length > 6 ? (
                        <li className="req-plan-more">…还有 {card.subtasks.length - 6} 条</li>
                      ) : null}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="req-actions">
        <span className="req-summary">{nodeCount > 0 ? summarizePlan(plan) : '等待输入需求文档'}</span>
        {error ? <span className="req-error">{error}</span> : null}
        {result ? (
          <span className="req-result">
            已创建 {result.created} 个任务
            {result.skipped > 0 ? `，跳过 ${result.skipped} 个同名任务` : ''}
          </span>
        ) : null}
        <div className="req-actions-buttons">
          {result && result.created > 0 ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => navigate(`/board/${boardId}`)}
            >
              去看板
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canGenerate}
            onClick={() => void generate()}
          >
            {creating ? (
              <>
                <span className="req-spinner" aria-hidden="true" />
                正在创建…
              </>
            ) : (
              <>
                <Icon name="plus" size={14} />
                生成 {willCreate} 个任务
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 描述只展示首行，避免预览区被长段落撑开 */
function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim().length > 0) ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
