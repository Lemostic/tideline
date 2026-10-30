import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '@/components/Icon';
import type { VipFeature } from '@/lib/types';

interface FeatureSpec {
  eyebrow: string;
  title: string;
  subtitle: string;
  roadmap: string;
  features: Array<{ icon: IconName; title: string; sub: string }>;
}

const FEATURES: Record<VipFeature, FeatureSpec> = {
  dashboard: {
    eyebrow: '路线图 · 后续版本',
    title: '仪表盘：让项目进度一眼可见',
    subtitle:
      '按看板、列表、优先级、截止日期汇总统计，把散落在各个看板里的任务变成图表。目前先把入口和版式留好，图表能力会在后续版本补齐。',
    roadmap: 'V0.4',
    features: [
      { icon: 'chart', title: '多维统计', sub: '按看板、优先级、截止日期聚合任务数量与完成率。' },
      { icon: 'sliders', title: '自定义卡片', sub: '自由组合统计卡片，保存成自己常用的数据视角。' },
      { icon: 'download', title: '数据导出', sub: '把统计结果导出为 CSV，用于周报与复盘。' },
    ],
  },
  'board-sets': {
    eyebrow: '路线图 · 后续版本',
    title: '看板集：多个看板，一处管理',
    subtitle:
      '把跨团队、跨项目的多个看板收纳进同一个看板集，用表格视图横向对比进度、负责人和风险。目前先把导航位置留出来，避免做一半的架构。',
    roadmap: 'V0.4',
    features: [
      { icon: 'table', title: '横向对比', sub: '像表格一样汇总多个看板的关键指标。' },
      { icon: 'users', title: '团队视图', sub: '按负责人维度查看各看板的负载。' },
      { icon: 'link', title: '一键切换', sub: '在看板、表格、时间线之间随时切换。' },
    ],
  },
  goals: {
    eyebrow: '路线图 · 后续版本',
    title: '目标：让每个任务都挂在目标之下',
    subtitle:
      '用公司目标 / 团队目标 / 个人目标三层结构拆解任务，定期回看进度。目前先把菜单占位，目标模型会在看板能力稳定后接入。',
    roadmap: 'V0.5',
    features: [
      { icon: 'target', title: '目标拆解', sub: '从目标向下拆解到任务，方向始终清晰。' },
      { icon: 'check-circle', title: '进度回写', sub: '任务完成后自动更新目标进度。' },
      { icon: 'chart', title: '定期复盘', sub: '按周期回顾目标完成情况，沉淀经验。' },
    ],
  },
};

/** 仪表盘 / 看板集 / 目标：功能占位页，保持菜单可用且表达清楚 */
export function VipFeaturePage({ feature }: { feature: VipFeature }) {
  const spec = FEATURES[feature];
  const navigate = useNavigate();

  return (
    <div className="upsell-page">
      <div className="upsell-card">
        <div className="upsell-banner">
          <span className="upsell-eyebrow">
            <Icon name="sparkles" size={13} />
            {spec.eyebrow}
          </span>
          <h1 className="upsell-title">{spec.title}</h1>
          <p className="upsell-sub">{spec.subtitle}</p>
        </div>

        <div className="upsell-body">
          {spec.features.map((item) => (
            <div className="upsell-feature" key={item.title}>
              <div className="upsell-feature-icon">
                <Icon name={item.icon} size={17} />
              </div>
              <div className="upsell-feature-title">{item.title}</div>
              <div className="upsell-feature-sub">{item.sub}</div>
            </div>
          ))}
        </div>

        <div className="upsell-foot">
          <button className="btn btn-ghost" onClick={() => navigate('/')}>
            <Icon name="arrow-left" size={14} />
            回到看板
          </button>
          <span className="upsell-note">
            潮线全部功能免费开源，不设付费墙 · 计划于 {spec.roadmap} 版本推出（详见
            docs/开发计划.md）
          </span>
        </div>
      </div>
    </div>
  );
}
