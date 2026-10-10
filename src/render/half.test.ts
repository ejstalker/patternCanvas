import { describe, expect, it } from 'vitest';
import { HALF_FLOAT_MAX, clampToHalfRange, floatToHalf, floatsToHalves } from './half';

/** Read a half back as a float, so the assertions read like the input values. */
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? Number.NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

describe('floatToHalf', () => {
  it('round-trips values a half can hold exactly', () => {
    const exact = [0, 1, -1, 0.5, 2, -2.5, 1024, 0.125, 65504];
    for (const value of exact) {
      expect(halfToFloat(floatToHalf(value))).toBe(value);
    }
  });

  it('keeps HDRI range values close enough to be invisible', () => {
    // Environment maps carry real highlights well above 1.0.
    for (const value of [1.5, 12.5, 100, 1000, 20000]) {
      const back = halfToFloat(floatToHalf(value));
      expect(Math.abs(back - value) / value).toBeLessThan(0.001);
    }
  });

  it('saturates rather than wrapping when the value is out of range', () => {
    expect(halfToFloat(floatToHalf(1e6))).toBe(Infinity);
    expect(halfToFloat(floatToHalf(-1e6))).toBe(-Infinity);
  });

  it('keeps the sign of the smallest subnormals', () => {
    expect(halfToFloat(floatToHalf(1e-8))).toBe(0);
    expect(halfToFloat(floatToHalf(-1e-8))).toBe(-0);
    expect(Math.sign(halfToFloat(floatToHalf(-1e-6)))).toBe(-1);
  });

  it('distinguishes NaN from infinity', () => {
    expect(Number.isNaN(halfToFloat(floatToHalf(Number.NaN)))).toBe(true);
    expect(halfToFloat(floatToHalf(Infinity))).toBe(Infinity);
  });
});

describe('floatsToHalves', () => {
  it('converts a whole buffer in place order', () => {
    const out = floatsToHalves([1, 2, 4], new Uint16Array(3));
    expect([...out].map(halfToFloat)).toEqual([1, 2, 4]);
  });

  it('refuses a buffer that is too small', () => {
    expect(() => floatsToHalves([1, 2, 3], new Uint16Array(2))).toThrow(/too small/);
  });
});

describe('clampToHalfRange', () => {
  it('pulls overflow down to the largest finite half float', () => {
    // 65504 is representable; one ulp above it is not.
    const data = new Float32Array([0, 1, 65504, 65505, 4.2e5, -1]);
    const report = clampToHalfRange(data);
    expect(Array.from(data)).toEqual([0, 1, HALF_FLOAT_MAX, HALF_FLOAT_MAX, HALF_FLOAT_MAX, 0]);
    expect(report.clamped).toBe(2);
    expect(report.nonFinite).toBe(0);
  });

  it('blacks out NaN and infinity rather than letting them spread', () => {
    const data = new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2]);
    const report = clampToHalfRange(data);
    expect(Array.from(data)).toEqual([0, 0, 0, 2]);
    expect(report.nonFinite).toBe(3);
    expect(report.clamped).toBe(0);
  });

  it('leaves usable data untouched', () => {
    const data = new Float32Array([0.5, 1, 100, HALF_FLOAT_MAX]);
    const report = clampToHalfRange(data);
    expect(report).toEqual({ clamped: 0, nonFinite: 0 });
    expect(Array.from(data)).toEqual([0.5, 1, 100, HALF_FLOAT_MAX]);
  });
});
