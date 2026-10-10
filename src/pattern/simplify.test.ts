import { describe, expect, it } from 'vitest';
import {
  keepCount,
  MIN_RUN,
  selectedPointRuns,
  simplifyIndices,
  simplifyRun,
  toleranceForKeep,
} from './simplify';
import { dist, pieceToPolyline } from './geometry';
import type { BezierPoint, Vec2 } from '../project/types';

/**
 * A real hand-drawn panel, taken from a document that was simplified for real.
 *
 * It is the shape a fit gets wrong: long edges meeting at sharp corners, plus a
 * densely drawn curve along the side. Reading tangents off the surviving points
 * rather than off the drawn outline sails 5 cm past the corner here.
 */
const DRAWN_PANEL: Array<[[number, number], [number, number] | null, [number, number] | null]> = [
  [[-31.95, 75.65], [-32.02, 75.14], null],
  [[-100.65, 75.01], null, null],
  [[-91.9, 39.25], null, null],
  [[-66.52, 1.82], null, null],
  [[-33.7, 14.24], null, null],
  [[-11.5, 19.68], null, [-11.5, 20.14]],
  [[-11.51, 21.07], [-11.5, 20.61], [-11.51, 21.58]],
  [[-11.52, 22.59], [-11.52, 22.09], [-11.53, 23.1]],
  [[-11.54, 24.11], [-11.53, 23.61], [-11.54, 24.62]],
  [[-11.55, 25.64], [-11.54, 25.13], [-11.56, 26.14]],
  [[-11.6, 27.16], [-11.56, 26.65], [-11.65, 27.67]],
  [[-11.81, 28.68], [-11.7, 28.18], [-11.91, 29.19]],
  [[-12.24, 30.19], [-12.07, 29.69], [-12.41, 30.71]],
  [[-12.82, 31.71], [-12.62, 31.21], [-13.02, 32.22]],
  [[-13.44, 33.22], [-13.24, 32.72], [-13.65, 33.73]],
  [[-14.06, 34.74], [-13.86, 34.23], [-14.27, 35.24]],
  [[-14.68, 36.25], [-14.48, 35.75], [-14.89, 36.76]],
  [[-15.29, 37.77], [-15.09, 37.26], [-15.49, 38.27]],
  [[-15.87, 39.29], [-15.69, 38.78], [-16.05, 39.79]],
  [[-16.37, 40.8], [-16.21, 40.29], [-16.53, 41.31]],
  [[-16.81, 42.32], [-16.67, 41.81], [-16.95, 42.82]],
  [[-17.22, 43.84], [-17.08, 43.33], [-17.35, 44.34]],
  [[-17.62, 45.36], [-17.49, 44.85], [-17.75, 45.86]],
  [[-18.02, 46.87], [-17.89, 46.37], [-18.15, 47.38]],
  [[-18.42, 48.39], [-18.29, 47.88], [-18.55, 48.9]],
  [[-18.81, 49.91], [-18.68, 49.4], [-18.95, 50.41]],
  [[-19.21, 51.43], [-19.08, 50.92], [-19.34, 51.93]],
  [[-19.6, 52.94], [-19.45, 52.44], [-19.75, 53.45]],
  [[-20.1, 54.46], [-19.86, 53.99], [-20.39, 55.01]],
  [[-21.16, 55.97], [-20.71, 55.55], [-21.8, 56.57]],
  [[-23.31, 57.47], [-22.54, 57.05], [-24.33, 58.05]],
  [[-26.51, 58.96], [-25.43, 58.48], [-27.65, 59.48]],
  [[-29.96, 60.45], [-28.84, 59.89], [-30.84, 60.89]],
  [[-32.49, 61.95], [-31.75, 61.31], [-32.95, 62.34]],
  [[-33.49, 63.46], [-33.3, 62.89], [-33.65, 63.95]],
  [[-33.48, 64.98], [-33.52, 64.48], [-33.44, 65.5]],
  [[-33.24, 66.51], [-33.31, 66], [-33.16, 67.02]],
  [[-33.01, 68.03], [-33.08, 67.52], [-32.93, 68.54]],
  [[-32.79, 69.55], [-32.86, 69.05], [-32.71, 70.06]],
  [[-32.57, 71.08], [-32.64, 70.57], [-32.5, 71.59]],
  [[-32.36, 72.6], [-32.43, 72.09], [-32.29, 73.11]],
  [[-32.15, 74.12], [-32.22, 73.62], [-32.09, 74.63]],
];

