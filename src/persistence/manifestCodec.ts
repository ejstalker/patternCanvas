import type {
  ImageNode,
  MeshDocument,
  ProjectDocument,
  SimInstance,
  Transform3dInstance,
} from '../project/types';
import { uid } from '../project/createDefault';
import { normalizeProject } from './projectCodec';
import {
  meshSettingsHash,
  packMeshGeometry,
  packPose,
  poseTopologyHash,
  type AssetRecord,
  type CanvasNodeManifest,
  type ImageNodeManifest,
  type MeshCacheRecord,
  type MeshDocumentManifest,
  type PoseRecord,
  type ProjectManifestV3,
  type SavePayload,
  type SimManifest,
  type TransformManifest,
  unpackMeshGeometry,
  unpackPose,
} from './schema';

export type ExternalizeOptions = {
  projectId: string;
  revision: number;
  /** Existing asset IDs keyed by data URL src to avoid re-upload. */
  existingAssetsBySrc?: Map<string, string>;
  /**
   * asset ID → the src whose bytes are actually in storage, owned by the store so
   * it survives between saves. An image is only skipped when its current src is
   * byte-for-byte the one recorded here; everything else is uploaded, which both
   * writes new images and repairs one whose blob never reached storage. The codec
   * records what it stores, so the map stays current.
   */
  storedAssetSrc?: Map<string, string>;
};

function isDataUrl(src: string): boolean {
  return src.startsWith('data:');
}

async function dataUrlToBlob(dataUrl: string): Promise<{ blob: Blob; mime: string }> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return { blob, mime: blob.type || 'application/octet-stream' };
}

function manifestNodesFromDocument(
  nodes: ProjectDocument['canvas']['nodes'],
  assetMap: Map<string, string>
): CanvasNodeManifest[] {
  return nodes.map((node) => {
    if (node.type !== 'image') return node;
    const img = node as ImageNode & { assetId?: string };
    let assetId = img.assetId;
    if (!assetId && img.src && assetMap.has(img.src)) {
      assetId = assetMap.get(img.src)!;
    }
    if (!assetId && img.src) {
      assetId = uid('asset');
      assetMap.set(img.src, assetId);
    }
    const { src: _s, ...rest } = img;
    return { ...rest, assetId: assetId ?? uid('asset') } as ImageNodeManifest;
  });
}

export async function documentToSavePayload(
  project: ProjectDocument,
  opts: ExternalizeOptions
): Promise<SavePayload> {
  const assetMap = new Map<string, string>(opts.existingAssetsBySrc);
  const assets: AssetRecord[] = [];
  const now = Date.now();
  // One write per asset, however many nodes share it.
  const stored = new Set<string>();

  for (const node of project.canvas.nodes) {
    if (node.type !== 'image') continue;
    const img = node as ImageNode & { assetId?: string };
    // Only an in-memory data URL still needs writing. A blob URL means the node
    // is already pointing at what an earlier save put in storage.
    if (!img.src || !isDataUrl(img.src)) continue;
    const assetId = img.assetId ?? assetMap.get(img.src) ?? uid('asset');
    assetMap.set(img.src, assetId);
    if (stored.has(assetId) || opts.storedAssetSrc?.get(assetId) === img.src) continue;
    const { blob, mime } = await dataUrlToBlob(img.src);
    assets.push({
      id: assetId,
      projectId: opts.projectId,
      mime,
      byteLength: blob.size,
      blob,
      createdAt: now,
    });
    stored.add(assetId);
    opts.storedAssetSrc?.set(assetId, img.src);
  }

  const poses: PoseRecord[] = [];
  const meshCaches: MeshCacheRecord[] = [];

  const meshes: MeshDocumentManifest[] = project.meshes.map((mesh) => {
    const pattern = project.patterns.find((p) => p.id === mesh.patternId);
    const settingsHash = meshSettingsHash(mesh.settings, mesh.patternId);
    let geometryCacheId: string | null = null;
    if (mesh.geometry && pattern) {
      geometryCacheId = `mc_${mesh.id}`;
      meshCaches.push({
        id: geometryCacheId,
        projectId: opts.projectId,
        meshId: mesh.id,
        settingsHash,
        data: packMeshGeometry(mesh.geometry),
        updatedAt: now,
      });
    }
    const { geometry: _g, ...rest } = mesh;
    return { ...rest, geometryCacheId };
  });

  const sims: SimManifest[] = project.sims.map((sim) => {
    const poseId = sim.pose ? `pose_sim_${sim.id}` : null;
    if (sim.pose && poseId) {
      const meshId = project.assignments.find((a) => a.simId === sim.id)?.meshId ?? 'unknown';
      const mesh = project.meshes.find((m) => m.id === meshId);
      const settingsHash = mesh ? meshSettingsHash(mesh.settings, mesh.patternId) : 'none';
      const vertexCount = sim.pose.positions.length / 3;
      const packed = packPose(sim.pose.positions, sim.pose.velocities);
      poses.push({
        id: poseId,
        projectId: opts.projectId,
        ownerType: 'sim',
        ownerId: sim.id,
        vertexCount,
        topologyHash: poseTopologyHash(meshId, settingsHash, vertexCount),
        positions: packed.positions,
        velocities: packed.velocities,
        updatedAt: now,
      });
    }
    const { pose: _p, ...rest } = sim;
    return { ...rest, poseId };
  });

  const transforms: TransformManifest[] = project.transforms.map((transform) => {
    const poseId = transform.pose ? `pose_tf_${transform.id}` : null;
    if (transform.pose && poseId) {
      const mesh = project.meshes.find((m) => m.id === transform.meshId);
      const settingsHash = mesh ? meshSettingsHash(mesh.settings, mesh.patternId) : 'none';
      const vertexCount = transform.pose.positions.length / 3;
      const packed = packPose(transform.pose.positions, transform.pose.velocities);
      poses.push({
        id: poseId,
        projectId: opts.projectId,
        ownerType: 'transform',
        ownerId: transform.id,
        vertexCount,
        topologyHash: poseTopologyHash(transform.meshId, settingsHash, vertexCount),
        positions: packed.positions,
        velocities: packed.velocities,
        updatedAt: now,
      });
    }
    const { pose: _p, ...rest } = transform;
    return { ...rest, poseId };
  });

  const manifest: ProjectManifestV3 = {
    version: 3,
    id: project.id,
    name: project.name,
    displayUnit: project.displayUnit,
    canvas: {
      panX: project.canvas.panX,
      panY: project.canvas.panY,
      zoom: project.canvas.zoom,
      nodes: manifestNodesFromDocument(project.canvas.nodes, assetMap),
    },
    patterns: project.patterns,
    meshes,
    transforms,
    sims,
    assignments: project.assignments,
    meshTransformAssignments: project.meshTransformAssignments,
    transformSimAssignments: project.transformSimAssignments,
    activeSimId: project.activeSimId,
    revision: opts.revision,
  };

  return { manifest, assets, poses, meshCaches };
}

