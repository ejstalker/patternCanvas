/**
 * Simplifying a run of outline points.
 *
 * A curve sketched by hand carries dozens of anchors where the shape needs five,
 * and a simplified outline is easier to draft against, faster to remesh and
 * easier to sew. Simplifying takes a run of consecutive anchors and rewrites it
 * with fewer of them — the ones Douglas–Peucker says carry the shape — then fits
 * the curve back through whatever is left.
 *
 * Three rules keep it honest:
 *
 *   - the run's own ends are never dropped. They are shared with the edges either
 *     side of the run, which the draftsperson did not pick and which must not
 *     move;
 *   - nothing outside the run is touched — not the neighbouring anchors, and not
 *     their handles, which belong to the edge before the run;
 *   - a point a seam or dart ends on is held onto however hard the reduction is
 *     pushed, because a seam is stored as an edge between two points and dropping
 *     one of them would leave the stitching pointing at an outline that no longer
 *     has that edge.
 */
import { dist } from './geometry';
import type { BezierPoint, Vec2 } from '../project/types';

/** Fewer than this and there is nothing to simplify. */
export const MIN_RUN = 3;

/**
 * How the simplified run is drawn back in.
 *
 * `corner` makes every edge between the survivors straight. `smooth` keeps the
 * tangents the outline was drawn with, so a curve drawn through the run stays a
 * curve and a corner stays a corner, and the handles reach a third of the way to
 * the next surviving point so the curve joins up across the points it dropped.
 */
export type SimplifyFit = 'corner' | 'smooth';

export type SimplifyResult = {
  /** The whole outline, with the run rewritten. */
  points: BezierPoint[];
  /** The run's surviving points, in outline order. */
  keptIds: string[];
  /** The run's dropped points. */
  removedIds: string[];
};

const cloneVec = (v: Vec2 | null | undefined): Vec2 | null => (v ? { x: v.x, y: v.y } : null);

/**
 * Runs of consecutive picked points around an outline, as ids in outline order.
 *
 * A closed outline is a cycle, so a run may cross the end of the array; that run
 * comes back whole rather than as two pieces, because it is one run to the
 * draftsperson — the points either side of wherever the document happens to
 * start.
 */
export function selectedPointRuns(
  points: readonly BezierPoint[],
  isSelected: (id: string) => boolean,
  closed: boolean,
  minLength = MIN_RUN
): string[][] {
  const n = points.length;
  if (n < minLength) return [];
  const picked = points.map((pt) => isSelected(pt.id));
  if (!picked.some(Boolean)) return [];
  if (closed && picked.every(Boolean)) return [points.map((pt) => pt.id)];

  const runs: number[][] = [];
  let current: number[] | null = null;
  // A closed outline is walked from a point that is *not* picked, so no run
  // straddles the end of the array and each one stays in outline order.
  const start = closed ? picked.findIndex((p) => !p) : -1;
  for (let step = 0; step < n; step++) {
    const index = closed ? (start + 1 + step) % n : step;
    if (!picked[index]) {
      current = null;
      continue;
    }
    if (current) current.push(index);
    else {
      current = [index];
      runs.push(current);
    }
  }
  return runs
    .filter((run) => run.length >= minLength)
    .map((run) => run.map((i) => points[i]!.id));
}

/** How many of `count` points a `reduce` percent asks for: never under the two ends. */
export function keepCount(count: number, reduce: number): number {
  const pct = Math.max(0, Math.min(100, reduce));
  return Math.max(2, Math.round(count - ((count - 2) * pct) / 100));
}

/** Douglas–Peucker: which anchors to keep so that dropping the rest stays within `tolerance`. */
export function simplifyIndices(
  anchors: readonly Vec2[],
  tolerance: number,
  forced: readonly number[] = []
): number[] {
  const n = anchors.length;
  if (n <= 2) return anchors.map((_, i) => i);
  const keep = new Array<boolean>(n).fill(false);
  // The two ends are always kept, and so is anything the caller cannot afford to
  // lose — a seam endpoint, say. Those split the run into stretches that are
  // simplified one at a time, so a stitched edge does not get absorbed into a
  // long chord that ignores it.
  const stops = [...new Set([0, ...forced, n - 1])]
    .filter((i) => i >= 0 && i < n)
    .sort((a, b) => a - b);
  for (const stop of stops) keep[stop] = true;
  for (let s = 1; s < stops.length; s++) {
    simplifySpan(anchors, stops[s - 1]!, stops[s]!, tolerance, keep);
  }
  return anchors.map((_, i) => i).filter((i) => keep[i]!);
}

