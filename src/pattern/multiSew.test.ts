import { describe, expect, it } from 'vitest';
import type { PatternPiece, SeamEdgeRef } from '../project/types';
import { buildManyToManySeams } from './multiSew';

function rectangle(id: string, x: number, width: number, height: number): PatternPiece {
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

function edge(pieceId: string, from: number, to: number): SeamEdgeRef {
  return {
    pieceId,
    fromPointId: `${pieceId}-${from}`,
    toPointId: `${pieceId}-${to}`,
    t0: 0,
    t1: 1,
  };
}

describe('buildManyToManySeams', () => {
  it('maps two source edges onto one target edge by arc length', () => {
    const sourcePiece = rectangle('source', 0, 10, 10);
    const targetPiece = rectangle('target', 20, 20, 10);
    const result = buildManyToManySeams(
      [edge('source', 0, 1), edge('source', 1, 2)],
      [edge('target', 0, 1)],
      [sourcePiece, targetPiece]
    );

    expect(result).toHaveLength(2);
    expect(result[0].a.t0).toBeCloseTo(0);
    expect(result[0].a.t1).toBeCloseTo(1);
    expect(result[0].b.t0).toBeCloseTo(0);
    expect(result[0].b.t1).toBeCloseTo(0.5);
    expect(result[1].b.t0).toBeCloseTo(0.5);
    expect(result[1].b.t1).toBeCloseTo(1);
  });

  it('honors reversed edge direction', () => {
    const a = rectangle('a', 0, 10, 10);
    const b = rectangle('b', 20, 10, 10);
    const reversed = { ...edge('b', 0, 1), t0: 1, t1: 0 };
    const result = buildManyToManySeams([edge('a', 0, 1)], [reversed], [a, b]);

    expect(result[0].b.t0).toBeCloseTo(1);
    expect(result[0].b.t1).toBeCloseTo(0);
  });
});
