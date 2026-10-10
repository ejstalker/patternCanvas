/**
 * Loop-cut geometry: the cut the knife draws when the pointer is on an outline.
 *
 * The mental model is Blender's loop cut / edge slide. In *follow* mode — the
 * default — the cut is not the chord: it is traced across the piece a step at a
 * time, holding the pointer's own share of the way between the walls either side
 * of it, the way edge slide holds its factor. So a cut across a panel whose sides
 * are parallel comes out straight, one across a curved panel bends with it, and
 * one across a tapering panel comes out evenly spaced.
 *
 * Two things decide how that behaves, and both are about *which* walls count:
 *
 *   - only contours roughly parallel to the cut are walls — the ones it runs
 *     between. The edge it crosses square on is the one it is about to leave
 *     through, and reading that as a wall swings the cut outwards along it;
 *   - the walls are the pair bracketing where the cut already is, not the pair
 *     nearest the chord. The chord can lie outside the piece — straight across
 *     the waist of a crescent panel it does — and its nearest boundary on either
 *     side is then the same boundary. Bracketing keeps the walls local, and makes
 *     the interval between them the piece's interior, so the share always lands
 *     inside the piece.
 *
 * The trace ends where it meets the boundary: usually the far side of the piece,
 * but across a panel that tapers away the cut is still on the panel after the
 * edge normal has left it, and then it carries on to the edge it actually
 * reaches. Sideways slides are capped and the traced line faired, so corners and
 * notches in the outline come out as turns rather than spikes.
 */
import {
  dist,
  edgeHandles,
  lerp,
  pieceToPolyline,
  pointInPolygon,
  sampleCubic,
} from './geometry';
import type { CutterChainPoint, CutterPath } from './slice';
import type { BezierPoint, PatternPiece, Vec2 } from '../project/types';

/** Outline samples per edge. Dense enough that offsets read as smooth curves. */
const OUTLINE_STEPS = 24;
/** Samples across the cut before simplification. */
const CUT_SAMPLES = 40;
/** Douglas–Peucker tolerance for the sampled cut, in cm. */
const SIMPLIFY_CM = 0.08;
/** Attempts at a coarser fit before falling back to one point per sample. */
const FIT_ATTEMPTS = 5;
/** How far past the far crossing of the edge normal the trace may run, in samples. */
const TRACE_STEPS = 4;
/**
 * How much of an edge's direction has to lie along the cut for it to count as a
 * wall: cos 60°, so contours within 60° of the cut do, ones running across it do
 * not.
 */
const WALL_PARALLEL_MIN = 0.5;
/**
 * How far the cut may slide sideways per centimetre of chord. Where a wall pair
 * changes places — around a corner, or across a notch — the share would
 * otherwise throw the cut across the piece in a single step; capping the slide
 * makes that a turn taken over several steps instead, which is what keeps a loop
 * free of the spikes and hooks a raw blend leaves behind.
 */
const MAX_SLIDE = 2.5;
/** A cut shorter than this is a sliver, not a cut. */
const MIN_SPAN_CM = 0.4;

export type LoopCutRequest = {
  /** Outline edge the pointer is on. */
  edgeIndex: number;
  /** Where along that edge, 0..1. */
  t: number;
  /** Follow the piece's contours (the default) instead of cutting straight. */
  follow: boolean;
};

export type LoopCut = {
  /** Where the cut starts, on the hovered edge. */
  entry: Vec2;
  /** Where it lands on the far side. */
  exit: Vec2;
  /** The cut from entry to exit: two points when straight, a chain when following. */
  path: CutterChainPoint[];
  /** The two contours the follow blend reads, entry → exit (for the preview). */
  rails: [Vec2[], Vec2[]];
  /** True when the cut is a straight chord, so the line cutter can take it. */
  straight: boolean;
  /** False when the cut would leave the piece or is a sliver. */
  valid: boolean;
  reason?: string;
};

type OutlinePoint = { p: Vec2 };

/**
 * The closed outline, sampled uniformly in edge parameter — `OUTLINE_STEPS`
 * points per edge, so index arithmetic maps straight back to (edge, t).
 *
 * `pieceToPolyline` cannot be used here: it collapses an edge to its anchors
 * unless the edge is curved, which leaves no samples to follow along a straight
 * side.
 */