/** Douglas–Peucker over one stretch of a run, marking what it keeps in `keep`. */
function simplifySpan(
  anchors: readonly Vec2[],
  first: number,
  last: number,
  tolerance: number,
  keep: boolean[]
): void {
  const stack: Array<[number, number]> = [[first, last]];
  while (stack.length > 0) {
    const [a0, b0] = stack.pop()!;
    const a = anchors[a0]!;
    const b = anchors[b0]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = a0 + 1; i < b0; i++) {
      const p = anchors[i]!;
      const d = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / length;
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = true;
      stack.push([a0, worst], [worst, b0]);
    }
  }
}

/**
 * The tolerance that leaves at most `keep` anchors.
 *
 * Douglas–Peucker's tolerance is what drives the reduction, but "how much to
 * reduce" is counted in points, so the two are matched by bisection: the count
 * falls as the tolerance rises, which makes it searchable.
 */
export function toleranceForKeep(
  anchors: readonly Vec2[],
  keep: number,
  forced: readonly number[] = []
): number {
  let high = 0;
  for (let i = 1; i < anchors.length; i++) high += dist(anchors[i - 1]!, anchors[i]!);
  if (keep <= 2 || high <= 0) return high;
  let low = 0;
  if (simplifyIndices(anchors, low, forced).length <= keep) return low;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (simplifyIndices(anchors, mid, forced).length <= keep) high = mid;
    else low = mid;
  }
  return high;
}

/**
 * Rewrite one run of a piece's outline with fewer points.
 *
 * `pinned` names points that must survive however hard the reduction is asked to
 * work — seam and dart ends, which are edges in their own right and would break
 * the stitching if the outline stopped having them.
 *
 * Returns null when the run no longer describes a consecutive stretch of the
 * outline — the piece was edited under the caller, and nothing should be applied.
 */
