/**
 * Avatar generation service: turns a stored {@link Avatar} into a generated mesh
 * (cached in memory by cache key) and an {@link AvatarBody} for the sim/render.
 */

import { AvatarBody } from '../mesh/AvatarBody';
import { bakeSdfVolume } from '../mesh/sdfBake';
import { SdfVolume } from '../mesh/sdfVolume';
import { avatarSdfAssetId, loadAvatarSdf, saveAvatarSdf } from '../persistence/avatarAssets';
import { getAsset } from '../persistence/idb';
import type { Avatar } from '../project/avatars';
import { autoCapableFields } from './makehuman/generate';
import {
  analyzeCollisionMesh,
  avatarMeshCacheKey,
  generateAvatarMesh,
  MAKEHUMAN_UNIT_TO_WORLD,
  type CollisionMeshAnalysis,
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
  const input = avatarMeshInput(avatar);
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

/**
 * The inputs a generated mesh is built from: measurements in cm, with the fields
 * the model itself derives left out (they are outputs, not goals).
 *
 * The cache key is derived from this in one place so the status the editor shows
 * can never disagree with what the cache would actually do.
 */
export function avatarMeshInput(avatar: Avatar): {
  gender: number;
  heightCm?: number;
  measurements: Record<string, number>;
} {
  const measurements = measurementsToCm(avatar);
  const manual = new Set(avatar.manual ?? []);
  for (const field of autoCapableFields()) {
    if (!manual.has(field)) delete measurements[field];
  }
  return { gender: avatar.gender, heightCm: measurements.height, measurements };
}

/** Cache key the avatar's *current* measurements and settings would generate. */
export function avatarCacheKeyFor(avatar: Avatar): string {
  return avatarMeshCacheKey(avatarMeshInput(avatar));
}

/** Collision representation an avatar is configured for. */
export function avatarCollisionMode(avatar: Avatar): 'triangle' | 'sdf' {
  return avatar.sdfResolution ? 'sdf' : 'triangle';
}

/**
 * The mesh the collider is built from: the SDF path bakes from the headless
 * collision mesh, the triangle path collides against the render mesh as-is.
 */
function colliderMesh(
  mesh: GeneratedAvatarMesh,
  mode: 'triangle' | 'sdf'
): { positions: Float32Array; indices: Uint32Array } {
  return mode === 'sdf'
    ? { positions: mesh.collision.positions, indices: mesh.collision.indices }
    : { positions: mesh.render.positions, indices: mesh.render.indices };
}

function analyzeCollider(mesh: GeneratedAvatarMesh, mode: 'triangle' | 'sdf'): CollisionMeshAnalysis {
  return cachedAnalysis(mesh, mode === 'sdf' ? 'collision' : 'render');
}

/**
 * Edge topology of one of a mesh's two surfaces.
 *
 * Memoised per generated mesh: the editor asks for these on every status refresh,
 * and building the edge map for 20k triangles is not something to repeat.
 */
const analysisCache = new WeakMap<
  GeneratedAvatarMesh,
  Partial<Record<'render' | 'collision', CollisionMeshAnalysis>>
>();

function cachedAnalysis(
  mesh: GeneratedAvatarMesh,
  which: 'render' | 'collision'
): CollisionMeshAnalysis {
  let entry = analysisCache.get(mesh);
  if (!entry) {
    entry = {};
    analysisCache.set(mesh, entry);
  }
  const hit = entry[which];
  if (hit) return hit;
  const value =
    which === 'render'
      ? analyzeCollisionMesh(mesh.render.positions, mesh.render.indices)
      : analyzeCollisionMesh(mesh.collision.positions, mesh.collision.indices);
  entry[which] = value;
  return value;
}

/** What the cloth will collide against, and what that took to produce. */
export type AvatarCollisionReport = {
  cacheKey: string;
  /** Nothing had to be solved: the mesh was already in memory. */
  meshFromCache: boolean;
  mode: 'triangle' | 'sdf';
  resolution?: number;
  /** Geometry of the mesh collisions are resolved against. */
  collider: CollisionMeshAnalysis;
  /** Geometry of the headless mesh an SDF is baked from (SDF mode only). */
  collisionMesh?: CollisionMeshAnalysis;
  /** Mesh-space → body-space lift applied to the collision mesh. */
  floorLift: number;
  sdfSource?: 'device-cache' | 'baked';
  bakeMs?: number;
  sdfBytes?: number;
  totalMs: number;
};

/** One line for status bars: what the drape will collide against. */
export function collisionSummaryText(report: AvatarCollisionReport): string {
  const tris = `${report.collider.triangles.toLocaleString()} tris`;
  if (report.mode === 'triangle') return `triangle mesh · ${tris}`;
  const from =
    report.sdfSource === 'device-cache'
      ? 'from device cache'
      : `baked in ${formatSeconds(report.bakeMs ?? 0)}`;
  return `SDF ${report.resolution}³ · ${tris} · ${from}`;
}

function formatSeconds(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/**
 * A baked SDF sitting in the device's IndexedDB for one cache key.
 *
 * The record is fetched without reading the blob, so this is cheap enough to run
 * whenever the avatar editor opens.
 */
export type AvatarSdfAsset = { resolution: number; byteLength: number; createdAt: number };

async function readSdfAsset(cacheKey: string, resolution: number): Promise<AvatarSdfAsset | null> {
  try {
    const record = await getAsset(avatarSdfAssetId(cacheKey, resolution));
    if (!record) return null;
    return { resolution, byteLength: record.byteLength, createdAt: record.createdAt };
  } catch {
    return null;
  }
}

/** Everything the UI can say about what exists for an avatar, and how current it is. */
export type AvatarAssetStatus = {
  /** Key these measurements and settings would generate. */
  cacheKey: string;
  /** Key the stored model was generated from, when there is one. */
  generatedKey: string | null;
  /** A model was generated for exactly these measurements. */
  current: boolean;
  /** A model exists, but these measurements have changed since. */
  stale: boolean;
  /** The generated mesh is still in memory, so nothing has to be re-solved. */
  meshInMemory: boolean;
  mode: 'triangle' | 'sdf';
  resolution?: number;
  /** Geometry of the render mesh (what is drawn), when the mesh is in memory. */
  render: CollisionMeshAnalysis | null;
  /** Geometry of the collider, when the mesh is in memory. */
  collider: CollisionMeshAnalysis | null;
  /** Geometry of the headless mesh an SDF bakes from, when in memory. */
  collisionMesh: CollisionMeshAnalysis | null;
  /** Baked SDF on this device for the current measurements. */
  sdf: AvatarSdfAsset | null;
};

/**
 * What exists for an avatar right now: whether a mesh has been generated for
 * these measurements, whether it is still in memory, what shape the collider has
 * and whether an SDF is already baked on this device.
 */
export async function describeAvatarAssets(avatar: Avatar): Promise<AvatarAssetStatus> {
  const cacheKey = avatarCacheKeyFor(avatar);
  const generatedKey = avatar.model?.cacheKey ?? null;
  const mode = avatarCollisionMode(avatar);
  const resolution = avatar.sdfResolution || undefined;
  const mesh = meshCache.get(cacheKey) ?? null;
  const sdf = resolution ? await readSdfAsset(cacheKey, resolution) : null;

  return {
    cacheKey,
    generatedKey,
    current: generatedKey === cacheKey,
    stale: generatedKey !== null && generatedKey !== cacheKey,
    meshInMemory: mesh !== null,
    mode,
    resolution,
    render: mesh ? cachedAnalysis(mesh, 'render') : null,
    collider: mesh ? analyzeCollider(mesh, mode) : null,
    collisionMesh: mesh ? cachedAnalysis(mesh, 'collision') : null,
    sdf,
  };
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
): Promise<{ volume: SdfVolume; source: 'device-cache' | 'baked'; ms: number; bytes: number }> {
  const started = performance.now();
  const cached = await loadAvatarSdf(mesh.cacheKey, resolution);
  if (cached) {
    return { volume: cached, source: 'device-cache', ms: performance.now() - started, bytes: 0 };
  }
  // `mesh.collision` is already in body space — the same frame the cloth and the
  // render body live in — so the volume can be sampled with particle positions.
  const { positions, indices } = mesh.collision;
  const bounds = computeBounds(positions);
  const data = await bakeSdfVolume(positions, indices, bounds.min, bounds.max, resolution, {
    onProgress,
  });
  await saveAvatarSdf(mesh.cacheKey, resolution, data);
  return {
    volume: new SdfVolume(data),
    source: 'baked',
    ms: performance.now() - started,
    bytes: data.distances.byteLength,
  };
}

/** Build a renderable {@link AvatarBody} from the generated meshes. */
export async function createAvatarBodyFromAvatar(
  device: GPUDevice,
  avatar: Avatar,
  options: AvatarBodyOptions = {}
): Promise<{ body: AvatarBody; mesh: GeneratedAvatarMesh; collision: AvatarCollisionReport }> {
  const started = performance.now();
  const mode = avatarCollisionMode(avatar);
  const meshFromCache = meshCache.has(avatarCacheKeyFor(avatar));
  const mesh = await buildAvatarMeshes(avatar);
  const floorLift = mesh.floorLift;
  const report: AvatarCollisionReport = {
    cacheKey: mesh.cacheKey,
    meshFromCache,
    mode,
    resolution: avatar.sdfResolution || undefined,
    collider: analyzeCollider(mesh, mode),
    floorLift,
    totalMs: 0,
  };

  if (options.sdfResolution) {
    const sdf = await buildAvatarSdfForMesh(mesh, options.sdfResolution, options.onProgress);
    const body = AvatarBody.fromRawMesh(
      mesh.render.positions,
      mesh.render.indices,
      MAKEHUMAN_UNIT_TO_WORLD,
      device,
      { skipSpatialGrid: true }
    );
    body.setSdfVolume(sdf.volume);
    report.collisionMesh = cachedAnalysis(mesh, 'collision');
    report.sdfSource = sdf.source;
    report.bakeMs = sdf.ms;
    report.sdfBytes = sdf.bytes;
    report.totalMs = performance.now() - started;
    return { body, mesh, collision: report };
  }

  const body = AvatarBody.fromRawMesh(
    mesh.render.positions,
    mesh.render.indices,
    MAKEHUMAN_UNIT_TO_WORLD,
    device
  );
  report.totalMs = performance.now() - started;
  return { body, mesh, collision: report };
}
