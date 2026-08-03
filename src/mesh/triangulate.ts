import Delaunator from 'delaunator';
import {
  boundsOf,
  dist,
  edgeArcLengthBetweenParams,
  edgeLengthByPointIds,
  findNearestEdge,
  isSeamEdgeValid,
  buildEdgeArcTable,
  pointInPolygon,
  pointOnEdgeAtArcFractionInSpan,
  pointOnEdgeAtT,
  pieceToPolyline,
} from '../pattern/geometry';
import type {
  PatternDocument,
  PatternPiece,
  SeamEdgeRef,
  SeamVertexTag,
  Vec2,
} from '../project/types';
import type { MeshAlgorithm, MeshGeometry, MeshSettings } from '../project/types';

export const DEFAULT_MESH_SETTINGS: MeshSettings = {
  algorithm: 'delaunay',
  targetEdgeCm: 4,
  boundarySpacingCm: 2,
  lloydIterations: 3,
};

const FALLBACK_POLYGON: Vec2[] = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 50 },
  { x: 0, y: 50 },
];

/** Flatten a single pattern piece to a polygon outline. */
export function pieceToPolygon(piece: { points: PatternDocument['pieces'][number]['points']; closed: boolean }): Vec2[] {
  return pieceToPolyline(piece.points, piece.closed, 20);
}

/** Every closed piece with an outline, as separate polygons (one per garment panel). */
export function patternToPolygons(pattern: PatternDocument | undefined): Vec2[][] {
  const closedPieces = (pattern?.pieces ?? []).filter((p) => p.closed && p.points.length >= 3);
  if (closedPieces.length === 0) {
    // Fall back to any piece at all (open outline) so something meshes, else a default rect.
    const anyPiece = pattern?.pieces.find((p) => p.points.length >= 3);
    return anyPiece ? [pieceToPolygon(anyPiece)] : [FALLBACK_POLYGON];
  }
  return closedPieces.map(pieceToPolygon);
}

/** Flatten pattern pieces to a single outer polygon (first closed piece). */
export function patternToPolygon(pattern: PatternDocument | undefined): Vec2[] {
  return patternToPolygons(pattern)[0] ?? FALLBACK_POLYGON;
}

function sampleBoundary(poly: Vec2[], spacingCm: number): Vec2[] {
  if (poly.length < 2) return [...poly];
  const spacing = Math.max(0.5, spacingCm);
  const out: Vec2[] = [];
  const n = poly.length;
  // Assume closed ring (last may equal first)
  const ring = [...poly];
  if (dist(ring[0], ring[ring.length - 1]) > 1e-6) ring.push({ ...ring[0] });

  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const len = dist(a, b);
    const steps = Math.max(1, Math.ceil(len / spacing));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return dedupePoints(out, spacing * 0.25);
}

function sampleInteriorGrid(poly: Vec2[], spacingCm: number): Vec2[] {
  const { min, max } = boundsOf(poly);
  const spacing = Math.max(0.75, spacingCm);
  const out: Vec2[] = [];
  // Inset slightly so boundary samples own the edge
  const inset = spacing * 0.35;
  for (let y = min.y + inset; y <= max.y - inset; y += spacing) {
    for (let x = min.x + inset; x <= max.x - inset; x += spacing) {
      const p = { x, y };
      if (pointInPolygon(p, poly)) out.push(p);
    }
  }
  return out;
}

function dedupePoints(points: Vec2[], minDist: number): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    if (out.some((q) => dist(p, q) < minDist)) continue;
    out.push(p);
  }
  return out;
}

function triangleCentroid(a: Vec2, b: Vec2, c: Vec2): Vec2 {
  return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
}

function uniqueEdges(triangles: number[]): Array<[number, number]> {
  const seen = new Set<string>();
  const edges: Array<[number, number]> = [];
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const tri = [triangles[i], triangles[i + 1], triangles[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([a, b]);
    }
  }
  return edges;
}

function delaunayFilter(points: Vec2[], poly: Vec2[]): MeshGeometry {
  if (points.length < 3) {
    return { vertices: points, triangles: [], edges: [] };
  }
  const coords = new Float64Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    coords[i * 2] = points[i].x;
    coords[i * 2 + 1] = points[i].y;
  }
  const del = new Delaunator(coords);
  const triangles: number[] = [];
  for (let i = 0; i < del.triangles.length; i += 3) {
    const i0 = del.triangles[i];
    const i1 = del.triangles[i + 1];
    const i2 = del.triangles[i + 2];
    const c = triangleCentroid(points[i0], points[i1], points[i2]);
    if (!pointInPolygon(c, poly)) continue;
    triangles.push(i0, i1, i2);
  }
  return {
    vertices: points,
    triangles,
    edges: uniqueEdges(triangles),
  };
}

