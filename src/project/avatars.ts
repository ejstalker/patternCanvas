/**
 * Avatars merge the old "measurement set / person" concept with an optional 3D
 * model. A **2D** avatar is just measurements; a **3D** avatar also owns a
 * generated MakeHuman mesh and its cached SDF collision volume.
 *
 * `Avatar` is a strict superset of `MeasurementSet`, so pattern/block/ruler code
 * that only cares about measurements keeps working unchanged.
 */

import type { UnitDisplay } from './types';
import {
  defaultMeasurementValues,
  MANDATORY_MEASUREMENT_IDS,
  measurementHeightCm,
  newMeasurementSet,
  normalizeMeasurementLibrary,
  type MeasurementSet,
} from './measurements';

export type AvatarKind = '2d' | '3d';

export type AvatarModelCache = {
  /** Hash of the inputs (measurements + gender + asset version) that produced this model. */
  cacheKey: string;
  /** IDB asset id for the generated mesh payload. */
  meshAssetId?: string;
  /** IDB asset id for the baked SDF payload. */
  sdfAssetId?: string;
};

export type Avatar = MeasurementSet & {
  kind: AvatarKind;
  /** MakeHuman gender slider: 0 = female, 1 = male. */
  gender: number;
  /** When true, measurements no longer drive generation (manual macro entry). */
  decoupled: boolean;
  /** Collision volume resolution for the sim; undefined = triangle mesh. */
  sdfResolution?: number;
  /** Fields the user has switched to manual entry (all other capable fields use the model value). */
  manual?: string[];
  model?: AvatarModelCache;
};

export type AvatarLibrary = {
  sets: Avatar[];
  activeId: string | null;
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function newAvatar(name: string, unit: UnitDisplay = 'cm'): Avatar {
  return {
    ...newMeasurementSet(name, unit),
    kind: '2d',
    gender: 0.5,
    decoupled: false,
    values: defaultMeasurementValues(unit),
  };
}

export function createDefaultAvatarLibrary(): AvatarLibrary {
  const first = newAvatar('Person 1');
  return { sets: [first], activeId: first.id };
}

/** Defensive load — tolerates old measurement-only payloads and hand edits. */
export function normalizeAvatarLibrary(raw: unknown): AvatarLibrary {
  const normalized = normalizeMeasurementLibrary(raw);
  const byId = new Map<string, Record<string, unknown>>();
  const rawSets = (raw as { sets?: unknown } | null)?.sets;
  if (Array.isArray(rawSets)) {
    for (const entry of rawSets) {
      if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
        byId.set((entry as { id: string }).id, entry as Record<string, unknown>);
      }
    }
  }

  const sets: Avatar[] = normalized.sets.map((set) => {
    const src = byId.get(set.id);
    const genderRaw = src?.gender;
    const gender =
      typeof genderRaw === 'number' && Number.isFinite(genderRaw) ? clamp01(genderRaw) : 0.5;
    const modelRaw = src?.model;
    const model =
      modelRaw && typeof modelRaw === 'object' && typeof (modelRaw as { cacheKey?: unknown }).cacheKey === 'string'
        ? {
            cacheKey: (modelRaw as { cacheKey: string }).cacheKey,
            meshAssetId:
              typeof (modelRaw as { meshAssetId?: unknown }).meshAssetId === 'string'
                ? (modelRaw as { meshAssetId: string }).meshAssetId
                : undefined,
            sdfAssetId:
              typeof (modelRaw as { sdfAssetId?: unknown }).sdfAssetId === 'string'
                ? (modelRaw as { sdfAssetId: string }).sdfAssetId
                : undefined,
          }
        : undefined;
    const height = measurementHeightCm(set.values, set.unit);
    const defaults = defaultMeasurementValues(set.unit, height);
    const values = { ...set.values };
    for (const id of MANDATORY_MEASUREMENT_IDS) {
      if (values[id] === undefined && defaults[id] !== undefined) values[id] = defaults[id];
    }
    return {
      ...set,
      values,
      kind: src?.kind === '3d' ? '3d' : '2d',
      gender,
      decoupled: src?.decoupled === true,
      ...(typeof src?.sdfResolution === 'number' && Number.isFinite(src.sdfResolution) && src.sdfResolution > 0
        ? { sdfResolution: src.sdfResolution }
        : {}),
      ...(Array.isArray(src?.manual)
        ? { manual: (src.manual as unknown[]).filter((x): x is string => typeof x === 'string') }
        : {}),
      ...(model ? { model } : {}),
    };
  });

  if (sets.length === 0) return createDefaultAvatarLibrary();
  const activeId = sets.some((s) => s.id === normalized.activeId)
    ? normalized.activeId!
    : sets[0]!.id;
  return { sets, activeId };
}
