/**
 * 看板任务链连线的纯布局计算。
 *
 * 输入两张卡片的相对矩形（相对看板画布），输出一条带弧度的三次贝塞尔路径。
 * 前置任务 → 后置任务：优先从右侧连到左侧；同一列上下关系则从底部连到顶部，
 * 并向右弯出弧线，避免完全压住卡片文本。
 */

export interface CardBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const H_GAP = 10;

function midY(box: CardBox): number {
  return box.top + box.height / 2;
}

function curvePath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  control1X: number,
  control1Y: number,
  control2X: number,
  control2Y: number,
): string {
  return `M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${control1X.toFixed(1)} ${control1Y.toFixed(1)}, ${control2X.toFixed(1)} ${control2Y.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}`;
}

/** 计算前置卡片到后置卡片的连线路径；同一位置返回 null。 */
export function dependencyPath(from: CardBox, to: CardBox): string | null {
  const fromCenterY = midY(from);
  const toCenterY = midY(to);
  // 左右分开：从右边缘连到左边缘，弧线落在列间空隙里。
  if (from.right + H_GAP <= to.left) {
    const startX = from.right - 1;
    const endX = to.left + 1;
    const dx = endX - startX;
    return curvePath(
      startX,
      fromCenterY,
      endX,
      toCenterY,
      startX + dx * 0.55,
      fromCenterY,
      endX - dx * 0.55,
      toCenterY,
    );
  }
  if (to.right + H_GAP <= from.left) {
    const startX = from.left + 1;
    const endX = to.right - 1;
    const dx = endX - startX;
    return curvePath(
      startX,
      fromCenterY,
      endX,
      toCenterY,
      startX + dx * 0.55,
      fromCenterY,
      endX - dx * 0.55,
      toCenterY,
    );
  }

  // 同一列（或横向重叠）：从右侧绕出去，形成沿列边的竖向弧线，
  // 避免只连接两张相邻卡片之间那几像素的缝隙。
  const sideX = Math.max(from.right, to.right) + 28;
  return curvePath(
    from.right - 1,
    fromCenterY,
    to.right - 1,
    toCenterY,
    sideX,
    fromCenterY,
    sideX,
    toCenterY,
  );
}
