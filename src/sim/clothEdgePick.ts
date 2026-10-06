import { vec4, type mat4 } from 'gl-matrix';
import type { MeshGeometry } from '../project/types';

/**
 * Picking a pattern edge off the cloth in a 3D viewport.
 *
 * Meshing already records, for every vertex sitting on a piece outline, which
 * pattern edge it came from and where along that edge it lies (`mesh.boundary`).
 * Grouping those tags by edge gives the discretised outline of every piece in
 * world space for free — which is exactly what has to be highlighted and clicked
 * to sew. Nothing here touches WebGPU: it is projection plus 2D distance, so it
 * can be reasoned about (and tested) without a canvas.
 *
 * Note that the outline is *not* `mesh.edges`: that list also holds interior
 * triangulation edges, and a vertex pair spanning two pattern edges would make a
 * nonsense seam. Grouping by tag keeps every candidate on a single pattern edge.
 */

/** One pattern edge, as the mesh vertices that lie along it. */
export type ClothBoundaryEdge = {
  pieceId: string;
  fromPointId: string;
  toPointId: string;
  /** Indices into `MeshGeometry.vertices`, ordered from `fromPointId` onwards. */
  vertices: number[];
  /**
   * Parametric position of each of those vertices on the pattern edge, ascending.
   * A pick reports where along the edge it landed so the seam a click means can be
   * told from the ones sharing the edge.
   */
  tags: number[];
};

export type ViewportRect = { left: number; top: number; width: number; height: number };

export type ClothEdgeHit = {
  edge: ClothBoundaryEdge;
  /** Parametric position along the edge the pointer is nearest, 0..1. */
  t: number;
  /** Screen distance from the pointer to the edge, in CSS pixels. */
  distancePx: number;
  /** True when the cloth hides this edge from the camera. */
  hidden: boolean;
};

export type ClothEdgePickOptions = {
  /** How far from the pointer an edge may be and still count. CSS pixels. */
  thresholdPx?: number;
  /**
   * True when the cloth surface hides this world point from the camera. Used to
   * reject the far side of a panel, whose outline projects just as close to the
   * pointer as the near side does.
   */
  isHidden?: (point: [number, number, number]) => boolean;
};

/** Stable key for the edge two point ids name. */
export function boundaryEdgeKey(pieceId: string, fromPointId: string, toPointId: string): string {
  return `${pieceId}\u0000${fromPointId}\u0000${toPointId}`;
}

/**
 * Every pattern edge the mesh has outline vertices for, in reading order.
 *
 * Vertices are sorted by their recorded parametric `t` rather than by index: the
 * mesh may place or renumber them in any order (Lloyd smoothing, compaction),
 * and a polyline that zig-zags across the edge would measure distances wrongly.
 */
export function buildClothBoundaryEdges(
  mesh: MeshGeometry | null | undefined
): ClothBoundaryEdge[] {
  const tags = mesh?.boundary;
  if (!mesh || !tags || tags.length === 0) return [];

  const buckets = new Map<string, { edge: ClothBoundaryEdge; t: number[] }>();
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (!tag) continue;
    const key = boundaryEdgeKey(tag.pieceId, tag.fromPointId, tag.toPointId);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        edge: {
          pieceId: tag.pieceId,
          fromPointId: tag.fromPointId,
          toPointId: tag.toPointId,
          vertices: [],
          tags: [],
        },
        t: [],
      };
      buckets.set(key, bucket);
    }
    bucket.edge.vertices.push(i);
    bucket.t.push(tag.t);
  }

  const out: ClothBoundaryEdge[] = [];
  for (const { edge, t } of buckets.values()) {
    const order = t.map((_, i) => i).sort((a, b) => t[a] - t[b]);
    edge.vertices = order.map((i) => edge.vertices[i]);
    edge.tags = order.map((i) => t[i]);
    if (edge.vertices.length >= 2) out.push(edge);
  }
  return out;
}

/** Project a world point into CSS pixels, using the canvas rect the ray came from. */
export function projectToViewport(
  world: ArrayLike<number>,
  viewProj: mat4,
  rect: ViewportRect
): { x: number; y: number; behind: boolean } | null {
  const clip = vec4.fromValues(world[0], world[1], world[2], 1);
  vec4.transformMat4(clip, clip, viewProj);
  if (Math.abs(clip[3]) < 1e-8) return null;
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  const ndcZ = clip[2] / clip[3];
  return {
    x: rect.left + (ndcX * 0.5 + 0.5) * rect.width,
    y: rect.top + (-ndcY * 0.5 + 0.5) * rect.height,
    // Camera uses WebGPU ZO projections, whose NDC depth range is [0, 1].
    behind: ndcZ < 0 || ndcZ > 1 || clip[3] < 0,
  };
}

/** Shortest distance from a point to a segment, all in the same 2D space. */
export function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  return closestOnSegment(px, py, ax, ay, bx, by).dist;
}

/** Distance to a segment, plus how far along it the nearest point lies. */
function closestOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { dist: number; fraction: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return { dist: Math.hypot(px - ax, py - ay), fraction: 0 };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return { dist: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), fraction: t };
}

