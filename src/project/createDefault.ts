import type {
  BezierPoint,
  MeshDocument,
  PatternDocument,
  PatternPiece,
  ProjectDocument,
  SimInstance,
  SimParams,
  Transform3dInstance,
  Vec2,
} from './types';
import { DEFAULT_MESH_SETTINGS, triangulatePattern } from '../mesh/triangulate';
import { getDefaultSimCamera, syncDefaultCameraFromDrapeA } from '../sim/cameraDefaults';

let _seq = 0;
export function uid(prefix = 'id'): string {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

export const DEFAULT_SIM_PARAMS: SimParams = {
  particleResolution: 15,
  mass: 100,
  springConst: 1000,
  dampingConst: 3.5,
  gravity: 0.8,
  wind: [0, 0, 0],
  fluidDensity: 1.225,
  dragCoeff: 1.0,
  engine: 'cpu-mass-spring',
  /** Prefer more CPU substeps for fidelity (GPU inspector can lower). */
  substeps: 24,
  constraintIterations: 6,
  stretchCompliance: 0,
  bendCompliance: 1e-3,
  bendSpringScale: 0.2,
  maxStretch: 1.12,
  velocityDamping: 0.998,
  longRangeStretchiness: 1.2,
  particleDiameterScalar: 1.5,
  contactFriction: 0.45,
  enableSelfCollision: false,
  interleavedHash: 3,
  maxSpeed: 30,
};

/** Default mesh preview frame size (40% of original 340×400). */
export const DEFAULT_MESH_FRAME_WIDTH = 136;
export const DEFAULT_MESH_FRAME_HEIGHT = 160;

export function rectPiece(
  name: string,
  widthCm: number,
  heightCm: number,
  origin: Vec2 = { x: 0, y: 0 }
): PatternPiece {
  const pts: BezierPoint[] = [
    {
      id: uid('pt'),
      anchor: { x: origin.x, y: origin.y },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    },
    {
      id: uid('pt'),
      anchor: { x: origin.x + widthCm, y: origin.y },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    },
    {
      id: uid('pt'),
      anchor: { x: origin.x + widthCm, y: origin.y + heightCm },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    },
    {
      id: uid('pt'),
      anchor: { x: origin.x, y: origin.y + heightCm },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    },
  ];
  return {
    id: uid('piece'),
    name,
    closed: true,
    points: pts,
    grainline: {
      from: { x: origin.x + widthCm * 0.5, y: origin.y + heightCm * 0.2 },
      to: { x: origin.x + widthCm * 0.5, y: origin.y + heightCm * 0.8 },
    },
  };
}

/** Cubic Bézier kappa for a quarter-circle approximation. */
const BEZIER_CIRCLE_K = 0.5522847498;

/** Closed elliptical (or circular) piece approximated with 4 cubic Bézier corners. */
export function ellipsePiece(
  name: string,
  cx: number,
  cy: number,
  rx: number,
  ry: number
): PatternPiece {
  const ox = rx * BEZIER_CIRCLE_K;
  const oy = ry * BEZIER_CIRCLE_K;
  const pts: BezierPoint[] = [
    {
      id: uid('pt'),
      anchor: { x: cx + rx, y: cy },
      handleIn: { x: cx + rx, y: cy - oy },
      handleOut: { x: cx + rx, y: cy + oy },
      handlesParallel: true,
    },
    {
      id: uid('pt'),
      anchor: { x: cx, y: cy + ry },
      handleIn: { x: cx + ox, y: cy + ry },
      handleOut: { x: cx - ox, y: cy + ry },
      handlesParallel: true,
    },
    {
      id: uid('pt'),
      anchor: { x: cx - rx, y: cy },
      handleIn: { x: cx - rx, y: cy + oy },
      handleOut: { x: cx - rx, y: cy - oy },
      handlesParallel: true,
    },
    {
      id: uid('pt'),
      anchor: { x: cx, y: cy - ry },
      handleIn: { x: cx - ox, y: cy - ry },
      handleOut: { x: cx + ox, y: cy - ry },
      handlesParallel: true,
    },
  ];
  return {
    id: uid('piece'),
    name,
    closed: true,
    points: pts,
    grainline: {
      from: { x: cx, y: cy - ry * 0.6 },
      to: { x: cx, y: cy + ry * 0.6 },
    },
  };
}

export function circlePiece(name: string, cx: number, cy: number, radiusCm: number): PatternPiece {
  return ellipsePiece(name, cx, cy, radiusCm, radiusCm);
}

export function createMeshDocument(patternId: string, name = 'Mesh'): MeshDocument {
  const doc: MeshDocument = {
    id: uid('mesh'),
    name,
    patternId,
    settings: { ...DEFAULT_MESH_SETTINGS },
    geometry: null,
  };
  return doc;
}

export function createTransform3dDocument(meshId: string, name = 'Transform 3D'): Transform3dInstance {
  return {
    id: uid('transform'),
    name,
    meshId,
    camera: getDefaultSimCamera(),
    pose: null,
    pieceTransforms: {},
  };
}

export { normalizeProject, serializeProject, parseProject } from '../persistence/projectCodec';

export function remeshDocument(mesh: MeshDocument, pattern: PatternDocument | undefined): void {
  mesh.geometry = triangulatePattern(pattern, mesh.settings);
}

export function createDefaultProject(): ProjectDocument {
  const patternId = uid('pattern');
  const meshId = uid('mesh');
  const simId = uid('sim');
  const piece = rectPiece('Front panel', 40, 50, { x: 5, y: 5 });

  const pattern: PatternDocument = {
    id: patternId,
    name: 'Study A',
    pieces: [piece],
    seams: [],
  };

  const mesh: MeshDocument = {
    id: meshId,
    name: 'Panel mesh',
    patternId,
    settings: { ...DEFAULT_MESH_SETTINGS },
    geometry: null,
  };
  remeshDocument(mesh, pattern);

  const transform = createTransform3dDocument(meshId, 'Transform 3D');
  const transformId = transform.id;

  const makeSim = (id: string, name: string): SimInstance => ({
    id,
    name,
    params: { ...DEFAULT_SIM_PARAMS },
    pose: null,
    camera: getDefaultSimCamera(),
    dropped: false,
  });

  const project: ProjectDocument = {
    version: 2,
    id: uid('project'),
    name: 'Untitled project',
    displayUnit: 'cm',
    canvas: {
      panX: 40,
      panY: 40,
      zoom: 1,
      nodes: [
        {
          type: 'patternFrame',
          id: uid('node'),
          patternId,
          x: 20,
          y: 70,
          width: 360,
          height: 440,
          zIndex: 1,
        },
        {
          type: 'meshFrame',
          id: uid('node'),
          meshId,
          x: 420,
          y: 100,
          width: DEFAULT_MESH_FRAME_WIDTH,
          height: DEFAULT_MESH_FRAME_HEIGHT,
          zIndex: 2,
        },
        {
          type: 'transform3d',
          id: uid('node'),
          transformId,
          x: 580,
          y: 60,
          width: 380,
          height: 320,
          zIndex: 3,
        },
        {
          type: 'simViewport',
          id: uid('node'),
          simId,
          x: 980,
          y: 40,
          width: 420,
          height: 340,
          zIndex: 4,
        },
      ],
    },
    patterns: [pattern],
    meshes: [mesh],
    transforms: [transform],
    sims: [makeSim(simId, 'Drape A')],
    assignments: [],
    meshTransformAssignments: [{ id: uid('assign'), meshId, transformId }],
    transformSimAssignments: [{ id: uid('assign'), transformId, simId }],
    activeSimId: null,
  };
  syncDefaultCameraFromDrapeA(project);
  return project;
}

export function downloadProject(project: ProjectDocument): void {
  const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name.replace(/\s+/g, '_') || 'project'}.patterncanvas.json`;
  a.click();
  URL.revokeObjectURL(url);
}
