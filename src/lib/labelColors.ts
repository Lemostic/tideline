import type { Board, BoardColor } from './types';

const LABEL_PALETTE: readonly BoardColor[] = ['blue', 'amber', 'coral', 'green', 'violet', 'rose', 'teal'];
const LABEL_HEX: Record<BoardColor, string> = {
  blue: '#225de0', amber: '#986000', coral: '#bd422a', green: '#147646',
  violet: '#7140ca', rose: '#af2e60', teal: '#087d78', slate: '#4b5663',
};

/** A deterministic palette assignment: the same label keeps its color after reload. */
export function labelColorKey(label: string, board?: Board): BoardColor {
  const override = board?.labelColors?.[label];
  if (override && Object.prototype.hasOwnProperty.call(LABEL_HEX, override)) return override;
  let hash = 2166136261;
  for (const character of label) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  }
  return LABEL_PALETTE[(hash >>> 0) % LABEL_PALETTE.length];
}

export function labelStyle(label: string, board?: Board) {
  return { backgroundColor: LABEL_HEX[labelColorKey(label, board)], color: '#ffffff' };
}
