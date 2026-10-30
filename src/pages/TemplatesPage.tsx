import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { EmptyState, Modal } from '@/components/Modal';
import {
  TEMPLATE_CATEGORIES,
  filterTemplates,
  templateCategoryLabel,
  templateCount,
  templateTaskCount,
  type TemplateItem,
} from '@/lib/templates';
import { boardColorValue, type TemplateCategory } from '@/lib/types';
import { useAppStore } from '@/store/appStore';
import './templates.css';

/** 模板中心：分类筛选、模板预览、一键生成看板 */
export function TemplatesPage() {
  const navigate = useNavigate();
  const createBoard = useAppStore((state) => state.createBoard);
  const createList = useAppStore((state) => state.createList);
  const createCard = useAppStore((state) => state.createCard);
  const deleteList = useAppStore((state) => state.deleteList);

  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const [preview, setPreview] = useState<TemplateItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const creatingRef = useRef(false);

  const templates = useMemo(() => filterTemplates(category), [category]);

  const openPreview = (template: TemplateItem) => {
    if (creatingRef.current) return;
    setCreateError(null);
    setPreview(template);
  };

  const closePreview = () => {
    if (creatingRef.current) return;
    setCreateError(null);
    setPreview(null);
  };

  /**
   * 用模板创建看板：
   * store.createBoard 会自动建「待办 / 进行中 / 已完成」三条默认列表，
   * 这里先记录并删除它们，再按模板顺序创建列表与任务，保证结果与模板完全一致。
   */
  const applyTemplate = async (template: TemplateItem) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);

    try {
      const board = await createBoard({
        title: template.name,
        description: template.summary,
        color: template.color,
      });

      const defaultLists = useAppStore
        .getState()
        .snapshot.lists.filter((list) => list.boardId === board.id);
      for (const list of defaultLists) {
        await deleteList(list.id);
      }

      for (const group of template.lists) {
        const list = await createList(board.id, group.title);
        for (const cardTitle of group.cards) {
          await createCard({ boardId: board.id, listId: list.id, title: cardTitle });
        }
      }

      creatingRef.current = false;
      setCreating(false);
      setPreview(null);
      navigate(`/board/${board.id}`);
    } catch (error) {
      creatingRef.current = false;
      setCreating(false);
      const message = error instanceof Error ? error.message : '未知错误';
      setCreateError(`创建失败：${message}`);
    }
  };

  return (
    <div className="page tmpl-page">
      <div className="page-head">
        <h1 className="page-title">模板中心</h1>
        <p className="page-sub">挑一个模板，几十秒搭出看板骨架，再按自己的节奏补充细节。</p>
      </div>

      <div className="tmpl-tabs" role="tablist" aria-label="模板分类">
        {TEMPLATE_CATEGORIES.map((item) => {
          const active = category === item.key;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={`tmpl-tab${active ? ' active' : ''}`}
              onClick={() => setCategory(item.key)}
            >
              {item.label}
              <span className="tmpl-tab-count">{templateCount(item.key)}</span>
            </button>
          );
        })}
      </div>

      <div className="tmpl-filter-line">
        <span className="tmpl-filter-count">{templates.length} 个模板</span>
        <span className="tmpl-filter-hint">点击模板可预览列表与任务大纲</span>
      </div>

      {templates.length === 0 ? (
        <div className="tmpl-empty">
          <EmptyState
            icon={<Icon name="folder" size={22} />}
            title="这个分类暂时没有模板"
            description="换一个分类看看，或者先新建一个空白看板，从自己的习惯开始。"
            action={
              <button className="btn btn-ghost" onClick={() => setCategory('all')}>
                查看全部模板
              </button>
            }
          />
        </div>
      ) : (
        <div className="tmpl-grid">
          {templates.map((template) => (
            <TemplateCard key={template.id} template={template} onOpen={openPreview} />
          ))}
        </div>
      )}

      {preview ? (
        <Modal
          width="wide"
          title={preview.name}
          subtitle={preview.summary}
          onClose={closePreview}
          footer={
            <div className="tmpl-preview-foot">
              <span className="tmpl-preview-note">
                <Icon name="info" size={13} />
                创建后可在看板里自由增删列表和任务
              </span>
              <button className="btn btn-quiet" onClick={closePreview} disabled={creating}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={creating}
                onClick={() => void applyTemplate(preview)}
              >
                {creating ? (
                  <>
                    <span className="tmpl-spinner" aria-hidden="true" />
                    正在创建…
                  </>
                ) : (
                  <>
                    <Icon name="plus" size={14} />
                    使用模板
                  </>
                )}
              </button>
            </div>
          }
        >
          <div className="tmpl-preview-head">
            <span
              className="tmpl-preview-cover"
              style={
                {
                  '--tmpl-color': boardColorValue(preview.color),
                  '--tmpl-soft': `${boardColorValue(preview.color)}1f`,
                } as CSSProperties
              }
            >
              {preview.emoji}
            </span>
            <div className="tmpl-preview-chips">
              <span className="chip chip-soft">{templateCategoryLabel(preview.category)}</span>
              {preview.hot ? (
                <span className="chip chip-accent">
                  <Icon name="sparkles" size={11} />
                  热门推荐
                </span>
              ) : null}
              <span className="chip">{preview.lists.length} 个列表</span>
              <span className="chip">{templateTaskCount(preview)} 个示例任务</span>
            </div>
          </div>

          <div className="tmpl-preview-plan-note">
            <Icon name="list" size={13} />
            创建后会生成下面 {preview.lists.length} 个列表和 {templateTaskCount(preview)} 张任务卡片
          </div>

          <div className="tmpl-preview-lists">
            {preview.lists.map((group) => (
              <section className="tmpl-preview-list" key={group.title}>
                <header className="tmpl-preview-list-head">
                  <span
                    className="tmpl-preview-dot"
                    style={{ background: boardColorValue(preview.color) }}
                  />
                  <span className="tmpl-preview-list-title">{group.title}</span>
                  <span className="tmpl-preview-list-count">{group.cards.length}</span>
                </header>
                <ul className="tmpl-preview-cards">
                  {group.cards.map((cardTitle) => (
                    <li className="tmpl-preview-card" key={cardTitle}>
                      {cardTitle}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          {createError ? (
            <div className="tmpl-preview-error" role="alert">
              <Icon name="info" size={13} />
              {createError}
            </div>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

interface TemplateCardProps {
  template: TemplateItem;
  onOpen: (template: TemplateItem) => void;
}

function TemplateCard({ template, onOpen }: TemplateCardProps) {
  const color = boardColorValue(template.color);
  const taskCount = templateTaskCount(template);

  return (
    <button
      type="button"
      className="tmpl-card"
      onClick={() => onOpen(template)}
      style={
        {
          '--tmpl-color': color,
          '--tmpl-soft': `${color}1a`,
        } as CSSProperties
      }
      aria-label={`预览模板：${template.name}`}
    >
      <span className="tmpl-cover">
        <span className="tmpl-cover-emoji" aria-hidden="true">
          {template.emoji}
        </span>
        {template.hot ? (
          <span className="tmpl-badge-hot">
            <Icon name="sparkles" size={10} />
            热门
          </span>
        ) : null}
        <span className="tmpl-badge-cat">{templateCategoryLabel(template.category)}</span>
      </span>
      <span className="tmpl-body">
        <span className="tmpl-name">{template.name}</span>
        <span className="tmpl-summary">{template.summary}</span>
        <span className="tmpl-meta">
          <span className="tmpl-meta-item">
            <Icon name="list" size={12} />
            {template.lists.length} 个列表
          </span>
          <span className="tmpl-meta-sep" aria-hidden="true" />
          <span className="tmpl-meta-item">
            <Icon name="check-circle" size={12} />
            {taskCount} 个任务
          </span>
        </span>
      </span>
    </button>
  );
}
