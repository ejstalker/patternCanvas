/**
 * Bridging two pieces along a pair of edges.
 *
 * The interesting questions are: does the rammed outline really span both
 * pieces and the area between them, are both outlines left exactly where they
 * were, do the two straight edges land at the runs' ends, and is a bridge that
 * could only be drawn by doubling the outline back refused rather than handed
 * over as a shape nothing can be cut from.
 */
import { describe, expect, it } from 'vitest';
import { bridgePieces } from './bridge';
import type { BezierPoint, PatternPiece, SeamEdgeRef, Vec2 } from '../project/types';

function makePiece(id: string, name: string, anchors: Vec2[]): PatternPiece {
  const points: BezierPoint[] = anchors.map((anchor, i) => ({
    id: `${id}p${i}`,
    anchor: { ...anchor },
    handleIn: null,
    handleOut: null,
    handlesParallel: false,
  }));
  return { id, name, closed: true, points };
}

const edge = (piece: PatternPiece, index: number): SeamEdgeRef => ({
  pieceId: piece.id,
  fromPointId: piece.points[index].id,
  toPointId: piece.points[(index + 1) % piece.points.length].id,
  t0: 0,
  t1: 1,
});

const anchors = (piece: PatternPiece): Vec2[] => piece.points.map((p) => p.anchor);

const signedArea = (piece: PatternPiece): number => {
  const points = piece.points.map((p) => p.anchor);
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
};

/** A 40 × 50 panel. Two of these, 20 cm apart, span 100 × 50. */
const panel = (id: string, left: number): PatternPiece =>
  makePiece(id, id, [
    { x: left, y: 5 },
    { x: left + 40, y: 5 },
    { x: left + 40, y: 55 },
    { x: left, y: 55 },
  ]);

