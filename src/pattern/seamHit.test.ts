import { describe, expect, it } from 'vitest';
import type { PatternPiece, SeamBinding, SeamEdgeRef } from '../project/types';
import { findSeamNearPoint, findSeamThroughEdge, reverseSeamsAcrossEdge, seamCoversEdge } from './seamHit';

/**
 * A long panel and a short one, with the long one's edge sewn to both of the
 * short one's — exactly the shape a many-to-many sew leaves behind: two seams
 * sharing a single edge, side by side.
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
const pieces = [long, short];

const ref = (
  pieceId: string,
  from: number,
  to: number,
  t0 = 0,
  t1 = 1
): SeamEdgeRef => ({
  pieceId,
  fromPointId: `${pieceId}-${from}`,
  toPointId: `${pieceId}-${to}`,
  t0,
  t1,
});

/** `long-0 > long-1` (20 cm) split in half against the short panel's top edge. */
const firstHalf: SeamBinding = {
  id: 'seam-first',
  a: ref('long', 0, 1, 0, 0.5),
  b: ref('short', 0, 1),
  restGapCm: 0.15,
};
const secondHalf: SeamBinding = {
  id: 'seam-second',
  a: ref('long', 0, 1, 0.5, 1),
  b: ref('short', 0, 1),
  restGapCm: 0.15,
};
const seams = [firstHalf, secondHalf];

const onLongEdge = (t: number) => ({
  pieceId: 'long',
  fromPointId: 'long-0',
  toPointId: 'long-1',
  t,
});

describe('finding the seam a pointer is on', () => {
  it('tells two seams sharing one edge apart by where the pointer is', () => {
    expect(findSeamThroughEdge(seams, onLongEdge(0.1))).toBe(firstHalf);
    expect(findSeamThroughEdge(seams, onLongEdge(0.9))).toBe(secondHalf);
    // The boundary between them belongs to both; either answer is defensible, but
    // it must be one of them and never something else.
    expect([firstHalf, secondHalf]).toContain(findSeamThroughEdge(seams, onLongEdge(0.5)));
  });

  it('reports coverage separately from the answer', () => {
    expect(seamCoversEdge(firstHalf, onLongEdge(0.25))).toBe(true);
    expect(seamCoversEdge(firstHalf, onLongEdge(0.75))).toBe(false);
  });

  it('falls back to the nearest span when the pointer is outside them all', () => {
    const partial: SeamBinding = {
      id: 'partial',
      a: ref('long', 0, 1, 0.2, 0.4),
      b: ref('short', 0, 1),
      restGapCm: 0.15,
    };
    const hit = onLongEdge(0.9);
    expect(findSeamThroughEdge([partial], hit)).toBe(partial);
    expect(seamCoversEdge(partial, hit)).toBe(false);
  });

  it('prefers the narrower span when spans overlap', () => {
    const wide: SeamBinding = {
      id: 'wide',
      a: ref('long', 0, 1, 0, 1),
      b: ref('short', 0, 1),
      restGapCm: 0.15,
    };
    const narrow: SeamBinding = {
      id: 'narrow',
      a: ref('long', 0, 1, 0.4, 0.6),
      b: ref('short', 0, 1),
      restGapCm: 0.15,
    };
    expect(findSeamThroughEdge([wide, narrow], onLongEdge(0.5))).toBe(narrow);
    // Outside the narrow span, the wide one is the only thing there.
    expect(findSeamThroughEdge([wide, narrow], onLongEdge(0.05))).toBe(wide);
  });

  it('ignores a seam on a different edge of the same piece', () => {
    const other: SeamBinding = {
      id: 'other',
      a: ref('long', 1, 2, 0, 1),
      b: ref('short', 0, 1),
      restGapCm: 0.15,
    };
    expect(findSeamThroughEdge([other], onLongEdge(0.5))).toBeNull();
  });

  it('finds the right seam from a pattern-space point', () => {
    // Along the long panel's top edge, which runs x = 0 → 20: the whole seam
    // sits on one edge, so only the position along it can choose.
    const near = findSeamNearPoint(seams, pieces, { x: 2, y: 0 }, 2);
    expect(near).toBe(firstHalf);
    const far = findSeamNearPoint(seams, pieces, { x: 18, y: 0 }, 2);
    expect(far).toBe(secondHalf);
    // Nowhere near any edge.
    expect(findSeamNearPoint(seams, pieces, { x: 15, y: 40 }, 2)).toBeNull();
  });

  it('does not pick a seam up from a piece that has none there', () => {
    expect(findSeamNearPoint(seams, pieces, { x: 35, y: 10 }, 2)).toBeNull();
  });
});