export function simplifyRun(
  points: readonly BezierPoint[],
  runIds: readonly string[],
  keep: number,
  fit: SimplifyFit,
  closed: boolean,
  pinned: ReadonlySet<string> = new Set()
): SimplifyResult | null {
  const n = points.length;
  if (n < MIN_RUN || runIds.length < 2 || runIds.length > n) return null;

  const indexOfId = new Map(points.map((pt, index) => [pt.id, index]));
  const run: number[] = [];
  for (const id of runIds) {
    const index = indexOfId.get(id);
    if (index === undefined) return null;
    run.push(index);
  }
  for (let k = 1; k < run.length; k++) {
    const previous = run[k - 1]!;
    const expected = closed ? (previous + 1) % n : previous + 1;
    if (run[k] !== expected) return null;
  }

  const at = (index: number): BezierPoint => points[(index + n) % n]!;

  // A run of a whole closed outline has no ends worth protecting: its two ends are
  // an artefact of where the array happens to start, and pinning them would cut a
  // corner wherever that is. Cut the cycle where both sides of the cut are
  // straightest instead, so pinning the ends cannot bend the outline.
  if (closed && run.length === n) {
    let cut = 0;
    let flattest = Infinity;
    for (let k = 0; k < n; k++) {
      const straightness =
        deviation(at(k - 1).anchor, at(k).anchor, at(k + 1).anchor) +
        deviation(at(k).anchor, at(k + 1).anchor, at(k + 2).anchor);
      if (straightness < flattest - 1e-9) {
        flattest = straightness;
        cut = k;
      }
    }
    run.length = 0;
    for (let k = 0; k < n; k++) run.push((cut + k) % n);
  }

  const first = run[0]!;
  const last = run[run.length - 1]!;
  const runPoints = run.map((index) => points[index]!);
  const anchors = runPoints.map((pt) => pt.anchor);

  const wanted = Math.max(2, Math.min(Math.round(keep), runPoints.length));
  const forced = runPoints.map((pt, index) => (pinned.has(pt.id) ? index : -1)).filter((i) => i >= 0);
  const keptLocal =
    wanted >= runPoints.length
      ? anchors.map((_, index) => index)
      : simplifyIndices(anchors, toleranceForKeep(anchors, wanted, forced), forced);
  const lastKept = keptLocal.length - 1;

  // The neighbouring anchors are in reach but are not ours to change: they give
  // the fit something to lean on where the run meets the edges either side.
  const before = closed || first > 0 ? at(first - 1).anchor : null;
  const after = closed || last + 1 < n ? at(last + 1).anchor : null;

  const keptPoints = keptLocal.map((local, position) => {
    const original = runPoints[local]!;
    const anchor = { ...original.anchor };
    if (fit === 'corner') {
      return {
        ...original,
        anchor,
        handleIn: position === 0 ? cloneVec(original.handleIn) : null,
        handleOut: position === lastKept ? cloneVec(original.handleOut) : null,
        handlesParallel: false,
      };
    }

    // Smooth fits read the tangent where the draughtsperson drew it — the
    // direction of the neighbouring anchors *in the run*, which may be points this
    // fit is about to drop. Reading it off the survivors instead would cut across
    // the shape: on a panel drawn as a few long edges, the chord from one
    // survivor to the next sails straight past a corner and the curve leaves the
    // outline.
    const prevAnchor = originalNeighbour(local, -1, runPoints, before, after, closed);
    const nextAnchor = originalNeighbour(local, 1, runPoints, before, after, closed);
    const inDir = normalize({ x: anchor.x - prevAnchor.x, y: anchor.y - prevAnchor.y });
    const outDir = normalize({ x: nextAnchor.x - anchor.x, y: nextAnchor.y - anchor.y });
    const keptPrev = anchorOfKept(keptLocal, position - 1, anchors, anchor);
    const keptNext = anchorOfKept(keptLocal, position + 1, anchors, anchor);
    const gapIn = dist(keptPrev, anchor);
    const gapOut = dist(anchor, keptNext);
    return {
      ...original,
      anchor,
      handleIn:
        position === 0
          ? cloneVec(original.handleIn)
          : { x: anchor.x - inDir.x * (gapIn / 3), y: anchor.y - inDir.y * (gapIn / 3) },
      handleOut:
        position === lastKept
          ? cloneVec(original.handleOut)
          : { x: anchor.x + outDir.x * (gapOut / 3), y: anchor.y + outDir.y * (gapOut / 3) },
    };
  });

  const removedIds = run
    .filter((_, position) => !keptLocal.includes(position))
    .map((index) => points[index]!.id);
  const keptIds = keptLocal.map((local) => runPoints[local]!.id);

  // A run that crosses the end of the array cannot stay where it was without
  // splitting in two, so the outline is rotated to start at the run. A closed
  // outline is a cycle, so the same piece comes out the other way round.
  const wraps = closed && last < first;
  const rewritten = wraps
    ? [...keptPoints, ...points.slice(last + 1, first)]
    : [...points.slice(0, first), ...keptPoints, ...points.slice(last + 1)];

  return { points: rewritten, keptIds, removedIds };
}

/** The anchor a kept point sits next to, in the outline: 1 = next, -1 = previous. */
function anchorOfKept(
  keptLocal: readonly number[],
  position: number,
  anchors: readonly Vec2[],
  fallback: Vec2
): Vec2 {
  const local = keptLocal[position];
  return local === undefined ? fallback : anchors[local]!;
}

/**
 * The anchor next to run point `local` on the outline, still counting the run's
 * own points — the drawn shape, not what survives the fit.
 */
function originalNeighbour(
  local: number,
  step: 1 | -1,
  runPoints: readonly BezierPoint[],
  before: Vec2 | null,
  after: Vec2 | null,
  closed: boolean
): Vec2 {
  const inside = local + step;
  if (inside >= 0 && inside < runPoints.length) return runPoints[inside]!.anchor;
  if (closed && runPoints.length > 1) {
    return step < 0 ? runPoints[runPoints.length - 1]!.anchor : runPoints[0]!.anchor;
  }
  return (step < 0 ? before : after) ?? runPoints[local]!.anchor;
}

/** Perpendicular distance from a point to the line through two others. */
function deviation(a: Vec2, p: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return length < 1e-9 ? dist(a, p) : Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / length;
}

function normalize(v: Vec2): Vec2 {
  const length = Math.hypot(v.x, v.y);
  return length < 1e-9 ? { x: 0, y: 0 } : { x: v.x / length, y: v.y / length };
}
