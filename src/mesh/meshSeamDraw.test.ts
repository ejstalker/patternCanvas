import { describe, expect, it } from 'vitest';
import { buildSeamConnectorPointPairs, drawMeshSeamConnectors, seamRefsFromPattern } from './meshSeamDraw';
import type { PatternDocument } from '../project/types';
import { rectPiece } from '../project/createDefault';

function makeSeamedPattern(): PatternDocument {
  const pieceA = rectPiece('A', 10, 10, { x: 0, y: 0 });
  const pieceB = rectPiece('B', 10, 10, { x: 20, y: 0 });
  return {
    id: 'p1',
    name: 'P',
    pieces: [pieceA, pieceB],
    seams: [
      {
        id: 's1',
        a: {
          pieceId: pieceA.id,
          fromPointId: pieceA.points[1].id,
          toPointId: pieceA.points[2].id,
          t0: 0,
          t1: 1,
        },
        b: {
          pieceId: pieceB.id,
          fromPointId: pieceB.points[3].id,
          toPointId: pieceB.points[0].id,
          t0: 0,
          t1: 1,
        },
        restGapCm: 0,
      },
    ],
  };
}

describe('meshSeamDraw', () => {
  it('collects seam edge refs from pattern bindings', () => {
    const pattern = makeSeamedPattern();
    const piece = pattern.pieces[0];
    const refs = seamRefsFromPattern(pattern);
    expect(refs).toHaveLength(2);
    expect(refs[0].fromPointId).toBe(piece.points[1].id);
  });

  it('returns empty refs when pattern is missing', () => {
    expect(seamRefsFromPattern(null)).toEqual([]);
  });

  it('draws multiple connector lines per seam binding', () => {
    const pattern = makeSeamedPattern();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    drawMeshSeamConnectors(svg, pattern);
    const lines = svg.querySelectorAll('.mesh-seam-connector');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0].getAttribute('opacity')).toBe('0.6');
  });

  it('matches arc-length samples along both seam edges', () => {
    const pattern = makeSeamedPattern();
    const pieceA = pattern.pieces[0];
    const pieceB = pattern.pieces[1];
    const seam = pattern.seams[0];
    const pairs = buildSeamConnectorPointPairs(pieceA, seam.a, pieceB, seam.b, 4);
    expect(pairs).toHaveLength(4);
    expect(pairs[0][0].y).not.toBe(pairs[3][0].y);
    expect(pairs[0][1].x).toBeGreaterThan(pairs[0][0].x);
  });
});