function outlineTable(piece: PatternPiece): OutlinePoint[] {
  const n = piece.points.length;
  const points: OutlinePoint[] = [];
  for (let i = 0; i < n; i++) {
    // `edgePointAt`, not `sampleCubic`: a straight edge is a lerp, and the
    // index arithmetic below assumes these samples are that same parameter.
    for (let k = 0; k < OUTLINE_STEPS; k++) {
      points.push({ p: edgePointAt(piece, i, k / OUTLINE_STEPS) });
    }
  }
  return points;
}

function isLinearEdge(a: BezierPoint, b: BezierPoint): boolean {
  return (
    (!a.handleOut || (a.handleOut.x === a.anchor.x && a.handleOut.y === a.anchor.y)) &&
    (!b.handleIn || (b.handleIn.x === b.anchor.x && b.handleIn.y === b.anchor.y))
  );
}

/** Unit tangent of an outline edge at parameter t, from the real cubic derivative. */
function edgeTangentAt(piece: PatternPiece, edgeIndex: number, t: number): Vec2 {
  const n = piece.points.length;
  const a = piece.points[edgeIndex]!;
  const b = piece.points[(edgeIndex + 1) % n]!;
  const { c0, c1 } = edgeHandles(a, b);
  const u = 1 - t;
  const x =
    3 * u * u * (c0.x - a.anchor.x) +
    6 * u * t * (c1.x - c0.x) +
    3 * t * t * (b.anchor.x - c1.x);
  const y =
    3 * u * u * (c0.y - a.anchor.y) +
    6 * u * t * (c1.y - c0.y) +
    3 * t * t * (b.anchor.y - c1.y);
  if (isLinearEdge(a, b)) {
    const dx = b.anchor.x - a.anchor.x;
    const dy = b.anchor.y - a.anchor.y;
    const chord = Math.hypot(dx, dy) || 1;
    return { x: dx / chord, y: dy / chord };
  }
  const len = Math.hypot(x, y);
  if (len < 1e-9) {
    const dx = b.anchor.x - a.anchor.x;
    const dy = b.anchor.y - a.anchor.y;
    const chord = Math.hypot(dx, dy) || 1;
    return { x: dx / chord, y: dy / chord };
  }
  return { x: x / len, y: y / len };
}

/** Point on an outline edge at parameter t. */
function edgePointAt(piece: PatternPiece, edgeIndex: number, t: number): Vec2 {
  const n = piece.points.length;
  const a = piece.points[edgeIndex]!;
  const b = piece.points[(edgeIndex + 1) % n]!;
  const { c0, c1 } = edgeHandles(a, b);
  const tt = Math.max(0, Math.min(1, t));
  // Handles pinned to the anchors still describe a cubic, which is not a straight
  // line at equal t; linear edges have to be evaluated as one.
  if (isLinearEdge(a, b)) return lerp(a.anchor, b.anchor, tt);
  const u = 1 - tt;
  return {
    x: u * u * u * a.anchor.x + 3 * u * u * tt * c0.x + 3 * u * tt * tt * c1.x + tt * tt * tt * b.anchor.x,
    y: u * u * u * a.anchor.y + 3 * u * u * tt * c0.y + 3 * u * tt * tt * c1.y + tt * tt * tt * b.anchor.y,
  };
}

function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  return len < 1e-9 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
}

type Crossing = { distance: number; index: number };

/**
 * Where a ray from `origin` along `dir` meets the outline. `index` is the
 * outline sample at the near end of the crossed segment, which is the point the
 * contour walk should stop before.
 */