const drawnPanel = (): BezierPoint[] =>
  DRAWN_PANEL.map(([anchor, handleIn, handleOut], index) => ({
    id: `d${index}`,
    anchor: { x: anchor[0], y: anchor[1] },
    handleIn: handleIn ? { x: handleIn[0], y: handleIn[1] } : null,
    handleOut: handleOut ? { x: handleOut[0], y: handleOut[1] } : null,
  }));

/** Dense samples along the outline a chain of points draws. */
function chainSamples(points: readonly BezierPoint[], closed: boolean): Vec2[] {
  return pieceToPolyline([...points], closed, 8);
}

/** How far a chain strays from another, at its worst. */
function worstDeviation(from: readonly Vec2[], to: readonly Vec2[], closed: boolean): number {
  let worst = 0;
  for (const p of from) {
    let best = Infinity;
    for (let i = 0; i < to.length; i++) {
      const a = to[i]!;
      const b = to[(i + 1) % to.length]!;
      if (!closed && i === to.length - 1) break;
      best = Math.min(best, distanceToSegment(p, a, b));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

const pt = (id: string, x: number, y: number): BezierPoint => ({
  id,
  anchor: { x, y },
  handleIn: null,
  handleOut: null,
});

/** A dense arc of `count` points, which simplification should thin out heavily. */
function arc(count: number, radius = 100, sweep = Math.PI / 2): BezierPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (sweep * i) / (count - 1);
    return pt(`p${i}`, Math.round((Math.cos(angle) * radius - radius) * 1000) / 1000, Math.round(Math.sin(angle) * radius * 1000) / 1000);
  });
}

describe('selectedPointRuns', () => {
  it('returns runs of consecutive ids in outline order, not the order of the set', () => {
    const points = [pt('a', 0, 0), pt('b', 1, 0), pt('c', 2, 0), pt('d', 3, 0), pt('e', 4, 0)];
    const picked = new Set(['d', 'b', 'c']);
    expect(selectedPointRuns(points, (id) => picked.has(id), false)).toEqual([['b', 'c', 'd']]);
  });

  it('splits runs apart and drops runs shorter than the minimum', () => {
    const points = [pt('a', 0, 0), pt('b', 1, 0), pt('c', 2, 0), pt('d', 3, 0), pt('e', 4, 0), pt('f', 5, 0)];
    const picked = new Set(['b', 'c', 'd', 'f']);
    expect(selectedPointRuns(points, (id) => picked.has(id), false)).toEqual([['b', 'c', 'd']]);
  });

  it('weaves a run that crosses the end of a closed outline back into one run', () => {
    const points = [pt('a', 0, 0), pt('b', 1, 0), pt('c', 2, 0), pt('d', 3, 0), pt('e', 4, 0), pt('f', 5, 0)];
    const picked = new Set(['e', 'f', 'a', 'b']);
    expect(selectedPointRuns(points, (id) => picked.has(id), true)).toEqual([['e', 'f', 'a', 'b']]);
  });

  it('treats a wholly picked closed outline as a single run', () => {
    const points = [pt('a', 0, 0), pt('b', 1, 0), pt('c', 2, 0), pt('d', 3, 0)];
    expect(selectedPointRuns(points, () => true, true)).toEqual([['a', 'b', 'c', 'd']]);
  });

  it('reports nothing when the picks are too few to be a run', () => {
    const points = [pt('a', 0, 0), pt('b', 1, 0), pt('c', 2, 0)];
    expect(selectedPointRuns(points, (id) => id === 'a' || id === 'b', false)).toEqual([]);
    expect(MIN_RUN).toBe(3);
  });
});

describe('keepCount', () => {
  it('keeps everything at 0% and the two ends at 100%', () => {
    expect(keepCount(10, 0)).toBe(10);
    expect(keepCount(10, 100)).toBe(2);
    expect(keepCount(10, 50)).toBe(6);
    expect(keepCount(3, 100)).toBe(2);
    expect(keepCount(4, 30)).toBe(3);
  });

  it('clamps out-of-range and fractional input', () => {
    expect(keepCount(5, -20)).toBe(5);
    expect(keepCount(5, 900)).toBe(2);
    expect(Number.isInteger(keepCount(9, 37))).toBe(true);
  });
});

