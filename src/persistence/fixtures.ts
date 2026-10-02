import type { ProjectDocument } from '../project/types';
import { uid, DEFAULT_SIM_PARAMS, rectPiece } from '../project/createDefault';
import { getDefaultSimCamera } from '../sim/cameraDefaults';
import { triangulatePattern, DEFAULT_MESH_SETTINGS } from '../mesh/triangulate';

/** ~1 KB synthetic project for unit tests. */
export function createSmallFixture(): ProjectDocument {
  const patternId = 'pattern_small';
  const meshId = 'mesh_small';
  const simId = 'sim_small';
  const piece = rectPiece('Panel', 20, 30, { x: 0, y: 0 });
  return {
    version: 2,
    id: 'project_small',
    name: 'Small fixture',
    displayUnit: 'cm',
    canvas: { panX: 0, panY: 0, zoom: 1, nodes: [] },
    patterns: [{ id: patternId, name: 'P', pieces: [piece], seams: [] }],
    meshes: [
      {
        id: meshId,
        name: 'Mesh',
        patternId,
        settings: { ...DEFAULT_MESH_SETTINGS },
        geometry: triangulatePattern(
          { id: patternId, name: 'P', pieces: [piece], seams: [] },
          { ...DEFAULT_MESH_SETTINGS }
        ),
      },
    ],
    transforms: [],
    sims: [{
      id: simId,
      name: 'Sim',
      params: { ...DEFAULT_SIM_PARAMS },
      pose: null,
      camera: getDefaultSimCamera(),
      dropped: false,
    }],
    assignments: [{ id: uid('assign'), meshId, simId }],
    meshTransformAssignments: [],
    transformSimAssignments: [],
    activeSimId: null,
  };
}

/** ~10 MB class project with synthetic image data URL and dense mesh. */
export function createMediumFixture(): ProjectDocument {
  const base = createSmallFixture();
  base.id = 'project_medium';
  base.name = 'Medium ~10MB fixture';

  const pixelCount = 512 * 512;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = (i / 4) % 256;
    rgba[i + 1] = 128;
    rgba[i + 2] = 64;
    rgba[i + 3] = 255;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const imgData = new ImageData(rgba, 512, 512);
  ctx.putImageData(imgData, 0, 0);
  const src = canvas.toDataURL('image/png');

  base.canvas.nodes.push({
    type: 'image',
    id: 'img_medium',
    x: 10,
    y: 10,
    width: 200,
    height: 200,
    zIndex: 1,
    src,
    label: 'Synthetic',
  });

  const positions: number[] = [];
  const n = 2000;
  for (let i = 0; i < n * 3; i++) positions.push(Math.sin(i * 0.01));
  base.sims[0]!.pose = { positions, velocities: positions.map(() => 0) };

  return base;
}

/** Larger fixture for perf benchmarks (scaled mesh + image). */
export function createLargeFixture(): ProjectDocument {
  const base = createMediumFixture();
  base.id = 'project_large';
  base.name = 'Large ~100MB class fixture';
  const positions: number[] = [];
  const n = 20000;
  for (let i = 0; i < n * 3; i++) positions.push(i * 0.001);
  base.sims[0]!.pose = { positions, velocities: positions.map(() => 0) };
  return base;
}
