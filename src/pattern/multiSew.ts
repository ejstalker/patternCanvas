import type { PatternPiece, SeamEdgeRef } from '../project/types';
import { sampleEdgeByPointIds } from './geometry';

export type MultiSewPair = {
  a: SeamEdgeRef;
  b: SeamEdgeRef;
};

function edgeLength(piece: PatternPiece, edge: SeamEdgeRef): number {
  const points = sampleEdgeByPointIds(piece, edge.fromPointId, edge.toPointId, 32);
  if (!points || points.length < 2) return 0;
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

type Span = {
  edge: SeamEdgeRef;
  from: number;
  to: number;
};

function normalizedSpans(edges: SeamEdgeRef[], pieces: PatternPiece[]): Span[] {
  const byId = new Map(pieces.map((piece) => [piece.id, piece]));
  const measured = edges.flatMap((edge) => {
    const piece = byId.get(edge.pieceId);
    if (!piece) return [];
    const length = edgeLength(piece, edge);
    return Number.isFinite(length) && length > 1e-6 ? [{ edge, length }] : [];
  });
  const total = measured.reduce((sum, item) => sum + item.length, 0);
  if (total <= 1e-6) return [];

  let cursor = 0;
  return measured.map((item) => {
    const from = cursor / total;
    cursor += item.length;
    return { edge: item.edge, from, to: cursor / total };
  });
}

function localT(span: Span, normalizedT: number): number {
  const ratio = (normalizedT - span.from) / (span.to - span.from);
  return span.edge.t0 + (span.edge.t1 - span.edge.t0) * ratio;
}

/**
 * Match two ordered edge groups by cumulative arc length.
 * Unequal edge counts are split into fractional seam ranges so the complete
 * source boundary maps continuously to the complete target boundary.
 */
export function buildManyToManySeams(
  source: SeamEdgeRef[],
  target: SeamEdgeRef[],
  pieces: PatternPiece[]
): MultiSewPair[] {
  const aSpans = normalizedSpans(source, pieces);
  const bSpans = normalizedSpans(target, pieces);
  const pairs: MultiSewPair[] = [];
  let ai = 0;
  let bi = 0;

  while (ai < aSpans.length && bi < bSpans.length) {
    const a = aSpans[ai];
    const b = bSpans[bi];
    const overlapFrom = Math.max(a.from, b.from);
    const overlapTo = Math.min(a.to, b.to);

    if (overlapTo - overlapFrom > 1e-8) {
      pairs.push({
        a: {
          ...a.edge,
          t0: localT(a, overlapFrom),
          t1: localT(a, overlapTo),
        },
        b: {
          ...b.edge,
          t0: localT(b, overlapFrom),
          t1: localT(b, overlapTo),
        },
      });
    }

    if (a.to <= b.to + 1e-8) ai += 1;
    if (b.to <= a.to + 1e-8) bi += 1;
  }

  return pairs;
}
