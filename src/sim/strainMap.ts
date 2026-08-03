/** Stretch edge used for strain visualization (particle indices + rest length). */
export type StrainEdge = { i: number; j: number; rest: number };

/**
 * Map currentLen/rest → RGB (blue compression → green rest → red stretch).
 * Neutral band is ±15% around rest.
 */
export function strainRatioToRgb(ratio: number, out: Float32Array, offset: number): void {
  const t = Math.max(-1, Math.min(1, (ratio - 1) / 0.15));
  if (t < 0) {
    const u = t + 1; // 0 at full compress, 1 at rest
    out[offset] = 0.12 + 0.18 * u;
    out[offset + 1] = 0.45 + 0.35 * u;
    out[offset + 2] = 0.95 - 0.35 * u;
  } else {
    out[offset] = 0.3 + 0.65 * t;
    out[offset + 1] = 0.8 - 0.7 * t;
    out[offset + 2] = 0.28 * (1 - t);
  }
}

/**
 * Average per-edge stretch ratios onto vertices (equal weight per incident edge).
 * `positions` is xyz packed; `outColors` is rgb packed (same vertex count).
 */
export function fillStrainColors(
  positions: Float32Array | ArrayLike<number>,
  edges: readonly StrainEdge[],
  outColors: Float32Array
): void {
  const n = (outColors.length / 3) | 0;
  outColors.fill(0);
  const weights = new Float32Array(n);

  for (let e = 0; e < edges.length; e++) {
    const { i, j, rest } = edges[e]!;
    if (i < 0 || j < 0 || i >= n || j >= n || !(rest > 1e-8)) continue;
    const ix = i * 3;
    const jx = j * 3;
    const dx = positions[jx]! - positions[ix]!;
    const dy = positions[jx + 1]! - positions[ix + 1]!;
    const dz = positions[jx + 2]! - positions[ix + 2]!;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Inline strainRatioToRgb to avoid per-edge allocations.
    const t = Math.max(-1, Math.min(1, (len / rest - 1) / 0.15));
    let r: number;
    let g: number;
    let b: number;
    if (t < 0) {
      const u = t + 1;
      r = 0.12 + 0.18 * u;
      g = 0.45 + 0.35 * u;
      b = 0.95 - 0.35 * u;
    } else {
      r = 0.3 + 0.65 * t;
      g = 0.8 - 0.7 * t;
      b = 0.28 * (1 - t);
    }
    for (const v of [i, j]) {
      const o = v * 3;
      outColors[o]! += r;
      outColors[o + 1]! += g;
      outColors[o + 2]! += b;
      weights[v]! += 1;
    }
  }

  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    const o = i * 3;
    if (w > 0) {
      outColors[o]! /= w;
      outColors[o + 1]! /= w;
      outColors[o + 2]! /= w;
    } else {
      // Isolated verts: rest green
      strainRatioToRgb(1, outColors, o);
    }
  }
}