function triangulateStructuredGrid(poly: Vec2[], targetEdgeCm: number): MeshGeometry {
  const { min, max } = boundsOf(poly);
  const width = Math.max(max.x - min.x, 1);
  const height = Math.max(max.y - min.y, 1);
  const spacing = Math.max(0.75, targetEdgeCm);
  const cols = Math.max(3, Math.min(80, Math.round(width / spacing) + 1));
  const rows = Math.max(3, Math.min(80, Math.round(height / spacing) + 1));
  const stepX = width / (cols - 1);
  const stepY = height / (rows - 1);

  const gridToVert = new Int32Array(cols * rows).fill(-1);
  const vertices: Vec2[] = [];

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p = { x: min.x + i * stepX, y: min.y + j * stepY };
      if (!pointInPolygon(p, poly)) continue;
      gridToVert[j * cols + i] = vertices.length;
      vertices.push(p);
    }
  }

  // Fallback full rect if polygon cull emptied the grid
  if (vertices.length < 4) {
    vertices.length = 0;
    gridToVert.fill(-1);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        gridToVert[j * cols + i] = vertices.length;
        vertices.push({ x: min.x + i * stepX, y: min.y + j * stepY });
      }
    }
  }

  const triangles: number[] = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const i00 = gridToVert[j * cols + i];
      const i10 = gridToVert[j * cols + i + 1];
      const i01 = gridToVert[(j + 1) * cols + i];
      const i11 = gridToVert[(j + 1) * cols + i + 1];
      if (i00 < 0 || i10 < 0 || i01 < 0 || i11 < 0) continue;
      // Alternate diagonal for less bias
      if ((i + j) % 2 === 0) {
        triangles.push(i00, i10, i11, i00, i11, i01);
      } else {
        triangles.push(i00, i10, i01, i10, i11, i01);
      }
    }
  }

  return { vertices, triangles, edges: uniqueEdges(triangles) };
}

function triangulateDelaunay(poly: Vec2[], settings: MeshSettings): MeshGeometry {
  const boundary = sampleBoundary(poly, settings.boundarySpacingCm);
  const interior = sampleInteriorGrid(poly, settings.targetEdgeCm);
  const points = dedupePoints([...boundary, ...interior], Math.min(settings.targetEdgeCm, settings.boundarySpacingCm) * 0.2);
  return delaunayFilter(points, poly);
}

/** Lloyd relaxation on interior points, then Delaunay — more even triangles. */
function triangulateCentroidal(poly: Vec2[], settings: MeshSettings): MeshGeometry {
  let mesh = triangulateDelaunay(poly, settings);
  const iters = Math.max(0, Math.min(12, settings.lloydIterations));
  if (iters === 0 || mesh.vertices.length < 4) return mesh;

  const boundarySet = new Set<number>();
  // Treat points near boundary as fixed
  const boundaryPts = sampleBoundary(poly, settings.boundarySpacingCm);
  for (let i = 0; i < mesh.vertices.length; i++) {
    const p = mesh.vertices[i];
    if (boundaryPts.some((b) => dist(b, p) < settings.boundarySpacingCm * 0.4)) {
      boundarySet.add(i);
    }
  }

  for (let iter = 0; iter < iters; iter++) {
    const accum = mesh.vertices.map(() => ({ x: 0, y: 0, w: 0 }));
    for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
      const i0 = mesh.triangles[t];
      const i1 = mesh.triangles[t + 1];
      const i2 = mesh.triangles[t + 2];
      const c = triangleCentroid(mesh.vertices[i0], mesh.vertices[i1], mesh.vertices[i2]);
      for (const idx of [i0, i1, i2]) {
        accum[idx].x += c.x;
        accum[idx].y += c.y;
        accum[idx].w += 1;
      }
    }
    const next = mesh.vertices.map((p, i) => {
      if (boundarySet.has(i) || accum[i].w === 0) return p;
      const q = { x: accum[i].x / accum[i].w, y: accum[i].y / accum[i].w };
      return pointInPolygon(q, poly) ? q : p;
    });
    mesh = delaunayFilter(next, poly);
  }
  return mesh;
}

