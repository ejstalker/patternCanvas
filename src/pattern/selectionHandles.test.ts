import { describe, expect, it } from 'vitest';
import {
  CORNER_HANDLES,
  angleAbout,
  boxContains,
  cornerGrips,
  handleCentre,
  rotatePoint,
  rotateZoneAt,
  rotateZoneHandle,
  snapAngle,
  type SelectionBox,
} from './selectionHandles';

const box: SelectionBox = { minX: 0, minY: 0, maxX: 100, maxY: 60 };

describe('selection handle geometry', () => {
  it('places every grip where the box says it is', () => {
    expect(handleCentre(box, 'nw')).toEqual({ x: 0, y: 0 });
    expect(handleCentre(box, 'ne')).toEqual({ x: 100, y: 0 });
    expect(handleCentre(box, 'sw')).toEqual({ x: 0, y: 60 });
    expect(handleCentre(box, 'se')).toEqual({ x: 100, y: 60 });
    expect(handleCentre(box, 'n')).toEqual({ x: 50, y: 0 });
    expect(handleCentre(box, 's')).toEqual({ x: 50, y: 60 });
    expect(handleCentre(box, 'w')).toEqual({ x: 0, y: 30 });
    expect(handleCentre(box, 'e')).toEqual({ x: 100, y: 30 });
  });

  it('marks the box, edges included', () => {
    expect(boxContains(box, { x: 50, y: 30 })).toBe(true);
    expect(boxContains(box, { x: 0, y: 0 })).toBe(true);
    expect(boxContains(box, { x: 100, y: 60 })).toBe(true);
    expect(boxContains(box, { x: 101, y: 30 })).toBe(false);
    expect(boxContains(box, { x: 50, y: -1 })).toBe(false);
  });

  it('gives the rotate zones to the corners only', () => {
    expect([...CORNER_HANDLES]).toEqual(['nw', 'ne', 'sw', 'se']);
    expect(cornerGrips(box).map((g) => g.handle)).toEqual([...CORNER_HANDLES]);
  });
});

describe('the rotate zone beside a corner grip', () => {
  const inner = 7;
  const outer = 20;

  it('is the annulus around the corner, not the grip itself', () => {
    // On the grip: that is a scale, and the grip's own element gets the event.
    expect(rotateZoneAt({ x: 0, y: 0 }, box, inner, outer)).toBeNull();
    expect(rotateZoneAt({ x: 3, y: 2 }, box, inner, outer)).toBeNull();
    // Just outside it: rotate.
    expect(rotateZoneAt({ x: -10, y: 0 }, box, inner, outer)).toBe('nw');
    expect(rotateZoneAt({ x: 5, y: -13 }, box, inner, outer)).toBe('nw');
    // Too far: nothing.
    expect(rotateZoneAt({ x: -25, y: 0 }, box, inner, outer)).toBeNull();
    expect(rotateZoneAt({ x: 50, y: 30 }, box, inner, outer)).toBeNull();
  });

  it('is trimmed to outside the box, so a small selection still moves', () => {
    const small: SelectionBox = { minX: 0, minY: 0, maxX: 30, maxY: 30 };
    // 10 out from the sw corner is inside this box, and inside means move.
    expect(rotateZoneAt({ x: 10, y: 25 }, small, inner, outer)).toBeNull();
    // The same distance on the outside of the corner rotates.
    const r = 13 / Math.SQRT2;
    expect(rotateZoneAt({ x: -r, y: -r }, small, inner, outer)).toBe('nw');
    // Still inside the box, even though it is in the corner's annulus.
    expect(rotateZoneAt({ x: r, y: r }, small, inner, outer)).toBeNull();
  });

  it('answers with the nearest corner when zones overlap', () => {
    const small: SelectionBox = { minX: 0, minY: 0, maxX: 24, maxY: 24 };
    // Between nw and ne, just above the top edge, a little closer to ne.
    expect(rotateZoneAt({ x: 20, y: -12 }, small, inner, outer)).toBe('ne');
    expect(rotateZoneAt({ x: 4, y: -12 }, small, inner, outer)).toBe('nw');
  });

  it('ignores anything within the grip radius, whatever the corner', () => {
    const corners = cornerGrips(box);
    expect(rotateZoneHandle({ x: 100, y: 60 }, corners, inner, outer)).toBeNull();
    expect(rotateZoneHandle({ x: 100, y: 60 + 12 }, corners, inner, outer)).toBe('se');
    expect(rotateZoneHandle({ x: 100, y: 60 + 40 }, corners, inner, outer)).toBeNull();
  });
});

describe('rotation maths', () => {
  it('measures an angle about a pivot', () => {
    const pivot = { x: 10, y: 10 };
    expect(angleAbout({ x: 20, y: 10 }, pivot)).toBeCloseTo(0, 9);
    // Pattern y runs down, so a positive angle is clockwise on screen.
    expect(angleAbout({ x: 10, y: 20 }, pivot)).toBeCloseTo(Math.PI / 2, 9);
    expect(angleAbout({ x: 0, y: 10 }, pivot)).toBeCloseTo(Math.PI, 9);
  });

  it('turns a point about a pivot', () => {
    const pivot = { x: 5, y: 5 };
    const turned = rotatePoint({ x: 8, y: 5 }, pivot, Math.PI / 2);
    expect(turned.x).toBeCloseTo(5, 9);
    expect(turned.y).toBeCloseTo(8, 9);
  });

  it('keeps distances and reads back the angle it turned through', () => {
    const pivot = { x: -3, y: 7 };
    const p = { x: 11, y: -2 };
    const before = Math.hypot(p.x - pivot.x, p.y - pivot.y);
    const angle = 0.7;
    const turned = rotatePoint(p, pivot, angle);
    expect(Math.hypot(turned.x - pivot.x, turned.y - pivot.y)).toBeCloseTo(before, 9);
    expect(angleAbout(turned, pivot)).toBeCloseTo(angleAbout(p, pivot) + angle, 9);
  });

  it('is its own inverse when turned back', () => {
    const pivot = { x: 40, y: 12 };
    const p = { x: -6, y: 25 };
    const there = rotatePoint(p, pivot, 1.234);
    const back = rotatePoint(there, pivot, -1.234);
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('snaps to whole steps, and passes anything through when the step is not positive', () => {
    const step = Math.PI / 12; // 15°, the step the ruler's own turn gesture uses
    const deg = Math.PI / 180;
    // 7° is nearest 0°, 8° is nearest 15°.
    expect(snapAngle(7 * deg, step)).toBeCloseTo(0, 9);
    expect(snapAngle(8 * deg, step)).toBeCloseTo(step, 9);
    expect(snapAngle(-8 * deg, step)).toBeCloseTo(-step, 9);
    // 22° is nearest 15°, 23° is nearest 30°.
    expect(snapAngle(22 * deg, step)).toBeCloseTo(step, 9);
    expect(snapAngle(23 * deg, step)).toBeCloseTo(2 * step, 9);
    expect(snapAngle(0.3, 0)).toBeCloseTo(0.3, 9);
  });
});
