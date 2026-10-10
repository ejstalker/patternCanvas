import type { BezierPoint, PatternPiece, SeamEdgeRef, Vec2 } from '../project/types';
import {
  dist,
  edgeIndexForPointIds,
  pieceToPolyline,
  pointInPolygon,
  sampleEdgeByPointIds,
} from './geometry';
import { cloneHandle, isSimpleRing, joinRing, polygonArea } from './ringDraft';

/**
 * Fusing two pattern pieces along a pair of edges, the way a 3D modeller welds
 * two boundaries.
 *
 * The first piece is *brought onto* the second so its selected edges line up
 * with the second piece's. Two ways of bringing it there are offered: `warp`
 * deforms it — moved, bent and scaled along the chain — so the edges lie exactly
 * on one another, while `match` moves, turns and scales the whole piece and
 * leaves its outline alone, matching the edges if they land within a tolerance
 * and filling whatever is left between them the way a bridge does.
 *
 * Two pieces can meet along one boundary in only two ways, end for end: either
 * the two chains are walked the same way round, or one is walked against the
 * other. Which of the two leaves the pieces side by side instead of on top of
 * each other depends on their winding senses, and it is not something a
 * draftsperson should have to know — so both are tried and the one whose fused
 * outline holds the two pieces' area wins.
 */

/** A contiguous run of whole edges on one piece, in the piece's winding order. */
export type JoinRun = {
  pieceId: string;
  /** Winding index of the run's first vertex. */
  startIndex: number;
  /** How many edges the run covers (at least one). */
  edgeCount: number;
  /** Winding indices of the run's vertices, first → last inclusive. */
  vertexIndices: number[];
};

export type JoinRunResult = { ok: true; run: JoinRun } | { ok: false; reason: string };

/** How the moving piece is brought onto the second one. */
export type JoinFit =
  /**
   * Bend, stretch and turn the piece until its picked edges lie exactly on the
   * second piece's — the fuse that always closes, whatever shape the two chains
   * are.
   */
  | 'warp'
  /**
   * Move, turn and scale the piece as it is, never bending it: the picked edges
   * are matched when they land within `tolerance` of the second piece's, and
   * whatever is left between the two chains is filled in, the way a bridge
   * fills the space between two runs.
   */
  | 'match';

export type JoinOptions = {
  /** Which of the two fits to use. Default `match`, the fit the join tool opens on. */
  fit?: JoinFit;
  /** In `match`, how far apart the picked edges may sit and still be matched, in cm. */
  tolerance?: number;
};

/**
 * The run of edges a list of picks covers, or why they cannot be one.
 *
 * Order is not asked of the draftsperson: a join only cares *which* edges, so
 * the picks are walked around the ring and the run is read off between the two
 * gaps that are left. What they must be is a single unbroken run on one piece.
 */
export function joinRunOf(piece: PatternPiece, refs: readonly SeamEdgeRef[]): JoinRunResult {
  const n = piece.points.length;
  if (!piece.closed || n < 3) return { ok: false, reason: 'Closed outlines only' };
  if (refs.length === 0) return { ok: false, reason: 'Select an edge on each piece' };
  if (refs.some((ref) => ref.pieceId !== piece.id)) {
    return { ok: false, reason: 'One side at a time: those edges are on two pieces' };
  }

  const edges = new Set<number>();
  for (const ref of refs) {
    if (ref.t0 !== 0 || ref.t1 !== 1) return { ok: false, reason: 'Whole edges only' };
    const index = edgeIndexForPointIds(piece, ref.fromPointId, ref.toPointId);
    if (index === null) return { ok: false, reason: 'Those edges are no longer on the piece' };
    edges.add(index);
  }
  if (edges.size >= n) {
    return { ok: false, reason: 'Leave the pieces an edge to keep' };
  }

  const sorted = [...edges].sort((a, b) => a - b);
  let start = sorted[0];
  let gaps = 0;
  for (let i = 0; i < sorted.length; i++) {
    const next = i === sorted.length - 1 ? sorted[0] + n : sorted[i + 1];
    const gap = next - sorted[i];
    if (gap === 1) continue;
    gaps++;
    start = sorted[(i + 1) % sorted.length];
  }
  if (gaps > 1) return { ok: false, reason: 'Those edges are not next to each other' };

  const vertexIndices: number[] = [];
  for (let i = 0; i <= sorted.length; i++) vertexIndices.push((start + i) % n);
  return {
    ok: true,
    run: { pieceId: piece.id, startIndex: start, edgeCount: sorted.length, vertexIndices },
  };
}