export function triangulate(poly: Vec2[], settings: MeshSettings): MeshGeometry {
  const polygon = poly.length >= 3 ? poly : patternToPolygon(undefined);
  switch (settings.algorithm as MeshAlgorithm) {
    case 'structuredGrid':
      return triangulateStructuredGrid(polygon, settings.targetEdgeCm);
    case 'centroidal':
      return triangulateCentroidal(polygon, settings);
    case 'delaunay':
    default:
      return triangulateDelaunay(polygon, settings);
  }
}

/** Merge multiple independent mesh islands (one per pattern piece) into one MeshGeometry. */
function mergeMeshes(meshes: MeshGeometry[]): MeshGeometry {
  const vertices: Vec2[] = [];
  const vertexPieceIds: Array<string | null> = [];
  const triangles: number[] = [];
  const edges: Array<[number, number]> = [];
  const boundary: Array<SeamVertexTag | null> = [];
  let hasBoundary = false;
  for (const m of meshes) {
    const offset = vertices.length;
    vertices.push(...m.vertices);
    if (m.vertexPieceIds?.length === m.vertices.length) {
      vertexPieceIds.push(...m.vertexPieceIds);
    } else {
      for (let i = 0; i < m.vertices.length; i++) vertexPieceIds.push(null);
    }
    for (const idx of m.triangles) triangles.push(idx + offset);
    for (const [a, b] of m.edges) edges.push([a + offset, b + offset]);
    if (m.boundary && m.boundary.length === m.vertices.length) {
      hasBoundary = true;
      boundary.push(...m.boundary);
    } else {
      for (let i = 0; i < m.vertices.length; i++) boundary.push(null);
    }
  }
  return {
    vertices,
    vertexPieceIds,
    triangles,
    edges,
    boundary: hasBoundary ? boundary : undefined,
  };
}

/**
 * Tag mesh vertices that lie on a pattern piece boundary with the owning edge
 * (point-id pair + parametric t). Interior verts get null.
 */
function tagPieceBoundary(
  piece: PatternPiece,
  mesh: MeshGeometry,
  tol: number
): Array<SeamVertexTag | null> {
  return mesh.vertices.map((v) => {
    const hit = findNearestEdge(piece.points, piece.closed, v);
    if (!hit || hit.dist > tol) return null;
    const n = piece.points.length;
    const a = piece.points[hit.edgeIndex];
    const b = piece.points[(hit.edgeIndex + 1) % n];
    return {
      pieceId: piece.id,
      fromPointId: a.id,
      toPointId: b.id,
      t: hit.t,
    };
  });
}

/** Default sew gap (cm). Zero-gap welds destabilize mass-spring / XPBD. */
export const DEFAULT_SEAM_GAP_CM = 0.15;

type ForcedBoundarySample = { pos: Vec2; tag: SeamVertexTag };

/** Agreed sample count (incl. endpoints) for each seamed pattern edge. */
type SeamEdgePlan = {
  count: number;
  t0: number;
  t1: number;
};

function seamEdgeKey(ref: SeamEdgeRef): string {
  return `${ref.pieceId}:${ref.fromPointId}>${ref.toPointId}`;
}

/**
 * For every sew binding, assign the same vertex count to both sides from the
 * average seamed span arc length so pairing can be exact 1:1.
 */
function buildSeamEdgePlans(
  pattern: PatternDocument,
  spacingCm: number
): Map<string, SeamEdgePlan> {
  const plans = new Map<string, SeamEdgePlan>();
  const spacing = Math.max(0.5, spacingCm);
  const byId = new Map(pattern.pieces.map((p) => [p.id, p]));

  for (const seam of pattern.seams) {
    const pieceA = byId.get(seam.a.pieceId);
    const pieceB = byId.get(seam.b.pieceId);
    if (!pieceA || !pieceB) continue;
    if (!isSeamEdgeValid(pattern.pieces, seam.a) || !isSeamEdgeValid(pattern.pieces, seam.b)) {
      continue;
    }

    // True arc length of each sew span (not |Δt| × full edge — Beziers are non-uniform).
    const lenA = edgeArcLengthBetweenParams(
      pieceA,
      seam.a.fromPointId,
      seam.a.toPointId,
      seam.a.t0,
      seam.a.t1
    );
    const lenB = edgeArcLengthBetweenParams(
      pieceB,
      seam.b.fromPointId,
      seam.b.toPointId,
      seam.b.t0,
      seam.b.t1
    );
    const avgSpanLen = (lenA + lenB) * 0.5;
    // Shared count including endpoints — identical on both sides.
    const count = Math.max(2, Math.round(avgSpanLen / spacing) + 1);

    plans.set(seamEdgeKey(seam.a), {
      count,
      t0: Math.min(seam.a.t0, seam.a.t1),
      t1: Math.max(seam.a.t0, seam.a.t1),
    });
    plans.set(seamEdgeKey(seam.b), {
      count,
      t0: Math.min(seam.b.t0, seam.b.t1),
      t1: Math.max(seam.b.t0, seam.b.t1),
    });
  }
  return plans;
}

