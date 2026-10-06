/**
 * Where a body mesh sits vertically, and how to rest it on the floor.
 *
 * Two frames are in play for a generated avatar:
 *  - **mesh space** — the MakeHuman base mesh's own frame, hips at y = 0, feet
 *    below (about −8.2 dm on a neutral body). Morphs, measurement rulers and the
 *    3D preview all live here.
 *  - **body space** — mesh space shifted up so the feet rest on y = 0. This is
 *    where the cloth is simulated, where `AvatarBody` renders and collides, and
 *    where the pattern view's avatar silhouette is aligned.
 *
 * Anything that crosses between the two — the render body, the collision mesh an
 * SDF is baked from — has to use *this* function, so the two can never drift
 * apart by a body's worth of height.
 */

/** Shift that moves `positions` from mesh space to body space (add it to y). */
export function floorLift(positions: Float32Array): number {
  let minY = Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i]!;
    if (y < minY) minY = y;
  }
  if (!Number.isFinite(minY)) return 0;
  // Never return -0: callers compare this against 0 to mean "already on the floor".
  return minY === 0 ? 0 : -minY;
}

/** `positions` shifted so the lowest vertex sits on y = 0. Returns a copy. */
export function toBodySpace(positions: Float32Array, lift: number): Float32Array {
  if (!Number.isFinite(lift) || Math.abs(lift) < 1e-9) return positions.slice();
  const out = positions.slice();
  for (let i = 1; i < out.length; i += 3) out[i] += lift;
  return out;
}
