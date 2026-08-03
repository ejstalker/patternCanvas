import { parseObj } from '../mesh/loadObj';
import { AvatarBody } from '../mesh/AvatarBody';
import { CM_TO_WORLD } from './units';
import { bakeSdfVolume, DEFAULT_SDF_RESOLUTION } from '../mesh/sdfBake';
import { SdfVolume, sdfCacheFileName } from '../mesh/sdfVolume';
import { decodeSdfOrOpenVdb } from '../mesh/openVdbSdf';

/** Served from refPpl/ via Vite middleware (dev) or copied to dist/refPpl (build). */
export const AVATAR_OBJ_URL = '/refPpl/me01_low1.obj';
export const DEFAULT_AVATAR_OBJ = 'me01_low1.obj';

/** me01_low1.obj vertices are in meters; cloth/pattern use cm → multiply by 100× CM_TO_WORLD. */
export const AVATAR_UNIT_TO_WORLD = CM_TO_WORLD * 100;

const PREFS_KEY = 'patternCanvas.avatarPrefs';

export type AvatarCollisionMode = 'triangle' | 'bake-sdf' | 'load-sdf';

export type AvatarPrefs = {
  objFileName: string;
  unitToWorld: number;
  useSdf: boolean;
  sdfResolution: number;
  sdfFileName?: string;
};

export function getAvatarPrefs(): AvatarPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return defaultAvatarPrefs();
    const parsed = JSON.parse(raw) as Partial<AvatarPrefs>;
    return {
      objFileName: parsed.objFileName ?? DEFAULT_AVATAR_OBJ,
      unitToWorld: parsed.unitToWorld ?? AVATAR_UNIT_TO_WORLD,
      useSdf: parsed.useSdf ?? false,
      sdfResolution: parsed.sdfResolution ?? DEFAULT_SDF_RESOLUTION,
      sdfFileName: parsed.sdfFileName,
    };
  } catch {
    return defaultAvatarPrefs();
  }
}

function defaultAvatarPrefs(): AvatarPrefs {
  return {
    objFileName: DEFAULT_AVATAR_OBJ,
    unitToWorld: AVATAR_UNIT_TO_WORLD,
    useSdf: false,
    sdfResolution: DEFAULT_SDF_RESOLUTION,
  };
}

export function saveAvatarPrefs(prefs: AvatarPrefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_');
}

function objUrlForPrefs(prefs: AvatarPrefs): string {
  if (prefs.objFileName === DEFAULT_AVATAR_OBJ) return AVATAR_OBJ_URL;
  return `/refPpl/${encodeURIComponent(prefs.objFileName)}`;
}

function sdfUrl(fileName: string): string {
  return `/refPpl/${encodeURIComponent(fileName)}`;
}

async function fetchObjText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load avatar OBJ (${res.status})`);
  return res.text();
}

async function fetchSdf(fileName: string): Promise<SdfVolume | null> {
  try {
    const res = await fetch(sdfUrl(fileName));
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return SdfVolume.decode(buf);
  } catch {
    return null;
  }
}

async function saveSdfToRefPpl(fileName: string, buffer: ArrayBuffer): Promise<void> {
  const res = await fetch('/api/avatar-sdf', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Sdf-File': fileName,
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Failed to save SDF to refPpl (${res.status})`);
}

async function saveObjToRefPpl(fileName: string, text: string): Promise<void> {
  const res = await fetch('/api/avatar-obj', {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/plain',
      'X-Obj-File': fileName,
    },
    body: text,
  });
  if (!res.ok) throw new Error(`Failed to save OBJ to refPpl (${res.status})`);
}

let avatarPromise: Promise<AvatarBody> | null = null;
let cachedBody: AvatarBody | null = null;

export function resetAvatarCache(): void {
  cachedBody?.destroy();
  cachedBody = null;
  avatarPromise = null;
}

async function attachSdfIfConfigured(body: AvatarBody, prefs: AvatarPrefs): Promise<void> {
  if (!prefs.useSdf || !prefs.sdfFileName) return;
  const sdf = await fetchSdf(prefs.sdfFileName);
  if (sdf) body.setSdfVolume(sdf);
}

async function buildAvatarBody(device: GPUDevice, prefs: AvatarPrefs): Promise<AvatarBody> {
  const text = await fetchObjText(objUrlForPrefs(prefs));
  const mesh = parseObj(text);
  const skipGrid = prefs.useSdf && !!prefs.sdfFileName;
  const body = AvatarBody.fromObjMesh(mesh, prefs.unitToWorld, device, { skipSpatialGrid: skipGrid });
  await attachSdfIfConfigured(body, prefs);
  if (!body.usesSdfCollision()) {
    body.buildCollisionGridIfNeeded();
  }
  cachedBody = body;
  return body;
}

/** Load the avatar once per GPU device (uses saved prefs + cached SDF when available). */
export async function loadAvatarBody(device: GPUDevice): Promise<AvatarBody> {
  if (cachedBody) return cachedBody;
  if (!avatarPromise) {
    avatarPromise = buildAvatarBody(device, getAvatarPrefs());
  }
  return avatarPromise;
}

