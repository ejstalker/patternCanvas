/**
 * Slicing along a Bézier chain.
 *
 * The linear and circle cutters always had exact maths behind them; the chain
 * cutter exists for the loop knife, whose cut follows the piece's contours and
 * arrives as a curve. What matters is that it cuts where the preview says it
 * will, that the children keep the whole area between them, and that the cut
 * geometry carries the curve rather than being flattened to a chord.
 */
import { describe, expect, it } from 'vitest';
import {
  cutterPathThrough,
  findBoundaryHits,
  pieceUnderChain,
  sampleCutterPath,
  slicePiece,
  type CutterPath,
} from './slice';
import { dist, edgeIndexForPointIds, sampleEdgeByPointIds } from './geometry';
import { loopCutAt, loopCutCutter } from './loopCut';
import type { BezierPoint, PatternPiece, Vec2 } from '../project/types';

let counter = 0;
const id = () => `id${++counter}`;

function piece(points: Vec2[]): PatternPiece {
  const anchors: BezierPoint[] = points.map((anchor) => ({
    id: id(),
    anchor: { ...anchor },
    handleIn: null,
    handleOut: null,
    handlesParallel: false,
  }));
  return { id: 'piece', name: 'Panel', closed: true, points: anchors };
}

function area(p: PatternPiece): number {
  let sum = 0;
  for (let i = 0, j = p.points.length - 1; i < p.points.length; j = i++) {
    sum += p.points[j]!.anchor.x * p.points[i]!.anchor.y - p.points[i]!.anchor.x * p.points[j]!.anchor.y;
  }
  return Math.abs(sum / 2);
}

const rectangle = () =>
  piece([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 200 },
    { x: 0, y: 200 },
  ]);

/** A chain that runs straight down the middle of the rectangle. */
const straightChain: CutterPath = {
  kind: 'path',
  points: [
    { anchor: { x: 50, y: 0 }, handleIn: null, handleOut: { x: 50, y: 66 } },
    { anchor: { x: 50, y: 200 }, handleIn: { x: 50, y: 134 }, handleOut: null },
  ],
};

/** A chain that bows out to the right on its way down. */
const bowedChain: CutterPath = {
  kind: 'path',
  points: [
    { anchor: { x: 20, y: 0 }, handleIn: null, handleOut: { x: 70, y: 20 } },
    { anchor: { x: 60, y: 100 }, handleIn: { x: 62, y: 60 }, handleOut: { x: 58, y: 140 } },
    { anchor: { x: 20, y: 200 }, handleIn: { x: -30, y: 180 }, handleOut: null },
  ],
};

describe('chain cutter hits', () => {
  it('crosses a straight-sided panel twice, ordered along the chain', () => {
    const hits = findBoundaryHits(rectangle(), straightChain);
    expect(hits.length).toBe(2);
    const [first, second] = [...hits].sort((a, b) => a.along - b.along);
    expect(first!.point.y).toBeCloseTo(0, 4);
    expect(second!.point.y).toBeCloseTo(200, 4);
    expect(first!.point.x).toBeCloseTo(50, 4);
  });

  it('finds the crossings of a bowed chain', () => {
    const hits = findBoundaryHits(rectangle(), bowedChain);
    expect(hits.length).toBe(2);
    for (const hit of hits) {
      // Each hit is on an edge of the outline.
      const onEdge = rectangle().points.some((_, i, all) => {
        const a = all[i]!.anchor;
        const b = all[(i + 1) % all.length]!.anchor;
        const cross = (b.x - a.x) * (hit.point.y - a.y) - (b.y - a.y) * (hit.point.x - a.x);
        return Math.abs(cross) < 1e-6;
      });
      expect(onEdge).toBe(true);
    }
  });
});

