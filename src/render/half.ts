/**
 * IEEE 754 binary16 conversion.
 *
 * Decoded HDRIs arrive as 32-bit floats, but `rgba32float` is neither filterable
 * nor renderable in core WebGPU. `rgba16float` is both, and half precision is
 * ample for an environment map — the eye cannot tell, and the textures halve.
 */

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** Round-to-nearest-even conversion of a single float to half, as a 16-bit int. */
export function floatToHalf(value: number): number {
  F32[0] = value;
  const bits = U32[0]!;

  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;

  if (exponent === 0xff) {
    // Inf or NaN: keep the payload, but a NaN must not collapse to Inf.
    return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  }

  // Rebias 127 -> 15.
  let e = exponent - 127 + 15;

  if (e >= 0x1f) {
    // Too large for half: infinity is the correct rounding of an overflow.
    return sign | 0x7c00;
  }

  if (e <= 0) {
    // Subnormal, or underflow to zero.
    if (e < -10) return sign;
    const m = (mantissa | 0x800000) >>> (1 - e);
    // Round half to even on the 13 dropped bits.
    const rounded = m + ((m >>> 13) & 1) + 0x0fff;
    return sign | (rounded >>> 13);
  }

  const rounded = mantissa + ((mantissa >>> 13) & 1) + 0x0fff;
  if (rounded & 0x800000) {
    // Rounding carried into the exponent.
    e += 1;
    if (e >= 0x1f) return sign | 0x7c00;
    return sign | (e << 10);
  }
  return sign | (e << 10) | (rounded >>> 13);
}

/**
 * Largest finite binary16 value. Anything above it becomes Inf in a half-float
 * texture, and Inf is contagious: hardware filtering multiplies it by a weight
 * of zero somewhere and hands back NaN, which then spreads through every pass
 * that reads the texture.
 */
export const HALF_FLOAT_MAX = 65504;

/**
 * Clamp HDR data into the range a half-float texture can actually hold.
 *
 * Real HDRIs do exceed it — a night street lamp in `hdri/` peaks at 4.2e5 — and
 * `floatToHalf` correctly rounds those to Inf. That is the right answer for a
 * conversion and the wrong answer for an environment map, so the data is
 * sanitised before it is uploaded: non-finite texels become black, negative
 * radiance is not a thing, and the ceiling is the representable maximum.
 *
 * Mutates in place and reports what it changed, so callers can surface it.
 */
export function clampToHalfRange(values: Float32Array): {
  clamped: number;
  nonFinite: number;
} {
  let clamped = 0;
  let nonFinite = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (!Number.isFinite(value)) {
      values[i] = 0;
      nonFinite++;
    } else if (value > HALF_FLOAT_MAX) {
      values[i] = HALF_FLOAT_MAX;
      clamped++;
    } else if (value < 0) {
      values[i] = 0;
    }
  }
  return { clamped, nonFinite };
}

/** Convert a float array to half floats, writing into a preallocated buffer. */
export function floatsToHalves(values: ArrayLike<number>, out: Uint16Array): Uint16Array {
  if (out.length < values.length) {
    throw new Error(`Half buffer too small: ${out.length} < ${values.length}`);
  }
  for (let i = 0; i < values.length; i++) out[i] = floatToHalf(values[i]!);
  return out;
}
