import type { BezierPoint, PatternPiece, Vec2 } from '../project/types';
import {
  dist,
  edgeHandles,
  lerp,
  pieceToPolyline,
  pointInPolygon,
  sampleCubic,
} from './geometry';

const EPS = 1e-6;
const T_EPS = 1e-4;
const MERGE_CM = 0.08;

export type CutterPath =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; center: Vec2; radius: number }
  | { kind: 'cubic'; a: Vec2; c0: Vec2; c1: Vec2; b: Vec2 };

export type BoundaryHit = {
  edgeIndex: number;
  t: number;
  point: Vec2;
  along: number;
  /** Existing outline vertex when the knife passes exactly through a corner. */
  pointId?: string;
};

export type SliceResult =
  | {
      ok: true;
      pieces: [PatternPiece, PatternPiece];
      /** Original/inserted working point ID → fresh point ID on each child. */
      pointIdMaps: [Map<string, string>, Map<string, string>];
    }
  | { ok: false; reason: string };

function evalCubic(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
  };
}

function isLinearEdge(a: BezierPoint, b: BezierPoint): boolean {
  return (
    (!a.handleOut || (a.handleOut.x === a.anchor.x && a.handleOut.y === a.anchor.y)) &&
    (!b.handleIn || (b.handleIn.x === b.anchor.x && b.handleIn.y === b.anchor.y))
  );
}

/** de Casteljau split of cubic at t. */
export function splitCubicAtT(
  p0: Vec2,
  c0: Vec2,
  c1: Vec2,
  p1: Vec2,
  t: number
): {
  left: { p0: Vec2; c0: Vec2; c1: Vec2; p1: Vec2 };
  right: { p0: Vec2; c0: Vec2; c1: Vec2; p1: Vec2 };
  point: Vec2;
} {
  const tt = Math.max(0, Math.min(1, t));
  const p01 = lerp(p0, c0, tt);
  const p12 = lerp(c0, c1, tt);
  const p23 = lerp(c1, p1, tt);
  const p012 = lerp(p01, p12, tt);
  const p123 = lerp(p12, p23, tt);
  const point = lerp(p012, p123, tt);
  return {
    left: { p0, c0: p01, c1: p012, p1: point },
    right: { p0: point, c0: p123, c1: p23, p1 },
    point,
  };
}

function clonePt(pt: BezierPoint): BezierPoint {
  return {
    id: pt.id,
    anchor: { ...pt.anchor },
    handleIn: pt.handleIn ? { ...pt.handleIn } : null,
    handleOut: pt.handleOut ? { ...pt.handleOut } : null,
    handlesParallel: pt.handlesParallel,
  };
}

function withFreshIds(
  points: BezierPoint[],
  makeId: () => string
): { points: BezierPoint[]; pointIdMap: Map<string, string> } {
  const pointIdMap = new Map<string, string>();
  const fresh = points.map((pt) => {
    const id = makeId();
    pointIdMap.set(pt.id, id);
    return {
      id,
      anchor: { ...pt.anchor },
      handleIn: pt.handleIn ? { ...pt.handleIn } : null,
      handleOut: pt.handleOut ? { ...pt.handleOut } : null,
      handlesParallel: pt.handlesParallel,
    };
  });
  return { points: fresh, pointIdMap };
}

