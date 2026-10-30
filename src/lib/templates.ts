/**
 * 模板中心的数据源
 *
 * 模板是「创建看板的一份菜谱」：一组有序的列表，以及每个列表下的示例任务标题。
 * 使用模板时只会创建看板和列表/任务骨架，不会写入截止日期与负责人，
 * 具体内容交给使用者按自己的节奏补充。
 *
 * 约定：
 * - `hot` 只用于「热门推荐」精选位，业务分类仍以 `category` 为准；
 * - 每个模板 3-4 个列表，每个列表 2-4 张示例任务；
 * - 列表顺序即创建后的看板列顺序。
 */
import type { BoardTemplate, TemplateCategory, TemplateCategoryMeta } from './types';

export interface TemplateItem extends BoardTemplate {
  /** 是否进入「热门推荐」：精选位展示，不改变业务分类 */
  hot?: boolean;
}

/** 分类 Tab 的顺序与文案（与 TemplateCategory 一一对应） */
export const TEMPLATE_CATEGORIES: ReadonlyArray<TemplateCategoryMeta> = [
  { key: 'all', label: '全部' },
  { key: 'hot', label: '热门推荐' },
  { key: 'collab', label: '办公协作' },
  { key: 'content', label: '内容管理' },
  { key: 'product', label: '产品研发' },
  { key: 'personal', label: '个人效率' },
];

const CATEGORY_LABEL: Record<TemplateCategory, string> = {
  hot: '热门推荐',
  collab: '办公协作',
  content: '内容管理',
  product: '产品研发',
  personal: '个人效率',
};

export function templateCategoryLabel(category: TemplateCategory): string {
  return CATEGORY_LABEL[category] ?? '其他';
}

/** 模板一共包含多少个示例任务 */
export function templateTaskCount(template: BoardTemplate): number {
  return template.lists.reduce((total, list) => total + list.cards.length, 0);
}

/** 按分类筛选模板；`hot` 走精选位，`all` 返回全部 */
export function filterTemplates(category: TemplateCategory | 'all'): TemplateItem[] {
  if (category === 'all') return BOARD_TEMPLATES;
  if (category === 'hot') return BOARD_TEMPLATES.filter((template) => template.hot);
  return BOARD_TEMPLATES.filter((template) => template.category === category);
}

/** 分类下模板数量，用于 Tab 角标 */
export function templateCount(category: TemplateCategory | 'all'): number {
  return filterTemplates(category).length;
}

