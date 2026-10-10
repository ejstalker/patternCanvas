/**
 * Loop-cut geometry. The behaviours worth pinning down are the two the feature
 * promises: a piece with parallel straight sides cuts straight wherever the
 * pointer sits, and a piece with curved contours bends the cut with them.
 */
import { describe, expect, it } from 'vitest';
import { loopCutAt, loopCutCutter, sampleLoopCutPath } from './loopCut';
import { findBoundaryHits } from './slice';
import { pointInPolygon, pieceToPolyline } from './geometry';
import type { BezierPoint, PatternPiece, Vec2 } from '../project/types';

let counter = 0;
const id = () => `pt${++counter}`;

function piece(points: Vec2[], curved?: { index: number; handle: Vec2 }[]): PatternPiece {
  const anchors: BezierPoint[] = points.map((anchor) => ({
    id: id(),
    anchor: { ...anchor },
    handleIn: null,
    handleOut: null,
    handlesParallel: false,
  }));
  for (const c of curved ?? []) {
    const pt = anchors[c.index]!;
    pt.handleOut = { ...c.handle };
    const next = anchors[(c.index + 1) % anchors.length]!;
    next.handleIn = { ...c.handle };
  }
  return { id: 'piece', name: 'Panel', closed: true, points: anchors };
}

/** Axis-aligned rectangle, wound clockwise in screen space (y down). */
function rectangle(width: number, height: number): PatternPiece {
  return piece([
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]);
}

function deviationFromStraight(
  cut: NonNullable<ReturnType<typeof loopCutAt>>
): number {
  const axis = {
    x: cut.exit.x - cut.entry.x,
    y: cut.exit.y - cut.entry.y,
  };
  const length = Math.hypot(axis.x, axis.y) || 1;
  const ux = axis.x / length;
  const uy = axis.y / length;
  let worst = 0;
  for (const p of sampleLoopCutPath(cut, 40)) {
    const dx = p.x - cut.entry.x;
    const dy = p.y - cut.entry.y;
    worst = Math.max(worst, Math.abs(-uy * dx + ux * dy));
  }
  return worst;
}

describe('loop cut on a rectangle', () => {
  const rect = rectangle(100, 200);

  it('enters where the pointer is and leaves on the far side', () => {
    // Bottom edge (0,0)→(100,0) is edge 0; hover 30% along it.
    const cut = loopCutAt(rect, { edgeIndex: 0, t: 0.3, follow: true })!;
    expect(cut).toBeTruthy();
    expect(cut.entry.x).toBeCloseTo(30, 6);
    expect(cut.entry.y).toBeCloseTo(0, 6);
    expect(cut.exit.x).toBeCloseTo(30, 6);
    expect(cut.exit.y).toBeCloseTo(200, 6);
    expect(cut.valid).toBe(true);
  });

  it('cuts straight across, wherever along the edge the pointer is', () => {
    for (const t of [0.05, 0.3, 0.5, 0.72, 0.95]) {
      const cut = loopCutAt(rect, { edgeIndex: 0, t, follow: true })!;
      // Parallel sides: the followed cut must not bow out toward the middle.
      expect(deviationFromStraight(cut), `t=${t}`).toBeLessThan(0.2);
    }
  });

  it('cuts the same line straight and followed', () => {
    const follow = loopCutAt(rect, { edgeIndex: 0, t: 0.3, follow: true })!;
    const straight = loopCutAt(rect, { edgeIndex: 0, t: 0.3, follow: false })!;
    expect(straight.straight).toBe(true);
    expect(follow.straight).toBe(false);
    expect(follow.entry).toEqual(straight.entry);
    expect(follow.exit).toEqual(straight.exit);
    expect(deviationFromStraight(follow)).toBeLessThan(0.2);
  });

  it('uses the edge normal, not the edge chord', () => {
    // Cut in from the right edge (100,0)→(100,200), edge 1, halfway down.
    const cut = loopCutAt(rect, { edgeIndex: 1, t: 0.5, follow: true })!;
    expect(cut.entry.x).toBeCloseTo(100, 6);
    expect(cut.entry.y).toBeCloseTo(100, 6);
    expect(cut.exit.x).toBeCloseTo(0, 6);
    expect(cut.exit.y).toBeCloseTo(100, 6);
  });
});

