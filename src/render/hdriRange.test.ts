/**
 * Every HDRI in `hdri/` has to survive the trip into an rgba16float texture.
 *
 * The danger is not the decode but the storage: a night scene with a lamp in it
 * holds radiance far above the half-float ceiling, `floatToHalf` rounds that to
 * Inf, and Inf in an environment map becomes NaN the moment the hardware filters
 * it — which shows up as the model dissolving into black-and-white static. So
 * the files are checked here as a group, and at least one is asserted to need
 * the clamp, because a test that passes vacuously is worse than no test.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeExr } from './exr';
import { HALF_FLOAT_MAX, clampToHalfRange } from './half';

const HDRI_DIR = resolve(process.cwd(), 'hdri');

function names(): string[] {
  return readdirSync(HDRI_DIR)
    .filter((file) => file.endsWith('.exr'))
    .sort();
}

function decode(name: string) {
  const raw = readFileSync(resolve(HDRI_DIR, name));
  const bytes = new Uint8Array(raw.byteLength);
  bytes.set(raw);
  return decodeExr(bytes.buffer);
}

describe('hdri/ value ranges', () => {
  it('has files that genuinely need clamping', () => {
    const overflowing = names().filter((name) => {
      const { data } = decode(name);
      return data.some((value) => value > HALF_FLOAT_MAX || !Number.isFinite(value));
    });
    expect(overflowing.length).toBeGreaterThan(0);
  });

  it('lands inside the half-float range once clamped', () => {
    for (const name of names()) {
      const { data } = decode(name);
      clampToHalfRange(data);
      // A plain loop: millions of `expect` calls would dominate the suite.
      let max = -Infinity;
      let nonFinite = 0;
      for (const value of data) {
        if (!Number.isFinite(value)) nonFinite++;
        else if (value > max) max = value;
      }
      expect({ name, nonFinite, over: max > HALF_FLOAT_MAX, max }).toEqual({
        name,
        nonFinite: 0,
        over: false,
        max,
      });
      expect(max, `${name} is not black`).toBeGreaterThan(0);
    }
  });
});
