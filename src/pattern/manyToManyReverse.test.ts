import { describe, expect, it } from 'vitest';
import type { PatternDocument, PatternPiece, SeamBinding, SeamEdgeRef } from '../project/types';
import {
  DEFAULT_MESH_SETTINGS,
  resolveSeamParticlePairs,
  triangulatePattern,
} from '../mesh/triangulate';
import { buildManyToManySeams } from './multiSew';

/**
 * What a many-to-many sew really leaves behind, and what reversing one of its
 * seams does to the stitches.
 *
 * The case: a 20 cm edge on a long panel, sewn to two 10 cm edges on a short one.
 * The operation splits the long edge in half to match, so the result is **two
 * seams on one edge**, `[0, 0.5]` and `[0.5, 1]`. Everything below follows from
 * that: a seam cannot be identified by its edge, and reversing one must not
 * disturb its neighbour.
 */

function panel(id: string, x: number, width: number, height = 10): PatternPiece {
  return {
    id,
    name: id,
    closed: true,
    points: [
      { id: `${id}-0`, anchor: { x, y: 0 }, handleIn: null, handleOut: null },
      { id: `${id}-1`, anchor: { x: x + width, y: 0 }, handleIn: null, handleOut: null },
      { id: `${id}-2`, anchor: { x: x + width, y: height }, handleIn: null, handleOut: null },
      { id: `${id}-3`, anchor: { x, y: height }, handleIn: null, handleOut: null },
    ],
  };
}

const long = panel('long', 0, 20);
const short = panel('short', 30, 10);

const edge = (pieceId: string, from: number, to: number): SeamEdgeRef => ({
  pieceId,
  fromPointId: `${pieceId}-${from}`,
  toPointId: `${pieceId}-${to}`,
  t0: 0,
  t1: 1,
});

/** The 20 cm edge against both 10 cm edges, in the order they were clicked. */
const sew = (overrides: Partial<SeamBinding>[] = []): SeamBinding[] =>
  buildManyToManySeams(
    [edge('long', 0, 1)],
    [edge('short', 0, 1), edge('short', 1, 2)],
    [long, short]
  ).map((pair, i) => ({
    id: `seam-${i}`,
    a: { ...pair.a, ...(overrides[i]?.a ?? {}) },
    b: { ...pair.b, ...(overrides[i]?.b ?? {}) },
    restGapCm: 0.15,
  }));

type Pairing = { longT: number; shortT: number };

/**
 * Where each resolved stitch sits, per seam.
 *
 * The two seams are told apart by which half of the long edge they are in, not
 * by which short edge the partner is on: the corner where the short panel's two
 * edges meet is sampled once and claimed by *both* seams, so its position cannot
 * say which seam a stitch belongs to.
 */
function pairings(seams: SeamBinding[], pieces: PatternPiece[]): { top: Pairing[]; right: Pairing[] } {
  const pattern: PatternDocument = { id: 'p', pieces, seams } as unknown as PatternDocument;
  const mesh = triangulatePattern(pattern, DEFAULT_MESH_SETTINGS);
  const at = (i: number) => mesh.vertices[i];
  const top: Pairing[] = [];
  const right: Pairing[] = [];

  for (const { a, b } of resolveSeamParticlePairs(pattern, mesh)) {
    const pa = at(a);
    const pb = at(b);
    // One end is on the long panel, the other on the short one.
    const [onLong, onShort] = pa.x <= 20 ? [pa, pb] : [pb, pa];
    if (onLong.x > 20 || onShort.x < 30) continue;
    const longT = onLong.x / 20;
    // The shared vertex at the split belongs to both seams; leave it out.
    if (longT < 0.5 - 1e-6) top.push({ longT, shortT: (onShort.x - 30) / 10 });
    else if (longT > 0.5 + 1e-6) right.push({ longT, shortT: onShort.y / 10 });
  }
  return { top, right };
}

const byLongT = (rows: Pairing[]) => [...rows].sort((a, b) => a.longT - b.longT);

