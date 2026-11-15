/**
 * 液态玻璃折射滤镜。
 *
 * 位移图中心保持中性灰，只在靠近轮廓的区域逐渐偏移 R/G 通道，
 * 因此透过玻璃的背景在中央保持稳定、在边缘产生透镜压缩。
 * 两种强度供厚玻璃（浮层/导航）与薄板（看板列/面板）共用。
 */

function gradientMap(direction: 'x' | 'y'): string {
  const vector = direction === 'x' ? 'x1="0" y1="0" x2="1" y2="0"' : 'x1="0" y1="0" x2="0" y2="1"';
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" preserveAspectRatio="none">
      <defs>
        <linearGradient id="g" ${vector}>
          <stop offset="0" stop-color="rgb(190,190,190)"/>
          <stop offset="0.22" stop-color="rgb(154,154,154)"/>
          <stop offset="0.5" stop-color="rgb(128,128,128)"/>
          <stop offset="0.78" stop-color="rgb(102,102,102)"/>
          <stop offset="1" stop-color="rgb(66,66,66)"/>
        </linearGradient>
      </defs>
      <rect width="240" height="240" fill="url(#g)"/>
    </svg>`,
  )}`;
}

const LENS_X = gradientMap('x');
const LENS_Y = gradientMap('y');

export function LiquidGlassFilters() {
  return (
    <svg className="lg-filters" aria-hidden="true" focusable="false">
      <defs>
        <filter
          id="lg-lens"
          x="-8%"
          y="-8%"
          width="116%"
          height="116%"
          colorInterpolationFilters="sRGB"
        >
          <feImage href={LENS_X} preserveAspectRatio="none" result="lensX" />
          <feImage href={LENS_Y} preserveAspectRatio="none" result="lensY" />
          <feColorMatrix
            in="lensX"
            type="matrix"
            values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="lensXChannel"
          />
          <feColorMatrix
            in="lensY"
            type="matrix"
            values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="lensYChannel"
          />
          <feComposite
            in="lensXChannel"
            in2="lensYChannel"
            operator="arithmetic"
            k2="1"
            k3="1"
            result="lensMap"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="lensMap"
            scale="128"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
        <filter
          id="lg-lens-soft"
          x="-6%"
          y="-6%"
          width="112%"
          height="112%"
          colorInterpolationFilters="sRGB"
        >
          <feImage href={LENS_X} preserveAspectRatio="none" result="lensXSoft" />
          <feImage href={LENS_Y} preserveAspectRatio="none" result="lensYSoft" />
          <feColorMatrix
            in="lensXSoft"
            type="matrix"
            values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="lensXSoftChannel"
          />
          <feColorMatrix
            in="lensYSoft"
            type="matrix"
            values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="lensYSoftChannel"
          />
          <feComposite
            in="lensXSoftChannel"
            in2="lensYSoftChannel"
            operator="arithmetic"
            k2="1"
            k3="1"
            result="lensMapSoft"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="lensMapSoft"
            scale="86"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}