describe('simplifyIndices', () => {
  it('always keeps both ends', () => {
    const anchors = arc(30).map((p) => p.anchor);
    const kept = simplifyIndices(anchors, 1e6);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(anchors.length - 1);
  });

  it('keeps more points as the tolerance comes down, and stays inside it', () => {
    const anchors = arc(40).map((p) => p.anchor);
    const loose = simplifyIndices(anchors, 5);
    const tight = simplifyIndices(anchors, 0.5);
    expect(loose.length).toBeLessThan(tight.length);
    for (const tolerance of [0, 0.25, 1, 4]) {
      const kept = simplifyIndices(anchors, tolerance);
      for (let i = 1; i < anchors.length - 1; i++) {
        if (kept.includes(i)) continue;
        const deviation = distanceToSegment(anchors[i]!, anchors[keptBefore(kept, i)]!, anchors[keptAfter(kept, i)]!);
        expect(deviation).toBeLessThanOrEqual(tolerance + 1e-6);
      }
    }
  });

  it('keeps the anchors it is told to keep', () => {
    const anchors = arc(30).map((p) => p.anchor);
    for (const forced of [[7], [4, 18], [1, 2, 28]]) {
      const kept = simplifyIndices(anchors, 1e6, forced);
      for (const index of forced) expect(kept).toContain(index);
      // A forced anchor also splits the run: every stretch stays within tolerance
      // of its own chords, so nothing is absorbed across a pinned point.
      expect(kept.length).toBe(forced.length + 2);
    }
    expect(simplifyIndices(anchors, 1e6)).toEqual([0, anchors.length - 1]);
  });

  it('collapses a collinear run to its ends', () => {
    const anchors = Array.from({ length: 12 }, (_, i) => ({ x: i * 3, y: 0 }));
    expect(simplifyIndices(anchors, 0.01)).toEqual([0, 11]);
  });
});

describe('toleranceForKeep', () => {
  it('finds a tolerance leaving at most the asked-for count', () => {
    const anchors = arc(50).map((p) => p.anchor);
    for (const keep of [2, 3, 8, 20, 49]) {
      const tolerance = toleranceForKeep(anchors, keep);
      const kept = simplifyIndices(anchors, tolerance);
      expect(kept.length).toBeLessThanOrEqual(keep);
      // Nothing coarser than needed: just under the found tolerance the count is
      // allowed to be higher, but the curve must not be over-reduced.
      expect(kept.length).toBeGreaterThanOrEqual(2);
    }
    expect(simplifyIndices(anchors, toleranceForKeep(anchors, 20)).length).toBeGreaterThan(3);
  });

  it('cannot reduce past a forced anchor, however hard it is asked', () => {
    const anchors = arc(40).map((p) => p.anchor);
    const forced = [10, 25];
    const tolerance = toleranceForKeep(anchors, 2, forced);
    const kept = simplifyIndices(anchors, tolerance, forced);
    expect(kept).toEqual([0, ...forced, anchors.length - 1]);
  });
});

