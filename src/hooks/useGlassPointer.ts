import { useEffect, type RefObject } from 'react';

/**
 * 把指针位置写给应用外壳，玻璃表面的镜面光斑通过 fixed 背景跟随指针。
 * 只在鼠标设备上启用，并用 rAF 合并高频移动事件。
 */
export function useGlassPointer(shellRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof window.matchMedia !== 'function') return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let x = 0;
    let y = 0;

    const flush = () => {
      frame = 0;
      shell.style.setProperty('--lg-px', `${x}px`);
      shell.style.setProperty('--lg-py', `${y}px`);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || reducedMotion.matches) return;
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = window.requestAnimationFrame(flush);
    };

    const onPointerLeave = () => {
      shell.style.removeProperty('--lg-px');
      shell.style.removeProperty('--lg-py');
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerleave', onPointerLeave);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerleave', onPointerLeave);
      shell.style.removeProperty('--lg-px');
      shell.style.removeProperty('--lg-py');
    };
  }, [shellRef]);
}
