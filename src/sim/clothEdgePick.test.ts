import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';
import type { MeshGeometry } from '../project/types';
import {
  boundaryEdgeKey,
  buildClothBoundaryEdges,
  distanceToSegment,
  pickClothEdge,
  projectToViewport,
  seamRefForBoundaryEdge,
} from './clothEdgePick';
import { ClothEdgeOverlay } from './ClothEdgeOverlay';

/**
 * Two short parallel edges (the two sides of one thin panel) plus an interior
 * vertex, with the boundary tags deliberately out of order so the sort has to do
 * the work. World units are small enough that the identity projection below
 * lands everything comfortably inside the 100 × 100 rect.
 */
const mesh: MeshGeometry = {
  vertices: [
    { x: 0, y: 0 }, // 0 — edge a→b, t 0
    { x: 0.2, y: 0 }, // 1 — edge a→b, t 1
    { x: 0, y: 0.05 }, // 2 — edge c→d, t 1
    { x: 0.2, y: 0.05 }, // 3 — edge c→d, t 0
    { x: 0.1, y: 0.1 }, // 4 — interior
  ],
  triangles: [0, 1, 4, 1, 3, 4, 0, 4, 2, 2, 4, 3],
  edges: [],
  vertexPieceIds: ['p1', 'p1', 'p1', 'p1', 'p1'],
  boundary: [
    { pieceId: 'p1', fromPointId: 'a', toPointId: 'b', t: 1 },
    { pieceId: 'p1', fromPointId: 'a', toPointId: 'b', t: 0 },
    { pieceId: 'p1', fromPointId: 'c', toPointId: 'd', t: 1 },
    { pieceId: 'p1', fromPointId: 'c', toPointId: 'd', t: 0 },
    null,
  ],
};

/** z = 0 everywhere: with the identity matrix the world point is the NDC point. */
const positions = new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 0.05, 0, 0.2, 0.05, 0, 0.1, 0.1, 0]);

const identity = mat4.create();
const rect = { left: 0, top: 0, width: 100, height: 100 };

/**
 * Screen positions with the identity projection and a 100 × 100 rect (y flips):
 * a→b runs (50,50) → (60,50); c→d runs (50,47.5) → (60,47.5).
 */
const screenY = (worldY: number) => (0.5 - worldY * 0.5) * 100;

describe('cloth boundary edges', () => {
  it('groups mesh vertices into pattern edges, ordered by parametric t', () => {
    const edges = buildClothBoundaryEdges(mesh);
    expect(edges).toHaveLength(2);
    const ab = edges.find((e) => e.fromPointId === 'a')!;
    const cd = edges.find((e) => e.fromPointId === 'c')!;
    // t 0 then t 1 — not the order the tags appear in.
    expect(ab.vertices).toEqual([1, 0]);
    expect(cd.vertices).toEqual([3, 2]);
    // Each vertex keeps the position it was tagged with, in the same order, so a
    // pick can say where along the edge it landed.
    expect(ab.tags).toEqual([0, 1]);
    expect(cd.tags).toEqual([0, 1]);
  });

  it('ignores interior vertices and needs two samples to be an edge', () => {
    const edges = buildClothBoundaryEdges(mesh);
    for (const edge of edges) expect(edge.vertices).not.toContain(4);
    expect(buildClothBoundaryEdges(null)).toEqual([]);
    expect(
      buildClothBoundaryEdges({ ...mesh, boundary: [mesh.boundary![0], null, null, null, null] })
    ).toEqual([]);
  });

  it('keys edges by all three ids, so mirrored halves stay apart', () => {
    expect(boundaryEdgeKey('p', 'a', 'b')).not.toBe(boundaryEdgeKey('p', 'b', 'a'));
    expect(boundaryEdgeKey('p', 'a', 'b')).not.toBe(boundaryEdgeKey('q', 'a', 'b'));
  });

  it('makes a whole-edge seam reference, wound the way the piece is', () => {
    const ab = buildClothBoundaryEdges(mesh).find((e) => e.fromPointId === 'a')!;
    expect(seamRefForBoundaryEdge(ab)).toEqual({
      pieceId: 'p1',
      fromPointId: 'a',
      toPointId: 'b',
      t0: 0,
      t1: 1,
    });
  });
});

describe('projecting to the viewport', () => {
  it('maps NDC through the canvas rect', () => {
    expect(projectToViewport([0, 0, 0.5], identity, rect)).toEqual({
      x: 50,
      y: 50,
      behind: false,
    });
    expect(projectToViewport([-1, 1, 0.5], identity, rect)).toEqual({
      x: 0,
      y: 0,
      behind: false,
    });
    // The camera uses WebGPU ZO projections, whose depth range is [0, 1].
    expect(projectToViewport([0, 0, -0.5], identity, rect)?.behind).toBe(true);
    expect(projectToViewport([0, 0, 1.5], identity, rect)?.behind).toBe(true);
    expect(projectToViewport([0, 0, 0.5], identity, { ...rect, left: 10, top: 4 })).toEqual({
      x: 60,
      y: 54,
      behind: false,
    });
  });

  it('measures to a segment, not to the infinite line', () => {
    // Level with the segment.
    expect(distanceToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 9);
    // Past its end: the distance is to the end point.
    expect(distanceToSegment(14, 3, 0, 0, 10, 0)).toBeCloseTo(5, 9);
    // Degenerate: both ends in the same place.
    expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 9);
  });
});