describe('loop cut over a long thin panel', () => {
  // The report: a strip with two long, nearly parallel sides and short ends,
  // where hovering a long side produced a little loop that shot out along the
  // edge instead of a clean cut across the strip.
  const strip = piece([
    { x: 31.05423616146588, y: 97.81604115058141 },
    { x: 35.55185023782902, y: 112.58214580491396 },
    { x: -74.45444203492323, y: 112.58214580491396 },
    { x: -70.60983331293104, y: 96.87793820930138 },
  ]);

  it('cuts across the strip without looping out along the edge', () => {
    for (const t of [0.08, 0.25, 0.5, 0.75, 0.92]) {
      for (const follow of [true, false]) {
        const cut = loopCutAt(strip, { edgeIndex: 1, t, follow });
        expect(cut, `t=${t} follow=${follow}`).toBeTruthy();
        if (!cut) return;
        expect(cut.valid).toBe(true);
        // Across the strip, not along it: the cut spans the short way.
        const span = Math.hypot(cut.exit.x - cut.entry.x, cut.exit.y - cut.entry.y);
        expect(span, `t=${t}`).toBeLessThan(20);
        // The two long sides are near enough parallel, so the cut stays within a
        // centimetre of the straight line the pointer asked for. The loop it used
        // to draw swung four centimetres off it near the edge.
        expect(deviationFromStraight(cut), `t=${t} follow=${follow}`).toBeLessThan(1);
      }
    }
  });

  it('does not run back down the cut at either end', () => {
    const cut = loopCutAt(strip, { edgeIndex: 1, t: 0.5, follow: true })!;
    const axis = { x: cut.exit.x - cut.entry.x, y: cut.exit.y - cut.entry.y };
    const length = Math.hypot(axis.x, axis.y);
    const ux = axis.x / length;
    const uy = axis.y / length;
    const samples = sampleLoopCutPath(cut, 48);
    let previous = 0;
    for (const p of samples) {
      const along = (p.x - cut.entry.x) * ux + (p.y - cut.entry.y) * uy;
      expect(along).toBeGreaterThanOrEqual(previous - 0.05);
      expect(along).toBeLessThanOrEqual(length + 0.05);
      previous = along;
    }
  });
});

