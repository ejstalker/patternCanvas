/**
 * Linear morph-target engine.
 *
 * Ported from `makehuman/core/algos3d.py` (`Target.apply`) and the
 * `Human.applyAllTargets` / `targetsDetailStack` model: the deformed mesh is
 * always `base + sum(weight * delta)` — there is no base offset accumulation
 * between modifiers.
 */

import type { TargetDelta } from './targetFile';

export type TargetEntry = {
  delta: TargetDelta;
  /** Signed morph factor. */
  weight: number;
};

/**
 * Apply weighted target deltas to `base`.
 *
 * When `out` is provided it must be the same length as `base`; it is
 * overwritten. Otherwise a fresh array is returned and `base` is untouched.
 */
export function applyTargets(
  base: Float32Array,
  entries: Iterable<TargetEntry>,
  out?: Float32Array
): Float32Array {
  const dst = out && out.length === base.length ? out : new Float32Array(base.length);
  dst.set(base);

  for (const { delta, weight } of entries) {
    if (!weight) continue;
    const { indices, deltas } = delta;
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i]! * 3;
      dst[v] += deltas[i * 3]! * weight;
      dst[v + 1] += deltas[i * 3 + 1]! * weight;
      dst[v + 2] += deltas[i * 3 + 2]! * weight;
    }
  }

  return dst;
}