/** Insert a point on edge `edgeIndex` at t, preserving cubic shape. */
export function insertPointOnEdgePreserving(
  points: BezierPoint[],
  closed: boolean,
  edgeIndex: number,
  t: number,
  makeId: () => string
): BezierPoint | null {
  const n = points.length;
  const edgeCount = closed ? n : Math.max(0, n - 1);
  if (edgeIndex < 0 || edgeIndex >= edgeCount) return null;
  const a = points[edgeIndex];
  const b = points[(edgeIndex + 1) % n];
  const tt = Math.max(T_EPS, Math.min(1 - T_EPS, t));

  if (isLinearEdge(a, b)) {
    const point: BezierPoint = {
      id: makeId(),
      anchor: lerp(a.anchor, b.anchor, tt),
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    };
    a.handleOut = null;
    b.handleIn = null;
    points.splice(edgeIndex + 1, 0, point);
    return point;
  }

  const { c0, c1 } = edgeHandles(a, b);
  const { left, right, point: anchor } = splitCubicAtT(a.anchor, c0, c1, b.anchor, tt);
  a.handleOut =
    left.c0.x === a.anchor.x && left.c0.y === a.anchor.y ? null : { ...left.c0 };
  const point: BezierPoint = {
    id: makeId(),
    anchor: { ...anchor },
    handleIn: left.c1.x === anchor.x && left.c1.y === anchor.y ? null : { ...left.c1 },
    handleOut: right.c0.x === anchor.x && right.c0.y === anchor.y ? null : { ...right.c0 },
    handlesParallel: false,
  };
  b.handleIn =
    right.c1.x === b.anchor.x && right.c1.y === b.anchor.y ? null : { ...right.c1 };
  points.splice(edgeIndex + 1, 0, point);
  return point;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function segmentSegmentHit(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2
): { tAB: number; tCD: number; point: Vec2 } | null {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const den = cross(abx, aby, cdx, cdy);
  if (Math.abs(den) < 1e-12) return null;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const tAB = cross(acx, acy, cdx, cdy) / den;
  const tCD = cross(acx, acy, abx, aby) / den;
  if (tAB < T_EPS || tAB > 1 - T_EPS || tCD < T_EPS || tCD > 1 - T_EPS) return null;
  return { tAB, tCD, point: { x: a.x + abx * tAB, y: a.y + aby * tAB } };
}

/**
 * Intersect edge segment AB with the infinite line through `origin` along `dir`.
 * `along` is the signed projection onto `dir` (for ordering hits along the knife).
 */
function edgeInfiniteLineHit(
  edgeA: Vec2,
  edgeB: Vec2,
  origin: Vec2,
  dir: Vec2
): { tEdge: number; along: number; point: Vec2 } | null {
  const abx = edgeB.x - edgeA.x;
  const aby = edgeB.y - edgeA.y;
  const den = cross(abx, aby, dir.x, dir.y);
  if (Math.abs(den) < 1e-12) return null;
  const ox = origin.x - edgeA.x;
  const oy = origin.y - edgeA.y;
  // edgeA + t*AB = origin + s*dir
  const rawT = cross(ox, oy, dir.x, dir.y) / den;
  if (rawT < -T_EPS || rawT > 1 + T_EPS) return null;
  const tEdge = Math.max(0, Math.min(1, rawT));
  const point = { x: edgeA.x + abx * tEdge, y: edgeA.y + aby * tEdge };
  const len2 = dir.x * dir.x + dir.y * dir.y || 1;
  const along = ((point.x - origin.x) * dir.x + (point.y - origin.y) * dir.y) / len2;
  return { tEdge, along, point };
}

function sampleEdgePoints(
  a: BezierPoint,
  b: BezierPoint,
  steps: number
): { t: number; p: Vec2 }[] {
  if (isLinearEdge(a, b)) {
    return [
      { t: 0, p: { ...a.anchor } },
      { t: 1, p: { ...b.anchor } },
    ];
  }
  const { c0, c1 } = edgeHandles(a, b);
  const pts = sampleCubic(a.anchor, c0, c1, b.anchor, steps);
  return pts.map((p, i) => ({ t: i / (pts.length - 1), p }));
}

function evalPolynomial(a: number, b: number, c: number, d: number, t: number): number {
  return ((a * t + b) * t + c) * t + d;
}

/**
 * Exact roots of cross(B(t) - origin, dir) for a cubic Bézier B.
 * Partitioning at derivative roots makes each interval monotonic, so this
 * catches ordinary crossings, endpoint hits, and tangencies without relying
 * on a sampling interval happening to straddle the line.
 */
function cubicInfiniteLineRoots(
  p0: Vec2,
  c0: Vec2,
  c1: Vec2,
  p1: Vec2,
  origin: Vec2,
  dir: Vec2
): number[] {
  const powerA = {
    x: -p0.x + 3 * c0.x - 3 * c1.x + p1.x,
    y: -p0.y + 3 * c0.y - 3 * c1.y + p1.y,
  };
  const powerB = {
    x: 3 * p0.x - 6 * c0.x + 3 * c1.x,
    y: 3 * p0.y - 6 * c0.y + 3 * c1.y,
  };
  const powerC = {
    x: -3 * p0.x + 3 * c0.x,
    y: -3 * p0.y + 3 * c0.y,
  };
  const powerD = { x: p0.x - origin.x, y: p0.y - origin.y };
  const a = cross(powerA.x, powerA.y, dir.x, dir.y);
  const b = cross(powerB.x, powerB.y, dir.x, dir.y);
  const c = cross(powerC.x, powerC.y, dir.x, dir.y);
  const d = cross(powerD.x, powerD.y, dir.x, dir.y);

  const critical: number[] = [0, 1];
  const qa = 3 * a;
  const qb = 2 * b;
  const qc = c;
  if (Math.abs(qa) < 1e-14) {
    if (Math.abs(qb) > 1e-14) {
      const t = -qc / qb;
      if (t > 0 && t < 1) critical.push(t);
    }
  } else {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const t0 = (-qb - s) / (2 * qa);
      const t1 = (-qb + s) / (2 * qa);
      if (t0 > 0 && t0 < 1) critical.push(t0);
      if (t1 > 0 && t1 < 1) critical.push(t1);
    }
  }
  critical.sort((x, y) => x - y);

  const coefficientScale = Math.max(1, Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  const tolerance = coefficientScale * 1e-10;
  const roots: number[] = [];
  const addRoot = (t: number) => {
    const clamped = Math.max(0, Math.min(1, t));
    if (!roots.some((r) => Math.abs(r - clamped) < 1e-6)) roots.push(clamped);
  };

  // Critical points include endpoint roots and double roots (tangencies).
  for (const t of critical) {
    if (Math.abs(evalPolynomial(a, b, c, d, t)) <= tolerance) addRoot(t);
  }

  for (let i = 0; i < critical.length - 1; i++) {
    let lo = critical[i]!;
    let hi = critical[i + 1]!;
    let fLo = evalPolynomial(a, b, c, d, lo);
    const fHi = evalPolynomial(a, b, c, d, hi);
    if (Math.abs(fLo) <= tolerance || Math.abs(fHi) <= tolerance || fLo * fHi > 0) continue;
    for (let step = 0; step < 60; step++) {
      const mid = (lo + hi) / 2;
      const fMid = evalPolynomial(a, b, c, d, mid);
      if (Math.abs(fMid) <= tolerance) {
        lo = mid;
        hi = mid;
        break;
      }
      if (fLo * fMid <= 0) {
        hi = mid;
      } else {
        lo = mid;
        fLo = fMid;
      }
    }
    addRoot((lo + hi) / 2);
  }
  return roots.sort((x, y) => x - y);
}

function dedupeHits(
  hits: { t: number; point: Vec2; along: number }[]
): { t: number; point: Vec2; along: number }[] {
  const out: { t: number; point: Vec2; along: number }[] = [];
  for (const h of hits) {
    if (h.t <= T_EPS || h.t >= 1 - T_EPS) continue;
    if (out.some((o) => dist(o.point, h.point) < MERGE_CM)) continue;
    out.push(h);
  }
  return out;
}

/** Intersections of a piece edge with the infinite line through lineA→lineB. */
function edgeLineIntersections(
  a: BezierPoint,
  b: BezierPoint,
  lineA: Vec2,
  lineB: Vec2
): { t: number; point: Vec2; along: number }[] {
  const dir = { x: lineB.x - lineA.x, y: lineB.y - lineA.y };
  if (Math.hypot(dir.x, dir.y) < EPS) return [];

  if (isLinearEdge(a, b)) {
    const hit = edgeInfiniteLineHit(a.anchor, b.anchor, lineA, dir);
    if (!hit) return [];
    return [{ t: hit.tEdge, point: hit.point, along: hit.along }];
  }

  const { c0, c1 } = edgeHandles(a, b);
  const hits: { t: number; point: Vec2; along: number }[] = [];
  for (const t of cubicInfiniteLineRoots(a.anchor, c0, c1, b.anchor, lineA, dir)) {
    const point = evalCubic(a.anchor, c0, c1, b.anchor, t);
    const len2 = dir.x * dir.x + dir.y * dir.y || 1;
    const along = ((point.x - lineA.x) * dir.x + (point.y - lineA.y) * dir.y) / len2;
    hits.push({ t, point, along });
  }
  // Unlike circle/curve cutters, line cuts deliberately retain t=0/1;
  // findBoundaryHits canonicalizes those duplicate edge hits to one vertex.
  const out: typeof hits = [];
  for (const hit of hits) {
    if (!out.some((other) => dist(other.point, hit.point) < MERGE_CM)) out.push(hit);
  }
  return out;
}

function edgeCircleIntersections(
  a: BezierPoint,
  b: BezierPoint,
  center: Vec2,
  radius: number
): { t: number; point: Vec2; along: number }[] {
  const hits: { t: number; point: Vec2; along: number }[] = [];
  const r2 = radius * radius;
  const samples = sampleEdgePoints(a, b, isLinearEdge(a, b) ? 2 : 64);

  const checkSeg = (p0: Vec2, p1: Vec2, t0: number, t1: number) => {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const fx = p0.x - center.x;
    const fy = p0.y - center.y;
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r2;
    if (A < 1e-12) return;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return;
    const s = Math.sqrt(disc);
    for (const sign of [-1, 1] as const) {
      const u = (-B + sign * s) / (2 * A);
      if (u < T_EPS || u > 1 - T_EPS) continue;
      const point = lerp(p0, p1, u);
      hits.push({
        t: t0 + (t1 - t0) * u,
        point,
        along: Math.atan2(point.y - center.y, point.x - center.x),
      });
    }
  };

  if (isLinearEdge(a, b)) {
    checkSeg(a.anchor, b.anchor, 0, 1);
    return dedupeHits(hits);
  }

  for (let i = 0; i < samples.length - 1; i++) {
    checkSeg(samples[i].p, samples[i + 1].p, samples[i].t, samples[i + 1].t);
  }

  const { c0, c1 } = edgeHandles(a, b);
  const refined: { t: number; point: Vec2; along: number }[] = [];
  for (const h of hits) {
    let t = h.t;
    for (let k = 0; k < 6; k++) {
      const p = evalCubic(a.anchor, c0, c1, b.anchor, t);
      const rx = p.x - center.x;
      const ry = p.y - center.y;
      const f = rx * rx + ry * ry - r2;
      const dt = 1e-4;
      const p2 = evalCubic(a.anchor, c0, c1, b.anchor, Math.min(1, t + dt));
      const vx = (p2.x - p.x) / dt;
      const vy = (p2.y - p.y) / dt;
      const fp = 2 * (rx * vx + ry * vy);
      if (Math.abs(fp) < 1e-12) break;
      t = Math.max(T_EPS, Math.min(1 - T_EPS, t - f / fp));
    }
    const point = evalCubic(a.anchor, c0, c1, b.anchor, t);
    refined.push({
      t,
      point,
      along: Math.atan2(point.y - center.y, point.x - center.x),
    });
  }
  return dedupeHits(refined);
}

function edgeCubicIntersections(
  a: BezierPoint,
  b: BezierPoint,
  q0: Vec2,
  qc0: Vec2,
  qc1: Vec2,
  q1: Vec2
): { t: number; point: Vec2; along: number }[] {
  const hits: { t: number; point: Vec2; along: number }[] = [];
  const edgeSamples = sampleEdgePoints(a, b, isLinearEdge(a, b) ? 2 : 40);
  const cutSamples = sampleCubic(q0, qc0, qc1, q1, 40);
  for (let i = 0; i < edgeSamples.length - 1; i++) {
    for (let j = 0; j < cutSamples.length - 1; j++) {
      const hit = segmentSegmentHit(
        edgeSamples[i].p,
        edgeSamples[i + 1].p,
        cutSamples[j],
        cutSamples[j + 1]
      );
      if (!hit) continue;
      hits.push({
        t: edgeSamples[i].t + (edgeSamples[i + 1].t - edgeSamples[i].t) * hit.tAB,
        point: hit.point,
        along: (j + hit.tCD) / (cutSamples.length - 1),
      });
    }
  }
  return dedupeHits(hits);
}

export function findBoundaryHits(piece: PatternPiece, cutter: CutterPath): BoundaryHit[] {
  if (!piece.closed || piece.points.length < 3) return [];
  const n = piece.points.length;
  const hits: BoundaryHit[] = [];
  for (let i = 0; i < n; i++) {
    const a = piece.points[i];
    const b = piece.points[(i + 1) % n];
    let local: { t: number; point: Vec2; along: number }[] = [];
    if (cutter.kind === 'line') local = edgeLineIntersections(a, b, cutter.a, cutter.b);
    else if (cutter.kind === 'circle') {
      if (cutter.radius < MERGE_CM) continue;
      local = edgeCircleIntersections(a, b, cutter.center, cutter.radius);
    } else {
      local = edgeCubicIntersections(a, b, cutter.a, cutter.c0, cutter.c1, cutter.b);
    }
    for (const h of local) {
      if (cutter.kind === 'line' && (h.t <= T_EPS || h.t >= 1 - T_EPS)) {
        const vertexIndex = h.t <= T_EPS ? i : (i + 1) % n;
        const vertex = piece.points[vertexIndex]!;
        hits.push({
          edgeIndex: vertexIndex,
          t: 0,
          point: { ...vertex.anchor },
          along: h.along,
          pointId: vertex.id,
        });
      } else {
        hits.push({ edgeIndex: i, t: h.t, point: h.point, along: h.along });
      }
    }
  }
  const merged: BoundaryHit[] = [];
  for (const h of hits) {
    const existing = merged.find((m) => dist(m.point, h.point) < MERGE_CM);
    if (!existing) {
      merged.push(h);
    } else if (h.pointId && !existing.pointId) {
      Object.assign(existing, h);
    }
  }
  return merged;
}

/** Snap a direction to the nearest multiple of `stepDeg` degrees. */
export function snapAngleDegrees(dx: number, dy: number, stepDeg = 30): Vec2 {
  const len = Math.hypot(dx, dy);
  if (len < EPS) return { x: 0, y: 0 };
  const step = (stepDeg * Math.PI) / 180;
  const ang = Math.atan2(dy, dx);
  const snapped = Math.round(ang / step) * step;
  return { x: Math.cos(snapped) * len, y: Math.sin(snapped) * len };
}

function normalizeAngle(a: number): number {
  let x = a;
  while (x <= -Math.PI) x += Math.PI * 2;
  while (x > Math.PI) x -= Math.PI * 2;
  return x;
}

function angleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

function circularArcCubics(
  center: Vec2,
  radius: number,
  a0: number,
  delta: number
): { p0: Vec2; c0: Vec2; c1: Vec2; p1: Vec2 }[] {
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const out: { p0: Vec2; c0: Vec2; c1: Vec2; p1: Vec2 }[] = [];
  for (let i = 0; i < steps; i++) {
    const t0 = a0 + (delta * i) / steps;
    const t1 = a0 + (delta * (i + 1)) / steps;
    const seg = t1 - t0;
    const k = (4 / 3) * Math.tan(seg / 4);
    const p0 = { x: center.x + Math.cos(t0) * radius, y: center.y + Math.sin(t0) * radius };
    const p1 = { x: center.x + Math.cos(t1) * radius, y: center.y + Math.sin(t1) * radius };
    const t0x = -Math.sin(t0);
    const t0y = Math.cos(t0);
    const t1x = -Math.sin(t1);
    const t1y = Math.cos(t1);
    out.push({
      p0,
      c0: { x: p0.x + t0x * k * radius, y: p0.y + t0y * k * radius },
      c1: { x: p1.x - t1x * k * radius, y: p1.y - t1y * k * radius },
      p1,
    });
  }
  return out;
}

function polyArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return a / 2;
}

