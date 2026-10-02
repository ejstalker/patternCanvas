import { describe, expect, it } from 'vitest';
import type { ClothSimulator } from './ClothSimulator';
import type { PieceTransform3d } from '../project/types';
import { keepPieceTransforms, recordPieceSuccessors } from './pieceTransforms';

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