/**
 * Build boundary samples edge-by-edge. Seamed edges use the agreed count at
 * even arc-length spacing; other edges use spacing. Corners are emitted once.
 */
function samplePieceBoundaryWithSeams(
  piece: PatternPiece,
  settings: MeshSettings,
  seamPlans: Map<string, SeamEdgePlan>
): ForcedBoundarySample[] {
  const n = piece.points.length;
  if (n < 2) return [];
  const edgeCount = piece.closed ? n : Math.max(0, n - 1);
  const spacing = Math.max(0.5, settings.boundarySpacingCm);
  const out: ForcedBoundarySample[] = [];

  for (let ei = 0; ei < edgeCount; ei++) {
    const from = piece.points[ei];
    const to = piece.points[(ei + 1) % n];
    const plan = seamPlans.get(`${piece.id}:${from.id}>${to.id}`);
    const edgeSamples: ForcedBoundarySample[] = [];

    if (plan && plan.count >= 2) {
      // Exact shared count on the seamed span (arc-even on each side).
      pushArcSpacedEdgeSamples(edgeSamples, piece, from, to, plan.t0, plan.t1, plan.count - 1);
      // Unseamed shoulders of a partial sew keep ordinary arc spacing.
      if (plan.t0 > 1e-3) {
        const prefixLen = edgeArcLengthBetweenParams(piece, from.id, to.id, 0, plan.t0);
        const shoulder = Math.max(1, Math.ceil(prefixLen / spacing));
        const prefix: ForcedBoundarySample[] = [];
        pushArcSpacedEdgeSamples(prefix, piece, from, to, 0, plan.t0, shoulder);
        // Drop the last prefix point — it duplicates the seam span start.
        edgeSamples.unshift(...prefix.slice(0, Math.max(0, prefix.length - 1)));
      }
      if (plan.t1 < 1 - 1e-3) {
        const suffixLen = edgeArcLengthBetweenParams(piece, from.id, to.id, plan.t1, 1);
        const shoulder = Math.max(1, Math.ceil(suffixLen / spacing));
        const suffix: ForcedBoundarySample[] = [];
        pushArcSpacedEdgeSamples(suffix, piece, from, to, plan.t1, 1, shoulder);
        edgeSamples.push(...suffix.slice(1));
      }
    } else {
      const len = edgeLengthByPointIds(piece, from.id, to.id);
      const steps = Math.max(1, Math.ceil(len / spacing));
      pushArcSpacedEdgeSamples(edgeSamples, piece, from, to, 0, 1, steps);
    }

    // Skip first sample when it duplicates the previous edge's endpoint.
    // The shared corner keeps the previous edge's tag; collectEdgeVerts
    // corner pull-in restores it for the next seamed edge.
    const start = out.length === 0 ? 0 : 1;
    for (let i = start; i < edgeSamples.length; i++) out.push(edgeSamples[i]);
  }

  // Closed ring: drop the final point if it coincides with the start corner
  // (avoids a duplicate vertex with a conflicting edge tag).
  if (piece.closed && out.length >= 2) {
    const a = out[0].pos;
    const b = out[out.length - 1].pos;
    if (dist(a, b) < spacing * 0.25) out.pop();
  }

  return out;
}

/**
 * Push `steps+1` samples from t0→t1 evenly in arc length (not parametric t).
 * Tags still store parametric t so seam pairing / collectEdgeVerts keep working.
 */