function buildCutBridge(
  cutter: CutterPath,
  from: Vec2,
  to: Vec2,
  makeId: () => string,
  piecePoly: Vec2[]
): BezierPoint[] {
  if (cutter.kind === 'line') {
    return [
      { id: makeId(), anchor: { ...from }, handleIn: null, handleOut: null, handlesParallel: false },
      { id: makeId(), anchor: { ...to }, handleIn: null, handleOut: null, handlesParallel: false },
    ];
  }

  if (cutter.kind === 'circle') {
    const a0 = Math.atan2(from.y - cutter.center.y, from.x - cutter.center.x);
    const a1 = Math.atan2(to.y - cutter.center.y, to.x - cutter.center.x);
    let dShort = angleDelta(a0, a1);
    if (Math.abs(dShort) < 1e-6) dShort = Math.PI * 2;
    const dLong = dShort > 0 ? dShort - 2 * Math.PI : dShort + 2 * Math.PI;
    const midShort = {
      x: cutter.center.x + Math.cos(a0 + dShort / 2) * cutter.radius,
      y: cutter.center.y + Math.sin(a0 + dShort / 2) * cutter.radius,
    };
    const midLong = {
      x: cutter.center.x + Math.cos(a0 + dLong / 2) * cutter.radius,
      y: cutter.center.y + Math.sin(a0 + dLong / 2) * cutter.radius,
    };
    const shortInside = pointInPolygon(midShort, piecePoly);
    const longInside = pointInPolygon(midLong, piecePoly);
    const delta = longInside && !shortInside ? dLong : dShort;
    const cubics = circularArcCubics(cutter.center, cutter.radius, a0, delta);
    const pts: BezierPoint[] = [];
    for (let i = 0; i < cubics.length; i++) {
      const c = cubics[i];
      if (i === 0) {
        pts.push({
          id: makeId(),
          anchor: { ...from },
          handleIn: null,
          handleOut: { ...c.c0 },
          handlesParallel: false,
        });
      } else {
        pts[pts.length - 1].handleOut = { ...c.c0 };
      }
      pts.push({
        id: makeId(),
        anchor: i === cubics.length - 1 ? { ...to } : { ...c.p1 },
        handleIn: { ...c.c1 },
        handleOut: null,
        handlesParallel: false,
      });
    }
    return pts;
  }

  return [
    {
      id: makeId(),
      anchor: { ...from },
      handleIn: null,
      handleOut: { ...cutter.c0 },
      handlesParallel: false,
    },
    {
      id: makeId(),
      anchor: { ...to },
      handleIn: { ...cutter.c1 },
      handleOut: null,
      handlesParallel: false,
    },
  ];
}