export type ImportAvatarOptions = {
  /** Viewport mesh. Omit to keep the current OBJ from prefs. */
  meshFile?: File | null;
  /** Pre-baked collision SDF (.sdf). Used when collisionMode === 'load-sdf'. */
  sdfFile?: File | null;
  unitToWorld: number;
  collisionMode: AvatarCollisionMode;
  sdfResolution: number;
  device: GPUDevice;
  onProgress?: (message: string, progress?: number) => void;
  signal?: AbortSignal;
};

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Import viewport mesh and/or collision SDF from disk; optional bake when no SDF file. */
export async function importAvatarModel(options: ImportAvatarOptions): Promise<AvatarBody> {
  const {
    meshFile,
    sdfFile,
    unitToWorld,
    collisionMode,
    sdfResolution,
    device,
    onProgress,
    signal,
  } = options;

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Avatar import cancelled', 'AbortError');
    }
  };

  throwIfAborted();
  const prev = getAvatarPrefs();

  if (!meshFile && !sdfFile && collisionMode !== 'bake-sdf') {
    throw new Error('Choose a viewport mesh and/or a collision SDF file');
  }
  if (collisionMode === 'load-sdf' && !sdfFile) {
    throw new Error('Choose a collision SDF file, or switch collision mode');
  }
  if (collisionMode === 'bake-sdf' && !meshFile && !prev.objFileName) {
    throw new Error('Choose a viewport mesh to bake an SDF from');
  }

  let objText: string;
  let objFileName: string;

  if (meshFile) {
    onProgress?.('Reading viewport mesh…');
    objText = await meshFile.text();
    throwIfAborted();
    objFileName = sanitizeFileName(meshFile.name);
  } else {
    onProgress?.('Loading current viewport mesh…');
    objFileName = prev.objFileName;
    objText = await fetchObjText(objUrlForPrefs({ ...prev, objFileName }));
    throwIfAborted();
  }

  const mesh = parseObj(objText);
  const willUseSdf = collisionMode === 'bake-sdf' || collisionMode === 'load-sdf';
  onProgress?.('Building avatar mesh…');
  const body = AvatarBody.fromObjMesh(mesh, unitToWorld, device, { skipSpatialGrid: willUseSdf });

  let sdfFileName: string | undefined;
  let useSdf = false;

  try {
    if (collisionMode === 'load-sdf' && sdfFile) {
      onProgress?.('Loading collision SDF…', 0.05);
      const buf = await sdfFile.arrayBuffer();
      throwIfAborted();
      const { data, source } = await decodeSdfOrOpenVdb(buf, {
        fileName: sdfFile.name,
        maxResolution: sdfResolution,
        unitToWorld,
        signal,
        onProgress: (p, message) =>
          onProgress?.(message ?? (source === 'openvdb' ? 'Densifying OpenVDB…' : 'Loading SDF…'), p),
      });
      throwIfAborted();
      const volume = new SdfVolume(data);
      body.setSdfVolume(volume);
      // Always cache densified PCSD so next launch skips OpenVDB parse.
      const stem = sanitizeFileName(sdfFile.name.replace(/\.[^.]+$/, '') || 'avatar');
      sdfFileName =
        source === 'openvdb'
          ? sdfCacheFileName(`${stem}.vdb`, unitToWorld, Math.max(data.dim[0], data.dim[1], data.dim[2]))
          : sanitizeFileName(sdfFile.name.endsWith('.sdf') ? sdfFile.name : `${stem}.sdf`);
      await saveSdfToRefPpl(sdfFileName, SdfVolume.encode(data));
      useSdf = true;
      onProgress?.(
        source === 'openvdb' ? 'OpenVDB densified and cached as .sdf' : 'SDF loaded',
        1
      );
    } else if (collisionMode === 'bake-sdf') {
      onProgress?.('Baking SDF (this may take a minute)…', 0);
      const bakeData = body.getCollisionBakeData();
      const sdfData = await bakeSdfVolume(
        bakeData.positions,
        bakeData.indices,
        bakeData.boundsMin,
        bakeData.boundsMax,
        sdfResolution,
        {
          signal,
          onProgress: (p) => onProgress?.('Baking SDF…', p),
        }
      );
      throwIfAborted();
      const volume = new SdfVolume(sdfData);
      body.setSdfVolume(volume);
      sdfFileName = sdfCacheFileName(objFileName, unitToWorld, sdfResolution);
      await saveSdfToRefPpl(sdfFileName, SdfVolume.encode(sdfData));
      useSdf = true;
      onProgress?.('SDF cached to refPpl', 1);
    } else if (collisionMode === 'triangle') {
      // Keep an existing cached SDF reference only if user didn't explicitly choose triangle.
      useSdf = false;
      sdfFileName = undefined;
    }

    throwIfAborted();

    if (!body.usesSdfCollision()) {
      body.buildCollisionGridIfNeeded();
    }

    if (meshFile && objFileName !== DEFAULT_AVATAR_OBJ) {
      await saveObjToRefPpl(objFileName, objText);
    }

    resetAvatarCache();

    const prefs: AvatarPrefs = {
      objFileName: objFileName === DEFAULT_AVATAR_OBJ ? DEFAULT_AVATAR_OBJ : objFileName,
      unitToWorld,
      useSdf,
      sdfResolution,
      sdfFileName,
    };
    saveAvatarPrefs(prefs);

    cachedBody = body;
    avatarPromise = Promise.resolve(body);
    return body;
  } catch (err) {
    body.destroy();
    if (!isAbortError(err)) {
      // leave previous prefs intact on failure
    }
    throw err;
  }
}

export function avatarStatusLabel(): string {
  const prefs = getAvatarPrefs();
  const sdf = prefs.useSdf && prefs.sdfFileName ? ` · SDF: ${prefs.sdfFileName}` : '';
  return `${prefs.objFileName} (×${prefs.unitToWorld.toFixed(2)})${sdf}`;
}
