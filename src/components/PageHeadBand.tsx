/**
 * 页面标题带（潮汐表式读数条）。
 *
 * 左侧是标题与说明，右侧是一组读数：标签 + 数值，读数之间用刻度线分隔。
 * 刻度只在承载数据时出现——没有读数就没有刻度，不会退化成装饰。
 */
import type { ReactNode } from 'react';

export interface ReadoutItem {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'danger' | 'accent' | 'muted';
}

interface PageHeadBandProps {
  title: ReactNode;
  /** 标题上方的位置说明，例如「工作台 · 2026 年 10 月 31 日 周六」 */
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** 右侧读数 */
  readouts?: ReadoutItem[];
  /** 标题下方的操作区 */
  actions?: ReactNode;
}

export function PageHeadBand({
  title,
  eyebrow,
  description,
  readouts = [],
  actions,
}: PageHeadBandProps) {
  const hasReadout = readouts.length > 0;

  return (
    <header className="page-head-band">
      <div className="page-head-top">
        <div className="page-head-main">
          {eyebrow ? <div className="page-eyebrow">{eyebrow}</div> : null}
          <h1 className="page-head-title">{title}</h1>
          {description ? <p className="page-head-sub">{description}</p> : null}
        </div>

        {hasReadout ? (
          <div className="readout">
            {readouts.map((item, index) => (
              <div key={item.label} className="readout-group">
                {index > 0 ? <span className="readout-divider" aria-hidden="true" /> : null}
                <span className="readout-item">
                  <span className="readout-label">{item.label}</span>
                  <span
                    className={`readout-value${item.tone && item.tone !== 'default' ? ` is-${item.tone}` : ''}`}
                  >
                    {item.value}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="page-head-rule" aria-hidden="true" />

      {actions ? <div className="page-head-actions">{actions}</div> : null}
    </header>
  );
}
