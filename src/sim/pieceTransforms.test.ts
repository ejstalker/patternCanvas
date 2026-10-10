import { describe, expect, it } from 'vitest';
import type { ClothSimulator } from './ClothSimulator';
import type { PieceTransform3d } from '../project/types';
import { arrangementBelongsTo, keepPieceTransforms, recordPieceSuccessors } from './pieceTransforms';

function stubCloth(centroids: Record<string, [number, number, number]>): ClothSimulator {
  return {
    getPieceCentroidTuple: (id: string) => centroids[id] ?? [0, 0, 0],
  } as unknown as ClothSimulator;
}

function t(x: number, y = 0, z = 0, rotX = 0): PieceTransform3d {
  return { position: [x, y, z], rotationDeg: [rotX, 0, 0] };
}

describe('keepPieceTransforms', () => {
  it('keeps every piece when ids are unchanged (remesh)', () => {
    const saved = { A: t(1), B: t(2, 0, 0, 45) };
    const kept = keepPieceTransforms(saved, ['A', 'B'], stubCloth({}));
    expect(kept).toEqual(saved);
    expect(kept.A).not.toBe(saved.A); // cloned, not aliased
  });

  it('drops only the deleted piece and leaves the others untouched', () => {
    const saved = { A: t(1), B: t(2), C: t(3, 0, 0, -90) };
    const kept = keepPieceTransforms(saved, ['A', 'C'], stubCloth({}));
    expect(Object.keys(kept).sort()).toEqual(['A', 'C']);
    expect(kept.A).toEqual(t(1));
    expect(kept.C).toEqual(t(3, 0, 0, -90));
  });

  it('leaves newly added pieces without a transform (they take the default)', () => {
    const saved = { A: t(5) };
    const kept = keepPieceTransforms(saved, ['A', 'NEW'], stubCloth({}));
    expect(kept.A).toEqual(t(5));
    expect(kept.NEW).toBeUndefined();
  });

  it('carries the arrangement onto another pattern, piece for piece in order', () => {
    // The node was duplicated with its arrangement and a different pattern
    // plugged in, so no id survives: the first piece of the new pattern takes the
    // first piece's placement and the rest follow.
    const saved = { A: t(1, 0, 0, 15), B: t(2, 0, 0, 30) };
    const kept = keepPieceTransforms(saved, ['X', 'Y'], stubCloth({}));
    expect(kept.X).toEqual(saved.A);
    expect(kept.Y).toEqual(saved.B);
    expect(kept.X).not.toBe(saved.A);
  });

  it('pairs as far as the shorter of the two patterns goes', () => {
    const saved = { A: t(1), B: t(2), C: t(3) };
    const kept = keepPieceTransforms(saved, ['X', 'Y'], stubCloth({}));
    expect(Object.keys(kept)).toEqual(['X', 'Y']);
    expect(kept.X.position).toEqual([1, 0, 0]);
    expect(kept.Y.position).toEqual([2, 0, 0]);
  });

  it('does not pair by order while any id still matches', () => {
    // Same pattern, one piece deleted and another added: the newcomer keeps its
    // laid-out position rather than inheriting the deleted piece's.
    const saved = { A: t(1), GONE: t(2) };
    const kept = keepPieceTransforms(saved, ['A', 'NEW'], stubCloth({}));
    expect(kept.A).toEqual(t(1));
    expect(kept.NEW).toBeUndefined();
  });

  it('does not pair an arrangement onto a cloth with no pieces of its own', () => {
    // A mesh predating per-vertex ownership has no piece ids to line anything up
    // with, so the arrangement must not land on its `__cloth__` entry.
    const saved = { A: t(1), B: t(2) };
    const kept = keepPieceTransforms(saved, ['__cloth__'], stubCloth({}));
    expect(kept).toEqual({});
  });

  it('leaves a legacy whole-cloth entry to be distributed rather than paired', () => {
    const saved = { __cloth__: t(7) };
    const cloth = stubCloth({ A: [0, 0, 0], B: [2, 0, 0] });
    const kept = keepPieceTransforms(saved, ['A', 'B'], cloth);
    expect(kept.A.position).toEqual([6, 0, 0]);
    expect(kept.B.position).toEqual([8, 0, 0]);
  });

  it('hands a replaced piece orientation to its successors, at their own layout positions', () => {
    const saved = { PARENT: t(9, 1, 2, 30) };
    const cloth = stubCloth({ A: [100, 0, 0], B: [200, 0, 0] });
    const kept = keepPieceTransforms(saved, ['A', 'B'], cloth, { PARENT: ['A', 'B'] });
    expect(kept.PARENT).toBeUndefined();
    expect(kept.A.position).toEqual([100, 0, 0]);
    expect(kept.B.position).toEqual([200, 0, 0]);
    expect(kept.A.rotationDeg).toEqual([30, 0, 0]);
    expect(kept.B.rotationDeg).toEqual([30, 0, 0]);
  });

  it('migrates a legacy whole-cloth transform onto a single piece', () => {
    const saved = { __cloth__: t(4, 5, 6, 90) };
    const kept = keepPieceTransforms(saved, ['A'], stubCloth({}));
    expect(kept.A).toEqual({ position: [4, 5, 6], rotationDeg: [90, 0, 0], rotationQuat: undefined });
  });

  it('distributes a legacy whole-cloth transform across several pieces', () => {
    const saved = { __cloth__: t(10, 0, 0, 0) };
    const cloth = stubCloth({ A: [0, 0, 0], B: [2, 0, 0] });
    const kept = keepPieceTransforms(saved, ['A', 'B'], cloth);
    expect(kept.A.position).toEqual([9, 0, 0]);
    expect(kept.B.position).toEqual([11, 0, 0]);
  });

  it('prefers real piece ids over a legacy whole-cloth entry', () => {
    const saved = { A: t(1), __cloth__: t(99) };
    const kept = keepPieceTransforms(saved, ['A'], stubCloth({}));
    expect(kept.A).toEqual(t(1));
  });
});

describe('arrangementBelongsTo', () => {
  it('recognises an arrangement whose pieces are still on the cloth', () => {
    expect(arrangementBelongsTo({ A: t(1), B: t(2) }, ['A', 'B'])).toBe(true);
    expect(arrangementBelongsTo({ A: t(1) }, ['A', 'NEW'])).toBe(true);
  });

  it('turns down another pattern’s arrangement', () => {
    expect(arrangementBelongsTo({ A: t(1), B: t(2) }, ['X', 'Y'])).toBe(false);
  });

  it('has nothing to match on for a legacy whole-cloth entry', () => {
    expect(arrangementBelongsTo({ __cloth__: t(1) }, ['X'])).toBe(true);
    expect(arrangementBelongsTo({}, ['X'])).toBe(true);
  });
});

describe('recordPieceSuccessors', () => {
  it('records lineage without mutating the input', () => {
    const before = { OLD: ['X'] };
    const after = recordPieceSuccessors(before, 'P', ['A', 'B']);
    expect(after).toEqual({ OLD: ['X'], P: ['A', 'B'] });
    expect(before).toEqual({ OLD: ['X'] });
  });

  it('de-duplicates children and ignores self-replacement', () => {
    expect(recordPieceSuccessors(undefined, 'P', ['A', 'A', 'P'])).toEqual({ P: ['A'] });
  });
});