function rayCrossings(outline: OutlinePoint[], origin: Vec2, dir: Vec2): Crossing[] {
  const crossings: Crossing[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!.p;
    const b = outline[(i + 1) % outline.length]!.p;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = ex * dir.y - ey * dir.x;
    if (Math.abs(den) < 1e-12) continue;
    const ox = a.x - origin.x;
    const oy = a.y - origin.y;
    // Intersect a + u·e = origin + s·dir by crossing with each direction.
    const s = -(ox * ey - oy * ex) / den;
    const u = -(ox * dir.y - oy * dir.x) / den;
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    // Crossings at the origin itself count: a station sitting on the boundary —
    // the far crossing of the edge normal does exactly that — is a wall on one
    // side, and without it the trace would stop a step short of the edge it is
    // heading for.
    if (s < -1e-6) continue;
    crossings.push({ distance: s, index: i });
  }
  crossings.sort((a, b) => a.distance - b.distance);
  const merged: Crossing[] = [];
  for (const crossing of crossings) {
    if (!merged.some((m) => Math.abs(m.distance - crossing.distance) < 0.02)) {
      merged.push(crossing);
    }
  }
  return merged;
}

/**
 * The piece's two walls at a station, as offsets from the station measured along
 * `perp`, ordered start → end the way the edge-slide fraction is counted.
 *
 * Only contours the cut runs *between* are walls: ones roughly parallel to the
 * cut. The edge the cut crosses square on — the far side it is about to leave
 * through — is not one of them, and reading it as one is what swings a cut
 * outwards at the last moment, along the edge it is about to end on.
 *
 * Among those, the walls are the pair that *brackets* where the cut already is,
 * not the pair nearest the chord. The chord can lie outside the piece — straight
 * across the waist of a crescent panel it does — and its nearest boundary on
 * either side is then the same boundary, which says nothing about the band being
 * cut. Bracketing keeps the pair local, and makes the interval between them the
 * piece's interior, so anything blended inside it is inside the piece too.
 */
function wallsAround(
  outline: OutlinePoint[],
  origin: Vec2,
  perp: Vec2,
  axis: Vec2,
  reference: number,
  startIsPositive: boolean
): { start: number; end: number } | null {
  const offsets: number[] = [];
  for (const [direction, sign] of [
    [perp, 1],
    [{ x: -perp.x, y: -perp.y }, -1],
  ] as const) {
    for (const crossing of rayCrossings(outline, origin, direction)) {
      const a = outline[crossing.index]!.p;
      const b = outline[(crossing.index + 1) % outline.length]!.p;
      const along = (a.x - b.x) * axis.x + (a.y - b.y) * axis.y;
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      if (Math.abs(along) / length < WALL_PARALLEL_MIN) continue;
      offsets.push(sign * crossing.distance);
    }
  }
  offsets.sort((a, b) => a - b);
  let below = Number.NEGATIVE_INFINITY;
  let above = Number.POSITIVE_INFINITY;
  for (const offset of offsets) {
    if (offset <= reference && offset > below) below = offset;
    if (offset >= reference && offset < above) above = offset;
  }
  if (!Number.isFinite(below) || !Number.isFinite(above)) return null;
  return startIsPositive ? { start: above, end: below } : { start: below, end: above };
}

/**
 * How far along its edge the pointer is, by arc length rather than parameter —
 * this is the edge-slide factor, and it is read straight off the pointer.
 */
function entryArcFraction(piece: PatternPiece, edgeIndex: number, t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  const at = (u: number) => edgePointAt(piece, edgeIndex, u);
  const step = 1 / OUTLINE_STEPS;
  let walked = 0;
  let total = 0;
  let prev = at(0);
  for (let k = 1; k <= OUTLINE_STEPS; k++) {
    const u = k * step;
    const cur = at(u);
    const length = dist(prev, cur);
    total += length;
    if (u <= clamped) walked += length;
    else if (clamped > u - step) walked += length * ((clamped - (u - step)) / step);
    prev = cur;
  }
  if (total < 1e-6) return 0.5;
  return Math.max(0.02, Math.min(0.98, walked / total));
}