function reverseBridge(bridge: BezierPoint[], makeId: () => string): BezierPoint[] {
  return [...bridge].reverse().map((pt) => ({
    id: makeId(),
    anchor: { ...pt.anchor },
    handleIn: pt.handleOut ? { ...pt.handleOut } : null,
    handleOut: pt.handleIn ? { ...pt.handleIn } : null,
    handlesParallel: pt.handlesParallel,
  }));
}

function walkBoundary(
  points: BezierPoint[],
  fromIdx: number,
  toIdx: number
): BezierPoint[] {
  const n = points.length;
  const out: BezierPoint[] = [];
  let i = fromIdx;
  for (let step = 0; step < n + 1; step++) {
    out.push(clonePt(points[i]));
    if (i === toIdx) break;
    i = (i + 1) % n;
  }
  return out;
}

function buildRing(boundaryArc: BezierPoint[], bridge: BezierPoint[]): BezierPoint[] {
  if (boundaryArc.length < 2 || bridge.length < 2) return [];
  const ring: BezierPoint[] = boundaryArc.map(clonePt);
  for (let i = 1; i < bridge.length - 1; i++) ring.push(clonePt(bridge[i]));
  const y = ring[boundaryArc.length - 1]!;
  // The original outgoing/incoming handles belonged to outline edges that
  // are no longer adjacent after the split. Replace them with cutter handles.
  y.handleOut = bridge[0]!.handleOut ? { ...bridge[0]!.handleOut } : null;
  const first = ring[0]!;
  const bridgeEnd = bridge[bridge.length - 1]!;
  first.handleIn = bridgeEnd.handleIn ? { ...bridgeEnd.handleIn } : null;
  return ring;
}

