import { CM_TO_WORLD } from './units';
import type { ProjectDocument, SimCameraState } from '../project/types';

/** Reference orbit height from the Drape A sim (world units). */
export const ORBIT_HEIGHT_WORLD = 6.096;

const DRAPE_A_SIM_NAME = 'Drape A';

/** Default drape viewport camera — seeded from Drape A. */
export let DEFAULT_SIM_CAMERA: SimCameraState = {
  distance: 30,
  azimuth: 0.35,
  elevation: 0.78,
  target: [0, ORBIT_HEIGHT_WORLD, 0],
};

export function cloneSimCamera(camera: SimCameraState): SimCameraState {
  return {
    distance: camera.distance,
    azimuth: camera.azimuth,
    elevation: camera.elevation,
    target: [camera.target[0], camera.target[1], camera.target[2]],
  };
}

/** Update baked defaults when Drape A's camera changes. */
export function setDefaultSimCamera(camera: SimCameraState): void {
  DEFAULT_SIM_CAMERA = cloneSimCamera(camera);
}

export function getDefaultSimCamera(project?: ProjectDocument): SimCameraState {
  const fromDrapeA = drapeASim(project)?.camera;
  if (fromDrapeA) return cloneSimCamera(fromDrapeA);
  return cloneSimCamera(DEFAULT_SIM_CAMERA);
}

function drapeASim(project?: ProjectDocument) {
  return project?.sims.find((sim) => sim.name === DRAPE_A_SIM_NAME);
}

/** Pull the current Drape A camera into module defaults (orbit height + framing). */
export function syncDefaultCameraFromDrapeA(project: ProjectDocument): void {
  const drapeA = drapeASim(project);
  if (!drapeA?.camera) return;
  setDefaultSimCamera(drapeA.camera);
}

/** Upgrade cameras saved before the avatar collider framing pass. */
export function migrateLegacySimCamera(
  camera: SimCameraState,
  defaults: SimCameraState = DEFAULT_SIM_CAMERA
): void {
  const legacyOrbitY = 1.5;
  const looksLegacy =
    (camera.distance <= 14 && camera.target[1] <= 2) ||
    Math.abs(camera.target[1] - legacyOrbitY) < 0.01;
  if (looksLegacy) {
    Object.assign(camera, cloneSimCamera(defaults));
    camera.target = [...defaults.target] as [number, number, number];
    return;
  }
  ensureAvatarFraming(camera, defaults);
}

function ensureAvatarFraming(camera: SimCameraState, defaults: SimCameraState): void {
  const tooClose = camera.distance < 20;
  const legacyOrbit = camera.target[1] <= 2;
  if (!tooClose && !legacyOrbit) return;
  Object.assign(camera, cloneSimCamera(defaults));
  camera.target = [...defaults.target] as [number, number, number];
}

/** Inches → world units helper (1 world unit = 10 cm). */
export function inchesToOrbitWorld(inches: number): number {
  return inches * 2.54 * CM_TO_WORLD;
}