/** A chain as a polyline with arc lengths and a tangent per sample. */
export type ChainFrame = {
  points: Vec2[];
  /** Unit tangent per sample, smoothed so a bend has no kinks at the seams. */
  tangents: Vec2[];
  /** Arc length at each sample. */
  cum: number[];
  length: number;
};

const smoothSteps = (chord: number): number => Math.max(6, Math.min(32, Math.round(chord / 0.4)));

/**
 * Sample a run into a polyline to work the deform against.
 *
 * `reverse` walks the run against the piece's winding order — which is how the
 * second piece's chain is always read, since the two chains meet end to end.
 */
export function joinChainFrame(piece: PatternPiece, run: JoinRun, reverse = false): ChainFrame {
  const n = piece.points.length;
  const points: Vec2[] = [];
  for (let i = 0; i < run.edgeCount; i++) {
    const index = (run.startIndex + i) % n;
    const a = piece.points[index];
    const b = piece.points[(index + 1) % n];
    const samples =
      sampleEdgeByPointIds(piece, a.id, b.id, smoothSteps(dist(a.anchor, b.anchor))) ?? [
        a.anchor,
        b.anchor,
      ];
    if (points.length === 0) points.push({ ...samples[0] });
    for (let s = 1; s < samples.length; s++) points.push({ ...samples[s] });
  }
  if (reverse) points.reverse();

  const cum: number[] = [0];
  const segDir: Vec2[] = [];
  const segLen: number[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    const len = Math.hypot(dx, dy);
    segLen.push(len);
    segDir.push(len > 1e-9 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 });
    cum.push(cum[i] + len);
  }

  // Length-weighted blend of the segments either side of a sample. For a
  // straightchain this is the segment direction itself, so a straight chain is
  // mapped without tilting it.
  const tangents: Vec2[] = points.map((_, k) => {
    const prev = k > 0 ? segDir[k - 1] : null;
    const next = k < segDir.length ? segDir[k] : null;
    const wp = prev ? segLen[k - 1] : 0;
    const wn = next ? segLen[k] : 0;
    const x = (prev ? prev.x * wp : 0) + (next ? next.x * wn : 0);
    const y = (prev ? prev.y * wp : 0) + (next ? next.y * wn : 0);
    const len = Math.hypot(x, y);
    if (len < 1e-9) return next ?? prev ?? { x: 1, y: 0 };
    return { x: x / len, y: y / len };
  });

  return { points, tangents, cum, length: cum[cum.length - 1] ?? 0 };
}

type ChainHit = { f: number; offset: number; tangent: Vec2 };

/** Where a point sits against a chain: how far along, and how far to the left. */
function projectToChain(frame: ChainFrame, p: Vec2): ChainHit {
  let best = { d: Infinity, i: 0, t: 0, at: p };
  for (let i = 0; i + 1 < frame.points.length; i++) {
    const a = frame.points[i];
    const b = frame.points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const at = { x: a.x + dx * t, y: a.y + dy * t };
    const d = dist(p, at);
    if (d < best.d) best = { d, i, t, at };
  }
  const i = best.i;
  const tangent = blendTangent(frame, i, best.t);
  const offset = (p.x - best.at.x) * -tangent.y + (p.y - best.at.y) * tangent.x;
  const span = frame.cum[i + 1] - frame.cum[i];
  const along = frame.cum[i] + span * best.t;
  return { f: frame.length > 0 ? along / frame.length : 0, offset, tangent };
}

/**
 * Points spaced evenly along a chain. A straight run is held as its two ends
 * alone, so measuring two chains against each other has to be done between
 * samples rather than at them.
 */
function frameSamples(frame: ChainFrame, count = 16): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= count; i++) out.push(sampleAt(frame, i / count));
  return out;
}

/** The furthest any of `from` sits from the polyline through `to`. */
function spread(from: readonly Vec2[], to: readonly Vec2[]): number {
  let worst = 0;
  for (const p of from) worst = Math.max(worst, distanceToPolyline(to, p));
  return worst;
}

function distanceToPolyline(points: readonly Vec2[], p: Vec2): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, dist(p, { x: a.x + dx * t, y: a.y + dy * t }));
  }
  return best;
}

