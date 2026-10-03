/**
 * IDB persistence for generated avatar collision volumes.
 *
 * Avatars are global (not project-scoped), so their assets are stored in the
 * existing `assets` object store under a reserved project id — this avoids an
 * IndexedDB schema/version bump.
 */

import { deleteAsset, getAsset, putAsset } from './idb';
import { SdfVolume, type SdfVolumeData } from '../mesh/sdfVolume';

/** Reserved `projectId` for globally-scoped avatar assets. */
export const AVATAR_PROJECT_ID = '__avatars__';

export function avatarSdfAssetId(cacheKey: string, resolution: number): string {
  return `avatar-sdf:${resolution}:${cacheKey}`;
}

export async function saveAvatarSdf(
  cacheKey: string,
  resolution: number,
  data: SdfVolumeData
): Promise<void> {
  const buffer = SdfVolume.encode(data);
  await putAsset({
    id: avatarSdfAssetId(cacheKey, resolution),
    projectId: AVATAR_PROJECT_ID,
    mime: 'application/x-pcsd',
    byteLength: buffer.byteLength,
    blob: new Blob([buffer]),
    createdAt: Date.now(),
  });
}

export async function loadAvatarSdf(cacheKey: string, resolution: number): Promise<SdfVolume | null> {
  try {
    const record = await getAsset(avatarSdfAssetId(cacheKey, resolution));
    if (!record) return null;
    return SdfVolume.decode(await record.blob.arrayBuffer());
  } catch {
    return null;
  }
}

export async function deleteAvatarSdf(cacheKey: string, resolution: number): Promise<void> {
  await deleteAsset(avatarSdfAssetId(cacheKey, resolution));
}
