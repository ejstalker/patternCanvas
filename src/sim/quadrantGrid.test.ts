import { describe, expect, it } from 'vitest';
import {
  QUADRANT_GRID,
  buildQuadrantLayout,
  pickQuadrant,
  quadrantCellCenter,
  quadrantCellVertices,
} from './quadrantGrid';

const layout = buildQuadrantLayout();

describe('quadrant grid layout', () => {
  it('has two planes of 2 × 8 cells', () => {
    expect(layout.columns).toBe(2);
    expect(layout.rows).toBe(8);
    expect(layout.planes).toHaveLength(2);
    expect(layout.cellCount).toBe(16);
    expect(layout.centers.length).toBe(2 * 16 * 3);
    expect(layout.cells.length).toBe(2 * 16 * 6 * 3);
  });

  it('spans 40 cm → 150 cm in height and ±30 cm in depth', () => {
    const [front, rear] = layout.planes;
    expect(front.side).toBe('front');
    expect(front.z).toBeCloseTo(3);
    expect(rear.side).toBe('rear');
    expect(rear.z).toBeCloseTo(-3);
    for (const plane of layout.planes) {
      expect(plane.minY).toBeCloseTo(4);
      expect(plane.maxY).toBeCloseTo(15);
      expect(plane.minX).toBeCloseTo(-3);
      expect(plane.maxX).toBeCloseTo(3);
    }
  });

  it('centres the first front cell (bottom-left quadrant)', () => {
    const center = quadrantCellCenter(layout, 0)!;
    expect(center[0]).toBeCloseTo(-1.5);
    expect(center[1]).toBeCloseTo(4 + (15 - 4) / 16);
    expect(center[2]).toBeCloseTo(3);
  });

  it('indexes the rear plane after the front plane', () => {
    const rearBottomLeft = quadrantCellCenter(layout, 16)!;
    expect(rearBottomLeft[2]).toBeCloseTo(-3);
    const last = quadrantCellCenter(layout, 31)!;
    expect(last[0]).toBeCloseTo(1.5);
    expect(last[2]).toBeCloseTo(-3);
  });

  it('returns null for out-of-range cells', () => {
    expect(quadrantCellCenter(layout, -1)).toBeNull();
    expect(quadrantCellCenter(layout, 32)).toBeNull();
    expect(quadrantCellVertices(layout, 32)).toBeNull();
  });

  it('emits 6 vertices per cell, all at the plane depth', () => {
    for (const index of [0, 9, 15, 16, 31]) {
      const verts = quadrantCellVertices(layout, index)!;
      expect(verts.length).toBe(18);
      const expectedZ = quadrantCellCenter(layout, index)![2];
      for (let i = 2; i < verts.length; i += 3) {
        expect(verts[i]).toBeCloseTo(expectedZ);
      }
    }
  });
});

describe('pickQuadrant', () => {
  it('hits the front grid for a ray travelling toward −z', () => {
    const hit = pickQuadrant(layout, [0, 10, 10], [0, 0, -1]);
    expect(hit).not.toBeNull();
    // x = 0 → second column; y = 10 → row 4 (rows are 1.375 deep from y = 4).
    expect(hit!.index).toBe(4 * 2 + 1);
    expect(hit!.point[2]).toBeCloseTo(3);
  });

  it('hits the rear grid for a ray travelling toward +z', () => {
    const hit = pickQuadrant(layout, [0, 10, -10], [0, 0, 1]);
    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(16 + 4 * 2 + 1);
    expect(hit!.point[2]).toBeCloseTo(-3);
  });

  it('prefers the nearer plane when the ray crosses both', () => {
    // From z = −10 toward +z: rear plane (z = −3, t = 7) is nearer than front (t = 13).
    const rear = pickQuadrant(layout, [0, 10, -10], [0, 0, 1]);
    expect(rear!.point[2]).toBeCloseTo(-3);
    expect(rear!.index).toBe(16 + 4 * 2 + 1);
    // From z = 10 toward −z: front plane (z = 3, t = 7) wins.
    const front = pickQuadrant(layout, [0, 10, 10], [0, 0, -1]);
    expect(front!.point[2]).toBeCloseTo(3);
    expect(front!.index).toBe(4 * 2 + 1);
  });

  it('returns null when the ray misses the grid bounds', () => {
    expect(pickQuadrant(layout, [100, 10, 10], [0, 0, -1])).toBeNull();
    expect(pickQuadrant(layout, [0, 100, 10], [0, 0, -1])).toBeNull();
    // Parallel to the planes.
    expect(pickQuadrant(layout, [0, 10, 10], [1, 0, 0])).toBeNull();
  });

  it('maps the outer corners of a plane', () => {
    const bottomLeft = pickQuadrant(layout, [-2.9, 4.1, 10], [0, 0, -1]);
    expect(bottomLeft!.index).toBe(0);
    const topRight = pickQuadrant(layout, [2.9, 14.9, 10], [0, 0, -1]);
    expect(topRight!.index).toBe(7 * 2 + 1);
  });

  it('uses the documented defaults', () => {
    expect(QUADRANT_GRID.columns).toBe(2);
    expect(QUADRANT_GRID.rows).toBe(8);
    expect(QUADRANT_GRID.bottomCm).toBe(40);
    expect(QUADRANT_GRID.topCm).toBe(150);
    expect(QUADRANT_GRID.frontZCm).toBe(30);
    expect(QUADRANT_GRID.rearZCm).toBe(-30);
  });
});
