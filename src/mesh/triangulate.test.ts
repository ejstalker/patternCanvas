import { describe, expect, it } from 'vitest';
import { DEFAULT_MESH_SETTINGS, triangulate, triangulatePattern } from './triangulate';
import { pointInPolygon } from '../pattern/geometry';
import type { BezierPoint, MeshGeometry, PatternDocument, PatternPiece, Vec2 } from '../project/types';

function rectRing(x: number, y: number, w: number, h: number): Vec2[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** Thin band along the diagonal (0,0)→(len,len), half-width derived from width. */
function diagonalStripRing(len: number, width: number): Vec2[] {
  const n = { x: -width / 2, y: width / 2 };
  const a = { x: 0, y: 0 };
  const b = { x: len, y: len };
  return [
    { x: a.x + n.x, y: a.y + n.y },
    { x: b.x + n.x, y: b.y + n.y },
    { x: b.x - n.x, y: b.y - n.y },
    { x: a.x - n.x, y: a.y - n.y },
  ];
}

describe('pattern piece order through the mesh', () => {
  // The 3D stages match an arrangement to the cloth by piece id, and fall back to
  // pairing by order when a whole other pattern is plugged in — which needs the
  // mesh to hand the pieces back in the pattern's own order.
  it('tags the vertices piece by piece in the order the pattern lists them', () => {
    const make = (id: string, x: number): PatternPiece => ({
      id,
      name: id,
      closed: true,
      points: rectPoints(`${id}-p`, x, 0, 10, 10),
    });
    const pattern: PatternDocument = {
      id: 'pat',
      name: 'pat',
      pieces: [make('first', 0), make('second', 20)],
      seams: [],
    };
    const mesh = triangulatePattern(pattern, DEFAULT_MESH_SETTINGS);
    const seen: string[] = [];
    for (const id of mesh.vertexPieceIds ?? []) {
      if (id && !seen.includes(id)) seen.push(id);
    }
    expect(seen).toEqual(['first', 'second']);
  });
});

function rectPoints(prefix: string, x: number, y: number, w: number, h: number): BezierPoint[] {
  return rectRing(x, y, w, h).map((p, i) => ({
    id: `${prefix}-${i}`,
    anchor: { ...p },
    handleIn: null,
    handleOut: null,
  }));
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function distanceToPolyline(poly: Vec2[], p: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    best = Math.min(best, distanceToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return best;
}

function area2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function usedVertices(mesh: MeshGeometry): Set<number> {
  return new Set(mesh.triangles);
}

function expectNoDegenerateTriangles(mesh: MeshGeometry): void {
  for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
    const a = mesh.vertices[mesh.triangles[t]];
    const b = mesh.vertices[mesh.triangles[t + 1]];
    const c = mesh.vertices[mesh.triangles[t + 2]];
    expect(Math.abs(area2(a, b, c))).toBeGreaterThan(1e-12);
  }
}

describe('thin-strip meshing', () => {
  it('gives a narrow delaunay strip interior vertices and no isolated vertices', () => {
    const poly = rectRing(0, 0, 2, 100);
    const mesh = triangulate(poly, DEFAULT_MESH_SETTINGS);

    expect(mesh.triangles.length).toBeGreaterThanOrEqual(6);
    // Every vertex is referenced by a triangle (no unconstrained floaters).
    expect(usedVertices(mesh).size).toBe(mesh.vertices.length);
    // A strip that is only boundary-sampled would have every vertex on the edge.
    const interior = mesh.vertices.filter((v) => distanceToPolyline(poly, v) > 0.1);
    expect(interior.length).toBeGreaterThan(0);
    expectNoDegenerateTriangles(mesh);
  });

  it('does not fall back to meshing the bounding box of a diagonal strip', () => {
    const poly = diagonalStripRing(60, 2);
    const mesh = triangulate(poly, { ...DEFAULT_MESH_SETTINGS, algorithm: 'structuredGrid' });

    expect(mesh.triangles.length).toBeGreaterThanOrEqual(3);
    expect(usedVertices(mesh).size).toBe(mesh.vertices.length);
    for (const v of mesh.vertices) {
      const onOrInside = pointInPolygon(v, poly) || distanceToPolyline(poly, v) < 0.75;
      expect(onOrInside).toBe(true);
    }
  });

  it('meshes a thin pattern piece with interior vertices', () => {
    const piece: PatternPiece = {
      id: 'strap',
      name: 'strap',
      closed: true,
      points: rectPoints('strap', 0, 0, 1.5, 90),
    };
    const pattern: PatternDocument = { id: 'pat', name: 'pat', pieces: [piece], seams: [] };

    const mesh = triangulatePattern(pattern, DEFAULT_MESH_SETTINGS);
    expect(mesh.triangles.length).toBeGreaterThanOrEqual(6);
    expect(usedVertices(mesh).size).toBe(mesh.vertices.length);
    expect(mesh.vertices.length).toBeGreaterThan(20);
    const poly = rectRing(0, 0, 1.5, 90);
    const interior = mesh.vertices.filter((v) => distanceToPolyline(poly, v) > 0.1);
    expect(interior.length).toBeGreaterThan(0);
    expectNoDegenerateTriangles(mesh);
  });
});
