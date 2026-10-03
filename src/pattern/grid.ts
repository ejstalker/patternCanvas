import type { UnitDisplay } from '../project/types';

export type GridBox = { x: number; y: number; w: number; h: number };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Assumed viewport size before flex layout settles. */
const FALLBACK_LAYOUT_PX = 360;

/**
 * How coarsely the minor spacing has to step before it is legible. Lines never
 * get closer than this on screen, however far you zoom out.
 */
const MIN_GAP_PX = 4;

/** Multipliers applied to the base unit, coarse enough to stay exact in binary. */
const LADDER = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/**
 * Minor/major reference grid in pattern units — 1 cm / 10 cm, or 1 in / 1 ft.
 *
 * Two things to keep in mind:
 * - Lines deliberately overshoot the viewBox. `xMidYMid meet` letterboxes the
 *   content whenever the viewBox aspect no longer matches the viewport, and a
 *   grid that stops at the viewBox edge looks cut off inside that margin.
 * - The minor spacing steps up a ladder as you zoom out so the lines never
 *   collapse into a solid wash, with the major line staying a fixed multiple of
 *   the minor one.
 *
 * Stroke widths are emitted in pattern units so they stay a constant pixel
 * weight as the viewBox scales (do not add `vector-effect: non-scaling-stroke`,
 * that would double-compensate).
 */
export function buildGridGroup(
  viewBox: GridBox,
  unit: UnitDisplay,
  layout: { width: number; height: number }
): SVGGElement {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'pattern-grid');

  const settled = layout.width >= 2 && layout.height >= 2;
  const layoutW = settled ? layout.width : FALLBACK_LAYOUT_PX;
  const layoutH = settled ? layout.height : FALLBACK_LAYOUT_PX;
  const scale = Math.min(layoutW / viewBox.w, layoutH / viewBox.h);
  if (!(scale > 0) || !Number.isFinite(scale)) return group;
  const px = (cssPixels: number): number => cssPixels / scale;

  const isInches = unit === 'in';
  const base = isInches ? 2.54 : 1; // 1 in ≈ 2.54 cm
  const perMajor = isInches ? 12 : 10; // 1 ft = 12 in · 10 cm
  let factor = LADDER[LADDER.length - 1]!;
  for (const m of LADDER) {
    if (base * m * scale >= MIN_GAP_PX) {
      factor = m;
      break;
    }
  }
  const minor = base * factor;
  const major = minor * perMajor;

  // How far the element reaches past the viewBox on each axis (letterbox).
  const overX = Math.max(0, layoutW / scale - viewBox.w) / 2 + px(2);
  const overY = Math.max(0, layoutH / scale - viewBox.h) / 2 + px(2);
  const left = viewBox.x - overX;
  const right = viewBox.x + viewBox.w + overX;
  const top = viewBox.y - overY;
  const bottom = viewBox.y + viewBox.h + overY;

  const isMajor = (v: number): boolean => {
    const n = v / major;
    return Math.abs(n - Math.round(n)) < 1e-6;
  };
  const addLine = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    cls: string,
    width: number
  ): void => {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    line.setAttribute('class', cls);
    line.setAttribute('stroke-width', String(width));
    group.appendChild(line);
  };

  // Minor lines first so the heavier major lines sit on top of them.
  const minorW = px(1);
  const majorW = px(1.8);
  const startX = Math.floor(left / minor) * minor;
  const startY = Math.floor(top / minor) * minor;
  for (let gx = startX; gx <= right; gx += minor) {
    if (isMajor(gx)) continue;
    addLine(gx, top, gx, bottom, 'pattern-grid-minor', minorW);
  }
  for (let gy = startY; gy <= bottom; gy += minor) {
    if (isMajor(gy)) continue;
    addLine(left, gy, right, gy, 'pattern-grid-minor', minorW);
  }
  const startMajorX = Math.floor(left / major) * major;
  const startMajorY = Math.floor(top / major) * major;
  for (let gx = startMajorX; gx <= right; gx += major) {
    addLine(gx, top, gx, bottom, 'pattern-grid-major', majorW);
  }
  for (let gy = startMajorY; gy <= bottom; gy += major) {
    addLine(left, gy, right, gy, 'pattern-grid-major', majorW);
  }
  return group;
}

/** Layout CSS px per pattern unit for a `xMidYMid meet` viewBox. */
export function viewScaleFor(
  viewBox: GridBox,
  layout: { width: number; height: number }
): number {
  const settled = layout.width >= 2 && layout.height >= 2;
  const w = settled ? layout.width : FALLBACK_LAYOUT_PX;
  const h = settled ? layout.height : FALLBACK_LAYOUT_PX;
  if (viewBox.w <= 0 || viewBox.h <= 0) return 1;
  return Math.min(w / viewBox.w, h / viewBox.h);
}