describe('slicing along a chain', () => {
  it('splits a panel in two and keeps every square centimetre', () => {
    const panel = rectangle();
    const result = slicePiece(panel, straightChain, id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [a, b] = result.pieces;
    expect(area(a) + area(b)).toBeCloseTo(area(panel), 6);
    expect(area(a)).toBeCloseTo(area(panel) / 2, 6);
  });

  it('keeps the curve in the cut geometry', () => {
    const panel = rectangle();
    const result = slicePiece(panel, bowedChain, id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [a, b] = result.pieces;
    expect(area(a) + area(b)).toBeCloseTo(area(panel), 6);
    // The two children each carry the cut; on a bowed cut those points are not
    // collinear, which is exactly what a chain buys over a chord.
    const bowed = (child: PatternPiece) =>
      child.points.some((pt) => pt.anchor.x > 45 && pt.anchor.y > 40 && pt.anchor.y < 160);
    expect(bowed(a) || bowed(b)).toBe(true);
  });

  it('ignores a chain that misses the piece', () => {
    const far: CutterPath = {
      kind: 'path',
      points: [
        { anchor: { x: 500, y: 0 }, handleIn: null, handleOut: { x: 500, y: 100 } },
        { anchor: { x: 500, y: 300 }, handleIn: { x: 500, y: 200 }, handleOut: null },
      ],
    };
    expect(slicePiece(rectangle(), far, id).ok).toBe(false);
  });

  it('samples the whole chain, ends included', () => {
    const samples = sampleCutterPath(bowedChain, 32);
    expect(samples.length).toBe(33);
    expect(samples[0]!.x).toBeCloseTo(20, 4);
    expect(samples[samples.length - 1]!.x).toBeCloseTo(20, 4);
  });
});

describe('the loop knife feeds the slicer', () => {
  it('cuts a tapered panel exactly where the preview draws it', () => {
    const taper = piece([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 70, y: 200 },
      { x: 30, y: 200 },
    ]);
    const cut = loopCutAt(taper, { edgeIndex: 0, t: 0.5, follow: true })!;
    expect(cut.valid).toBe(true);
    const cutter = loopCutCutter(cut);
    expect(cutter.kind).toBe('path');

    // The slicer must find the same two crossings the preview did.
    const hits = findBoundaryHits(taper, cutter);
    expect(hits.length).toBe(2);
    const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) < 0.1;
    expect(hits.some((h) => near(h.point, cut.entry))).toBe(true);
    expect(hits.some((h) => near(h.point, cut.exit))).toBe(true);

    const result = slicePiece(taper, cutter, id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [a, b] = result.pieces;
    expect(area(a) + area(b)).toBeCloseTo(area(taper), 4);
    expect(area(a)).toBeGreaterThan(1);
    expect(area(b)).toBeGreaterThan(1);
  });

  it('cuts a straight loop cut with the line cutter', () => {
    const panel = rectangle();
    const cut = loopCutAt(panel, { edgeIndex: 0, t: 0.3, follow: false })!;
    expect(cut.straight).toBe(true);
    expect(loopCutCutter(cut).kind).toBe('line');
    const result = slicePiece(panel, loopCutCutter(cut), id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(area(result.pieces[0])).toBeCloseTo(30 * 200, 4);
    expect(area(result.pieces[1])).toBeCloseTo(70 * 200, 4);
  });
});

describe('a cutter built from clicked points', () => {
  it('needs two points to be a cutter at all', () => {
    expect(cutterPathThrough([])).toBeNull();
    expect(cutterPathThrough([{ x: 1, y: 1 }])).toBeNull();
    expect(cutterPathThrough([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toEqual({
      kind: 'path',
      points: [
        { anchor: { x: 1, y: 1 }, handleIn: null, handleOut: null },
        { anchor: { x: 2, y: 2 }, handleIn: null, handleOut: null },
      ],
    });
  });

  it('passes through the clicks, and only the clicks, when straight', () => {
    const clicks = [
      { x: 20, y: 0 },
      { x: 60, y: 100 },
      { x: 20, y: 200 },
    ];
    const cutter = cutterPathThrough(clicks, 'straight')!;
    expect(cutter.kind === 'path' && cutter.points.every((p) => !p.handleIn && !p.handleOut)).toBe(true);
    const samples = sampleCutterPath(cutter, 200);
    // Every sample sits on the two chords: a straight chain never leaves them.
    for (const sample of samples) {
      const strayed = clicks.slice(0, -1).reduce((best, click, i) => {
        const next = clicks[i + 1]!;
        const dx = next.x - click.x;
        const dy = next.y - click.y;
        const t = Math.max(0, Math.min(1, ((sample.x - click.x) * dx + (sample.y - click.y) * dy) / (dx * dx + dy * dy)));
        return Math.min(best, Math.hypot(sample.x - (click.x + t * dx), sample.y - (click.y + t * dy)));
      }, Infinity);
      expect(strayed).toBeLessThan(0.35);
    }
  });

  it('bows through the clicks when smooth, and still lands on them', () => {
    const clicks = [
      { x: 20, y: 0 },
      { x: 60, y: 100 },
      { x: 20, y: 200 },
    ];
    const cutter = cutterPathThrough(clicks, 'smooth')!;
    expect(cutter.kind).toBe('path');
    const samples = sampleCutterPath(cutter, 400);
    // The middle click is on the curve, and the curve reaches out towards it
    // rather than running straight between the ends.
    const closest = Math.min(...samples.map((p) => Math.hypot(p.x - 60, p.y - 100)));
    expect(closest).toBeLessThan(0.5);
    const straightMid = { x: 40, y: 100 };
    const farFromChord = Math.max(...samples.map((p) => Math.abs(p.x - straightMid.x)));
    expect(farFromChord).toBeGreaterThan(5);
    // The ends are where they were clicked, and the chain starts out along the
    // first segment (one-sided tangent at the ends).
    expect(samples[0]!.y).toBeCloseTo(0, 6);
    expect(samples[samples.length - 1]!.y).toBeCloseTo(200, 6);
    expect(samples[0]!.x).toBeCloseTo(20, 6);
  });

  it('cuts the piece it crosses, and reports the edges its cut created', () => {
    const panel = rectangle();
    const cutter = cutterPathThrough(
      [
        { x: 20, y: -40 },
        { x: 60, y: 100 },
        { x: 20, y: 240 },
      ],
      'smooth'
    )!;
    const result = slicePiece(panel, cutter, id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [a, b] = result.pieces;
    expect(result.cutEdges.length).toBeGreaterThan(0);
    for (const pair of result.cutEdges) {
      expect(pair.a.pieceId).toBe(a.id);
      expect(pair.b.pieceId).toBe(b.id);
      // Both sides of the seam are real edges of the pieces they point at.
      expect(edgeIndexForPointIds(a, pair.a.fromPointId, pair.a.toPointId)).not.toBeNull();
      expect(edgeIndexForPointIds(b, pair.b.fromPointId, pair.b.toPointId)).not.toBeNull();
      // …and they lie on top of each other when both are read the way the seam
      // reads them: sewing them welds the split instead of twisting it.
      const readA = sampleEdgeByPointIds(a, pair.a.fromPointId, pair.a.toPointId, 8)!;
      const readB = sampleEdgeByPointIds(b, pair.b.fromPointId, pair.b.toPointId, 8)!;
      const alongA = pair.a.t0 > pair.a.t1 ? [...readA].reverse() : readA;
      const alongB = pair.b.t0 > pair.b.t1 ? [...readB].reverse() : readB;
      expect(alongA.length).toBe(alongB.length);
      for (let i = 0; i < alongA.length; i++) {
        expect(dist(alongA[i]!, alongB[i]!)).toBeLessThan(0.05);
      }
    }
    // The clicks below and above the panel bracket two crossings, so the
    // trimmed cut runs crossing → middle click → crossing: two segments, and so
    // two paired edges to sew.
    expect(result.cutEdges.length).toBe(2);
  });
});

describe('which panel a chain cuts', () => {
  /** Two panels side by side, 10 cm apart, on the same horizontal band. */
  const twoPanels = () => [
    { piece: piece([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }]), name: 'A' },
    { piece: piece([{ x: 110, y: 0 }, { x: 210, y: 0 }, { x: 210, y: 60 }, { x: 110, y: 60 }]), name: 'B' },
  ];

  it('takes the panel the chain is drawn through', () => {
    const panels = twoPanels();
    const pieces = panels.map((p) => p.piece);
    const through = pieceUnderChain(pieces, [
      { x: 30, y: -20 },
      { x: 50, y: 30 },
      { x: 70, y: 80 },
    ]);
    expect(through?.id).toBe(panels[0]!.piece.id);
  });

  it('does not take the panel a carried-on end would run into', () => {
    const panels = twoPanels();
    const pieces = panels.map((p) => p.piece);
    // Both clicks are inside panel A, and the line they lie on carries on out of
    // A, across the gap, and into B. The cut is A's: what is beyond the end of the
    // cut is none of the knife's business.
    const chain = [
      { x: 20, y: 30 },
      { x: 60, y: 41 },
    ];
    expect(pieceUnderChain(pieces, chain, 'smooth')?.id).toBe(panels[0]!.piece.id);
    // The same line, drawn inside B, is B's.
    const inB = [
      { x: 130, y: 30 },
      { x: 170, y: 41 },
    ];
    expect(pieceUnderChain(pieces, inB, 'smooth')?.id).toBe(panels[1]!.piece.id);
  });

  it('picks the panel the chain spends most of itself inside', () => {
    const panels = twoPanels();
    const pieces = panels.map((p) => p.piece);
    // A chain that clips the end of A and then runs most of its length through B.
    const chain = [
      { x: 90, y: 30 },
      { x: 120, y: 30 },
      { x: 200, y: 30 },
    ];
    expect(pieceUnderChain(pieces, chain, 'straight')?.id).toBe(panels[1]!.piece.id);
  });

  it('reports nothing when the chain runs through no panel', () => {
    const pieces = twoPanels().map((p) => p.piece);
    expect(pieceUnderChain(pieces, [{ x: -100, y: -100 }, { x: -60, y: -100 }])).toBeNull();
    expect(pieceUnderChain(pieces, [])).toBeNull();
  });
});