function pushArcSpacedEdgeSamples(
  into: ForcedBoundarySample[],
  piece: PatternPiece,
  from: PatternPiece['points'][number],
  to: PatternPiece['points'][number],
  t0: number,
  t1: number,
  steps: number
): void {
  const n = Math.max(1, steps);
  const table = buildEdgeArcTable(piece, from.id, to.id);
  for (let s = 0; s <= n; s++) {
    const hit = pointOnEdgeAtArcFractionInSpan(
      piece,
      from.id,
      to.id,
      t0,
      t1,
      s / n,
      table
    );
    if (!hit) {
      // Fallback: parametric (linear edges / degenerate tables).
      const t = t0 + (t1 - t0) * (s / n);
      const pos = pointOnEdgeAtT(piece, from.id, to.id, t);
      if (!pos) continue;
      into.push({
        pos,
        tag: { pieceId: piece.id, fromPointId: from.id, toPointId: to.id, t },
      });
      continue;
    }
    into.push({
      pos: hit.pos,
      tag: { pieceId: piece.id, fromPointId: from.id, toPointId: to.id, t: hit.t },
    });
  }
}

/**
 * Assign tags from forced seam/boundary samples (exact t), falling back to
 * nearest-edge for any leftover boundary verts.
 */
function tagFromForcedSamples(
  piece: PatternPiece,
  vertices: Vec2[],
  forced: ForcedBoundarySample[],
  tol: number,
  /** Nearest-edge fallback adds extras on seamed edges — only for structured grid. */
  allowNearestFallback: boolean
): Array<SeamVertexTag | null> {
  const tags: Array<SeamVertexTag | null> = vertices.map(() => null);
  const usedForced = new Set<number>();

  for (let vi = 0; vi < vertices.length; vi++) {
    const v = vertices[vi];
    let bestI = -1;
    let bestD = tol;
    for (let fi = 0; fi < forced.length; fi++) {
      if (usedForced.has(fi)) continue;
      const d = dist(v, forced[fi].pos);
      if (d < bestD) {
        bestD = d;
        bestI = fi;
      }
    }
    if (bestI >= 0) {
      tags[vi] = { ...forced[bestI].tag };
      usedForced.add(bestI);
    }
  }

  if (!allowNearestFallback) return tags;

  // Structured-grid leftovers only: nearest edge for unmatched boundary verts.
  for (let vi = 0; vi < vertices.length; vi++) {
    if (tags[vi]) continue;
    const hit = findNearestEdge(piece.points, piece.closed, vertices[vi]);
    if (!hit || hit.dist > tol) continue;
    const n = piece.points.length;
    const a = piece.points[hit.edgeIndex];
    const b = piece.points[(hit.edgeIndex + 1) % n];
    tags[vi] = {
      pieceId: piece.id,
      fromPointId: a.id,
      toPointId: b.id,
      t: hit.t,
    };
  }
  return tags;
}

function triangulatePieceSeamAware(
  piece: PatternPiece,
  settings: MeshSettings,
  seamPlans: Map<string, SeamEdgePlan>
): MeshGeometry {
  const poly = pieceToPolygon(piece);
  const forced = samplePieceBoundaryWithSeams(piece, settings, seamPlans);
  const forcedPos = forced.map((f) => f.pos);
  const tol = Math.max(0.35, settings.boundarySpacingCm * 0.45);

  if (settings.algorithm === 'structuredGrid') {
    const mesh = triangulate(poly, settings);
    mesh.vertexPieceIds = mesh.vertices.map(() => piece.id);
    mesh.boundary = tagFromForcedSamples(piece, mesh.vertices, forced, tol, true);
    return mesh;
  }

  const interior = sampleInteriorGrid(poly, settings.targetEdgeCm).filter(
    (p) => !forcedPos.some((b) => dist(b, p) < settings.boundarySpacingCm * 0.35)
  );
  let points = [...forcedPos, ...interior];
  let mesh = delaunayFilter(points, poly);

  if (settings.algorithm === 'centroidal') {
    const iters = Math.max(0, Math.min(12, settings.lloydIterations));
    // Freeze by index: forced samples are always the prefix of `points`.
    const forcedCount = forcedPos.length;
    const boundarySet = new Set<number>();
    for (let i = 0; i < Math.min(forcedCount, mesh.vertices.length); i++) {
      boundarySet.add(i);
    }
    for (let iter = 0; iter < iters; iter++) {
      const accum = mesh.vertices.map(() => ({ x: 0, y: 0, w: 0 }));
      for (let t = 0; t + 2 < mesh.triangles.length; t += 3) {
        const i0 = mesh.triangles[t];
        const i1 = mesh.triangles[t + 1];
        const i2 = mesh.triangles[t + 2];
        const c = triangleCentroid(mesh.vertices[i0], mesh.vertices[i1], mesh.vertices[i2]);
        for (const idx of [i0, i1, i2]) {
          accum[idx].x += c.x;
          accum[idx].y += c.y;
          accum[idx].w += 1;
        }
      }
      const next = mesh.vertices.map((p, i) => {
        if (boundarySet.has(i) || accum[i].w === 0) return p;
        const q = { x: accum[i].x / accum[i].w, y: accum[i].y / accum[i].w };
        return pointInPolygon(q, poly) ? q : p;
      });
      // Keep forced boundary positions exact through Lloyd.
      for (let i = 0; i < forcedCount; i++) next[i] = forcedPos[i];
      mesh = delaunayFilter(next, poly);
    }
  }

  mesh.vertexPieceIds = mesh.vertices.map(() => piece.id);
  // No nearest-edge fallback: only forced samples tag the boundary (exact seam counts).
  mesh.boundary = tagFromForcedSamples(piece, mesh.vertices, forced, tol, false);
  return mesh;
}