export const BOARD_TEMPLATES: TemplateItem[] = [
  {
    id: 'project-delivery',
    name: '项目管理看板',
    summary: '从需求评审到上线复盘，一个看板看清项目每一步。',
    category: 'product',
    color: 'blue',
    emoji: '🚀',
    hot: true,
    lists: [
      {
        title: '需求池',
        cards: ['需求评审与优先级排序', '补充验收标准与边界场景', '确认排期与资源投入'],
      },
      {
        title: '设计开发',
        cards: ['产出色稿与交互稿', '拆分开发任务并估时', '评审技术方案与风险点'],
      },
      {
        title: '联调测试',
        cards: ['联调主流程与异常分支', '回归测试并收敛缺陷', '准备上线检查清单'],
      },
      {
        title: '已上线',
        cards: ['灰度发布与监控告警', '上线后数据复盘', '整理版本发布说明'],
      },
    ],
  },
  {
    id: 'personal-todo',
    name: '个人任务待办',
    summary: '把脑子里的事清空到看板，今天只盯最重要的三件。',
    category: 'personal',
    color: 'amber',
    emoji: '✅',
    hot: true,
    lists: [
      {
        title: '今天',
        cards: ['处理积压的消息与邮件', '完成今天的三件要事', '下班前整理明日计划'],
      },
      {
        title: '这周',
        cards: ['准备周会汇报材料', '整理本月账单与预算', '约一次体检'],
      },
      {
        title: '有空再说',
        cards: ['看完收藏的教程', '整理手机相册', '给房间做一次断舍离'],
      },
    ],
  },
  {
    id: 'key-task-supervision',
    name: '要事督办',
    summary: '领导交办、跨部门协同的要事，件件有着落、事事有回音。',
    category: 'collab',
    color: 'coral',
    emoji: '📌',
    hot: true,
    lists: [
      {
        title: '待立项',
        cards: ['梳理本月重点督办事项', '明确责任人与完成时限', '对齐验收标准'],
      },
      {
        title: '推进中',
        cards: ['跟进跨部门数据接口联调', '更新督办台账并同步进度', '标记需要协调的卡点'],
      },
      {
        title: '待验收',
        cards: ['核对交付物与验收标准', '回访需求方确认满意度'],
      },
      {
        title: '已办结',
        cards: ['归档督办材料', '复盘超期原因并形成改进项'],
      },
    ],
  },
  {
    id: 'weekly-report',
    name: '周报日报',
    summary: '进展、问题、下周计划照着填，写周报不再临时拼凑。',
    category: 'collab',
    color: 'teal',
    emoji: '🗓️',
    hot: true,
    lists: [
      {
        title: '本周进展',
        cards: ['汇总各项目完成事项', '整理关键数据与截图', '记录对外交付的时间点'],
      },
      {
        title: '阻塞与风险',
        cards: ['标注需要支持的阻塞点', '发起一次跨组对齐', '同步风险与预案'],
      },
      {
        title: '下周计划',
        cards: ['列出下周最重要的三件事', '补充待确认的需求点', '预留机动时间缓冲'],
      },
      {
        title: '沉淀与复盘',
        cards: ['整理可复用的模板与结论', '记录一次踩坑与改进'],
      },
    ],
  },
  {
    id: 'okr-sync',
    name: 'OKR 同步',
    summary: '目标与关键结果拆开写，让团队始终对齐同一个方向。',
    category: 'collab',
    color: 'violet',
    emoji: '🎯',
    hot: true,
    lists: [
      {
        title: 'O 与 KR',
        cards: ['明确本季度目标 O', '拆出三个可量化的 KR', '对齐各团队承接的指标'],
      },
      {
        title: '本月举措',
        cards: ['拆解到每月关键举措', '确定每项举措负责人', '排出优先级与依赖关系'],
      },
      {
        title: '进展与信心',
        cards: ['更新 KR 进度与信心指数', '记录影响判断的关键假设', '同步需要升级的偏差'],
      },
      {
        title: '季度复盘',
        cards: ['复盘目标完成度并打分', '沉淀下季度改进点'],
      },
    ],
  },
  {
    id: 'content-calendar',
    name: '内容发布排期',
    summary: '选题、撰稿、审核、发布，稳定地保持更新节奏。',
    category: 'content',
    color: 'amber',
    emoji: '📅',
    hot: true,
    lists: [
      {
        title: '选题池',
        cards: ['收集本周选题与热点', '确认发布平台与排期', '标记选题优先级'],
      },
      {
        title: '撰写中',
        cards: ['完成初稿与配图', '补充引用来源与素材', '统一标题与封面文案'],
      },
      {
        title: '待审核',
        cards: ['校对错别字与事实', '合规审核并修改', '确认最终发布时间'],
      },
      {
        title: '已发布',
        cards: ['发布并同步社群', '记录阅读与互动数据'],
      },
    ],
  },
  {
    id: 'staffing-sync',
    name: '人员分工同步',
    summary: '谁负责、什么时候交、卡在哪，一张看板同步给所有人。',
    category: 'collab',
    color: 'green',
    emoji: '👥',
    lists: [
      {
        title: '待分配',
        cards: ['拆解本周任务并明确负责人', '同步分工给相关同学'],
      },
      {
        title: '进行中',
        cards: ['跟进各自进度并更新状态', '提前预警进度风险'],
      },
      {
        title: '待协助',
        cards: ['汇总需要支援的事项', '安排一次对齐会'],
      },
      {
        title: '已完成',
        cards: ['确认交付并归档', '更新下一轮分工'],
      },
    ],
  },
  {
    id: 'invoice-board',
    name: '申请发票看板',
    summary: '从开票申请到回款到账，每张发票都有迹可循。',
    category: 'collab',
    color: 'rose',
    emoji: '🧾',
    lists: [
      {
        title: '待开票',
        cards: ['收集合同与开票信息', '确认抬头与税号', '提交开票申请'],
      },
      {
        title: '已开票',
        cards: ['下载电子发票并归档', '同步财务登记入账'],
      },
      {
        title: '待报销',
        cards: ['粘贴发票并填写报销单', '跟进审批节点'],
      },
      {
        title: '已到账',
        cards: ['确认回款并核销', '更新费用台账'],
      },
    ],
  },
  {
    id: 'hiring-tracker',
    name: '招聘面试跟踪',
    summary: '候选人从初筛到入职，进度和反馈不再靠私聊打听。',
    category: 'collab',
    color: 'blue',
    emoji: '🤝',
    lists: [
      {
        title: '待筛选',
        cards: ['筛选简历并约面', '同步岗位要求与团队介绍'],
      },
      {
        title: '面试中',
        cards: ['安排一面与二面', '汇总面试评价与分歧点'],
      },
      {
        title: '待发 offer',
        cards: ['确认薪资与入职时间', '发起录用审批'],
      },
      {
        title: '已入职',
        cards: ['准备入职材料与设备', '安排新人引导人'],
      },
    ],
  },
  {
    id: 'research-project',
    name: '课题研究管理',
    summary: '文献、实验、结论各就各位，研究过程不再散落在硬盘里。',
    category: 'product',
    color: 'slate',
    emoji: '🔬',
    lists: [
      {
        title: '立项与调研',
        cards: ['完成文献综述与可行性分析', '确定研究问题与假设'],
      },
      {
        title: '实验与分析',
        cards: ['设计实验方案', '跑通基线实验并记录参数', '整理数据与可视化图表'],
      },
      {
        title: '写作与投稿',
        cards: ['撰写阶段性报告', '完成论文初稿', '准备投稿材料与图表'],
      },
      {
        title: '已结题',
        cards: ['返修并回复审稿意见', '归档代码与数据'],
      },
    ],
  },
  {
    id: 'film-production',
    name: '影视制作流程',
    summary: '从脚本到成片，每个环节的交付物和负责人一目了然。',
    category: 'content',
    color: 'violet',
    emoji: '🎬',
    lists: [
      {
        title: '前期筹备',
        cards: ['完成分镜脚本', '勘景与场地确认', '确认演员与器材清单'],
      },
      {
        title: '拍摄',
        cards: ['确认拍摄通告与日程', '跟组拍摄并核对素材'],
      },
      {
        title: '后期',
        cards: ['粗剪与配乐', '调色与字幕包装'],
      },
      {
        title: '交付',
        cards: ['输出成片与封面', '按平台规格转码分发'],
      },
    ],
  },
  {
    id: 'event-planning',
    name: '活动策划',
    summary: '从创意到复盘，把一场活动的每个关键节点都盯住。',
    category: 'content',
    color: 'coral',
    emoji: '🎪',
    lists: [
      {
        title: '创意与方案',
        cards: ['确认活动目标与预算', '输出活动方案与流程'],
      },
      {
        title: '筹备执行',
        cards: ['对接场地、物料与供应商', '宣传推广与报名收集'],
      },
      {
        title: '现场执行',
        cards: ['准备现场流程与应急预案', '确认人员分工与物料到场'],
      },
      {
        title: '复盘',
        cards: ['收集反馈与现场照片', '输出复盘报告与改进项'],
      },
    ],
  },
  {
    id: 'reading-notes',
    name: '读书笔记',
    summary: '读过的书、划过的句子和想做的事，集中放在一个看板里。',
    category: 'personal',
    color: 'green',
    emoji: '📖',
    lists: [
      {
        title: '在读',
        cards: ['《深度工作》第三章', '《卡片笔记写作法》'],
      },
      {
        title: '待读',
        cards: ['《系统之美》', '《写作这回事》', '《人类简史》'],
      },
      {
        title: '笔记与摘录',
        cards: ['整理关于专注力的方法', '摘抄三段有启发的原文'],
      },
      {
        title: '读完待整理',
        cards: ['写一篇读书总结', '把可执行的方法加入待办'],
      },
    ],
  },
  {
    id: 'travel-plan',
    name: '旅行计划',
    summary: '行程、预订、清单放在一起，出发前不用再翻聊天记录。',
    category: 'personal',
    color: 'teal',
    emoji: '🧳',
    lists: [
      {
        title: '想去的地方',
        cards: ['收集目的地与路线灵感', '确认出行时间与预算'],
      },
      {
        title: '预订清单',
        cards: ['订往返交通', '订住宿并确认入住时间', '预约热门景点门票'],
      },
      {
        title: '行前准备',
        cards: ['整理证件与保单', '列行李清单并打包'],
      },
      {
        title: '回来后',
        cards: ['整理照片与游记', '报销差旅费用'],
      },
    ],
  },
];
