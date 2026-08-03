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

export function normalizeProject(project: ProjectDocument): ProjectDocument {
  const normalized: ProjectDocument = {
    ...project,
    transforms: project.transforms ?? [],
    meshTransformAssignments: project.meshTransformAssignments ?? [],
    transformSimAssignments: project.transformSimAssignments ?? [],
  };

  for (const transform of normalized.transforms) {
    if (!transform.pieceTransforms) transform.pieceTransforms = {};
  }

  // Repair projects created by the first Transform 3D implementation, where
  // the node/links received a separately generated ID from the document.
  const transformIds = new Set(normalized.transforms.map((transform) => transform.id));
  const claimedIds = new Set<string>();
  for (const node of normalized.canvas.nodes) {
    if (node.type !== 'transform3d') continue;
    if (transformIds.has(node.transformId)) {
      claimedIds.add(node.transformId);
      continue;
    }

    const staleId = node.transformId;
    const replacement = normalized.transforms.find(
      (transform) => !claimedIds.has(transform.id)
    );
    if (!replacement) continue;

    node.transformId = replacement.id;
    claimedIds.add(replacement.id);
    for (const assignment of normalized.meshTransformAssignments) {
      if (assignment.transformId === staleId) {
        assignment.transformId = replacement.id;
      }
    }
    for (const assignment of normalized.transformSimAssignments) {
      if (assignment.transformId === staleId) {
        assignment.transformId = replacement.id;
      }
    }
  }

  // One mesh link per transform (duplicates remesh/rebuild the same node twice).
  const seenTransformLinks = new Set<string>();
  normalized.meshTransformAssignments = normalized.meshTransformAssignments.filter((assignment) => {
    if (!transformIds.has(assignment.transformId)) return false;
    if (seenTransformLinks.has(assignment.transformId)) return false;
    seenTransformLinks.add(assignment.transformId);
    return true;
  });

  return normalized;
}

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

export function serializeProject(project: ProjectDocument): string {
  return JSON.stringify(project);
}

export function parseProject(json: string): ProjectDocument {
  const raw = JSON.parse(json) as {
    version: number;
    id: string;
    name: string;
    displayUnit: ProjectDocument['displayUnit'];
    canvas?: ProjectDocument['canvas'];
    patterns?: ProjectDocument['patterns'];
    meshes?: MeshDocument[];
    sims?: ProjectDocument['sims'];
    assignments?: Array<{ id: string; patternId?: string; meshId?: string; simId: string }>;
    activeSimId?: string | null;
  };

  if (raw.version === 2 && Array.isArray(raw.meshes)) {
    return normalizeProject(raw as ProjectDocument);
  }

  // Migrate v1 pattern→sim assignments into Pattern → Mesh → Sim
  if (raw.version === 1) {
    const patterns = raw.patterns ?? [];
    const sims = raw.sims ?? [];
    const meshes: MeshDocument[] = [];
    const assignments: ProjectDocument['assignments'] = [];
    const nodes = [...(raw.canvas?.nodes ?? [])];

    const oldAssigns = (raw.assignments ?? []).filter((a) => a.patternId && a.simId);
    const patternIds = new Set(oldAssigns.map((a) => a.patternId!));
    if (patternIds.size === 0 && patterns[0]) patternIds.add(patterns[0].id);

    let meshOffset = 0;
    for (const patternId of patternIds) {
      const pattern = patterns.find((p) => p.id === patternId);
      const mesh = createMeshDocument(patternId, `Mesh · ${pattern?.name ?? 'panel'}`);
      remeshDocument(mesh, pattern);
      meshes.push(mesh);
      nodes.push({
        type: 'meshFrame',
        id: uid('node'),
        meshId: mesh.id,
        x: 420,
        y: 100 + meshOffset * 40,
        width: DEFAULT_MESH_FRAME_WIDTH,
        height: DEFAULT_MESH_FRAME_HEIGHT,
        zIndex: 50 + meshOffset,
      });
      meshOffset += 1;
      for (const a of oldAssigns.filter((x) => x.patternId === patternId)) {
        assignments.push({ id: uid('assign'), meshId: mesh.id, simId: a.simId });
      }
    }

    return {
      version: 2,
      id: raw.id,
      name: raw.name,
      displayUnit: raw.displayUnit,
      canvas: {
        panX: raw.canvas?.panX ?? 0,
        panY: raw.canvas?.panY ?? 0,
        zoom: raw.canvas?.zoom ?? 1,
        nodes,
      },
      patterns,
      meshes,
      transforms: [],
      sims,
      assignments,
      meshTransformAssignments: [],
      transformSimAssignments: [],
      activeSimId: raw.activeSimId ?? null,
    };
  }

  throw new Error(`Unsupported project version: ${raw.version}`);
}

export function downloadProject(project: ProjectDocument): void {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name.replace(/\s+/g, '_') || 'project'}.patterncanvas.json`;
  a.click();
  URL.revokeObjectURL(url);
}