describe('loop cut follows contours', () => {
  it('bends with a banana-shaped panel', () => {
    // Both long sides bow to the right, so a cut from the hem to the waist has
    // to bow with them: the straight chord even leaves this piece.
    const banana = piece([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 160, y: 100 },
      { x: 100, y: 200 },
      { x: 0, y: 200 },
      { x: 60, y: 100 },
    ]);
    const cut = loopCutAt(banana, { edgeIndex: 0, t: 0.5, follow: true })!;
    const straight = loopCutAt(banana, { edgeIndex: 0, t: 0.5, follow: false })!;
    expect(cut.valid).toBe(true);
    // Halfway across, the band's midline sits at x = 110; the straight chord
    // would sit at 50 and fall outside the piece.
    const samples = sampleLoopCutPath(cut, 40);
    const mid = samples.reduce((best, p) =>
      Math.abs(p.y - 100) < Math.abs(best.y - 100) ? p : best
    );
    expect(mid.y).toBeCloseTo(100, 0);
    expect(mid.x).toBeGreaterThan(90);
    expect(mid.x).toBeLessThan(120);
    expect(straight.valid).toBe(false);
  });

  it('holds its share across a tapering panel', () => {
    // A skirt panel: wide at the hem, narrow at the waist.
    const taper = piece([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 70, y: 200 },
      { x: 30, y: 200 },
    ]);
    const poly = pieceToPolyline(taper.points, true);
    const cut = loopCutAt(taper, { edgeIndex: 0, t: 0.25, follow: true })!;
    expect(cut.valid).toBe(true);
    // The cut leaves square to the hem, a quarter of the way along it.
    expect(cut.entry.x).toBeCloseTo(25, 4);
    // It holds its quarter share to the end, so it carries on to the waist: the
    // far crossing of the edge normal is at x = 25, but the cut is still inside
    // the panel long after that, and the trace follows it to the edge it reaches.
    expect(cut.exit.y).toBeCloseTo(200, 3);
    expect(cut.exit.x).toBeCloseTo(40, 1);
    const samples = sampleLoopCutPath(cut, 40);
    for (const p of samples.slice(1, -1)) {
      expect(pointInPolygon(p, poly), `${p.x.toFixed(2)},${p.y.toFixed(2)}`).toBe(true);
    }
    // Halfway up, the contours run from x = 15 to x = 85, so a cut holding its
    // quarter share sits at 32.5 — the chord's straight 25 would ignore the taper.
    // Interpolate to y = 100 rather than trusting a sample to land there.
    let midX = Number.NaN;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      if (a.y <= 100 && b.y >= 100) {
        midX = a.x + ((b.x - a.x) * (100 - a.y)) / (b.y - a.y);
        break;
      }
    }
    expect(midX).toBeCloseTo(32.5, 1);
  });

  it('keeps every sample inside the piece', () => {
    const taper = piece([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 70, y: 200 },
      { x: 30, y: 200 },
    ]);
    const poly = pieceToPolyline(taper.points, true);
    const cut = loopCutAt(taper, { edgeIndex: 0, t: 0.5, follow: true })!;
    const samples = sampleLoopCutPath(cut, 40);
    // The ends sit on the boundary by definition; the cut between them must not.
    for (const p of samples.slice(1, -1)) {
      expect(pointInPolygon(p, poly), `${p.x},${p.y}`).toBe(true);
    }
  });
});

describe('the cut and the slicer agree', () => {
  it('crosses the boundary exactly where the cut starts and ends', () => {
    const rect = rectangle(100, 200);
    for (const follow of [true, false]) {
      const cut = loopCutAt(rect, { edgeIndex: 0, t: 0.3, follow })!;
      const hits = findBoundaryHits(rect, loopCutCutter(cut));
      expect(hits.length, `follow=${follow}`).toBe(2);
      const points = hits.map((h) => h.point);
      const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) < 0.05;
      expect(points.some((p) => near(p, cut.entry))).toBe(true);
      expect(points.some((p) => near(p, cut.exit))).toBe(true);
    }
  });
});

describe('loop cut refuses what it cannot do', () => {
  it('rejects a hover that is not on the piece', () => {
    const rect = rectangle(100, 200);
    expect(loopCutAt(rect, { edgeIndex: 9, t: 0.5, follow: true })).toBeNull();
  });

  /**
   * Hovers anywhere on a concave piece: every cut that comes back either stays
   * inside the piece, or says why it cannot. The normal has to be derived from
   * the outline rather than from the centroid here — a V has its centroid in
   * open space, which is exactly the case that used to point the cut outwards.
   */
  it('never offers a cut that leaves a concave piece', () => {
    const vee = piece([
      { x: 0, y: 0 },
      { x: 40, y: 100 },
      { x: 80, y: 0 },
      { x: 80, y: 200 },
      { x: 0, y: 200 },
    ]);
    const poly = pieceToPolyline(vee.points, true);
    let offered = 0;
    for (let edgeIndex = 0; edgeIndex < vee.points.length; edgeIndex++) {
      for (const t of [0.15, 0.35, 0.5, 0.65, 0.85]) {
        for (const follow of [true, false]) {
          const cut = loopCutAt(vee, { edgeIndex, t, follow });
          if (!cut) continue;
          if (!cut.valid) {
            expect(cut.reason, `edge ${edgeIndex} t ${t}`).toBeTruthy();
            continue;
          }
          offered++;
          const samples = sampleLoopCutPath(cut, 24);
          for (const p of samples.slice(1, -1)) {
            expect(pointInPolygon(p, poly), `edge ${edgeIndex} t ${t} ${p.x},${p.y}`).toBe(true);
          }
        }
      }
    }
    expect(offered).toBeGreaterThan(8);
  });
});
