import { describe, expect, it } from 'vitest';
import type { SeamEdgeRef } from '../project/types';
import {
  sameSeamBindingPair,
  sameSeamSpan,
  sampleEdgeSpanByPointIds,
  seamReadsFromSecondHalf,
  seamRefFromHalf,
} from './geometry';

function edge(
  pieceId: string,
  from: string,
  to: string,
  t0 = 0,
  t1 = 1
): SeamEdgeRef {
  return { pieceId, fromPointId: from, toPointId: to, t0, t1 };
}

describe('seam span helpers', () => {
  it('distinguishes fractional spans on the same edge', () => {
    const full = edge('p', 'a', 'b', 0, 1);
    const half = edge('p', 'a', 'b', 0, 0.5);
    expect(sameSeamSpan(full, half)).toBe(false);
  });

  it('matches identical bindings regardless of side order', () => {
    const a1 = edge('p1', 'a', 'b', 0, 0.5);
    const b1 = edge('p2', 'c', 'd', 0.5, 1);
    const a2 = edge('p1', 'a', 'b', 0, 0.5);
    const b2 = edge('p2', 'c', 'd', 0.5, 1);
    expect(sameSeamBindingPair(a1, b1, a2, b2)).toBe(true);
    expect(sameSeamBindingPair(a1, b1, b2, a2)).toBe(true);
  });

  it('reads direction from the picked half', () => {
    // Near half → forward; far half → reversed.
    expect(seamRefFromHalf('p', 'a', 'b', 0.2)).toEqual(edge('p', 'a', 'b', 0, 1));
    expect(seamRefFromHalf('p', 'a', 'b', 0.8)).toEqual(edge('p', 'a', 'b', 1, 0));
    // Exactly the midpoint counts as the first half.
    expect(seamRefFromHalf('p', 'a', 'b', 0.5)).toEqual(edge('p', 'a', 'b', 0, 1));

    expect(seamReadsFromSecondHalf(seamRefFromHalf('p', 'a', 'b', 0.2))).toBe(false);
    expect(seamReadsFromSecondHalf(seamRefFromHalf('p', 'a', 'b', 0.8))).toBe(true);
  });

  it('samples only the requested parametric span', () => {
    const piece = {
      id: 'p',
      name: 'p',
      closed: false,
      points: [
        { id: 'a', anchor: { x: 0, y: 0 }, handleIn: null, handleOut: null },
        { id: 'b', anchor: { x: 10, y: 0 }, handleIn: null, handleOut: null },
      ],
    };
    const samples = sampleEdgeSpanByPointIds(piece, 'a', 'b', 0.25, 0.75, 8)!;
    expect(samples[0].x).toBeCloseTo(2.5);
    expect(samples[samples.length - 1].x).toBeCloseTo(7.5);
  });
});