describe('picking a cloth edge', () => {
  const edges = buildClothBoundaryEdges(mesh);
  const pick = (
    x: number,
    y: number,
    options?: Parameters<typeof pickClothEdge>[6]
  ) => pickClothEdge(edges, positions, identity, rect, x, y, options);

  it('picks the edge under the pointer', () => {
    const lower = pick(55, screenY(0));
    expect(lower?.edge.fromPointId).toBe('a');
    // On the line, to within float error in the projection.
    expect(lower?.distancePx).toBeLessThan(0.01);

    const upper = pick(55, screenY(0.05));
    expect(upper?.edge.fromPointId).toBe('c');
    expect(upper?.distancePx).toBeLessThan(0.01);
  });

  it('picks nothing when the pointer is not near an edge', () => {
    expect(pick(55, 10)).toBeNull();
    expect(pick(5, 50)).toBeNull();
  });

  it('respects the threshold', () => {
    // 1 px off the a→b line, 1.5 px off the c→d line.
    expect(pick(55, screenY(0) - 1)?.edge.fromPointId).toBe('a');
    expect(pick(55, screenY(0) - 1, { thresholdPx: 0.5 })).toBeNull();
  });

  it('says where along the edge the pointer landed', () => {
    // a→b is tagged running from x = 0.2 (t 0) to x = 0 (t 1), so its screen
    // run is 60 → 50 and the position interpolates along it.
    expect(pick(60, screenY(0))?.t).toBeCloseTo(0, 6);
    expect(pick(50, screenY(0))?.t).toBeCloseTo(1, 6);
    expect(pick(55, screenY(0))?.t).toBeCloseTo(0.5, 6);
  });

  it('prefers an edge you can see over one the cloth hides', () => {
    // Sitting exactly on a→b, but the fabric hides it: near a silhouette the far
    // side of a panel projects just as close, and it is never what was meant.
    const hidden = (point: [number, number, number]) => point[1] < 0.02;
    const hit = pick(55, screenY(0), { isHidden: hidden });
    expect(hit?.edge.fromPointId).toBe('c');
    expect(hit?.hidden).toBe(false);

    // With nothing visible, a hidden edge is still better than no edge at all.
    const allHidden = pick(55, screenY(0), { isHidden: () => true });
    expect(allHidden?.edge.fromPointId).toBe('a');
    expect(allHidden?.hidden).toBe(true);
  });

  it('ignores vertices the cloth has no positions for', () => {
    // Only vertices 0 and 1 have positions, so the c→d edge cannot be projected
    // at all — and does not get picked by falling back to the a→b line nearby.
    const short = positions.slice(0, 6);
    expect(
      pickClothEdge(edges, short, identity, rect, 55, screenY(0.05), { thresholdPx: 1 })
    ).toBeNull();
    expect(
      pickClothEdge(edges, short, identity, rect, 55, screenY(0), { thresholdPx: 1 })?.edge
        .fromPointId
    ).toBe('a');
  });

  it('gives up when the canvas has no size yet', () => {
    expect(
      pickClothEdge(edges, positions, identity, { ...rect, width: 0 }, 55, 50)
    ).toBeNull();
  });
});

describe('cloth edge overlay', () => {
  const points = [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
  ];

  it('shows a line only while there is an edge to show', () => {
    const host = document.createElement('div');
    const overlay = new ClothEdgeOverlay(host);
    const lines = Array.from(host.querySelectorAll('.cloth-edge-line'));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect((line as SVGElement).style.display).toBe('none');

    overlay.setHover(points);
    const hover = host.querySelector('.cloth-edge-line.is-hover')!;
    expect(hover.getAttribute('points')).toBe('1.00,2.00 3.00,4.00');
    expect((hover as SVGElement).style.display).toBe('block');

    overlay.setSource(points);
    expect(
      host.querySelector('.cloth-edge-line.is-source')!.getAttribute('points')
    ).toBe('1.00,2.00 3.00,4.00');

    overlay.setHover(null);
    expect((hover as SVGElement).style.display).toBe('none');
    // A single point is not a line.
    overlay.setSource([points[0]]);
    expect(
      (host.querySelector('.cloth-edge-line.is-source') as SVGElement).style.display
    ).toBe('none');

    overlay.destroy();
    expect(host.querySelector('.cloth-edge-overlay')).toBeNull();
  });
});
