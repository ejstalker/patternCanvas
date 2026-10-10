import { describe, expect, it } from 'vitest';
import { axisLockFromDelta } from './geometry';

describe('axis lock for Shift-held drags', () => {
  it('leaves movement free without Shift', () => {
    expect(axisLockFromDelta(10, 3, false)).toBeNull();
    expect(axisLockFromDelta(0, 0, false)).toBeNull();
  });

  it('locks to the axis the drag has moved along most', () => {
    expect(axisLockFromDelta(10, 3, true)).toBe('x');
    expect(axisLockFromDelta(-10, 3, true)).toBe('x');
    expect(axisLockFromDelta(2, -9, true)).toBe('y');
  });

  it('locks to x on a tie, including before any movement', () => {
    expect(axisLockFromDelta(5, 5, true)).toBe('x');
    expect(axisLockFromDelta(0, 0, true)).toBe('x');
  });
});