/** Douglas–Peucker, iterative, keeping the ends. */
function simplify(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length < 3) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const a = points[first]!;
    const b = points[last]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstDist = tolerance;
    for (let i = first + 1; i < last; i++) {
      const p = points[i]!;
      const d = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
      if (d > worstDist) {
        worstDist = d;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = true;
      stack.push([first, worst], [worst, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Bézier chain through the samples, Catmull-Rom style: each handle points along
 * the line through the neighbouring samples, which is what keeps the curve
 * through the cut rather than bowing away from it. The ends have no second
 * neighbour, so they lean on the one they have.
 */
function chainThrough(points: Vec2[], axis: Vec2): CutterChainPoint[] {
  const n = points.length;
  if (n < 2) return [];
  void axis;
  const chain: CutterChainPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    let tangent: Vec2;
    if (i === 0) {
      tangent = normalize({ x: points[1]!.x - p.x, y: points[1]!.y - p.y });
    } else if (i === n - 1) {
      tangent = normalize({ x: p.x - points[n - 2]!.x, y: p.y - points[n - 2]!.y });
    } else {
      const prev = points[i - 1]!;
      const next = points[i + 1]!;
      tangent = normalize({ x: next.x - prev.x, y: next.y - prev.y });
    }
    const prevGap = i === 0 ? 0 : dist(points[i - 1]!, p);
    const nextGap = i === n - 1 ? 0 : dist(p, points[i + 1]!);
    chain.push({
      anchor: { ...p },
      handleIn: i === 0 ? null : { x: p.x - tangent.x * (prevGap / 3), y: p.y - tangent.y * (prevGap / 3) },
      handleOut:
        i === n - 1 ? null : { x: p.x + tangent.x * (nextGap / 3), y: p.y + tangent.y * (nextGap / 3) },
    });
  }
  return chain;
}

/** Sample a Bézier chain, segment by segment. */
function sampleChain(chain: CutterChainPoint[], steps: number): Vec2[] {
  const out: Vec2[] = [];
  const per = Math.max(2, Math.round(steps / Math.max(1, chain.length - 1)));
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i]!;
    const b = chain[i + 1]!;
    const segment = sampleCubic(a.anchor, a.handleOut ?? a.anchor, b.handleIn ?? b.anchor, b.anchor, per);
    for (const p of segment) {
      if (out.length === 0 || dist(out[out.length - 1]!, p) > 1e-9) out.push(p);
    }
  }
  return out;
}

/** Distance from a point to a polyline. */
function distanceToPolyline(p: Vec2, points: Vec2[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

/**
 * Fit a chain to the samples and check the fit.
 *
 * Simplifying first keeps the chain short, but a Bézier through a simplified
 * polyline bulges past it, and where the piece is concave that bulge cuts empty
 * space. So the tolerance halves until the curve stays within it of the samples
 * it came from, and failing that every sample is kept — the curve then tracks
 * the blend closely enough that there is nothing left to bulge past.
 */
function fitChain(samples: Vec2[], axis: Vec2): CutterChainPoint[] {
  let tolerance = SIMPLIFY_CM;
  for (let attempt = 0; attempt < FIT_ATTEMPTS; attempt++) {
    const chain = chainThrough(simplify(samples, tolerance), axis);
    const dense = sampleChain(chain, Math.min(256, 16 * Math.max(1, chain.length - 1)));
    let worst = 0;
    for (const p of dense) worst = Math.max(worst, distanceToPolyline(p, samples));
    if (worst <= tolerance) return chain;
    tolerance /= 2;
  }
  return chainThrough(samples, axis);
}

/**
 * The cut a hover on `edgeIndex` at `t` would make, or null when the piece cannot
 * be cut that way at all.
 */
export function loopCutAt(piece: PatternPiece, request: LoopCutRequest): LoopCut | null {
  if (!piece.closed || piece.points.length < 3) return null;
  const n = piece.points.length;
  if (request.edgeIndex < 0 || request.edgeIndex >= n) return null;

  const entry = edgePointAt(piece, request.edgeIndex, request.t);

  // Inward normal: the edge tangent turned 90°.
  const tangent = edgeTangentAt(piece, request.edgeIndex, request.t);
  let normal = { x: -tangent.y, y: tangent.x };
  if (Math.hypot(normal.x, normal.y) < 1e-9) return null;

  const outline = outlineTable(piece);
  const insidePoly = (p: Vec2) => pointInPolygon(p, outline.map((o) => o.p));

  // Which of the two normals points into the piece. Stepping just inside and
  // asking the outline is reliable where the centroid is not: a piece with a
  // concave bite (a cut that curved, a crescent) can have its centroid outside
  // itself, which would send the cut out through the near side instead of across.
  const probeCm = 0.15;
  const aheadIn = insidePoly({
    x: entry.x + normal.x * probeCm,
    y: entry.y + normal.y * probeCm,
  });
  const behindIn = insidePoly({
    x: entry.x - normal.x * probeCm,
    y: entry.y - normal.y * probeCm,
  });
  if (aheadIn === behindIn) {
    const hint = { x: 0, y: 0 };
    for (const pt of piece.points) {
      hint.x += pt.anchor.x / n;
      hint.y += pt.anchor.y / n;
    }
    const towardsHint = (hint.x - entry.x) * normal.x + (hint.y - entry.y) * normal.y;
    if (towardsHint < 0) normal = { x: -normal.x, y: -normal.y };
  } else if (!aheadIn) {
    normal = { x: -normal.x, y: -normal.y };
  }
  const crossings = rayCrossings(outline, entry, normal);
  if (crossings.length === 0) return null;

  // "The other side of the piece" is the far crossing, not the nearest one: a
  // near crossing on a concave piece would leave the cut short of the far side.
  const far = crossings[crossings.length - 1]!;
  const farDistance = far.distance;
  const chordExit = { x: entry.x + normal.x * farDistance, y: entry.y + normal.y * farDistance };
  if (farDistance < MIN_SPAN_CM) return null;

  const axis = normalize({ x: chordExit.x - entry.x, y: chordExit.y - entry.y });
  const perp = { x: -axis.y, y: axis.x };

  // Which wall the share is counted from: the one on the edge's start side, the
  // direction edge slide measures in. Both walls are reachable from either
  // normal, so this is read off the edge rather than assumed.
  const entryTangent = edgeTangentAt(piece, request.edgeIndex, request.t);
  const startIsPositive = -(perp.x * entryTangent.x + perp.y * entryTangent.y) > 0;
  const fraction = entryArcFraction(piece, request.edgeIndex, request.t);

  // Trace the cut a step at a time, placing it at the pointer's share of the way
  // between the walls either side of where it has got to. Keeping to the share is
  // what makes the cut straight on a panel with parallel sides, bent on one whose
  // sides curve together, and evenly spaced on a panel that tapers. Measuring the
  // walls around the cut itself, rather than around the chord, is what keeps it
  // local: it neither shoots out along the edge it enters through, nor wraps
  // around a corner to reach a wall it should never have seen.
  //
  // The trace ends where it meets the boundary. That is usually the far side of
  // the piece, but not always: on a panel that tapers away the cut is still
  // inside it long after the edge normal has left, and there the trace carries
  // on to the edge the cut actually reaches.
  const stepCm = farDistance / CUT_SAMPLES;
  const rails: [Vec2[], Vec2[]] = [[], []];
  const samples: Vec2[] = [{ ...entry }];
  let reference = 0;
  let reached = entry;
  let outside: Vec2 | null = null;
  for (let i = 1; i <= CUT_SAMPLES * TRACE_STEPS; i++) {
    const along = i * stepCm;
    const origin = { x: entry.x + axis.x * along, y: entry.y + axis.y * along };
      const wall = wallsAround(outline, origin, perp, axis, reference, startIsPositive);
    if (wall) {
      const share = wall.start + (wall.end - wall.start) * fraction;
      const slide = stepCm * MAX_SLIDE;
      reference = Math.max(reference - slide, Math.min(reference + slide, share));
      rails[0].push({ x: origin.x + perp.x * wall.start, y: origin.y + perp.y * wall.start });
      rails[1].push({ x: origin.x + perp.x * wall.end, y: origin.y + perp.y * wall.end });
    }
    // A station with no pair of walls to read — the cut has run past the piece,
    // or past the far end of the contours it is between — carries the cut on as
    // it is, and the boundary it reaches ends the trace.
    const point = { x: origin.x + perp.x * reference, y: origin.y + perp.y * reference };
    if (!insidePoly(point)) {
      outside = point;
      break;
    }
    samples.push(point);
    reached = point;
  }
  const exit = outside
    ? boundaryCrossing(outline, reached, outside) ?? boundaryHit(reached, outside, insidePoly)
    : { ...reached };
  smoothPath(samples, insidePoly);
  if (dist(samples[samples.length - 1]!, exit) > 1e-9) samples.push({ ...exit });

  const chordInside = (() => {
    for (let i = 1; i < 12; i++) {
      if (!insidePoly(lerp(entry, chordExit, i / 12))) return false;
    }
    return true;
  })();

  if (!request.follow) {
    return {
      entry,
      exit: chordExit,
      path: [
        { anchor: { ...entry }, handleIn: null, handleOut: null },
        { anchor: { ...chordExit }, handleIn: null, handleOut: null },
      ],
      rails,
      straight: true,
      valid: chordInside,
      reason: chordInside ? undefined : 'A straight cut would leave the piece',
    };
  }

  const path = fitChain(samples, axis);
  const span = dist(entry, exit);
  return {
    entry,
    exit,
    path,
    rails,
    straight: false,
    valid: path.length >= 2 && span >= MIN_SPAN_CM,
    reason: path.length >= 2 ? undefined : 'The followed cut would leave the piece at once',
  };
}

/**
 * Take the corners off a traced cut.
 *
 * A step across a corner — the walls changing places, or a share read off a
 * briefly one-sided section — leaves a kink that reads as a sharp turn in the
 * cut. Two passes of a 1-2-1 average over the interior samples rounds those
 * kinks into turns the cut takes over a step or two, without moving either end
 * or letting the cut off the piece.
 */
function smoothPath(samples: Vec2[], isInside: (p: Vec2) => boolean): void {
  for (let pass = 0; pass < 2; pass++) {
    const source = samples.map((p) => ({ ...p }));
    for (let i = 1; i + 1 < source.length; i++) {
      const blended = {
        x: (source[i - 1]!.x + 2 * source[i]!.x + source[i + 1]!.x) / 4,
        y: (source[i - 1]!.y + 2 * source[i]!.y + source[i + 1]!.y) / 4,
      };
      if (isInside(blended)) samples[i] = blended;
    }
  }
}

/**
 * Where the traced cut leaves the piece: the first outline crossing along the
 * step that took it outside. Landing exactly on the outline rather than a
 * hair inside it is what lets the slicer find the cut's far end.
 */
function boundaryCrossing(outline: OutlinePoint[], from: Vec2, to: Vec2): Vec2 | null {
  const dirX = to.x - from.x;
  const dirY = to.y - from.y;
  let best = Number.POSITIVE_INFINITY;
  let hit: Vec2 | null = null;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!.p;
    const b = outline[(i + 1) % outline.length]!.p;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = ex * dirY - ey * dirX;
    if (Math.abs(den) < 1e-12) continue;
    const ox = a.x - from.x;
    const oy = a.y - from.y;
    const s = -(ox * ey - oy * ex) / den;
    const u = -(ox * dirY - oy * dirX) / den;
    if (s < -1e-9 || s > 1 + 1e-9) continue;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    if (s < best) {
      best = s;
      hit = { x: from.x + dirX * s, y: from.y + dirY * s };
    }
  }
  return hit;
}

/**
 * Where the cut meets the boundary, when the outline itself does not say: the
 * point between the last sample inside the piece and the first one out of it.
 */
function boundaryHit(inside: Vec2, outside: Vec2, isInside: (p: Vec2) => boolean): Vec2 {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (isInside(lerp(inside, outside, mid))) lo = mid;
    else hi = mid;
  }
  return lerp(inside, outside, lo);
}

/** The cutter the slicer takes for a cut, straight or following. */
export function loopCutCutter(cut: LoopCut): CutterPath {
  if (cut.straight) return { kind: 'line', a: { ...cut.entry }, b: { ...cut.exit } };
  return { kind: 'path', points: cut.path.map((pt) => ({ ...pt })) };
}

/** Sample a cut path for drawing, whether straight or a chain. */
export function sampleLoopCutPath(cut: LoopCut, steps = 48): Vec2[] {
  if (cut.straight) return [{ ...cut.entry }, { ...cut.exit }];
  return sampleChain(cut.path, steps);
}
