import type { BezierPoint, Vec2 } from '../project/types';

/**
 * Stitching an outline together from walks of other outlines.
 *
 * A fuse and a bridge both end up with kept walks of two pieces to run together
 * into one ring, and both have to ask the same questions about the result: do
 * the walks meet, and does the ring they make cross itself? Keeping that here
 * means the two tools agree on what a clean outline is.
 */

/** How close two joints have to be to be read as the same point, in cm. */
export const JOINT_EPS = 1e-4;

export type RingDraft = { ring: BezierPoint[]; idAliases: Record<string, string> };

export const sameSpot = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a.x - b.x) <= JOINT_EPS && Math.abs(a.y - b.y) <= JOINT_EPS;

export function cloneHandle(handle: Vec2 | null): Vec2 | null {
  return handle ? { x: handle.x, y: handle.y } : null;
}

export function polygonArea(points: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * One outline from the kept walks and the straight edges between them.
 *
 * Each walk ends where its own run started, so the edge leaves there and the
 * next walk picks it up where that run ended; the last walk's end is closed back
 * onto the first. Every joint squares off the handle that used to run along the
 * picked edges — the join across them is straight — while the handles describing
 * the pieces' own outlines come through as they were. Where two joints sit at
 * the same spot (the halves of a knife cut, say) they become one vertex carrying
 * both of their outline handles.
 */
export function joinRing(walksIn: BezierPoint[][]): RingDraft {
  const walks = walksIn.map((walk) =>
    walk.map((point, i) => ({
      ...point,
      handleIn: i === 0 ? null : cloneHandle(point.handleIn),
      handleOut: i === walk.length - 1 ? null : cloneHandle(point.handleOut),
    }))
  );

  const ring: BezierPoint[] = [];
  const idAliases: Record<string, string> = {};
  for (const walk of walks) {
    for (const point of walk) {
      const last = ring[ring.length - 1];
      if (last && sameSpot(last.anchor, point.anchor)) {
        // The walk in hand and the walk that follows meet here: one vertex, and
        // it keeps a handle into each of them.
        idAliases[point.id] = last.id;
        ring[ring.length - 1] = { ...last, handleOut: cloneHandle(point.handleOut) };
        continue;
      }
      ring.push(point);
    }
  }

  if (ring.length > 2 && sameSpot(ring[ring.length - 1].anchor, ring[0].anchor)) {
    const dropped = ring.pop() as BezierPoint;
    idAliases[dropped.id] = ring[0].id;
    ring[0] = { ...ring[0], handleIn: cloneHandle(dropped.handleIn) };
  }
  return { ring, idAliases };
}

/**
 * Does this outline cross itself? Neighbouring edges are welcome to share an
 * end — that is just a corner — but not to run back along each other, and no
 * two edges may cut across one another.
 */
export function isSimpleRing(poly: readonly Vec2[]): boolean {
  const n = poly.length;
  if (n < 4) return true;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (crosses(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

/**
 * A proper crossing: two edges that touch end to end do not count, but two that
 * run back along each other do — an outline cannot double up on its own line,
 * which is what an edge drawn between runs that face away from each other would
 * do.
 */
function crosses(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const side = (p: Vec2, q: Vec2, r: Vec2): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = side(a, b, c);
  const abD = side(a, b, d);
  const cdA = side(c, d, a);
  const cdB = side(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  const span = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(d.x - c.x), Math.abs(d.y - c.y), 1);
  const flat = 1e-12 * span * span;
  if (Math.abs(abC) > flat || Math.abs(abD) > flat) return false;
  const horizontal =
    Math.abs(b.x - a.x) + Math.abs(d.x - c.x) >= Math.abs(b.y - a.y) + Math.abs(d.y - c.y);
  const at = (p: Vec2): number => (horizontal ? p.x : p.y);
  const overlap =
    Math.min(Math.max(at(a), at(b)), Math.max(at(c), at(d))) -
    Math.max(Math.min(at(a), at(b)), Math.min(at(c), at(d)));
  return overlap > JOINT_EPS;
}
