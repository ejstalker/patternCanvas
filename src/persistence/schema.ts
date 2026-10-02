/** IndexedDB / on-disk persistence schema (v3). Runtime uses hydrated ProjectDocument. */

import type {
  CanvasNode,
  ImageNode,
  MeshDocument,
  MeshGeometry,
  MeshSettings,
  PatternDocument,
  ProjectDocument,
  SimInstance,
  SimParams,
  Transform3dInstance,
  UnitDisplay,
} from '../project/types';

export const STORAGE_VERSION = 3;
export const IDB_NAME = 'patternCanvas';
export const IDB_VERSION = 1;

export const IDB_STORES = {
  projects: 'projects',
  assets: 'assets',
  poses: 'poses',
  meshCaches: 'meshCaches',
  meta: 'meta',
} as const;

export type AssetRecord = {
  id: string;
  projectId: string;
  mime: string;
  byteLength: number;
  blob: Blob;
  createdAt: number;
};

export type PoseOwnerType = 'sim' | 'transform';

export type PoseRecord = {
  id: string;
  projectId: string;
  ownerType: PoseOwnerType;
  ownerId: string;
  vertexCount: number;
  topologyHash: string;
  positions: ArrayBuffer;
  velocities?: ArrayBuffer;
  updatedAt: number;
};

export type MeshCacheRecord = {
  id: string;
  projectId: string;
  meshId: string;
  settingsHash: string;
  /** Packed mesh geometry bytes (see packMeshGeometry). */
  data: ArrayBuffer;
  updatedAt: number;
};

export type ProjectMetaRecord = {
  id: string;
  name: string;
  updatedAt: number;
  revision: number;
  manifest: ProjectManifestV3;
};

export type ImageNodeManifest = Omit<ImageNode, 'src'> & {
  assetId: string;
  /** Runtime-only; omitted from persisted manifest. */
  src?: string;
};

export type CanvasNodeManifest =
  | Exclude<CanvasNode, ImageNode>
  | ImageNodeManifest;

export type MeshDocumentManifest = Omit<MeshDocument, 'geometry'> & {
  geometryCacheId?: string | null;
};

export type SimManifest = Omit<SimInstance, 'pose'> & {
  poseId?: string | null;
};

export type TransformManifest = Omit<Transform3dInstance, 'pose'> & {
  poseId?: string | null;
};

/** Slim persisted project — heavy payloads live in sibling IDB stores. */
export type ProjectManifestV3 = {
  version: 3;
  id: string;
  name: string;
  displayUnit: UnitDisplay;
  canvas: {
    panX: number;
    panY: number;
    zoom: number;
    nodes: CanvasNodeManifest[];
  };
  patterns: PatternDocument[];
  meshes: MeshDocumentManifest[];
  transforms: TransformManifest[];
  sims: SimManifest[];
  assignments: ProjectDocument['assignments'];
  meshTransformAssignments: ProjectDocument['meshTransformAssignments'];
  transformSimAssignments: ProjectDocument['transformSimAssignments'];
  activeSimId: string | null;
  revision: number;
};

export type SavePayload = {
  manifest: ProjectManifestV3;
  assets: AssetRecord[];
  poses: PoseRecord[];
  meshCaches: MeshCacheRecord[];
  /** Asset IDs referenced but unchanged (skip rewrite). */
  retainedAssetIds?: string[];
  retainedPoseIds?: string[];
  retainedMeshCacheIds?: string[];
};

export type PackedMeshGeometry = {
  vertices: Float32Array;
  vertexPieceIds: Array<string | null>;
  triangles: Uint32Array;
  edgesFlat: Uint32Array;
  boundaryJson: string;
};

export function meshSettingsHash(settings: MeshSettings, patternId: string): string {
  return `${patternId}:${settings.algorithm}:${settings.targetEdgeCm}:${settings.boundarySpacingCm}:${settings.lloydIterations}`;
}

export function packMeshGeometry(geom: MeshGeometry): ArrayBuffer {
  const packed: PackedMeshGeometry = {
    vertices: new Float32Array(geom.vertices.flatMap((v) => [v.x, v.y])),
    vertexPieceIds: geom.vertexPieceIds ?? geom.vertices.map(() => null),
    triangles: new Uint32Array(geom.triangles),
    edgesFlat: new Uint32Array(geom.edges.flatMap(([a, b]) => [a, b])),
    boundaryJson: JSON.stringify(geom.boundary ?? geom.vertices.map(() => null)),
  };
  const json = JSON.stringify({
    v: Array.from(packed.vertices),
    vp: packed.vertexPieceIds,
    t: Array.from(packed.triangles),
    e: Array.from(packed.edgesFlat),
    b: packed.boundaryJson,
  });
  return new TextEncoder().encode(json).buffer;
}

export function unpackMeshGeometry(data: ArrayBuffer): MeshGeometry {
  const raw = JSON.parse(new TextDecoder().decode(data)) as {
    v: number[];
    vp: Array<string | null>;
    t: number[];
    e: number[];
    b: string;
  };
  const vertices: MeshGeometry['vertices'] = [];
  for (let i = 0; i < raw.v.length; i += 2) {
    vertices.push({ x: raw.v[i], y: raw.v[i + 1] });
  }
  const edges: MeshGeometry['edges'] = [];
  for (let i = 0; i < raw.e.length; i += 2) {
    edges.push([raw.e[i], raw.e[i + 1]]);
  }
  const boundary = JSON.parse(raw.b) as MeshGeometry['boundary'];
  return {
    vertices,
    vertexPieceIds: raw.vp,
    triangles: raw.t,
    edges,
    boundary,
  };
}

export function poseTopologyHash(meshId: string, settingsHash: string, vertexCount: number): string {
  return `${meshId}:${settingsHash}:${vertexCount}`;
}

export function packPose(positions: number[], velocities?: number[]): { positions: ArrayBuffer; velocities?: ArrayBuffer } {
  const pos = new Float32Array(positions);
  const out: { positions: ArrayBuffer; velocities?: ArrayBuffer } = { positions: pos.buffer.slice(0) };
  if (velocities && velocities.length) {
    out.velocities = new Float32Array(velocities).buffer.slice(0);
  }
  return out;
}

export function unpackPose(record: PoseRecord): { positions: number[]; velocities?: number[] } {
  const positions = Array.from(new Float32Array(record.positions));
  const velocities = record.velocities
    ? Array.from(new Float32Array(record.velocities))
    : undefined;
  return { positions, velocities };
}