function blendTangent(frame: ChainFrame, i: number, t: number): Vec2 {
  const a = frame.tangents[i] ?? { x: 1, y: 0 };
  const b = frame.tangents[i + 1] ?? a;
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  const len = Math.hypot(x, y);
  return len < 1e-9 ? a : { x: x / len, y: y / len };
}

function sampleAt(frame: ChainFrame, f: number): Vec2 {
  const target = Math.max(0, Math.min(1, f)) * frame.length;
  let i = 0;
  while (i + 2 < frame.cum.length && frame.cum[i + 1] < target) i++;
  const span = frame.cum[i + 1] - frame.cum[i];
  const t = span > 1e-12 ? (target - frame.cum[i]) / span : 0;
  const a = frame.points[i];
  const b = frame.points[i + 1] ?? a;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function tangentAt(frame: ChainFrame, f: number): Vec2 {
  const target = Math.max(0, Math.min(1, f)) * frame.length;
  let i = 0;
  while (i + 2 < frame.cum.length && frame.cum[i + 1] < target) i++;
  const span = frame.cum[i + 1] - frame.cum[i];
  const t = span > 1e-12 ? (target - frame.cum[i]) / span : 0;
  return blendTangent(frame, i, t);
}

/**
 * The deform itself: a ribbon map. Every point keeps its distance along the
 * chain (as a fraction of its length) and its perpendicular offset, so the
 * chain lands on the chain and the rest of the piece follows it — stretched
 * along the chain by the length ratio, rotated into the target's frame, and
 * left alone across it.
 */
function warpVector(v: Vec2, from: Vec2, to: Vec2, stretch: number): Vec2 {
  const along = v.x * from.x + v.y * from.y;
  const across = -v.x * from.y + v.y * from.x;
  const s = along * stretch;
  return { x: to.x * s - to.y * across, y: to.y * s + to.x * across };
}

function warpPiece(
  piece: PatternPiece,
  src: ChainFrame,
  tgt: ChainFrame,
  stretch: number
): { points: BezierPoint[]; at: (p: Vec2) => Vec2 } {
  const at = (p: Vec2): Vec2 => {
    const hit = projectToChain(src, p);
    const tangent = tangentAt(tgt, hit.f);
    const base = sampleAt(tgt, hit.f);
    return { x: base.x - tangent.y * hit.offset, y: base.y + tangent.x * hit.offset };
  };
  const points = piece.points.map((point) => {
    const hit = projectToChain(src, point.anchor);
    const to = tangentAt(tgt, hit.f);
    const anchor = at(point.anchor);
    const handle = (h: Vec2 | null): Vec2 | null => {
      if (!h) return null;
      const v = { x: h.x - point.anchor.x, y: h.y - point.anchor.y };
      const w = warpVector(v, hit.tangent, to, stretch);
      return { x: anchor.x + w.x, y: anchor.y + w.y };
    };
    return {
      ...point,
      anchor,
      handleIn: handle(point.handleIn),
      handleOut: handle(point.handleOut),
    };
  });
  return { points, at };
}

/** The outline from `from` to `to` inclusive, following the piece's winding. */
/** The outline from one vertex to another the way the piece is wound, both ends in. */
export function ringWalk(points: readonly BezierPoint[], from: number, to: number): BezierPoint[] {
  const n = points.length;
  const out: BezierPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const index = (from + i) % n;
    out.push(points[index]);
    if (index === to) break;
  }
  return out;
}

export type JoinResult =
  | {
      ok: true;
      /** The fused piece — it keeps the second (unmoved) piece's identity. */
      piece: PatternPiece;
      /** The piece that was moved into place, now gone from the pattern. */
      movingPieceId: string;
      /**
       * How far the picked edges sat apart once the piece had been brought
       * over, in cm. A warp lands them on one another, so it always reports 0;
       * a match reports what the fill had to span.
       */
      gap: number;
      /**
       * Point ids that were folded onto a neighbour. A seam that named one of
       * these still describes a real edge of the fused piece, so it is worth
       * following the alias before concluding a seam has gone stale.
       */
      idAliases: Record<string, string>;
    }
  | {
      ok: false;
      reason: string;
      /**
       * Set when the edges simply sat too far apart for a `match`: how far, in
       * pattern units. The caller can say it in whichever unit it shows.
       */
      gap?: number;
    };

/**
 * Fuse `moving` onto `base` along the picked edges. The result keeps the base's
 * id and name; the moving piece stops existing.
 */