describe('reversing the order of the seams sharing an edge', () => {
  /** The shared edge split in half, each half sewn to a *different* short edge. */
  const fan: SeamBinding[] = [
    { id: 'first', a: ref('long', 0, 1, 0, 0.5), b: ref('short', 0, 1), restGapCm: 0.15 },
    { id: 'second', a: ref('long', 0, 1, 0.5, 1), b: ref('short', 1, 2), restGapCm: 0.15 },
  ];

  it('hands the partners round in reverse and leaves every span where it was', () => {
    const reversed = reverseSeamsAcrossEdge(fan, onLongEdge(0.25))!;
    expect(reversed).toHaveLength(2);
    // The spans still say which part of the shared edge each seam covers...
    expect(reversed.map((s) => s.a)).toEqual(fan.map((s) => s.a));
    // ...and the partners have swapped: the first span now takes the last one.
    expect(reversed[0].b).toEqual(fan[1].b);
    expect(reversed[1].b).toEqual(fan[0].b);
    // Identity and fit survive, so the seams stay the same seams.
    expect(reversed.map((s) => s.id)).toEqual(['first', 'second']);
    expect(reversed.map((s) => s.restGapCm)).toEqual([0.15, 0.15]);
  });

  it('leaves the originals alone', () => {
    reverseSeamsAcrossEdge(fan, onLongEdge(0.25));
    expect(fan[0].b.fromPointId).toBe('short-0');
    expect(fan[1].b.fromPointId).toBe('short-1');
  });

  it('reverses to exactly what it started from when applied twice', () => {
    const once = reverseSeamsAcrossEdge(fan, onLongEdge(0.25))!;
    const twice = reverseSeamsAcrossEdge(once, onLongEdge(0.25))!;
    expect(twice).toEqual(fan);
  });

  it('orders by where the seams sit on the edge, not by their order in the list', () => {
    const reversed = reverseSeamsAcrossEdge([...fan].reverse(), onLongEdge(0.25))!;
    expect(reversed.map((s) => s.id)).toEqual(['first', 'second']);
    expect(reversed[0].b).toEqual(fan[1].b);
  });

  it('rewrites whichever side of the seam sits on the edge', () => {
    // The same fan, handed over with the shared edge on side B.
    const mirrored: SeamBinding[] = fan.map((seam, i) => ({
      ...seam,
      id: `mirror-${i}`,
      a: seam.b,
      b: seam.a,
    }));
    const reversed = reverseSeamsAcrossEdge(mirrored, onLongEdge(0.25))!;
    expect(reversed[0].a).toEqual(mirrored[1].a);
    expect(reversed[1].a).toEqual(mirrored[0].a);
    expect(reversed.map((s) => s.b)).toEqual(mirrored.map((s) => s.b));
  });

  it('has nothing to reorder for a single seam on the edge', () => {
    expect(reverseSeamsAcrossEdge([fan[0]], onLongEdge(0.25))).toBeNull();
    // Nor for a seam on some other edge, or between two spans of this one.
    const elsewhere = { ...fan[0], id: 'other', a: ref('short', 0, 1) };
    expect(reverseSeamsAcrossEdge([fan[1], elsewhere], onLongEdge(0.25))).toBeNull();
    const selfSeam: SeamBinding = {
      id: 'self',
      a: ref('long', 0, 1, 0, 0.5),
      b: ref('long', 0, 1, 0.5, 1),
      restGapCm: 0.15,
    };
    expect(reverseSeamsAcrossEdge([selfSeam, fan[0]], onLongEdge(0.25))).toBeNull();
  });

  it('ignores a seam that only touches the edge in the other direction', () => {
    // long-1 → long-0 is the same segment walked backwards; ids decide, so it
    // is not part of this run.
    const backwards: SeamBinding = {
      id: 'backwards',
      a: ref('long', 1, 0, 0, 0.5),
      b: ref('short', 0, 1),
      restGapCm: 0.15,
    };
    expect(reverseSeamsAcrossEdge([fan[0], backwards], onLongEdge(0.25))).toBeNull();
  });
});
