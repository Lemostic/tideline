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

/** 目标：功能占位页，保持菜单可用且表达清楚 */
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