export function joinPieces(
  moving: PatternPiece,
  movingRefs: readonly SeamEdgeRef[],
  base: PatternPiece,
  baseRefs: readonly SeamEdgeRef[],
  options: JoinOptions = {}
): JoinResult {
  if (moving.id === base.id) return { ok: false, reason: 'Pick an edge on each piece' };

  const movingRun = joinRunOf(moving, movingRefs);
  if (!movingRun.ok) return { ok: false, reason: `First piece: ${movingRun.reason}` };
  const baseRun = joinRunOf(base, baseRefs);
  if (!baseRun.ok) return { ok: false, reason: `Second piece: ${baseRun.reason}` };

  const src = joinChainFrame(moving, movingRun.run, false);
  if (src.length < 1e-6) return { ok: false, reason: 'Those edges are too short to join' };

  const baseArea = Math.abs(polygonArea(pieceToPolyline(base.points, true, 4)));
  const movingArea = Math.abs(polygonArea(pieceToPolyline(moving.points, true, 4)));
  if ((options.fit ?? 'match') === 'match') {
    return matchedJoin(
      moving,
      movingRun.run,
      base,
      baseRun.run,
      src,
      baseArea,
      movingArea,
      Math.max(0, options.tolerance ?? 0)
    );
  }
  const candidates = [
    attemptJoin(moving, movingRun.run, base, baseRun.run, src, baseArea, movingArea, true),
    attemptJoin(moving, movingRun.run, base, baseRun.run, src, baseArea, movingArea, false),
  ].filter((attempt): attempt is JoinAttempt => !!attempt);

  // Pick the pairing that leaves the pieces side by side rather than on top of
  // one another. A run that turns a corner harder than the piece is deep cannot
  // be brought round without folding, and a fold is not a fuse: both what the
  // outline holds and what is left of the moved piece have to come out whole.
  const clean = candidates.filter(
    (attempt) => attempt.area > 0.05 && attempt.held >= MIN_HELD && attempt.kept >= MIN_KEPT
  );
  if (clean.length === 0) {
    const folded = candidates.some((attempt) => attempt.area > 0.05);
    return {
      ok: false,
      reason: folded
        ? 'That join would fold the pieces onto each other — pick a shorter run, or one that turns the same way'
        : 'That join would fold the pieces onto each other',
    };
  }
  const pick = clean.reduce((best, attempt) => (attempt.area > best.area ? attempt : best));

  const piece: PatternPiece = {
    ...base,
    points: pick.ring,
    grainline: pickGrainline(base, moving, pick.ring, pick.at),
  };
  return { ok: true, piece, movingPieceId: moving.id, idAliases: pick.idAliases, gap: 0 };
}

type JoinAttempt = {
  ring: BezierPoint[];
  idAliases: Record<string, string>;
  /** Where the moving piece's points ended up, for warping the grainline with it. */
  at: (p: Vec2) => Vec2;
  area: number;
  /** Share of the two pieces' area the fused outline holds. */
  held: number;
  /** Share of the moved piece that survived the bend, against what scaling alone would do. */
  kept: number;
};

/** A fuse that loses more than this of either measure has folded, not bent. */
const MIN_HELD = 0.8;
const MIN_KEPT = 0.5;

type MatchAttempt = {
  ring: BezierPoint[];
  idAliases: Record<string, string>;
  /** Where the moving piece's points ended up, for carrying the grainline with them. */
  at: (p: Vec2) => Vec2;
  area: number;
  simple: boolean;
  /** How far the worst of the moved chain sits from the second chain, in cm. */
  gap: number;
};

/**
 * The fuse that keeps the moving piece's shape.
 *
 * Its picked edges are landed on the second piece's by moving, turning and
 * scaling the piece — never bending it — so the two agree only as well as their
 * shapes allow. They count as matched while they end up within `tolerance`, and
 * what the two chains still leave between them is filled in the way a bridge
 * fills between two runs: the fused outline runs round the second piece's chain
 * and the moving piece's kept outline, and both picked chains become interior.
 */