export function manifestToDocument(
  manifest: ProjectManifestV3,
  assets: Map<string, Blob>,
  poses: Map<string, PoseRecord>,
  meshCaches: Map<string, MeshCacheRecord>,
  resolveAssetUrl: (assetId: string, blob: Blob) => string
): ProjectDocument {
  const nodes = manifest.canvas.nodes.map((node) => {
    if (node.type !== 'image') return node;
    const img = node as ImageNodeManifest;
    const blob = assets.get(img.assetId);
    const src = blob ? resolveAssetUrl(img.assetId, blob) : '';
    return { ...img, src, assetId: img.assetId } as ImageNode & { assetId: string };
  });

  const meshes: MeshDocument[] = manifest.meshes.map((mesh) => {
    const m = mesh as MeshDocumentManifest;
    let geometry = null as MeshDocument['geometry'];
    if (m.geometryCacheId) {
      const cache = meshCaches.get(m.geometryCacheId);
      if (cache) geometry = unpackMeshGeometry(cache.data);
    }
    const { geometryCacheId: _g, ...rest } = m;
    return { ...rest, geometry };
  });

  const sims: SimInstance[] = manifest.sims.map((sim) => {
    const s = sim as SimManifest;
    let pose: SimInstance['pose'] = null;
    if (s.poseId) {
      const rec = poses.get(s.poseId);
      if (rec) {
        const unpacked = unpackPose(rec);
        pose = { positions: unpacked.positions, velocities: unpacked.velocities };
      }
    }
    const { poseId: _p, ...rest } = s;
    return { ...rest, pose };
  });

  const transforms: Transform3dInstance[] = manifest.transforms.map((transform) => {
    const t = transform as TransformManifest;
    let pose: Transform3dInstance['pose'] = null;
    if (t.poseId) {
      const rec = poses.get(t.poseId);
      if (rec) {
        const unpacked = unpackPose(rec);
        pose = { positions: unpacked.positions, velocities: unpacked.velocities };
      }
    }
    const { poseId: _p, ...rest } = t;
    return { ...rest, pose };
  });

  return normalizeProject({
    version: 2,
    id: manifest.id,
    name: manifest.name,
    displayUnit: manifest.displayUnit,
    canvas: { ...manifest.canvas, nodes },
    patterns: manifest.patterns,
    meshes,
    transforms,
    sims,
    assignments: manifest.assignments,
    meshTransformAssignments: manifest.meshTransformAssignments,
    transformSimAssignments: manifest.transformSimAssignments,
    activeSimId: manifest.activeSimId,
  });
}

/** Convert v2 JSON document directly to save payload (migration). */
export async function v2DocumentToSavePayload(
  project: ProjectDocument,
  revision = 1
): Promise<SavePayload> {
  return documentToSavePayload(project, { projectId: project.id, revision });
}
