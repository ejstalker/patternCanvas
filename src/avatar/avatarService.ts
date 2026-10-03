/**
 * Avatar generation service: turns a stored {@link Avatar} into a generated mesh
 * (cached in memory by cache key) and an {@link AvatarBody} for the sim/render.
 */

import { AvatarBody } from '../mesh/AvatarBody';
import { bakeSdfVolume } from '../mesh/sdfBake';
import { SdfVolume } from '../mesh/sdfVolume';
import { loadAvatarSdf, saveAvatarSdf } from '../persistence/avatarAssets';
import type { Avatar } from '../project/avatars';
import { autoCapableFields } from './makehuman/generate';
import {
  avatarMeshCacheKey,
  generateAvatarMesh,
  MAKEHUMAN_UNIT_TO_WORLD,
  type GeneratedAvatarMesh,
} from './generateMesh';

const meshCache = new Map<string, GeneratedAvatarMesh>();
const inflight = new Map<string, Promise<GeneratedAvatarMesh>>();

/** Avatar measurements converted to centimetres (the generator's working unit). */
export function measurementsToCm(avatar: Avatar): Record<string, number> {
  const factor = avatar.unit === 'in' ? 2.54 : 1;
  const out: Record<string, number> = {};
  for (const [field, value] of Object.entries(avatar.values)) {
    if (Number.isFinite(value)) out[field] = value * factor;
  }
  return out;
}

export function invalidateGeneratedMeshes(cacheKey?: string): void {
  if (cacheKey) {
    meshCache.delete(cacheKey);
    inflight.delete(cacheKey);
  } else {
    meshCache.clear();
    inflight.clear();
  }
}

/** Generate (or return cached) meshes for an avatar. */
export async function buildAvatarMeshes(
  avatar: Avatar,
  onProgress?: (done: number, total: number) => void
): Promise<GeneratedAvatarMesh> {
  const measurements = measurementsToCm(avatar);
  // Model-driven fields are outputs, not goals — don't feed them back in.
  const manual = new Set(avatar.manual ?? []);
  for (const field of autoCapableFields()) {
    if (!manual.has(field)) delete measurements[field];
  }
  const input = { gender: avatar.gender, heightCm: measurements.height, measurements };
  const cacheKey = avatarMeshCacheKey(input);

  const cached = meshCache.get(cacheKey);
  if (cached) return cached;
  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const promise = generateAvatarMesh({ ...input, onProgress }).then((mesh) => {
    meshCache.set(mesh.cacheKey, mesh);
    inflight.delete(cacheKey);
    return mesh;
  });
  inflight.set(cacheKey, promise);
  return promise;
}

export type AvatarBodyOptions = {
  /** Bake/attach a signed-distance collision volume at this resolution (undefined = triangle collision). */
  sdfResolution?: number;
  onProgress?: (value: number) => void;
};

function computeBounds(positions: Float32Array): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const value = positions[i + k]!;
      if (value < min[k]!) min[k] = value;
      if (value > max[k]!) max[k] = value;
    }
  }
  return { min, max };
}

/** Bake (or load from IDB) the avatar's collision SDF, keyed by mesh cache key + resolution. */
export async function buildAvatarSdfForMesh(
  mesh: GeneratedAvatarMesh,
  resolution: number,
  onProgress?: (value: number) => void
): Promise<SdfVolume> {
  const cached = await loadAvatarSdf(mesh.cacheKey, resolution);
  if (cached) return cached;
  const { positions, indices } = mesh.collision;
  const bounds = computeBounds(positions);
  const data = await bakeSdfVolume(positions, indices, bounds.min, bounds.max, resolution, {
    onProgress,
  });
  await saveAvatarSdf(mesh.cacheKey, resolution, data);
  return new SdfVolume(data);
}

/** Build a renderable {@link AvatarBody} from the generated meshes. */
export async function createAvatarBodyFromAvatar(
  device: GPUDevice,
  avatar: Avatar,
  options: AvatarBodyOptions = {}
): Promise<{ body: AvatarBody; mesh: GeneratedAvatarMesh }> {
  const mesh = await buildAvatarMeshes(avatar);
  if (options.sdfResolution) {
    const sdf = await buildAvatarSdfForMesh(mesh, options.sdfResolution, options.onProgress);
    const body = AvatarBody.fromRawMesh(
      mesh.render.positions,
      mesh.render.indices,
      MAKEHUMAN_UNIT_TO_WORLD,
      device,
      { skipSpatialGrid: true }
    );
    body.setSdfVolume(sdf);
    return { body, mesh };
  }
  const body = AvatarBody.fromRawMesh(
    mesh.render.positions,
    mesh.render.indices,
    MAKEHUMAN_UNIT_TO_WORLD,
    device
  );
  return { body, mesh };
}
