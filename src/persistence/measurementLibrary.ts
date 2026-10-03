import { getMeta, setMeta } from '../persistence/idb';
import {
  createDefaultMeasurementLibrary,
  newMeasurementSet,
  normalizeMeasurementLibrary,
  type MeasurementLibrary,
  type MeasurementSet,
} from '../project/measurements';

/**
 * Body measurement sets live **outside** any project — they describe the people
 * you draft for, and every project should be able to reach the same list.
 *
 * The whole library is small (a name plus ~30 numbers per person), so it is
 * stored as one JSON blob in the existing `meta` store rather than as its own
 * object store, which would mean an IndexedDB version bump.
 */
const META_KEY = 'measurementSets';

/** Cached copy so the modal can render synchronously. */
let cache: MeasurementLibrary | null = null;

export async function loadMeasurementLibrary(): Promise<MeasurementLibrary> {
  if (cache) return cache;
  try {
    const raw = await getMeta(META_KEY);
    cache = raw ? normalizeMeasurementLibrary(JSON.parse(raw)) : createDefaultMeasurementLibrary();
  } catch {
    // Unreadable or hand-edited payload — fall back rather than lose the feature.
    cache = createDefaultMeasurementLibrary();
  }
  return cache;
}

export async function saveMeasurementLibrary(library: MeasurementLibrary): Promise<void> {
  cache = library;
  try {
    await setMeta(META_KEY, JSON.stringify(library));
  } catch {
    /* storage full or unavailable — the in-memory cache still works this session */
  }
}

/** Synchronous peek for callers that already primed the cache. */
export function cachedMeasurementLibrary(): MeasurementLibrary | null {
  return cache;
}

export async function addMeasurementSet(name?: string): Promise<MeasurementLibrary> {
  const library = await loadMeasurementLibrary();
  const set = newMeasurementSet(name ?? `Person ${library.sets.length + 1}`, activeUnit(library));
  library.sets.push(set);
  library.activeId = set.id;
  await saveMeasurementLibrary(library);
  return library;
}

/** Copy everything about a person — handy for "same person, different ease". */
export async function duplicateMeasurementSet(setId: string): Promise<MeasurementLibrary> {
  const library = await loadMeasurementLibrary();
  const source = library.sets.find((s) => s.id === setId);
  if (!source) return library;
  const copy = newMeasurementSet(`${source.name} copy`, source.unit);
  copy.values = { ...source.values };
  const at = library.sets.findIndex((s) => s.id === setId);
  library.sets.splice(at + 1, 0, copy);
  library.activeId = copy.id;
  await saveMeasurementLibrary(library);
  return library;
}

/** Never leaves the library empty — a project always has someone to draft for. */
export async function removeMeasurementSet(setId: string): Promise<MeasurementLibrary> {
  const library = await loadMeasurementLibrary();
  if (library.sets.length <= 1) return library;
  library.sets = library.sets.filter((s) => s.id !== setId);
  if (library.activeId === setId) library.activeId = library.sets[0]?.id ?? null;
  await saveMeasurementLibrary(library);
  return library;
}

export async function updateMeasurementSet(
  setId: string,
  patch: Partial<Pick<MeasurementSet, 'name' | 'unit' | 'values'>>
): Promise<MeasurementLibrary> {
  const library = await loadMeasurementLibrary();
  const set = library.sets.find((s) => s.id === setId);
  if (!set) return library;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.unit !== undefined) set.unit = patch.unit;
  if (patch.values !== undefined) set.values = { ...patch.values };
  set.updatedAt = Date.now();
  await saveMeasurementLibrary(library);
  return library;
}

export async function setActiveMeasurementSet(setId: string): Promise<MeasurementLibrary> {
  const library = await loadMeasurementLibrary();
  if (library.sets.some((s) => s.id === setId)) {
    library.activeId = setId;
    await saveMeasurementLibrary(library);
  }
  return library;
}

/** A new person inherits the unit the others are using. */
function activeUnit(library: MeasurementLibrary): MeasurementSet['unit'] {
  const active = library.sets.find((s) => s.id === library.activeId) ?? library.sets[0];
  return active?.unit ?? 'cm';
}