describe('reversing a seam that many-to-many sewing made', () => {
  const pieces = [long, short];

  it('splits the long edge in half, so two seams share one edge', () => {
    const seams = sew();
    expect(seams).toHaveLength(2);
    expect(seams[0].a).toMatchObject({ pieceId: 'long', t0: 0, t1: 0.5 });
    expect(seams[1].a).toMatchObject({ pieceId: 'long', t0: 0.5, t1: 1 });
    // Both seams name the same piece edge on that side — the reason a seam has
    // to be identified by its span and not by its edge.
    expect(seams[0].a.fromPointId).toBe(seams[1].a.fromPointId);
    expect(seams[0].a.toPointId).toBe(seams[1].a.toPointId);
  });

  it('stitches like ends to like ends', () => {
    const { top } = pairings(sew(), pieces);
    const ordered = byLongT(top);
    expect(ordered.length).toBeGreaterThan(1);
    // Walking the long edge, the partner on the short one advances with it.
    expect(ordered[0].shortT).toBeLessThan(ordered[ordered.length - 1].shortT);
    // And the seam sits in its own half of the long edge.
    expect(ordered[0].longT).toBeLessThan(0.5);
    expect(ordered[ordered.length - 1].longT).toBeLessThanOrEqual(0.5);
  });

  it('flips the reversed seam and leaves its neighbour alone', () => {
    const before = pairings(sew(), pieces);
    // Reverse the first seam's short side only.
    const reversed = sew([{ b: { ...edge('short', 0, 1), t0: 1, t1: 0 } }]);
    const after = pairings(reversed, pieces);

    const topBefore = byLongT(before.top);
    const topAfter = byLongT(after.top);
    expect(topBefore[0].shortT).toBeLessThan(topBefore[topBefore.length - 1].shortT);
    expect(topAfter[0].shortT).toBeGreaterThan(topAfter[topAfter.length - 1].shortT);

    // The second seam, in the other half against the short panel's other edge,
    // is untouched.
    const rightBefore = byLongT(before.right);
    const rightAfter = byLongT(after.right);
    expect(rightBefore[0].shortT).toBeLessThan(rightBefore[rightBefore.length - 1].shortT);
    expect(rightAfter[0].shortT).toBeLessThan(rightAfter[rightAfter.length - 1].shortT);
  });

  it('does not need a remesh: the spans, not the direction, set the sampling', () => {
    const straight = sew();
    const reversed = sew([{ b: { ...edge('short', 0, 1), t0: 1, t1: 0 } }]);
    const meshOf = (seams: SeamBinding[]) =>
      triangulatePattern({ id: 'p', pieces, seams } as unknown as PatternDocument, DEFAULT_MESH_SETTINGS);
    // Same vertices, same triangles — only the pairing code sees the difference.
    expect(meshOf(reversed).vertices.length).toBe(meshOf(straight).vertices.length);
    expect(meshOf(reversed).triangles.length).toBe(meshOf(straight).triangles.length);
  });

  it('samples only one seam per edge to the agreed count (known gap)', () => {
    // `buildSeamEdgePlans` keys its plan by *edge*, so of the two seams sharing
    // the long edge only the last one keeps its agreed sample count; the other
    // span falls back to ordinary boundary spacing. With the default 2 cm
    // spacing that is invisible, because 10 cm divides into 5 steps and the two
    // sides happen to come out level. At 3 cm they do not:
    const settings = { ...DEFAULT_MESH_SETTINGS, boundarySpacingCm: 3 };
    const seams = sew();
    const pattern = { id: 'p', pieces, seams } as unknown as PatternDocument;
    const mesh = triangulatePattern(pattern, settings);

    /** Boundary samples on one edge of one piece, tagged inside a span. */
    const samplesIn = (
      pieceId: string,
      fromPointId: string,
      toPointId: string,
      lo: number,
      hi: number
    ) =>
      (mesh.boundary ?? []).filter(
        (tag) =>
          !!tag &&
          tag.pieceId === pieceId &&
          tag.fromPointId === fromPointId &&
          tag.toPointId === toPointId &&
          tag.t >= lo - 1e-6 &&
          tag.t <= hi + 1e-6
      ).length;

    const agreed = samplesIn('short', 'short-0', 'short-1', 0, 1);
    expect(agreed).toBeGreaterThan(2);
    // The first seam's two sides should be sampled alike. They are not: the long
    // side carries the shoulder spacing, the short side the agreed count.
    expect(samplesIn('long', 'long-0', 'long-1', 0, 0.5)).not.toBe(agreed);
    // The seam that won the plan is exact.
    expect(samplesIn('long', 'long-0', 'long-1', 0.5, 1)).toBe(agreed);
  });
});