function matchedJoin(
  moving: PatternPiece,
  movingRun: JoinRun,
  base: PatternPiece,
  baseRun: JoinRun,
  src: ChainFrame,
  baseArea: number,
  movingArea: number,
  tolerance: number
): JoinResult {
  const attempts = [true, false]
    .map((reversed) =>
      matchAttempt(moving, movingRun, base, baseRun, src, reversed)
    )
    .filter((attempt): attempt is MatchAttempt => !!attempt);
  if (attempts.length === 0) return { ok: false, reason: 'Those edges cannot be brought together' };

  const closest = attempts.reduce((best, attempt) => (attempt.gap < best.gap ? attempt : best));
  if (closest.gap > tolerance) {
    return { ok: false, reason: 'Those edges are too far apart to match', gap: closest.gap };
  }

  const wound = Math.sign(polygonArea(base.points.map((point) => point.anchor)));
  const wanted = Math.max(baseArea, movingArea);
  const usable = attempts.filter(
    (attempt) =>
      attempt.gap <= tolerance &&
      attempt.simple &&
      Math.sign(attempt.area) === wound &&
      Math.abs(attempt.area) >= wanted - 1e-6
  );
  if (usable.length === 0) {
    return { ok: false, reason: 'Those edges face away from each other — the piece would fold over itself' };
  }
  const pick = usable.reduce((best, attempt) =>
    Math.abs(attempt.area) > Math.abs(best.area) ? attempt : best
  );
  const piece: PatternPiece = {
    ...base,
    points: pick.ring,
    grainline: pickGrainline(base, moving, pick.ring, pick.at),
  };
  return { ok: true, piece, movingPieceId: moving.id, idAliases: pick.idAliases, gap: pick.gap };
}

/** One pairing of the chains, brought together by moving, turning and scaling. */
function matchAttempt(
  moving: PatternPiece,
  movingRun: JoinRun,
  base: PatternPiece,
  baseRun: JoinRun,
  src: ChainFrame,
  reversed: boolean
): MatchAttempt | null {
  const tgt = joinChainFrame(base, baseRun, reversed);
  if (tgt.length < 1e-6) return null;

  const at = similarityAcross(src, tgt);
  const moved = moving.points.map((point) => ({
    ...point,
    anchor: at(point.anchor),
    handleIn: point.handleIn ? at(point.handleIn) : null,
    handleOut: point.handleOut ? at(point.handleOut) : null,
  }));
  // The two chains share their ends by construction, so what is left to measure
  // is how far apart they wander in between — read both ways round, or a chain
  // that bulges away between samples would go unnoticed.
  const movedSamples = frameSamples(src).map(at);
  const tgtSamples = frameSamples(tgt);
  const gap = Math.max(
    spread(tgtSamples, movedSamples),
    spread(movedSamples, tgtSamples)
  );

  const baseKeep = ringWalk(
    base.points,
    baseRun.vertexIndices[baseRun.edgeCount],
    baseRun.vertexIndices[0]
  );
  const movingKeep = ringWalk(
    moved,
    movingRun.vertexIndices[movingRun.edgeCount],
    movingRun.vertexIndices[0]
  );
  if (baseKeep.length < 2 || movingKeep.length < 2) return null;

  // Both kept walks run from one joint to the other, so the second has to be
  // walked the way that carries on from where the first stopped — which is the
  // direction the second chain is read in, as it is for a warp.
  const draft = joinRing([baseKeep, reversed ? movingKeep : reverseWalk(movingKeep)]);
  if (draft.ring.length < 3) return null;
  const poly = pieceToPolyline(draft.ring, true, 10);
  return {
    ring: draft.ring,
    idAliases: draft.idAliases,
    at,
    area: polygonArea(poly),
    simple: isSimpleRing(poly),
    gap,
  };
}

/**
 * The similarity — a move, a turn and one uniform scale — that lands the source
 * chain's ends on the target chain's. Uniform, so the piece keeps its shape:
 * every angle and proportion comes through as it was, and only its size changes.
 */
function similarityAcross(src: ChainFrame, tgt: ChainFrame): (p: Vec2) => Vec2 {
  const srcA = src.points[0];
  const srcB = src.points[src.points.length - 1];
  const tgtA = tgt.points[0];
  const tgtB = tgt.points[tgt.points.length - 1];
  const sa = { x: srcB.x - srcA.x, y: srcB.y - srcA.y };
  const sb = { x: tgtB.x - tgtA.x, y: tgtB.y - tgtA.y };
  const from = Math.hypot(sa.x, sa.y);
  const to = Math.hypot(sb.x, sb.y);
  const scale = from > 1e-9 ? to / from : 1;
  const turn = Math.atan2(sb.y, sb.x) - Math.atan2(sa.y, sa.x);
  const cos = Math.cos(turn) * scale;
  const sin = Math.sin(turn) * scale;
  return (p: Vec2): Vec2 => {
    const vx = p.x - srcA.x;
    const vy = p.y - srcA.y;
    return { x: tgtA.x + vx * cos - vy * sin, y: tgtA.y + vx * sin + vy * cos };
  };
}

