import { CM_TO_WORLD } from './units';

/**
 * Quadrant snap grid: two vertical planes (front / rear) that a pattern piece
 * can be centred on. Distances are authored in cm and converted to world units
 * (1 world unit = 10 cm) where the sim/renderer live.
 */
export const QUADRANT_GRID = {
  columns: 2,
  rows: 8,
  /** Grid starts this far above the floor. */
  bottomCm: 40,
  /** Grid ends this far above the floor. */
  topCm: 150,
  /** Total width of each grid, centred on x = 0. */
  widthCm: 60,
  /** The two planes along z. */
  frontZCm: 30,
  rearZCm: -30,
} as const;

export type QuadrantPlane = {
  /** 'front' (+z) or 'rear' (−z). */
  side: 'front' | 'rear';
  /** World-space z of the plane. */
  z: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Index of this plane's first cell (planes are contiguous). */
  firstCell: number;
};

export type QuadrantLayout = {
  columns: number;
  rows: number;
  planes: QuadrantPlane[];
  cellCount: number;
  /** Per-cell world-space centre, flattened xyz. */
  centers: Float32Array;
  /** Triangle-list vertices (xyz) covering every cell. */
  cells: Float32Array;
};

export type QuadrantConfig = {
  columns: number;
  rows: number;
  bottomCm: number;
  topCm: number;
  widthCm: number;
  frontZCm: number;
  rearZCm: number;
};

export function buildQuadrantLayout(config: QuadrantConfig = QUADRANT_GRID): QuadrantLayout {
  const columns = Math.max(1, Math.round(config.columns));
  const rows = Math.max(1, Math.round(config.rows));
  const minX = -(config.widthCm * CM_TO_WORLD) / 2;
  const maxX = (config.widthCm * CM_TO_WORLD) / 2;
  const minY = config.bottomCm * CM_TO_WORLD;
  const maxY = config.topCm * CM_TO_WORLD;
  const cellCount = columns * rows;

  const planes: QuadrantPlane[] = [
    {
      side: 'front',
      z: config.frontZCm * CM_TO_WORLD,
      minX,
      maxX,
      minY,
      maxY,
      firstCell: 0,
    },
    {
      side: 'rear',
      z: config.rearZCm * CM_TO_WORLD,
      minX,
      maxX,
      minY,
      maxY,
      firstCell: cellCount,
    },
  ];

  const colWidth = (maxX - minX) / columns;
  const rowHeight = (maxY - minY) / rows;

  const centers = new Float32Array(planes.length * cellCount * 3);
  const cells = new Float32Array(planes.length * cellCount * 6 * 3);

  let vertexCursor = 0;
  for (const plane of planes) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const x0 = plane.minX + col * colWidth;
        const x1 = x0 + colWidth;
        const y0 = plane.minY + row * rowHeight;
        const y1 = y0 + rowHeight;
        const cell = plane.firstCell + row * columns + col;
        const ci = cell * 3;
        centers[ci] = (x0 + x1) / 2;
        centers[ci + 1] = (y0 + y1) / 2;
        centers[ci + 2] = plane.z;

        // Two triangles (CCW) at the plane depth.
        const quad = [
          x0, y0, plane.z,
          x1, y0, plane.z,
          x1, y1, plane.z,
          x0, y0, plane.z,
          x1, y1, plane.z,
          x0, y1, plane.z,
        ];
        cells.set(quad, vertexCursor);
        vertexCursor += quad.length;
      }
    }
  }

  return { columns, rows, planes, cellCount, centers, cells };
}

/** Triangle-list vertices for a single cell (used for the hover highlight). */
export function quadrantCellVertices(layout: QuadrantLayout, index: number): Float32Array | null {
  if (!Number.isInteger(index) || index < 0 || index >= layout.cellCount * layout.planes.length) {
    return null;
  }
  const start = index * 18;
  return layout.cells.slice(start, start + 18);
}

/** World-space centre of a cell, or null when the index is out of range. */
export function quadrantCellCenter(
  layout: QuadrantLayout,
  index: number
): [number, number, number] | null {
  if (!Number.isInteger(index) || index < 0 || index >= layout.cellCount * layout.planes.length) {
    return null;
  }
  const i = index * 3;
  return [layout.centers[i], layout.centers[i + 1], layout.centers[i + 2]];
}

/**
 * Intersect a ray with the grid planes and return the nearest cell under it.
 * Rays that miss both grids (or hit behind the origin) return null.
 */
export function pickQuadrant(
  layout: QuadrantLayout,
  origin: ArrayLike<number>,
  dir: ArrayLike<number>
): { index: number; point: [number, number, number] } | null {
  const dz = dir[2];
  if (Math.abs(dz) < 1e-8) return null;

  let best: { index: number; point: [number, number, number]; t: number } | null = null;

  for (const plane of layout.planes) {
    const t = (plane.z - origin[2]) / dz;
    if (t <= 0) continue;
    const x = origin[0] + dir[0] * t;
    const y = origin[1] + dir[1] * t;
    if (x < plane.minX || x > plane.maxX || y < plane.minY || y > plane.maxY) continue;
    if (best && t >= best.t) continue;

    const col = Math.min(
      layout.columns - 1,
      Math.max(0, Math.floor(((x - plane.minX) / (plane.maxX - plane.minX)) * layout.columns))
    );
    const row = Math.min(
      layout.rows - 1,
      Math.max(0, Math.floor(((y - plane.minY) / (plane.maxY - plane.minY)) * layout.rows))
    );
    best = {
      index: plane.firstCell + row * layout.columns + col,
      point: [x, y, plane.z],
      t,
    };
  }

  return best ? { index: best.index, point: best.point } : null;
}
