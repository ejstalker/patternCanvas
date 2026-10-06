import type { PatternPiece, SeamBinding, SeamEdgeRef, Vec2 } from '../project/types';
import { findNearestEdge } from './geometry';

/**
 * Finding the seam a pointer is on.
 *
 * A seam is not identified by its edge. A many-to-many sew walks two groups of
 * edges and splits spans to match their arc lengths, so a 20 cm edge sewn to two
 * 10 cm edges carries **two** seams side by side — `[0, 0.5]` and `[0.5, 1]` of
 * that one edge. Anything that asks "which seam is here?" by comparing point ids
 * alone gets the first match in the document, which is why a right-click could
 * reverse a seam the pointer was nowhere near.
 *
 * So the span decides. These helpers take a position along an edge and pick the
 * seam whose span covers it, falling back to the nearest span when none does.
 */

/** Where a pointer landed on a piece edge: its ids plus the parametric position. */
export type EdgeParamHit = {
  pieceId: string;
  fromPointId: string;
  toPointId: string;
  /** Parametric position along that edge in its own winding, 0..1. */
  t: number;
};

/** Distance from `t` to a seam side's span: zero when the position is inside it. */
function spanDistance(ref: SeamEdgeRef, t: number): number {
  const lo = Math.min(ref.t0, ref.t1);
  const hi = Math.max(ref.t0, ref.t1);
  if (t < lo) return lo - t;
  if (t > hi) return t - hi;
  return 0;
}

/** Does this side of a seam sit on the edge the pointer is on? */
function refOnEdge(ref: SeamEdgeRef, hit: EdgeParamHit): boolean {
  return (
    ref.pieceId === hit.pieceId &&
    ref.fromPointId === hit.fromPointId &&
    ref.toPointId === hit.toPointId
  );
}

/**
 * Re-pair the seams that share an edge, in the opposite order.
 *
 * A many-to-many sew walks two groups of edges and splits spans to match their
 * arc lengths, so a single edge can end up carrying several seams side by side.
 * Hand the two groups over in the wrong order — the left edge clicked before the
 * right — and every one of those seams pairs the wrong way round: the stitches
 * cross and a run that should read along the seam reads against it. Reversing a
 * seam's *direction* cannot fix that, because the spans are fine; what is wrong
 * is which partner each span is paired with.
 *
 * So every span stays exactly where it is and the partners are handed round in
 * reverse: the first span takes the last partner. Returns the rewritten seams,
 * or null when the edge has fewer than two seams to reorder.
 */
export function reverseSeamsAcrossEdge(
  seams: readonly SeamBinding[],
  hit: EdgeParamHit
): SeamBinding[] | null {
  const onEdge: Array<{ seam: SeamBinding; local: SeamEdgeRef; partner: SeamEdgeRef; start: number }> =
    [];

  for (const seam of seams) {
    const aOnEdge = refOnEdge(seam.a, hit);
    const bOnEdge = refOnEdge(seam.b, hit);
    // A seam with both sides on this edge has no partner to hand round, and one
    // with neither is not part of this run.
    if (aOnEdge === bOnEdge) continue;
    const local = aOnEdge ? seam.a : seam.b;
    onEdge.push({
      seam,
      local,
      partner: aOnEdge ? seam.b : seam.a,
      start: Math.min(local.t0, local.t1),
    });
  }
  if (onEdge.length < 2) return null;

  const ordered = [...onEdge].sort((x, y) => x.start - y.start);
  const partners = ordered.map((entry) => entry.partner).reverse();

  return ordered.map((entry, i) => {
    const partner = partners[i];
    return refOnEdge(entry.seam.a, hit)
      ? { ...entry.seam, b: partner }
      : { ...entry.seam, a: partner };
  });
}

/** Does either side of the seam cover this position on this edge? */
export function seamCoversEdge(seam: SeamBinding, hit: EdgeParamHit): boolean {
  return [seam.a, seam.b].some((ref) => refOnEdge(ref, hit) && spanDistance(ref, hit.t) === 0);
}

/**
 * The seam running through a position on a piece edge, or null.
 *
 * A span that covers the position always wins; among those, the narrowest — the
 * most specific answer. With nothing covering it, the nearest span's seam.
 */
export function findSeamThroughEdge(
  seams: readonly SeamBinding[],
  hit: EdgeParamHit
): SeamBinding | null {
  const t = Math.min(1, Math.max(0, hit.t));
  let best: { seam: SeamBinding; distance: number; width: number } | null = null;

  for (const seam of seams) {
    for (const ref of [seam.a, seam.b]) {
      if (ref.pieceId !== hit.pieceId) continue;
      if (ref.fromPointId !== hit.fromPointId || ref.toPointId !== hit.toPointId) continue;
      const distance = spanDistance(ref, t);
      const width = Math.abs(ref.t1 - ref.t0);
      if (
        !best ||
        distance < best.distance - 1e-9 ||
        (Math.abs(distance - best.distance) <= 1e-9 && width < best.width)
      ) {
        best = { seam, distance, width };
      }
    }
  }

  return best?.seam ?? null;
}

/**
 * The seam whose edge passes nearest a pattern-space point.
 *
 * The piece edge under the point names the candidates; the position along that
 * edge picks between them. A seam whose span covers the point is preferred over
 * one that merely shares the edge, however slightly nearer the latter's edge is.
 */
export function findSeamNearPoint(
  seams: readonly SeamBinding[],
  pieces: readonly PatternPiece[],
  point: Vec2,
  threshold: number
): SeamBinding | null {
  let best: { seam: SeamBinding; score: number } | null = null;

  for (const piece of pieces) {
    if (piece.points.length < 2) continue;
    const near = findNearestEdge(piece.points, piece.closed, point);
    if (!near || near.dist > threshold) continue;
    const n = piece.points.length;
    const from = piece.points[near.edgeIndex];
    const to = piece.points[(near.edgeIndex + 1) % n];
    const hit: EdgeParamHit = {
      pieceId: piece.id,
      fromPointId: from.id,
      toPointId: to.id,
      t: near.t,
    };
    const seam = findSeamThroughEdge(seams, hit);
    if (!seam) continue;
    // Missing the span is a near-miss, not a different seam: rank it behind any
    // seam that actually covers the point, but ahead of a farther edge.
    const score = seamCoversEdge(seam, hit) ? near.dist : near.dist + threshold;
    if (!best || score < best.score) best = { seam, score };
  }

  return best?.seam ?? null;
}
