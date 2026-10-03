import { getMeta, setMeta } from './idb';
import {
  createDefaultAvatarLibrary,
  newAvatar,
  normalizeAvatarLibrary,
  type Avatar,
  type AvatarLibrary,
} from '../project/avatars';

/**
 * The avatar library lives **outside** any project: a 2D avatar is just
 * measurements, a 3D avatar also owns generated mesh + SDF children. Stored as
 * one JSON blob in the existing `meta` store (no IDB version bump).
 *
 * Migrates the older `measurementSets` blob on first load.
 */
const META_KEY = 'avatars';
const LEGACY_META_KEY = 'measurementSets';

/** Cached copy so the UI can render synchronously. */
let cache: AvatarLibrary | null = null;

export async function loadAvatarLibrary(): Promise<AvatarLibrary> {
  if (cache) return cache;
  try {
    const raw = await getMeta(META_KEY);
    if (raw) {
      cache = normalizeAvatarLibrary(JSON.parse(raw));
    } else {
      const legacy = await getMeta(LEGACY_META_KEY);
      cache = legacy ? normalizeAvatarLibrary(JSON.parse(legacy)) : createDefaultAvatarLibrary();
      if (legacy) await saveAvatarLibrary(cache);
    }
  } catch {
    cache = createDefaultAvatarLibrary();
  }
  return cache;
}

export async function saveAvatarLibrary(library: AvatarLibrary): Promise<void> {
  cache = library;
  try {
    await setMeta(META_KEY, JSON.stringify(library));
  } catch {
    /* storage full or unavailable — the in-memory cache still works this session */
  }
}

/** Synchronous peek for callers that already primed the cache. */
export function cachedAvatarLibrary(): AvatarLibrary | null {
  return cache;
}

export async function addAvatar(name?: string): Promise<AvatarLibrary> {
  const library = await loadAvatarLibrary();
  const avatar = newAvatar(name ?? `Person ${library.sets.length + 1}`, activeUnit(library));
  library.sets.push(avatar);
  library.activeId = avatar.id;
  await saveAvatarLibrary(library);
  return library;
}

export async function duplicateAvatar(setId: string): Promise<AvatarLibrary> {
  const library = await loadAvatarLibrary();
  const source = library.sets.find((s) => s.id === setId);
  if (!source) return library;
  const copy: Avatar = {
    ...source,
    id: newAvatar(source.name, source.unit).id,
    name: `${source.name} copy`,
    values: { ...source.values },
    model: undefined,
    updatedAt: Date.now(),
  };
  const at = library.sets.findIndex((s) => s.id === setId);
  library.sets.splice(at + 1, 0, copy);
  library.activeId = copy.id;
  await saveAvatarLibrary(library);
  return library;
}

export async function removeAvatar(setId: string): Promise<AvatarLibrary> {
  const library = await loadAvatarLibrary();
  if (library.sets.length <= 1) return library;
  library.sets = library.sets.filter((s) => s.id !== setId);
  if (library.activeId === setId) library.activeId = library.sets[0]?.id ?? null;
  await saveAvatarLibrary(library);
  return library;
}

export async function updateAvatar(
  setId: string,
  patch: Partial<
    Pick<
      Avatar,
      'name' | 'unit' | 'values' | 'kind' | 'gender' | 'decoupled' | 'sdfResolution' | 'manual' | 'model'
    >
  >
): Promise<AvatarLibrary> {
  const library = await loadAvatarLibrary();
  const avatar = library.sets.find((s) => s.id === setId);
  if (!avatar) return library;
  if (patch.name !== undefined) avatar.name = patch.name;
  if (patch.unit !== undefined) avatar.unit = patch.unit;
  if (patch.values !== undefined) avatar.values = { ...patch.values };
  if (patch.kind !== undefined) avatar.kind = patch.kind;
  if (patch.gender !== undefined) avatar.gender = patch.gender < 0 ? 0 : patch.gender > 1 ? 1 : patch.gender;
  if (patch.decoupled !== undefined) avatar.decoupled = patch.decoupled;
  if (patch.sdfResolution !== undefined) avatar.sdfResolution = patch.sdfResolution;
  if (patch.manual !== undefined) avatar.manual = [...patch.manual];
  if (patch.model !== undefined) avatar.model = patch.model;
  avatar.updatedAt = Date.now();
  await saveAvatarLibrary(library);
  return library;
}

export async function setActiveAvatar(setId: string): Promise<AvatarLibrary> {
  const library = await loadAvatarLibrary();
  if (library.sets.some((s) => s.id === setId)) {
    library.activeId = setId;
    await saveAvatarLibrary(library);
  }
  return library;
}

/** A new avatar inherits the unit the others are using. */
function activeUnit(library: AvatarLibrary): Avatar['unit'] {
  const active = library.sets.find((s) => s.id === library.activeId) ?? library.sets[0];
  return active?.unit ?? 'cm';
}