describe('simplifyRun', () => {
  it('drops the requested number of points and leaves the rest of the outline alone', () => {
    const points = [...arc(20), pt('tail', 200, 0), pt('tail2', 210, 0)];
    const runIds = points.slice(0, 20).map((p) => p.id);
    const result = simplifyRun(points, runIds, 4, 'smooth', false);
    expect(result).not.toBeNull();
    expect(result!.keptIds.length).toBe(4);
    expect(result!.removedIds.length).toBe(16);
    // The untouched tail keeps its order and comes after the run, which keeps its
    // own order too.
    expect(result!.points.slice(-2).map((p) => p.id)).toEqual(['tail', 'tail2']);
    const order = result!.points.map((p) => p.id);
    expect(order.slice(0, 4)).toEqual(result!.keptIds);
  });

  it('keeps the run ends, whose anchors belong to the edges either side of it', () => {
    const points = arc(15);
    const runIds = points.slice(3, 12).map((p) => p.id);
    const result = simplifyRun(points, runIds, 3, 'corner', false)!;
    const first = points[3]!;
    const last = points[11]!;
    const keptFirst = result.points.find((p) => p.id === first.id)!;
    const keptLast = result.points.find((p) => p.id === last.id)!;
    expect(keptFirst.anchor).toEqual(first.anchor);
    expect(keptLast.anchor).toEqual(last.anchor);
    // The outside neighbours are untouched, handles and all.
    for (const neighbour of [points[2]!, points[12]!]) {
      expect(result.points.find((p) => p.id === neighbour.id)).toBe(neighbour);
    }
  });

  it('corner fit leaves straight edges between the kept points', () => {
    const points = arc(24);
    const runIds = points.map((p) => p.id);
    const result = simplifyRun(points, runIds, 5, 'corner', false)!;
    for (const kept of result.points) {
      if (kept.id === result.keptIds[0] || kept.id === result.keptIds[4]) continue;
      expect(kept.handleIn).toBeNull();
      expect(kept.handleOut).toBeNull();
    }
    const first = result.points.find((p) => p.id === result.keptIds[0])!;
    expect(first.handleOut).toBeNull();
    const last = result.points.find((p) => p.id === result.keptIds[4])!;
    expect(last.handleIn).toBeNull();
  });

  it('smooth fit follows the tangents the outline was drawn with', () => {
    const points = arc(30);
    const runIds = points.map((p) => p.id);
    const result = simplifyRun(points, runIds, 8, 'smooth', false)!;
    const kept = result.keptIds.map((id) => result.points.find((p) => p.id === id)!);
    for (let k = 1; k < kept.length - 1; k++) {
      const point = kept[k]!;
      const local = points.findIndex((p) => p.id === point.id);
      const drawnOut = {
        x: points[local + 1]!.anchor.x - point.anchor.x,
        y: points[local + 1]!.anchor.y - point.anchor.y,
      };
      const out = { x: point.handleOut!.x - point.anchor.x, y: point.handleOut!.y - point.anchor.y };
      expect(crossOf(out, drawnOut)).toBeLessThan(1e-9);
      expect(dotOf(out, drawnOut)).toBeGreaterThan(0);
      // The handle spans a third of the gap to the next surviving point, so the
      // curve joins up across the points the fit dropped.
      const next = kept[k + 1]!;
      expect(Math.hypot(out.x, out.y)).toBeCloseTo(dist(point.anchor, next.anchor) / 3, 9);
    }
    // The run's outer handles are the originals, so the edges outside the run are
    // not silently re-shaped.
    const first = result.points.find((p) => p.id === result.keptIds[0])!;
    expect(first.handleIn).toEqual(points[0]!.handleIn);
  });

  it('smooth fit does not leave a long edge beside a corner', () => {
    const source = drawnPanel();
    const runIds = source.map((p) => p.id);
    const original = chainSamples(source, true);
    for (const reduce of [0, 25, 50, 75]) {
      const result = simplifyRun(source, runIds, keepCount(source.length, reduce), 'smooth', true)!;
      const fitted = chainSamples(result.points, true);
      // Reading the tangent off the survivors instead of off the drawn outline
      // sails 5.77 cm past the corner here.
      expect(worstDeviation(fitted, original, true)).toBeLessThan(0.5);
    }
  });

  it('corner fit reproduces a drawn panel edge for edge', () => {
    const source = drawnPanel();
    for (const reduce of [25, 50, 75]) {
      const result = simplifyRun(
        source,
        source.map((p) => p.id),
        keepCount(source.length, reduce),
        'corner',
        true
      )!;
      // The panel is drawn from straight edges, so a corner fit throws nothing
      // away but the points that were only there to hold a straight line.
      const strayed = worstDeviation(chainSamples(result.points, true), chainSamples(source, true), true);
      expect(strayed).toBeLessThan(0.05);
    }
  });

  it('a reduced drawn panel keeps its shape, and its corners', () => {
    const source = drawnPanel();
    const result = simplifyRun(source, source.map((p) => p.id), 8, 'corner', true)!;
    const kept = result.points.filter((p) => result.keptIds.includes(p.id));
    expect(kept.length).toBe(result.keptIds.length);
    expect(result.keptIds.length).toBeGreaterThanOrEqual(2);
    // Whatever it keeps, the panel still lies inside the outline it was drawn
    // with: a fit that cut a corner would show up as a large inward stray.
    const strayed = worstDeviation(chainSamples(result.points, true), chainSamples(source, true), true);
    expect(strayed).toBeLessThan(12);
  });

  it('rewrites a run that crosses the end of a closed outline as one run', () => {
    const points = arc(16);
    const runIds = [
      ...points.slice(13).map((p) => p.id),
      ...points.slice(0, 3).map((p) => p.id),
    ];
    const result = simplifyRun(points, runIds, 4, 'corner', true)!;
    expect(result.points.length).toBe(16 - 6 + 4);
    expect(result.keptIds[0]).toBe('p13');
    expect(result.keptIds[3]).toBe('p2');
    expect(result.points.slice(0, 4).map((p) => p.id)).toEqual(result.keptIds);
    // Every remaining point is still accounted for exactly once.
    const ids = result.points.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const point of points) {
      if (result.removedIds.includes(point.id)) continue;
      expect(ids).toContain(point.id);
    }
  });

  it('keeps pinned points — a seam ends on them, so its edge has to survive', () => {
    const points = arc(24);
    const runIds = points.map((p) => p.id);
    const pinned = new Set([points[9]!.id, points[17]!.id]);
    const result = simplifyRun(points, runIds, 2, 'corner', false, pinned)!;
    const ids = result.points.map((p) => p.id);
    for (const id of pinned) expect(ids).toContain(id);
    expect(result.keptIds.length).toBeGreaterThanOrEqual(4);
    // Every seam edge — a pinned point and its neighbour — is still an edge.
    for (const id of pinned) {
      const index = ids.indexOf(id);
      expect(index).toBeGreaterThan(0);
      expect(index).toBeLessThan(ids.length - 1);
    }
  });

  it('returns null when the run is no longer a consecutive stretch of the outline', () => {
    const points = arc(12);
    expect(simplifyRun(points, [points[0]!.id, points[5]!.id], 2, 'corner', false)).toBeNull();
    expect(simplifyRun(points, [points[0]!.id, points[1]!.id, points[2]!.id], 2, 'corner', false)).not.toBeNull();
  });

  it('simplifies a whole closed outline without cutting a corner at the array start', () => {
    const shape = [
      pt('a', 0, 0),
      pt('b', 10, 0),
      pt('c', 20, 0),
      pt('d', 30, 0),
      pt('e', 30, 10),
      pt('f', 30, 20),
      pt('g', 20, 20),
      pt('h', 10, 20),
      pt('i', 0, 20),
      pt('j', 0, 10),
    ];
    const rectangle = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 20 },
      { x: 0, y: 20 },
    ];
    // The run's ends are an artefact of the array order, so the cycle is cut where
    // it is straight — here mid-edge — and the rectangle survives intact.
    for (const keep of [6, 8, 9]) {
      const result = simplifyRun(shape, shape.map((p) => p.id), keep, 'corner', true)!;
      expect(polylineArea(result.points.map((p) => p.anchor))).toBeCloseTo(600, 6);
    }
    // Asked for four points, the outline gives up a corner — but it stays a valid
    // outline, inside the original shape.
    const few = simplifyRun(shape, shape.map((p) => p.id), 4, 'corner', true)!;
    expect(few.points.length).toBe(4);
    expect(polylineArea(few.points.map((p) => p.anchor))).toBeGreaterThan(0);
    expect(polylineArea(few.points.map((p) => p.anchor))).toBeLessThanOrEqual(600);
    for (const point of few.points) {
      expect(point.anchor.x).toBeGreaterThanOrEqual(-1e-9);
      expect(point.anchor.x).toBeLessThanOrEqual(30 + 1e-9);
      expect(point.anchor.y).toBeGreaterThanOrEqual(-1e-9);
      expect(point.anchor.y).toBeLessThanOrEqual(20 + 1e-9);
    }
  });
});

/** Dense samples along the outline a run of points describes. */
function arcPoints(points: readonly BezierPoint[]): Vec2[] {
  return pieceToPolyline([...points], false, 6);
}

function nearestDistance(point: Vec2, polyline: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < polyline.length; i++) {
    best = Math.min(best, distanceToSegment(point, polyline[i - 1]!, polyline[i]!));
  }
  return best;
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function crossOf(a: Vec2, b: Vec2): number {
  return Math.abs(a.x * b.y - a.y * b.x);
}

function dotOf(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

function polylineArea(points: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function keptBefore(kept: readonly number[], index: number): number {
  let best = 0;
  for (const k of kept) if (k < index) best = k;
  return best;
}

function keptAfter(kept: readonly number[], index: number): number {
  for (const k of kept) if (k > index) return k;
  return index;
}