/**
 * One of the two ways the chains can be brought together: `reversed` walks the
 * second piece's chain against its winding order, which is the pairing that
 * keeps two same-handed pieces side by side.
 */
function attemptJoin(
  moving: PatternPiece,
  movingRun: JoinRun,
  base: PatternPiece,
  baseRun: JoinRun,
  src: ChainFrame,
  baseArea: number,
  movingArea: number,
  reversed: boolean
): JoinAttempt | null {
  const tgt = joinChainFrame(base, baseRun, reversed);
  if (tgt.length < 1e-6) return null;

  const stretch = tgt.length / src.length;
  const warped = warpPiece(moving, src, tgt, stretch);

  const baseKeep = ringWalk(
    base.points,
    baseRun.vertexIndices[baseRun.edgeCount],
    baseRun.vertexIndices[0]
  );
  const movingKeep = ringWalk(
    warped.points,
    movingRun.vertexIndices[movingRun.edgeCount],
    movingRun.vertexIndices[0]
  );
  if (movingKeep.length < 3) return null;

  // Both kept walks run from one joint to the other, so the second has to be
  // walked the way that carries on from where the first stopped. Two pieces of
  // opposite handedness meet the other way round, which is exactly when the
  // moving walk has to be turned back on itself.
  const walk = reversed ? movingKeep : reverseWalk(movingKeep);
  const jointEnd = baseKeep.length - 1;
  const ring: BezierPoint[] = baseKeep.map((point) => ({ ...point }));
  for (let i = 1; i < walk.length - 1; i++) ring.push({ ...walk[i] });
  // The joints take the moving side's handles: it is the moving piece's kept
  // outline that runs into and out of them.
  ring[0] = { ...ring[0], handleIn: cloneHandle(walk[walk.length - 1].handleIn) };
  ring[jointEnd] = { ...ring[jointEnd], handleOut: cloneHandle(walk[0].handleOut) };

  if (ring.length < 3) return null;
  const area = Math.abs(polygonArea(pieceToPolyline(ring, true)));
  // How much of the two pieces the fused outline actually holds. A fuse that
  // runs one piece across the other cancels area out of the outline, and that is
  // the only thing that tells a fold from a bend — the two kept outlines meeting
  // at a joint can look tidy either way.
  const moved = Math.abs(polygonArea(pieceToPolyline(warped.points, true, 4)));
  const held = baseArea + moved > 0 ? area / (baseArea + moved) : 0;
  const expected = movingArea * stretch;
  const kept = expected > 1e-6 ? moved / expected : 0;

  const idAliases: Record<string, string> = { [walk[0].id]: ring[jointEnd].id };
  idAliases[walk[walk.length - 1].id] = ring[0].id;
  return { ring, idAliases, at: warped.at, area, held, kept };
}

/** The same outline walked the other way round, handles handed over. */
export function reverseWalk(points: readonly BezierPoint[]): BezierPoint[] {
  return [...points].reverse().map((point) => ({
    ...point,
    handleIn: point.handleOut,
    handleOut: point.handleIn,
  }));
}

/** The base's grainline if it survives the fuse, else the moving piece's warped. */
function pickGrainline(
  base: PatternPiece,
  moving: PatternPiece,
  ring: BezierPoint[],
  at: (p: Vec2) => Vec2
): PatternPiece['grainline'] {
  const poly = pieceToPolyline(ring, true);
  const inside = (line: PatternPiece['grainline']): boolean =>
    !!line &&
    pointInPolygon({ x: (line.from.x + line.to.x) / 2, y: (line.from.y + line.to.y) / 2 }, poly);
  const fromBase = base.grainline
    ? { from: { ...base.grainline.from }, to: { ...base.grainline.to } }
    : undefined;
  if (inside(fromBase)) return fromBase;
  if (!moving.grainline) return undefined;
  const warped = { from: at(moving.grainline.from), to: at(moving.grainline.to) };
  return inside(warped) ? warped : undefined;
}