function assignGrainline(
  original: PatternPiece,
  child: PatternPiece
): PatternPiece['grainline'] | undefined {
  if (!original.grainline) return undefined;
  const mid = {
    x: (original.grainline.from.x + original.grainline.to.x) / 2,
    y: (original.grainline.from.y + original.grainline.to.y) / 2,
  };
  if (!pointInPolygon(mid, pieceToPolyline(child.points, true))) return undefined;
  return {
    from: { ...original.grainline.from },
    to: { ...original.grainline.to },
  };
}

/** Slice a closed piece into two along a cutter that crosses the boundary twice. */
export function slicePiece(
  piece: PatternPiece,
  cutter: CutterPath,
  makeId: () => string
): SliceResult {
  if (!piece.closed || piece.points.length < 3) {
    return { ok: false, reason: 'Piece must be a closed outline' };
  }

  const working = piece.points.map(clonePt);
  // Line cutters always use the infinite line through a→b (see edgeLineIntersections).
  const hits = findBoundaryHits({ ...piece, points: working }, cutter);

  if (hits.length < 2) {
    return { ok: false, reason: 'Cut must cross the outline twice' };
  }

  hits.sort((a, b) => a.along - b.along);
  let h0 = hits[0]!;
  let h1 = hits[1]!;

  // Prefer a consecutive pair along the knife whose chord midpoint is inside the piece.
  // This picks opposite-side crossings on simple polygons (not just adjacent edges).
  const poly = pieceToPolyline(working, true);
  if (hits.length >= 2) {
    let best: { i: number; j: number; span: number } | null = null;
    for (let i = 0; i < hits.length; i++) {
      for (let j = i + 1; j < hits.length; j++) {
        const mid = lerp(hits[i]!.point, hits[j]!.point, 0.5);
        if (cutter.kind === 'line' && !pointInPolygon(mid, poly)) continue;
        const span = Math.abs(hits[j]!.along - hits[i]!.along);
        if (!best || span < best.span) best = { i, j, span };
      }
    }
    // Fallback: for lines, also try consecutive hits along the sorted line
    if (!best && cutter.kind === 'line') {
      for (let i = 0; i < hits.length - 1; i++) {
        const mid = lerp(hits[i]!.point, hits[i + 1]!.point, 0.5);
        if (pointInPolygon(mid, poly)) {
          best = { i, j: i + 1, span: Math.abs(hits[i + 1]!.along - hits[i]!.along) };
          break;
        }
      }
    }
    if (best) {
      h0 = hits[best.i]!;
      h1 = hits[best.j]!;
    } else if (cutter.kind === 'line') {
      return { ok: false, reason: 'Cut line must pass through the piece' };
    }
  }

  if (cutter.kind === 'line') {
    const mid = lerp(h0.point, h1.point, 0.5);
    if (!pointInPolygon(mid, poly)) {
      return { ok: false, reason: 'Cut line must pass through the piece' };
    }
  }

  const ordered = [h0, h1].sort((a, b) => b.edgeIndex - a.edgeIndex || b.t - a.t);
  const inserted: BezierPoint[] = [];
  for (const h of ordered) {
    if (h.pointId) {
      const existing = working.find((point) => point.id === h.pointId);
      if (!existing) return { ok: false, reason: 'Existing cut point was lost' };
      inserted.push(existing);
      continue;
    }
    const pt = insertPointOnEdgePreserving(working, true, h.edgeIndex, h.t, makeId);
    if (!pt) return { ok: false, reason: 'Failed to insert cut point' };
    inserted.push(pt);
  }

  const idxA = working.findIndex((p) => p.id === inserted[0]!.id);
  const idxB = working.findIndex((p) => p.id === inserted[1]!.id);
  if (idxA < 0 || idxB < 0) return { ok: false, reason: 'Cut points lost' };

  let iA = idxA;
  let iB = idxB;
  if (walkBoundary(working, idxA, idxB).length > working.length / 2 + 1) {
    iA = idxB;
    iB = idxA;
  }

  const arcAB = walkBoundary(working, iA, iB);
  const arcBA = walkBoundary(working, iB, iA);
  if (arcAB.length < 2 || arcBA.length < 2) {
    return { ok: false, reason: 'Degenerate split' };
  }

  const piecePoly = pieceToPolyline(working, true);
  const bridgeAB = buildCutBridge(
    cutter,
    working[iA]!.anchor,
    working[iB]!.anchor,
    makeId,
    piecePoly
  );
  const bridgeBA = reverseBridge(bridgeAB, makeId);
  const fresh1 = withFreshIds(buildRing(arcAB, bridgeBA), makeId);
  const fresh2 = withFreshIds(buildRing(arcBA, bridgeAB), makeId);
  const ring1 = fresh1.points;
  const ring2 = fresh2.points;

  if (ring1.length < 3 || ring2.length < 3) {
    return { ok: false, reason: 'Degenerate split' };
  }
  if (
    Math.abs(polyArea(ring1.map((p) => p.anchor))) < 0.05 ||
    Math.abs(polyArea(ring2.map((p) => p.anchor))) < 0.05
  ) {
    return { ok: false, reason: 'Cut creates a vanishing piece' };
  }

  const baseName = piece.name.replace(/\s+copy$/, '').replace(/\s+[AB]$/, '');
  const child1: PatternPiece = {
    id: makeId(),
    name: `${baseName} A`,
    closed: true,
    points: ring1,
  };
  const child2: PatternPiece = {
    id: makeId(),
    name: `${baseName} B`,
    closed: true,
    points: ring2,
  };
  child1.grainline = assignGrainline(piece, child1);
  child2.grainline = assignGrainline(piece, child2);
  return {
    ok: true,
    pieces: [child1, child2],
    pointIdMaps: [fresh1.pointIdMap, fresh2.pointIdMap],
  };
}

export function sampleCutterPath(cutter: CutterPath, steps = 48): Vec2[] {
  if (cutter.kind === 'line') return [cutter.a, cutter.b];
  if (cutter.kind === 'circle') {
    const out: Vec2[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      out.push({
        x: cutter.center.x + Math.cos(a) * cutter.radius,
        y: cutter.center.y + Math.sin(a) * cutter.radius,
      });
    }
    return out;
  }
  return sampleCubic(cutter.a, cutter.c0, cutter.c1, cutter.b, steps);
}
