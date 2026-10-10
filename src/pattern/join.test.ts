/**
 * Fusing two pieces along a pair of edges.
 *
 * The interesting questions are: does the moved piece really land on the second
 * piece's edge, does it keep the second chain's length (the "scaling" half of the
 * operation), does a curved chain bend it rather than just tilt it, and are the
 * two outlines stitched into one ring without the pieces ending up on top of each
 * other.
 */
import { describe, expect, it } from 'vitest';
import { joinPieces, joinRunOf, type JoinOptions } from './join';
import { dist, edgeIndexForPointIds } from './geometry';
import type { BezierPoint, PatternPiece, SeamEdgeRef, Vec2 } from '../project/types';

/** A closed outline from the given anchors; `bow` curves the first edge with it. */
function makePiece(
  id: string,
  name: string,
  anchors: Vec2[],
  out?: Vec2,
  back?: Vec2
): PatternPiece {
  const points: BezierPoint[] = anchors.map((anchor, i) => ({
    id: `${id}p${i}`,
    anchor: { ...anchor },
    handleIn: i === 1 && back ? { ...back } : null,
    handleOut: i === 0 && out ? { ...out } : null,
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

/** A 10 × 10 square with its chain on the edge from corner 0 to corner 1. */
const square = (id: string, at: Vec2): PatternPiece =>
  makePiece(id, id, [
    { x: at.x, y: at.y },
    { x: at.x + 10, y: at.y },
    { x: at.x + 10, y: at.y + 10 },
    { x: at.x, y: at.y + 10 },
  ]);

/** The fuse that bends a piece onto the chain — what the tests below describe. */
const WARP: JoinOptions = { fit: 'warp' };

const anchors = (piece: PatternPiece): Vec2[] => piece.points.map((p) => ({ ...p.anchor }));
const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 1e3) / 1e3, y: Math.round(p.y * 1e3) / 1e3 });

describe('the run of edges a pick covers', () => {
  const targets = square('t', { x: 0, y: 0 });

  it('reads a run in the outline order the picks happen to be in', () => {
    const forwards = joinRunOf(targets, [edge(targets, 1), edge(targets, 2)]);
    const backwards = joinRunOf(targets, [edge(targets, 2), edge(targets, 1)]);
    expect(forwards.ok && backwards.ok).toBe(true);
    if (!forwards.ok || !backwards.ok) return;
    expect(forwards.run.vertexIndices).toEqual([1, 2, 3]);
    expect(backwards.run.vertexIndices).toEqual(forwards.run.vertexIndices);
  });

  it('refuses edges that are not next to each other', () => {
    const result = joinRunOf(targets, [edge(targets, 0), edge(targets, 2)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/next to each other/);
  });

  it('refuses a run that would take the whole outline', () => {
    const result = joinRunOf(targets, [0, 1, 2, 3].map((i) => edge(targets, i)));
    expect(result.ok).toBe(false);
  });

  it('refuses part of an edge', () => {
    const result = joinRunOf(targets, [{ ...edge(targets, 0), t0: 0, t1: 0.5 }]);
    expect(result.ok).toBe(false);
  });
});

describe('fusing pieces', () => {
  it('moves the first piece onto the second edge, ends aligned', () => {
    const moving = square('m', { x: 0, y: 0 });
    const base = square('b', { x: 40, y: 20 });
    const result = joinPieces(moving, [edge(moving, 0)], base, [edge(base, 0)], WARP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A 20 × 10 rectangle: the two squares side by side along y = 20, the base
    // below it and the moved square above it.
    expect(anchors(result.piece).map(round)).toEqual([
      { x: 50, y: 20 },
      { x: 50, y: 30 },
      { x: 40, y: 30 },
      { x: 40, y: 20 },
      { x: 40, y: 10 },
      { x: 50, y: 10 },
    ]);
    expect(signedArea(result.piece)).toBeCloseTo(200, 6);
    // The fused outline keeps the base's winding, which is what makes a face out
    // of it rather than a hole.
    expect(signedArea(result.piece)).toBeGreaterThan(0);
    expect(result.movingPieceId).toBe('m');
    expect(result.piece.id).toBe('b');
    expect(result.piece.name).toBe('b');
  });

  it('fuses two pieces of opposite handedness by walking one the other way', () => {
    const moving = makePiece('m', 'm', [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
    ]);
    expect(signedArea(moving)).toBeLessThan(0);
    const base = square('b', { x: 40, y: 20 });
    const result = joinPieces(moving, [edge(moving, 0)], base, [edge(base, 0)], WARP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(signedArea(result.piece)).toBeGreaterThan(0);
    expect(Math.abs(signedArea(result.piece))).toBeCloseTo(200, 6);
  });

  it('scales the first piece along the chain to the second chain’s length', () => {
    const moving = square('m', { x: 0, y: 0 });
    const base = makePiece('b', 'b', [
      { x: 40, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 30 },
      { x: 40, y: 30 },
    ]);
    const result = joinPieces(moving, [edge(moving, 0)], base, [edge(base, 0)], WARP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The chain doubled, so the moving square came out 20 wide and 10 deep.
    expect(anchors(result.piece).map(round)).toEqual([
      { x: 60, y: 20 },
      { x: 60, y: 30 },
      { x: 40, y: 30 },
      { x: 40, y: 20 },
      { x: 40, y: 10 },
      { x: 60, y: 10 },
    ]);
    expect(signedArea(result.piece)).toBeCloseTo(400, 6);
  });

  it('follows a curved second chain instead of just tilting the first piece', () => {
    // The base's chain from (40,20) to (60,20) bows away from the base, gently:
    // control points 3 cm out at each end.
    const base = makePiece(
      'b',
      'b',
      [
        { x: 40, y: 20 },
        { x: 60, y: 20 },
        { x: 60, y: 30 },
        { x: 40, y: 30 },
      ],
      { x: 47, y: 17 },
      { x: 53, y: 17 }
    );
    const moving = square('m', { x: 0, y: 0 });
    const result = joinPieces(moving, [edge(moving, 0)], base, [edge(base, 0)], WARP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const points = anchors(result.piece);

    // The moving chain's two ends landed exactly on the base chain's ends.
    expect(points[0]).toEqual({ x: 60, y: 20 });
    expect(points[3]).toEqual({ x: 40, y: 20 });

    // Each far corner kept its 10 cm depth, but measured against the chain's
    // *end* direction, so the two ends swing apart the way the chain bends.
    const depth = (far: Vec2, end: Vec2): number => Math.hypot(far.x - end.x, far.y - end.y);
    expect(depth(points[5], points[0])).toBeCloseTo(10, 1);
    expect(depth(points[4], points[3])).toBeCloseTo(10, 1);
    expect(Math.abs(points[5].x - points[4].x)).toBeGreaterThan(20);
  });

  it('fuses a run of two edges against a single edge, dropping the vertex between them', () => {
    const moving = makePiece('m', 'm', [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 0, y: 10 },
    ]);
    const base = makePiece('b', 'b', [
      { x: 40, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 40 },
      { x: 40, y: 40 },
    ]);
    const result = joinPieces(moving, [edge(moving, 0), edge(moving, 1)], base, [edge(base, 0)], WARP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 4 kept base corners + 2 kept moving corners: the vertex between the two
    // fused edges is gone.
    expect(result.piece.points).toHaveLength(6);
    expect(result.piece.points.some((p) => p.id === 'mp1')).toBe(false);
    expect(Math.abs(signedArea(result.piece))).toBeCloseTo(600, 0);
  });

  it('hands the dropped joint points over to the neighbours they became', () => {
    const moving = square('m', { x: 0, y: 0 });
    const base = square('b', { x: 40, y: 20 });
    const result = joinPieces(moving, [edge(moving, 0)], base, [edge(base, 0)], WARP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Both ends of the moving chain are now the base's corners.
    expect(result.idAliases['mp0']).toBe('bp1');
    expect(result.idAliases['mp1']).toBe('bp0');
    // A seam along the moving piece's kept edge is still an edge of the fused
    // piece once its end point is followed through the alias.
    const from = result.idAliases['mp1'] ?? 'mp1';
    expect(edgeIndexForPointIds(result.piece, from, 'mp2')).not.toBeNull();
  });

  it('keeps the second piece’s grainline, and the first’s when it has none', () => {
    const moving = square('m', { x: 0, y: 0 });
    moving.grainline = { from: { x: 5, y: 5 }, to: { x: 5, y: 9 } };
    const base = square('b', { x: 40, y: 20 });
    base.grainline = { from: { x: 45, y: 25 }, to: { x: 45, y: 29 } };

    const both = joinPieces(moving, [edge(moving, 0)], base, [edge(base, 0)], WARP);
    expect(both.ok && both.piece.grainline).toEqual({ from: { x: 45, y: 25 }, to: { x: 45, y: 29 } });

    const bare = makePiece('b2', 'b2', [
      { x: 40, y: 20 },
      { x: 50, y: 20 },
      { x: 50, y: 30 },
      { x: 40, y: 30 },
    ]);
    const fallback = joinPieces(moving, [edge(moving, 0)], bare, [edge(bare, 0)], WARP);
    expect(fallback.ok).toBe(true);
    if (!fallback.ok) return;
    // Warped with the piece: the base chain runs (50,20) → (40,20), so the
    // grainline's points keep their depth above the chain and their spacing.
    expect(fallback.piece.grainline?.from).toEqual({ x: 45, y: 15 });
    expect(fallback.piece.grainline?.to).toEqual({ x: 45, y: 11 });
  });

  it('fuses a run of edges on each side — many to many', () => {
    // Two halves of one panel, each side's boundary split at y = 30, picked as
    // runs of two edges. Nothing should be lost: the halves come back as the
    // panel they were cut from, with the shared vertex gone from both.
    const left = makePiece('l', 'l', [
      { x: 5, y: 5 },
      { x: 45, y: 5 },
      { x: 45, y: 30 },
      { x: 45, y: 55 },
      { x: 5, y: 55 },
    ]);
    const right = makePiece('r', 'r', [
      { x: 45, y: 5 },
      { x: 85, y: 5 },
      { x: 85, y: 55 },
      { x: 45, y: 55 },
      { x: 45, y: 30 },
    ]);
    const result = joinPieces(left, [edge(left, 1), edge(left, 2)], right, [
      edge(right, 3),
      edge(right, 4),
    ], WARP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(signedArea(result.piece)).toBeCloseTo(4000, 6);
    expect(result.piece.points.map((p) => p.anchor)).toEqual([
      { x: 45, y: 5 },
      { x: 85, y: 5 },
      { x: 85, y: 55 },
      { x: 45, y: 55 },
      { x: 5, y: 55 },
      { x: 5, y: 5 },
    ]);
  });

  it('scales a run onto a shorter one, whatever each side is made of', () => {
    // The moving run is two 25 cm edges; the second side's run is one 25 cm
    // edge, so the moving piece is halved along the chain and nothing else.
    const moving = makePiece('m', 'm', [
      { x: 5, y: 5 },
      { x: 45, y: 5 },
      { x: 45, y: 30 },
      { x: 45, y: 55 },
      { x: 5, y: 55 },
    ]);
    const base = makePiece('b', 'b', [
      { x: 45, y: 5 },
      { x: 85, y: 5 },
      { x: 85, y: 55 },
      { x: 45, y: 55 },
      { x: 45, y: 30 },
    ]);
    const result = joinPieces(moving, [edge(moving, 1), edge(moving, 2)], base, [
      edge(base, 3),
    ], WARP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const piece = result.piece;
    // Half a run: the moving piece's depth is untouched and its chain-parallel
    // side is halved, so the second piece's 2000 keeps its area and the moved
    // piece brings 2000 × 0.5 with it. The vertex between its two fused edges
    // is consumed.
    expect(signedArea(piece)).toBeCloseTo(2000 + 1000, 0);
    expect(piece.points.some((p) => p.id === 'mp2')).toBe(false);
  });

  it('refuses runs that can only meet by folding one piece over the other', () => {
    // Runs that wrap *opposite* corners of the shared boundary: bringing them
    // together would have to run the moving piece across the piece it joins.
    const a = makePiece('a', 'a', [
      { x: 5, y: 5 },
      { x: 45, y: 5 },
      { x: 45, y: 55 },
      { x: 5, y: 55 },
    ]);
    const b = makePiece('b', 'b', [
      { x: 45, y: 5 },
      { x: 85, y: 5 },
      { x: 85, y: 35 },
      { x: 45, y: 35 },
    ]);
    const result = joinPieces(a, [edge(a, 0), edge(a, 1)], b, [edge(b, 3), edge(b, 0)], WARP);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/fold|shorter run/);
  });

  it('refuses to fuse a piece onto itself', () => {
    const piece = square('m', { x: 0, y: 0 });
    const result = joinPieces(piece, [edge(piece, 0)], piece, [edge(piece, 2)], WARP);
    expect(result.ok).toBe(false);
  });
});

describe('the fused ring reads as one outline', () => {
  it('carries the moving side’s handles through the joint', () => {
    // A moving piece whose kept outline leaves its chain corner along a curve:
    // the fused ring has to keep that curve, not the base's straight corner.
    const moving = makePiece('m', 'm', [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    moving.points[1].handleOut = { x: 14, y: 4 };
    moving.points[2].handleIn = { x: 14, y: 6 };
    const base = square('b', { x: 40, y: 20 });
    const result = joinPieces(moving, [edge(moving, 0)], base, [edge(base, 0)], WARP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The joint the moving outline runs out of keeps the moved handle.
    const joint = result.piece.points[3];
    expect(joint.id).toBe('bp0');
    expect(joint.handleOut).not.toBeNull();
    expect(joint.handleOut!.x).not.toBe(40);
  });
});

describe('matching a piece on without warping it', () => {
  /**
   * A 10 × 10 panel whose picked chain is a V cut 4 cm into its own body, so the
   * outline runs (40,20) → (45,24) → (50,20). Its body holds 80 cm² and the V is
   * the space a matched join has to fill. `wide` stretches the same mouth to
   * 16 cm, which is a scale of 1.6 for a 10 cm chain coming onto it.
   */
  const vNotched = (at: Vec2, wide = false): PatternPiece => {
    const half = wide ? 8 : 5;
    return makePiece('b', 'b', [
      { x: at.x, y: at.y },
      { x: at.x + half, y: at.y + 4 },
      { x: at.x + half * 2, y: at.y },
      { x: at.x + half * 2, y: at.y + 10 },
      { x: at.x, y: at.y + 10 },
    ]);
  };
  const vRun = (piece: PatternPiece): SeamEdgeRef[] => [edge(piece, 0), edge(piece, 1)];

  const area = (piece: PatternPiece): number => Math.abs(signedArea(piece));

  it('lands the ends and fills what the chains leave between them', () => {
    const moving = square('m', { x: 0, y: 0 });
    const base = vNotched({ x: 40, y: 20 });
    expect(area(base)).toBeCloseTo(80, 6);

    const result = joinPieces(moving, [edge(moving, 0)], base, vRun(base), {
      fit: 'match',
      tolerance: 4.5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The moving edge lands on the chord the V is cut across — the piece is not
    // bent into the V — so the 4 cm the V takes out of the base is what the fill
    // has to span.
    expect(result.gap).toBeCloseTo(4, 6);
    // The base's body, the space the V took out of it and the moved square: the
    // rectangle (40,10)-(50,30).
    expect(anchors(result.piece).map(round)).toEqual([
      { x: 50, y: 20 },
      { x: 50, y: 30 },
      { x: 40, y: 30 },
      { x: 40, y: 20 },
      { x: 40, y: 10 },
      { x: 50, y: 10 },
    ]);
    expect(area(result.piece)).toBeCloseTo(200, 6);
  });

  it('refuses edges that miss the tolerance, and says by how much', () => {
    const moving = square('m', { x: 0, y: 0 });
    const base = vNotched({ x: 40, y: 20 });
    const refused = joinPieces(moving, [edge(moving, 0)], base, vRun(base), {
      fit: 'match',
      tolerance: 3.5,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // The V is 4 cm deep, so a 3.5 cm tolerance turns the join down — and it
    // says how far apart the edges would have sat, for the caller to word.
    expect(refused.gap).toBeCloseTo(4, 6);

    // The same picks, one tolerance wider, go through.
    const accepted = joinPieces(moving, [edge(moving, 0)], base, vRun(base), {
      fit: 'match',
      tolerance: 4.5,
    });
    expect(accepted.ok).toBe(true);
  });

  it('scales the moving piece evenly, and only once', () => {
    // A 10 cm chain onto a 16 cm mouth: everything the moving piece keeps has to
    // come out 1.6 times as big, both of the edges it keeps by the same 1.6 — a
    // warp would have stretched only the one running along the chain.
    const moving = makePiece('m', 'm', [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 6, y: 4 },
      { x: 6, y: 10 },
    ]);
    const base = vNotched({ x: 40, y: 20 }, true);
    const result = joinPieces(moving, [edge(moving, 0)], base, vRun(base), {
      fit: 'match',
      tolerance: 4.5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gap).toBeCloseTo(4, 6);

    const kept = result.piece.points.filter((point) => point.id.startsWith('mp'));
    expect(kept.map((point) => point.id)).toEqual(['mp2', 'mp3', 'mp4']);
    const lengths = [
      dist(kept[0].anchor, kept[1].anchor),
      dist(kept[1].anchor, kept[2].anchor),
    ];
    expect(lengths[0]).toBeCloseTo(4 * 1.6, 6);
    expect(lengths[1]).toBeCloseTo(6 * 1.6, 6);
    // The base's body (a 16 × 10 panel less the 32 cm² the V takes out of it),
    // the V itself, and the moving piece's 46 cm² scaled by 1.6².
    expect(area(result.piece)).toBeCloseTo(128 + 32 + 46 * 2.56, 6);
  });

  it('matches a straight chain to a straight one exactly, as a warp does', () => {
    const moving = square('m', { x: 0, y: 0 });
    const base = square('b', { x: 40, y: 20 });
    const matched = joinPieces(moving, [edge(moving, 0)], base, [edge(base, 0)], {
      fit: 'match',
      tolerance: 0.5,
    });
    const warped = joinPieces(moving, [edge(moving, 0)], base, [edge(base, 0)], WARP);
    expect(matched.ok && warped.ok).toBe(true);
    if (!matched.ok || !warped.ok) return;
    expect(anchors(matched.piece).map(round)).toEqual(anchors(warped.piece).map(round));
    expect(matched.gap).toBe(0);
  });
});
