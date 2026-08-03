import { parseObj } from '../mesh/loadObj';
import { getAvatarPrefs, AVATAR_OBJ_URL, DEFAULT_AVATAR_OBJ } from '../sim/avatarAsset';
import { CM_TO_WORLD } from '../sim/units';

/** Orthographic silhouette views in the 2D pattern editor. */
export type AvatarOverlayView = 'front' | 'back' | 'left' | 'right';

export const AVATAR_OVERLAY_VIEWS: Array<{ id: AvatarOverlayView; label: string }> = [
  { id: 'front', label: 'Front' },
  { id: 'back', label: 'Back' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
];

type OverlaySource = {
  key: string;
  /** Vertex positions in pattern cm (Y-up, feet on y=0). */
  positionsCm: Float32Array;
  indices: Uint32Array;
  /**
   * World-up hip height in cm (from feet). Projection puts this on pattern y=0
   * so the vertical axis crosses the figure at the hips.
   */
  hipYCm: number;
};

let sourceCache: OverlaySource | null = null;
let sourcePromise: Promise<OverlaySource> | null = null;

function objUrlForPrefs(objFileName: string): string {
  if (objFileName === DEFAULT_AVATAR_OBJ) return AVATAR_OBJ_URL;
  return `/refPpl/${encodeURIComponent(objFileName)}`;
}

/**
 * Load avatar OBJ into pattern centimeters (same scale as drafting units).
 * World = source × unitToWorld; cm = world / CM_TO_WORLD.
 */
async function loadOverlaySource(): Promise<OverlaySource> {
  const prefs = getAvatarPrefs();
  const key = `hip53:${prefs.objFileName}:${prefs.unitToWorld}`;
  if (sourceCache?.key === key) return sourceCache;

  const res = await fetch(objUrlForPrefs(prefs.objFileName));
  if (!res.ok) throw new Error(`Failed to load avatar for pattern overlay (${res.status})`);
  const mesh = parseObj(await res.text());

  const toCm = prefs.unitToWorld / CM_TO_WORLD;
  const n = mesh.positions.length / 3;
  const positionsCm = new Float32Array(n * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = mesh.positions[i * 3] * toCm;
    const y = mesh.positions[i * 3 + 1] * toCm;
    const z = mesh.positions[i * 3 + 2] * toCm;
    positionsCm[i * 3] = x;
    positionsCm[i * 3 + 1] = y;
    positionsCm[i * 3 + 2] = z;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  // Match AvatarBody floor rest (feet on y=0).
  if (Number.isFinite(minY) && Math.abs(minY) > 1e-6) {
    for (let i = 0; i < n; i++) positionsCm[i * 3 + 1] -= minY;
    maxY -= minY;
  }
  // Greater-trochanter / hip line ≈ 53% of stature — aligns pattern y=0 with the hips.
  const hipYCm = Math.max(1, maxY * 0.53);

  sourceCache = { key, positionsCm, indices: mesh.indices, hipYCm };
  return sourceCache;
}

export function resetAvatarOverlayCache(): void {
  sourceCache = null;
  sourcePromise = null;
}

export async function ensureAvatarOverlaySource(): Promise<OverlaySource> {
  const prefs = getAvatarPrefs();
  const key = `hip53:${prefs.objFileName}:${prefs.unitToWorld}`;
  if (sourceCache?.key === key) return sourceCache;
  if (!sourcePromise) {
    sourcePromise = loadOverlaySource().finally(() => {
      sourcePromise = null;
    });
  }
  return sourcePromise;
}

function projectVertex(
  x: number,
  y: number,
  z: number,
  view: AvatarOverlayView,
  hipYCm: number
): { u: number; v: number; depth: number } {
  // Pattern SVG: +X right, +Y down. Offset so hips sit on v=0; head stays toward −Y (up).
  const v = -(y - hipYCm);
  switch (view) {
    case 'front':
      return { u: x, v, depth: z };
    case 'back':
      return { u: -x, v, depth: -z };
    case 'left':
      // Looking from −X toward +X
      return { u: z, v, depth: -x };
    case 'right':
      // Looking from +X toward −X
      return { u: -z, v, depth: x };
  }
}

function viewCameraDir(view: AvatarOverlayView): [number, number, number] {
  switch (view) {
    case 'front':
      return [0, 0, 1];
    case 'back':
      return [0, 0, -1];
    case 'left':
      return [-1, 0, 0];
    case 'right':
      return [1, 0, 0];
  }
}

/**
 * Build an SVG path of backface-culled triangles in pattern cm for the given view.
 * Triangles are painter-sorted (far → near).
 */
export function buildAvatarOverlayPath(
  source: OverlaySource,
  view: AvatarOverlayView
): string {
  const { positionsCm: p, indices, hipYCm } = source;
  const [cx, cy, cz] = viewCameraDir(view);
  type Tri = { d: string; depth: number };
  const tris: Tri[] = [];

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];
    const ax = p[i0 * 3];
    const ay = p[i0 * 3 + 1];
    const az = p[i0 * 3 + 2];
    const bx = p[i1 * 3];
    const by = p[i1 * 3 + 1];
    const bz = p[i1 * 3 + 2];
    const cxw = p[i2 * 3];
    const cyw = p[i2 * 3 + 1];
    const czw = p[i2 * 3 + 2];

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cxw - ax;
    const e2y = cyw - ay;
    const e2z = czw - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    // Keep faces that point toward the camera.
    if (nx * cx + ny * cy + nz * cz <= 0) continue;

    const a = projectVertex(ax, ay, az, view, hipYCm);
    const b = projectVertex(bx, by, bz, view, hipYCm);
    const c = projectVertex(cxw, cyw, czw, view, hipYCm);
    tris.push({
      d: `M${a.u.toFixed(3)} ${a.v.toFixed(3)}L${b.u.toFixed(3)} ${b.v.toFixed(3)}L${c.u.toFixed(3)} ${c.v.toFixed(3)}Z`,
      depth: (a.depth + b.depth + c.depth) / 3,
    });
  }

  tris.sort((t0, t1) => t0.depth - t1.depth);
  return tris.map((t) => t.d).join('');
}
