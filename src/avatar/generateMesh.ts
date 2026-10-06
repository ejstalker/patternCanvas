/**
 * High-level generated-avatar mesh service: load MakeHuman assets, solve the
 * measurement-driven morph, and emit
 *  - a **render** mesh (body-only, includes the head), and
 *  - a **collision** mesh (head removed at the neck) for SDF baking.
 *
 * Both are in the base mesh's decimetres; `unitToWorld` for the base mesh is 1.0
 * (1 dm = 10 cm = 1 world unit).
 *
 * Two frames, deliberately:
 *  - **mesh space** — the MakeHuman frame, hips at y = 0, feet below. Morphs,
 *    rulers, the 3D preview and the pattern silhouette all work here.
 *  - **body space** — mesh space rested on the floor (feet at y = 0), which is
 *    where the cloth is simulated and where `AvatarBody` collides. The collision
 *    mesh, and therefore anything baked from it, is emitted in *this* frame,
 *    because an SDF is queried with world-space particle positions.
 */

import {
  buildRenderMesh,
  compactMesh,
  type BaseMeshSource,
  type RenderMesh,
} from './makehuman/baseMesh';
import { generateAvatar, type TargetResolver } from './makehuman/generate';
import {
  loadMakeHumanBase,
  loadMakeHumanTargets,
  makeTargetResolver,
} from './makehuman/makehumanAssets';
import { floorLift, toBodySpace } from '../mesh/floorLift';

/** Top of the neck / base of the head in the neutral base mesh (see `neck-height` ruler). */
export const NECK_TOP_VERTEX = 853;

/**
 * Bump when the vendored MakeHuman assets, the morph recipe or the collision
 * mesh change. Both the in-memory mesh cache and every SDF on disk are keyed by
 * it, so a bump retires them.
 */
export const AVATAR_ASSET_VERSION = 2;

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
  /** Body-only mesh (includes head/neck), decimetres, **mesh space**. */
  render: RenderMesh;
  /**
   * Headless neck-preserving mesh for SDF baking, **body space** (feet on y = 0)
   * so a volume baked from it lines up with the cloth and with `AvatarBody`.
   */
  collision: { positions: Float32Array; indices: Uint32Array };
  /** Mesh space → body space: add this to Y. See `src/mesh/floorLift.ts`. */
  floorLift: number;
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
 * Clip everything above `planeY`.
 *
 * Triangles are dropped only when all three vertices are above the plane;
 * anything straddling it is kept with its above vertices *snapped* onto the
 * plane. Snapping is what makes the cut flat, and it leaves no hole a viewer
 * would notice.
 *
 * It is not watertight in the parity sense, and `analyzeCollisionMesh` measures
 * that: a straddling triangle whose above-edge neighbour was dropped keeps that
 * edge to itself, so the cut leaves a few hundred one-sided edges, and the
 * snapped triangles pile up into an overlapping fan reaching well beyond the
 * neck's own cross-section. Both are latent in practice — the SDF's parity ray is
 * near-horizontal, so it barely ever meets the horizontal cut, and cloth never
 * sits within a collision margin of it — but do not read this as a closed cap.
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

export type CollisionMeshAnalysis = {
  vertices: number;
  triangles: number;
  /** Edges used by exactly one triangle: the surface is open along these. */
  openEdges: number;
  /** Edges used by three or more triangles. */
  nonManifoldEdges: number;
  /** Every edge shared by exactly two triangles. */
  watertight: boolean;
  /** Top and bottom of the mesh (decimetres). */
  maxY: number;
  minY: number;
  /** How far the flat top reaches from the vertical axis (decimetres). */
  cutReach: number;
};

/**
 * Cheap health check for a collision mesh: size, watertightness, and how far the
 * flat cut at the top spreads. The avatar editor reports these, so the numbers a
 * bake will be built from are visible instead of assumed.
 */
export function analyzeCollisionMesh(
  positions: Float32Array,
  indices: Uint32Array
): CollisionMeshAnalysis {
  const edges = new Map<number, number>();
  const vertexCount = positions.length / 3;
  const key = (a: number, b: number): number => (a < b ? a * vertexCount + b : b * vertexCount + a);

  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    for (let k = 0; k < 3; k++) {
      const e = key(tri[k]!, tri[(k + 1) % 3]!);
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }

  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edges.values()) {
    if (count === 1) openEdges++;
    else if (count > 2) nonManifoldEdges++;
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  let cutReach = 0;
  if (Number.isFinite(maxY)) {
    for (let i = 0; i < positions.length; i += 3) {
      if (Math.abs(positions[i + 1]! - maxY) > 1e-6) continue;
      cutReach = Math.max(cutReach, Math.hypot(positions[i]!, positions[i + 2]!));
    }
  }

  return {
    vertices: vertexCount,
    triangles: indices.length / 3,
    openEdges,
    nonManifoldEdges,
    watertight: openEdges === 0 && nonManifoldEdges === 0,
    maxY,
    minY,
    cutReach,
  };
}

/**
 * Solve the morph and build both meshes. Takes loaded assets, so tests can drive
 * it from files instead of the network.
 */
export function composeAvatarMesh(
  base: BaseMeshSource,
  resolve: TargetResolver,
  input: AvatarMeshInput
): GeneratedAvatarMesh {
  const result = generateAvatar({
    base: base.positions,
    indices: base.bodyTriangleIndices,
    resolve,
    gender: input.gender,
    heightCm: input.heightCm,
    measurements: input.measurements,
  });

  const render = buildRenderMesh(base, result.positions);
  // Cut in the morph's own frame (that is where the neck landmark lives), then
  // move the clipped result into the body frame the cloth collides in.
  const neckTopY = result.positions[NECK_TOP_VERTEX * 3 + 1]!;
  const clipped = clipAbovePlane(render.positions, render.indices, neckTopY);
  const lift = floorLift(render.positions);
  const collision = {
    positions: toBodySpace(clipped.positions, lift),
    indices: clipped.indices,
  };

  return {
    cacheKey: avatarMeshCacheKey(input),
    positions: result.positions,
    render,
    collision,
    floorLift: lift,
    measured: result.measured,
    saturated: result.saturated,
    driven: result.driven,
    rulerPolylines: result.rulerPolylines,
    gender: input.gender,
    heightCm: result.measured.height,
  };
}

export async function generateAvatarMesh(input: AvatarMeshInput): Promise<GeneratedAvatarMesh> {
  const base: BaseMeshSource = await loadMakeHumanBase();
  const targets = await loadMakeHumanTargets(input.onProgress);
  return composeAvatarMesh(base, makeTargetResolver(targets), input);
}