describe('bridging pieces', () => {
  it('spans the two pieces and the gap between them', () => {
    const left = panel('a', 5);
    const right = panel('b', 65);
    // The left panel's right edge, the right panel's left edge — the facing pair.
    const result = bridgePieces(left, [edge(left, 1)], right, [edge(right, 3)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Left panel's outline up to its run, the bottom bridge, the right panel's
    // outline, the top bridge: a 100 × 50 rectangle with the two joints left as
    // the corners they are.
    expect(anchors(result.piece)).toEqual([
      { x: 45, y: 55 },
      { x: 5, y: 55 },
      { x: 5, y: 5 },
      { x: 45, y: 5 },
      { x: 65, y: 5 },
      { x: 105, y: 5 },
      { x: 105, y: 55 },
      { x: 65, y: 55 },
    ]);
    expect(signedArea(result.piece)).toBeCloseTo(5000, 6);
    expect(result.piece.name).toBe('b');
    expect(result.bridgedPieceId).toBe('a');
  });

  it('leaves both outlines exactly where they were', () => {
    const left = panel('a', 5);
    const right = panel('b', 65);
    const before = { a: anchors(left), b: anchors(right) };
    const result = bridgePieces(left, [edge(left, 1)], right, [edge(right, 3)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nothing moved, nothing was scaled: every anchor of both pieces is in the
    // bridged outline at the same spot it was drafted at.
    expect(anchors(left)).toEqual(before.a);
    expect(anchors(right)).toEqual(before.b);
    for (const anchor of [...before.a, ...before.b]) {
      expect(anchors(result.piece).some((p) => p.x === anchor.x && p.y === anchor.y)).toBe(true);
    }
    expect(result.piece.points.every((p) => p.handleIn === null && p.handleOut === null)).toBe(true);
  });

  it('bridges the halves a knife left to make the panel they were cut from', () => {
    const lower = makePiece('l', 'l', [
      { x: 5, y: 5 },
      { x: 45, y: 5 },
      { x: 45, y: 30 },
      { x: 45, y: 55 },
      { x: 5, y: 55 },
    ]);
    const upper = makePiece('u', 'u', [
      { x: 45, y: 5 },
      { x: 85, y: 5 },
      { x: 85, y: 55 },
      { x: 45, y: 55 },
      { x: 45, y: 30 },
    ]);
    const result = bridgePieces(lower, [edge(lower, 1), edge(lower, 2)], upper, [
      edge(upper, 3),
      edge(upper, 4),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The joints sit on top of one another, so they come out as one vertex each
    // and the split vertex on the shared edge is consumed: the panel, six points.
    expect(anchors(result.piece)).toEqual([
      { x: 45, y: 55 },
      { x: 5, y: 55 },
      { x: 5, y: 5 },
      { x: 45, y: 5 },
      { x: 85, y: 5 },
      { x: 85, y: 55 },
    ]);
    expect(signedArea(result.piece)).toBeCloseTo(4000, 6);
    // A seam that named a folded-away joint is read at the point it became.
    expect(result.idAliases.up0).toBe('lp1');
    expect(result.idAliases.up3).toBe('lp3');
  });

  it('bridges a run of edges onto a run of a different length', () => {
    const left = makePiece('a', 'a', [
      { x: 5, y: 5 },
      { x: 45, y: 5 },
      { x: 45, y: 30 },
      { x: 45, y: 55 },
      { x: 5, y: 55 },
    ]);
    const right = makePiece('b', 'b', [
      { x: 65, y: 5 },
      { x: 105, y: 5 },
      { x: 105, y: 55 },
      { x: 65, y: 55 },
      { x: 65, y: 35 },
    ]);
    const result = bridgePieces(left, [edge(left, 1), edge(left, 2)], right, [
      edge(right, 3),
      edge(right, 4),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(signedArea(result.piece)).toBeCloseTo(5000, 6);
    // Both splits are interior now, so the outline runs from joint to joint.
    expect(anchors(result.piece)).toHaveLength(8);
    expect(anchors(result.piece).some((p) => p.x === 45 && p.y === 30)).toBe(false);
    expect(anchors(result.piece).some((p) => p.x === 65 && p.y === 35)).toBe(false);
  });

  it('reads the second piece either way round', () => {
    const left = panel('a', 5);
    // The same panel, wound the other way: the same bridge, the same outline.
    const right = makePiece('b', 'b', [
      { x: 65, y: 55 },
      { x: 105, y: 55 },
      { x: 105, y: 5 },
      { x: 65, y: 5 },
    ]);
    const result = bridgePieces(left, [edge(left, 1)], right, [edge(right, 3)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Same bridge, same outline, down to the order the points come out in.
    expect(anchors(result.piece)).toEqual([
      { x: 45, y: 55 },
      { x: 5, y: 55 },
      { x: 5, y: 5 },
      { x: 45, y: 5 },
      { x: 65, y: 5 },
      { x: 105, y: 5 },
      { x: 105, y: 55 },
      { x: 65, y: 55 },
    ]);
    expect(signedArea(result.piece)).toBeCloseTo(5000, 6);
  });

  it('bridges runs that turn a corner', () => {
    const left = panel('a', 5);
    const right = panel('b', 65);
    // The right panel's left and bottom: the run turns at its bottom-left.
    const result = bridgePieces(left, [edge(left, 1), edge(left, 2)], right, [
      edge(right, 3),
      edge(right, 0),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The left panel keeps its outline down to its bottom-right corner; the run
    // carried on round the right panel's corner, so the second bridge closes the
    // rectangle along the top.
    expect(anchors(result.piece)).toEqual([
      { x: 5, y: 55 },
      { x: 5, y: 5 },
      { x: 45, y: 5 },
      { x: 105, y: 5 },
      { x: 105, y: 55 },
      { x: 65, y: 55 },
    ]);
    expect(signedArea(result.piece)).toBeCloseTo(5000, 6);
  });

  it('carries the kept outlines’ handles through the joints', () => {
    const left: PatternPiece = {
      id: 'a',
      name: 'a',
      closed: true,
      points: [
        { id: 'ap0', anchor: { x: 5, y: 5 }, handleIn: null, handleOut: { x: 25, y: 5 }, handlesParallel: false },
        { id: 'ap1', anchor: { x: 45, y: 5 }, handleIn: { x: 25, y: 5 }, handleOut: null, handlesParallel: false },
        { id: 'ap2', anchor: { x: 45, y: 55 }, handleIn: null, handleOut: null, handlesParallel: false },
        { id: 'ap3', anchor: { x: 5, y: 55 }, handleIn: null, handleOut: null, handlesParallel: false },
      ],
    };
    const right = panel('b', 65);
    const result = bridgePieces(left, [edge(left, 2)], right, [edge(right, 3)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const curve = result.piece.points.find((p) => p.id === 'ap0');
    expect(curve?.handleOut).toEqual({ x: 25, y: 5 });
    // The bridge is a straight line, so the handles that used to run along the
    // picked edges are gone.
    for (const id of ['ap2', 'bp0', 'bp3']) {
      const joint = result.piece.points.find((p) => p.id === id);
      expect(joint).toBeDefined();
      expect(joint?.handleIn ?? null).toBe(null);
      expect(joint?.handleOut ?? null).toBe(null);
    }
  });

  it('keeps the second piece’s grainline and the first’s as a fallback', () => {
    const left = panel('a', 5);
    left.grainline = { from: { x: 25, y: 10 }, to: { x: 25, y: 50 } };
    const right = panel('b', 65);
    // Nothing else carries a grainline, so the first piece's is the one there is
    // to keep — it still runs through the bridged outline.
    const withFirst = bridgePieces(left, [edge(left, 1)], right, [edge(right, 3)]);
    expect(withFirst.ok).toBe(true);
    if (!withFirst.ok) return;
    expect(withFirst.piece.grainline).toEqual({ from: { x: 25, y: 10 }, to: { x: 25, y: 50 } });

    right.grainline = { from: { x: 85, y: 10 }, to: { x: 85, y: 50 } };
    const result = bridgePieces(left, [edge(left, 1)], right, [edge(right, 3)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.piece.grainline).toEqual({ from: { x: 85, y: 10 }, to: { x: 85, y: 50 } });
  });

  it('fills the bay between two runs of one piece', () => {
    // A V notch in the top of a panel: the two runs are its walls, so the bay
    // between them is the notch, and filling it gives the panel back.
    const notched = makePiece('a', 'a', [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 30 },
      { x: 0, y: 50 },
    ]);
    const result = bridgePieces(notched, [edge(notched, 2)], notched, [edge(notched, 3)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(anchors(result.piece)).toEqual([
      { x: 0, y: 50 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
    ]);
    expect(signedArea(result.piece)).toBeCloseTo(5000, 6);
    // The piece grew; there was no second piece to fold into it.
    expect(result.bridgedPieceId).toBe(null);
    expect(result.piece.id).toBe('a');
    expect(result.piece.name).toBe('a');
  });

  it('fills a rectangular notch, closing it with one straight edge', () => {
    const notched = makePiece('a', 'a', [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 70 },
      { x: 70, y: 70 },
      { x: 70, y: 40 },
      { x: 30, y: 40 },
      { x: 30, y: 70 },
      { x: 0, y: 70 },
    ]);
    expect(signedArea(notched)).toBeCloseTo(5800, 6);
    // The notch's two walls, on the same piece: the floor between them and the
    // walls themselves go interior, and the top is closed across.
    const result = bridgePieces(notched, [edge(notched, 3)], notched, [edge(notched, 5)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(anchors(result.piece)).toEqual([
      { x: 30, y: 70 },
      { x: 0, y: 70 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 70 },
      { x: 70, y: 70 },
    ]);
    expect(signedArea(result.piece)).toBeCloseTo(7000, 6);
    // The floor and both walls are gone from the outline.
    for (const gone of [
      { x: 70, y: 40 },
      { x: 30, y: 40 },
    ]) {
      expect(anchors(result.piece).some((p) => p.x === gone.x && p.y === gone.y)).toBe(false);
    }
  });

  it('fills between runs of several edges within one piece', () => {
    // The same notch, with both walls split in two, so each side is a run.
    const notched = makePiece('a', 'a', [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 70 },
      { x: 70, y: 70 },
      { x: 70, y: 55 },
      { x: 70, y: 40 },
      { x: 30, y: 40 },
      { x: 30, y: 55 },
      { x: 30, y: 70 },
      { x: 0, y: 70 },
    ]);
    const result = bridgePieces(
      notched,
      [edge(notched, 3), edge(notched, 4)],
      notched,
      [edge(notched, 6), edge(notched, 7)]
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(signedArea(result.piece)).toBeCloseTo(7000, 6);
    expect(anchors(result.piece)).toEqual([
      { x: 30, y: 70 },
      { x: 0, y: 70 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 70 },
      { x: 70, y: 70 },
    ]);
    expect(result.bridgedPieceId).toBe(null);
  });

  it('refuses runs of one piece with no bay between them', () => {
    const piece = panel('a', 5);
    // Bottom edge and top edge: the two "ways round" are the sides, so nothing
    // is enclosed between them.
    const result = bridgePieces(piece, [edge(piece, 0)], piece, [edge(piece, 2)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no bay|would cross/);
  });

  it('refuses runs of one piece that share an edge', () => {
    const piece = panel('a', 5);
    const result = bridgePieces(piece, [edge(piece, 0), edge(piece, 1)], piece, [edge(piece, 1)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/share an edge/);
  });

  it('refuses runs that face away from each other', () => {
    const left = panel('a', 5);
    const right = panel('b', 65);
    // Both runs on the far sides: the two bridges would have to cross.
    const result = bridgePieces(left, [edge(left, 1)], right, [edge(right, 1)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cross itself/);
  });

  it('refuses pieces that are already on top of each other', () => {
    const left = panel('a', 5);
    const over = panel('b', 25);
    const result = bridgePieces(left, [edge(left, 1)], over, [edge(over, 3)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cross itself/);
  });

  it('refuses picks that are not a single run of whole edges', () => {
    const left = panel('a', 5);
    const right = panel('b', 65);
    const acrossTwo = bridgePieces(
      left,
      [edge(left, 0), edge(right, 0)],
      right,
      [edge(right, 3)]
    );
    expect(acrossTwo.ok).toBe(false);
    if (!acrossTwo.ok) expect(acrossTwo.reason).toMatch(/on two pieces/);

    const opposite = bridgePieces(left, [edge(left, 0), edge(left, 2)], right, [edge(right, 3)]);
    expect(opposite.ok).toBe(false);
    if (!opposite.ok) expect(opposite.reason).toMatch(/next to each other/);
  });
});