/**
 * Triangulate every closed piece in the pattern independently (each garment
 * panel becomes its own mesh island) and merge them into one MeshGeometry.
 * Seamed edges share a sample count so stitch pairing is exact 1:1.
 */
export function triangulatePattern(
  pattern: PatternDocument | undefined,
  settings: MeshSettings
): MeshGeometry {
  const closedPieces = (pattern?.pieces ?? []).filter((p) => p.closed && p.points.length >= 3);
  const pieces: PatternPiece[] =
    closedPieces.length > 0
      ? closedPieces
      : pattern?.pieces.find((p) => p.points.length >= 3)
        ? [pattern.pieces.find((p) => p.points.length >= 3)!]
        : [];

  if (pieces.length === 0) {
    const poly = patternToPolygons(pattern)[0];
    return triangulate(poly, settings);
  }

  const seamPlans =
    pattern && pattern.seams.length > 0
      ? buildSeamEdgePlans(pattern, settings.boundarySpacingCm)
      : new Map<string, SeamEdgePlan>();

  const meshes = pieces.map((piece) => triangulatePieceSeamAware(piece, settings, seamPlans));
  return mergeMeshes(meshes);
}

export type SeamParticlePair = { a: number; b: number; restCm: number };

/**
 * Resolve pattern seams into particle index pairs using mesh boundary tags.
 *
 * When seam-aware meshing matched both sides' counts, this is a pure zip.
 * Otherwise picks distinct evenly-spaced verts (no many-to-one duplicates).
 */
export function resolveSeamParticlePairs(
  pattern: PatternDocument | undefined,
  mesh: MeshGeometry
): SeamParticlePair[] {
  if (!pattern || !mesh.boundary || mesh.boundary.length !== mesh.vertices.length) {
    return [];
  }

  const pairs: SeamParticlePair[] = [];
  const globalSeen = new Set<string>();

  for (const seam of pattern.seams) {
    if (!isSeamEdgeValid(pattern.pieces, seam.a) || !isSeamEdgeValid(pattern.pieces, seam.b)) {
      continue;
    }

    const sideA = dedupeEdgeVertsByT(collectEdgeVerts(mesh, seam.a));
    const sideB = dedupeEdgeVertsByT(collectEdgeVerts(mesh, seam.b));
    if (sideA.length === 0 || sideB.length === 0) continue;

    // Sort by parametric t in sewing direction (t0→t1; reverse when t0>t1)
    const sortA = sortEdgeVerts(sideA, seam.a.t0, seam.a.t1);
    const sortB = sortEdgeVerts(sideB, seam.b.t0, seam.b.t1);

    const nPairs = Math.min(sortA.length, sortB.length);
    if (nPairs < 1) continue;

    const restCm = seam.restGapCm > 1e-6 ? seam.restGapCm : DEFAULT_SEAM_GAP_CM;
    const idxA = pickDistinctIndices(sortA.length, nPairs);
    const idxB = pickDistinctIndices(sortB.length, nPairs);

    for (let i = 0; i < nPairs; i++) {
      const ia = sortA[idxA[i]].index;
      const ib = sortB[idxB[i]].index;
      if (ia === ib) continue;
      const key = ia < ib ? `${ia}_${ib}` : `${ib}_${ia}`;
      if (globalSeen.has(key)) continue;
      globalSeen.add(key);
      pairs.push({ a: ia, b: ib, restCm });
    }
  }

  return pairs;
}