function closestOnPolyline(
  px: number,
  py: number,
  points: ReadonlyArray<{ x: number; y: number }>
): { dist: number; segment: number; fraction: number } | null {
  let best: { dist: number; segment: number; fraction: number } | null = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const hit = closestOnSegment(px, py, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y);
    if (!best || hit.dist < best.dist) best = { ...hit, segment: i };
  }
  return best;
}

/**
 * Where along the pattern edge a point between two samples lies.
 *
 * The samples are ordered by their tag, so the two bracketing tags bound the
 * position and interpolating between them is monotonic — including across the
 * corners of a curve, where arc length and parametric t disagree.
 */
function interpolateTag(edge: ClothBoundaryEdge, segment: number, fraction: number): number {
  const a = edge.tags[segment];
  const b = edge.tags[segment + 1];
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.min(1, Math.max(0, a + (b - a) * fraction));
}

/**
 * The pattern edge nearest the pointer, or null when the pointer is not near one.
 *
 * A visible edge always beats a hidden one: near the silhouette the far side of a
 * panel lands within the threshold just as easily as the near side, and picking
 * the edge you cannot see is never what was meant.
 */
export function pickClothEdge(
  edges: readonly ClothBoundaryEdge[],
  positions: ArrayLike<number>,
  viewProj: mat4,
  rect: ViewportRect,
  clientX: number,
  clientY: number,
  options: ClothEdgePickOptions = {}
): ClothEdgeHit | null {
  const threshold = options.thresholdPx ?? 10;
  const screen: Array<{ x: number; y: number }> = [];
  let best: ClothEdgeHit | null = null;

  for (const edge of edges) {
    screen.length = 0;
    let offscreen = false;
    for (const vi of edge.vertices) {
      if (vi < 0 || vi * 3 + 2 >= positions.length) {
        offscreen = true;
        break;
      }
      const p = projectToViewport(
        [positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]],
        viewProj,
        rect
      );
      if (!p || p.behind) {
        offscreen = true;
        break;
      }
      screen.push({ x: p.x, y: p.y });
    }
    if (offscreen || screen.length < 2) continue;

    const closest = closestOnPolyline(clientX, clientY, screen);
    if (!closest || closest.dist > threshold) continue;
    const distancePx = closest.dist;

    const mid = edge.vertices[edge.vertices.length >> 1];
    const hidden = options.isHidden
      ? options.isHidden([
          positions[mid * 3],
          positions[mid * 3 + 1],
          positions[mid * 3 + 2],
        ])
      : false;

    const better =
      !best ||
      (best.hidden && !hidden) ||
      (best.hidden === hidden && distancePx < best.distancePx);
    if (better) best = { edge, t: interpolateTag(edge, closest.segment, closest.fraction), distancePx, hidden };
  }

  return best;
}

/** Evenly spaced distinct indices into `length`, ascending. */
function evenIndices(length: number, count: number): number[] {
  if (count <= 0) return [];
  if (count >= length) return Array.from({ length }, (_, i) => i);
  const out: number[] = [];
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0 : i / (count - 1);
    let idx = Math.round(f * (length - 1));
    if (used.has(idx)) {
      let delta = 1;
      while (used.has(idx) && delta < length) {
        const lo = idx - delta;
        const hi = idx + delta;
        if (lo >= 0 && !used.has(lo)) {
          idx = lo;
          break;
        }
        if (hi < length && !used.has(hi)) {
          idx = hi;
          break;
        }
        delta++;
      }
    }
    used.add(idx);
    out.push(idx);
  }
  return out;
}

/** A picked edge's mesh vertices ordered the way `ref` reads them. */
export function edgeVerticesInReadOrder(
  edge: ClothBoundaryEdge,
  ref: { t0: number; t1: number }
): number[] {
  return ref.t0 > ref.t1 ? [...edge.vertices].reverse() : edge.vertices;
}

/**
 * The stitches a seam between these two edges would make, as mesh-vertex index
 * pairs — the same rank-order zip the mesher performs (`resolveSeamParticlePairs`),
 * so a preview shows exactly what committing the seam would stitch and reveals a
 * crossing, reversed run before it is created.
 */
export function buildStitchPreviewPairs(
  edgeA: ClothBoundaryEdge,
  refA: { t0: number; t1: number },
  edgeB: ClothBoundaryEdge,
  refB: { t0: number; t1: number }
): Array<[number, number]> {
  const va = edgeVerticesInReadOrder(edgeA, refA);
  const vb = edgeVerticesInReadOrder(edgeB, refB);
  const count = Math.min(va.length, vb.length);
  if (count < 1) return [];
  const ia = evenIndices(va.length, count);
  const ib = evenIndices(vb.length, count);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) pairs.push([va[ia[i]], vb[ib[i]]]);
  return pairs;
}

/** A `SeamEdgeRef` for the whole of one picked edge. */export function seamRefForBoundaryEdge(edge: ClothBoundaryEdge): {
  pieceId: string;
  fromPointId: string;
  toPointId: string;
  t0: number;
  t1: number;
} {
  return {
    pieceId: edge.pieceId,
    fromPointId: edge.fromPointId,
    toPointId: edge.toPointId,
    t0: 0,
    t1: 1,
  };
}
