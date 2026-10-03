/**
 * High-level generated-avatar mesh service: load MakeHuman assets, solve the
 * measurement-driven morph, and emit
 *  - a **render** mesh (body-only, includes the head), and
 *  - a **collision** mesh (head removed at the neck, kept watertight) for SDF baking.
 *
 * Both are in the base mesh's decimetres; `unitToWorld` for the base mesh is 1.0
 * (1 dm = 10 cm = 1 world unit).
 */

import {
  buildRenderMesh,
  compactMesh,
  type BaseMeshSource,
  type RenderMesh,
} from './makehuman/baseMesh';
import { generateAvatar } from './makehuman/generate';
import {
  loadMakeHumanBase,
  loadMakeHumanTargets,
  makeTargetResolver,
} from './makehuman/makehumanAssets';

/** Top of the neck / base of the head in the neutral base mesh (see `neck-height` ruler). */
export const NECK_TOP_VERTEX = 853;

/** Bump when the vendored MakeHuman assets or the morph recipe change. */
export const AVATAR_ASSET_VERSION = 1;

/** 1 dm = 10 cm = 1 world unit (CM_TO_WORLD = 0.1). */
export const MAKEHUMAN_UNIT_TO_WORLD = 1;

export type AvatarMeshInput = {
  gender: number;
  heightCm?: number;
  measurements?: Record<string, number>;
  onProgress?: (done: number, total: number) => void;
};

export type GeneratedAvatarMesh = {
  cacheKey: string;
  /** Full deformed positions (decimetres, MakeHuman vertex numbering) — for measurement rulers. */
  positions: Float32Array;
  /** Body-only mesh (includes head/neck), decimetres. */
  render: RenderMesh;
  /** Headless neck-preserving mesh for SDF baking, decimetres. */
  collision: { positions: Float32Array; indices: Uint32Array };
  /** Every readable measurement on the generated body (cm). */
  measured: Record<string, number>;
  /** Driven goals outside MakeHuman's achievable slider range. */
  saturated: string[];
  /** Fields the solver drove from entered measurements. */
  driven: string[];
  /** Plane-slice/landmark measurement polylines (decimetres) keyed by field. */
  rulerPolylines: Record<string, Float32Array>;
  gender: number;
  heightCm: number;
};

export function avatarMeshCacheKey(input: {
  gender: number;
  heightCm?: number;
  measurements?: Record<string, number>;
}): string {
  const parts = [
    `v${AVATAR_ASSET_VERSION}`,
    `g${input.gender.toFixed(3)}`,
    `h${(input.heightCm ?? 0).toFixed(1)}`,
  ];
  const measurements = input.measurements ?? {};
  for (const key of Object.keys(measurements).sort()) {
    parts.push(`${key}:${measurements[key]!.toFixed(2)}`);
  }
  return parts.join('|');
}

/**
 * Clip everything above `planeY` and snap straddling triangles onto the plane.
 *
 * Snapping (rather than dropping) keeps the surface closed, so the SDF's
 * ray-parity sign test stays valid without a separate cap pass.
 */
export function clipAbovePlane(
  positions: Float32Array,
  indices: Uint32Array,
  planeY: number
): { positions: Float32Array; indices: Uint32Array } {
  const outPositions = positions.slice();
  const kept: number[] = [];

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    const aAbove = outPositions[a * 3 + 1]! > planeY;
    const bAbove = outPositions[b * 3 + 1]! > planeY;
    const cAbove = outPositions[c * 3 + 1]! > planeY;
    const aboveCount = (aAbove ? 1 : 0) + (bAbove ? 1 : 0) + (cAbove ? 1 : 0);
    if (aboveCount === 3) continue;

    if (aAbove) outPositions[a * 3 + 1] = planeY;
    if (bAbove) outPositions[b * 3 + 1] = planeY;
    if (cAbove) outPositions[c * 3 + 1] = planeY;
    kept.push(a, b, c);
  }

  const mesh = compactMesh(outPositions, Uint32Array.from(kept));
  return { positions: mesh.positions, indices: mesh.indices };
}

export async function generateAvatarMesh(input: AvatarMeshInput): Promise<GeneratedAvatarMesh> {
  const base: BaseMeshSource = await loadMakeHumanBase();
  const targets = await loadMakeHumanTargets(input.onProgress);
  const resolve = makeTargetResolver(targets);

  const result = generateAvatar({
    base: base.positions,
    indices: base.bodyTriangleIndices,
    resolve,
    gender: input.gender,
    heightCm: input.heightCm,
    measurements: input.measurements,
  });

  const render = buildRenderMesh(base, result.positions);
  const neckTopY = result.positions[NECK_TOP_VERTEX * 3 + 1]!;
  const collision = clipAbovePlane(render.positions, render.indices, neckTopY);

  return {
    cacheKey: avatarMeshCacheKey(input),
    positions: result.positions,
    render,
    collision,
    measured: result.measured,
    saturated: result.saturated,
    driven: result.driven,
    rulerPolylines: result.rulerPolylines,
    gender: input.gender,
    heightCm: result.measured.height,
  };
}