/** Collapse near-duplicate parametric samples on one edge (keep first). */
function dedupeEdgeVertsByT(
  verts: Array<{ index: number; t: number }>,
  eps = 1e-3
): Array<{ index: number; t: number }> {
  const sorted = [...verts].sort((a, b) => a.t - b.t);
  const out: Array<{ index: number; t: number }> = [];
  for (const v of sorted) {
    if (out.length && Math.abs(out[out.length - 1].t - v.t) < eps) continue;
    out.push(v);
  }
  return out;
}

/** Evenly spaced distinct indices into a side of length `sideLen`. */
function pickDistinctIndices(sideLen: number, nPairs: number): number[] {
  if (nPairs <= 0) return [];
  if (nPairs >= sideLen) return Array.from({ length: sideLen }, (_, i) => i);
  const out: number[] = [];
  const used = new Set<number>();
  for (let i = 0; i < nPairs; i++) {
    const f = nPairs === 1 ? 0 : i / (nPairs - 1);
    let idx = Math.round(f * (sideLen - 1));
    if (used.has(idx)) {
      // Walk outward to the nearest free slot (avoids duplicate stitches).
      let delta = 1;
      while (used.has(idx) && delta < sideLen) {
        const lo = idx - delta;
        const hi = idx + delta;
        if (lo >= 0 && !used.has(lo)) {
          idx = lo;
          break;
        }
        if (hi < sideLen && !used.has(hi)) {
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

function collectEdgeVerts(
  mesh: MeshGeometry,
  ref: { pieceId: string; fromPointId: string; toPointId: string; t0: number; t1: number }
): Array<{ index: number; t: number }> {
  const out: Array<{ index: number; t: number }> = [];
  const seen = new Set<number>();
  const boundary = mesh.boundary!;
  const tMin = Math.min(ref.t0, ref.t1);
  const tMax = Math.max(ref.t0, ref.t1);

  const push = (index: number, t: number) => {
    if (seen.has(index)) return;
    if (t < tMin - 1e-4 || t > tMax + 1e-4) return;
    seen.add(index);
    out.push({ index, t: Math.max(0, Math.min(1, t)) });
  };

  for (let i = 0; i < boundary.length; i++) {
    const tag = boundary[i];
    if (!tag || tag.pieceId !== ref.pieceId) continue;

    // Primary: tagged to this edge.
    if (tag.fromPointId === ref.fromPointId && tag.toPointId === ref.toPointId) {
      push(i, tag.t);
      continue;
    }

    // Corners often win the adjacent edge in tagPieceBoundary. Pull them in:
    // arriving at fromPoint (t≈1 on prev edge) → t=0 on this edge
    if (tag.toPointId === ref.fromPointId && tag.t > 0.98) {
      push(i, 0);
      continue;
    }
    // leaving fromPoint on a different next edge (t≈0) → t=0
    if (tag.fromPointId === ref.fromPointId && tag.toPointId !== ref.toPointId && tag.t < 0.02) {
      push(i, 0);
      continue;
    }
    // leaving toPoint onto the next edge (t≈0) → t=1
    if (tag.fromPointId === ref.toPointId && tag.t < 0.02) {
      push(i, 1);
      continue;
    }
    // arriving at toPoint from a different prev edge (t≈1) → t=1
    if (tag.toPointId === ref.toPointId && tag.fromPointId !== ref.fromPointId && tag.t > 0.98) {
      push(i, 1);
    }
  }
  return out;
}

function sortEdgeVerts(
  verts: Array<{ index: number; t: number }>,
  t0: number,
  t1: number
): Array<{ index: number; t: number }> {
  const sorted = [...verts].sort((a, b) => a.t - b.t);
  return t0 > t1 ? sorted.reverse() : sorted;
}

export function meshStats(mesh: MeshGeometry): { verts: number; tris: number; edges: number } {
  return {
    verts: mesh.vertices.length,
    tris: Math.floor(mesh.triangles.length / 3),
    edges: mesh.edges.length,
  };
}
