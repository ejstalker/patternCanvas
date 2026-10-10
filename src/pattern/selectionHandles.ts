/**
 * Selection transform handles: which grip a pointer is on, and what the near-miss
 * gesture around a corner should do.
 *
 * The editor's selection box carries eight scale grips — four corners and four
 * edge midpoints — and, just outside each corner, a rotate zone. Illustrator's
 * rule, and the reason the zone exists at all: the grips are small and exact, so
 * "rotate this" is the gesture you reach for when you are *near* a corner rather
 * than on it, and a drag that starts a few pixels out has to mean rotate instead
 * of a marquee.
 *
 * Pure geometry, so the rules can be tested without a DOM.
 */

import type { Vec2 } from '../project/types';

export type ScaleHandle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 'e' | 's' | 'w';

/** Handles that carry a rotate zone beside them: corners only. */
export const CORNER_HANDLES: readonly ScaleHandle[] = ['nw', 'ne', 'sw', 'se'];

export type SelectionBox = { minX: number; minY: number; maxX: number; maxY: number };

/** Centre of a handle, in the same space as the box. */
export function handleCentre(box: SelectionBox, handle: ScaleHandle): Vec2 {
  const midX = (box.minX + box.maxX) / 2;
  const midY = (box.minY + box.maxY) / 2;
  switch (handle) {
    case 'nw':
      return { x: box.minX, y: box.minY };
    case 'ne':
      return { x: box.maxX, y: box.minY };
    case 'sw':
      return { x: box.minX, y: box.maxY };
    case 'se':
      return { x: box.maxX, y: box.maxY };
    case 'n':
      return { x: midX, y: box.minY };
    case 's':
      return { x: midX, y: box.maxY };
    case 'w':
      return { x: box.minX, y: midY };
    case 'e':
      return { x: box.maxX, y: midY };
  }
}

/** True when `p` is inside the box (on an edge counts as inside). */
export function boxContains(box: SelectionBox, p: Vec2): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

/** True when two boxes share any area (touching edges count). */
export function boxesOverlap(a: SelectionBox, b: SelectionBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * The corner whose rotate zone the pointer is in, or null.
 *
 * The zone is the annulus around a corner: outside `inner` (which keeps the grip
 * itself, and anything the grip is drawn over, free for scaling) and within
 * `outer`. Nearest corner wins, so the overlapping zones of a small selection
 * still answer with the corner you are closest to rather than an arbitrary one.
 *
 * Whether the pointer is *inside* the box is the caller's decision — a drag
 * inside the box means "move", so a zone that reaches inward must be trimmed by
 * `boxContains` before it is used.
 */
export function rotateZoneHandle(
  pointer: Vec2,
  corners: readonly { handle: ScaleHandle; centre: Vec2 }[],
  inner: number,
  outer: number
): ScaleHandle | null {
  let best: { handle: ScaleHandle; distance: number } | null = null;
  for (const corner of corners) {
    const distance = Math.hypot(pointer.x - corner.centre.x, pointer.y - corner.centre.y);
    if (distance <= inner || distance > outer) continue;
    if (!best || distance < best.distance) best = { handle: corner.handle, distance };
  }
  return best?.handle ?? null;
}

/** The four corner grips of a box, in the order they are drawn. */
export function cornerGrips(box: SelectionBox): Array<{ handle: ScaleHandle; centre: Vec2 }> {
  return CORNER_HANDLES.map((handle) => ({ handle, centre: handleCentre(box, handle) }));
}

/**
 * The corner whose rotate zone the pointer is in, or null.
 *
 * Inside the box is excluded: a drag that starts there means "move", and for a
 * small selection the annuli would otherwise cover the whole box.
 */
export function rotateZoneAt(
  pointer: Vec2,
  box: SelectionBox,
  inner: number,
  outer: number
): ScaleHandle | null {
  if (boxContains(box, pointer)) return null;
  return rotateZoneHandle(pointer, cornerGrips(box), inner, outer);
}

/** Angle of `p` about `pivot`, radians, measured from +x like `atan2`. */
export function angleAbout(p: Vec2, pivot: Vec2): number {
  return Math.atan2(p.y - pivot.y, p.x - pivot.x);
}

/** Rotate a point about a pivot. */
export function rotatePoint(p: Vec2, pivot: Vec2, angle: number): Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return {
    x: pivot.x + dx * cos - dy * sin,
    y: pivot.y + dx * sin + dy * cos,
  };
}

/** Snap an angle to the nearest multiple of `step` (radians). */
export function snapAngle(angle: number, step: number): number {
  if (!(step > 0)) return angle;
  return Math.round(angle / step) * step;
}
