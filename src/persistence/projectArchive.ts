import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { normalizeProject, parseProject, serializeProject } from './projectCodec';
import { documentToSavePayload, manifestToDocument } from './manifestCodec';
import type { ProjectDocument } from '../project/types';
import type { ProjectManifestV3 } from './schema';
import { packMeshGeometry, packPose, type AssetRecord, type MeshCacheRecord, type PoseRecord } from './schema';

const MANIFEST_NAME = 'manifest.json';
const ASSETS_DIR = 'assets/';
const POSES_DIR = 'poses/';
const MESH_DIR = 'mesh/';

export type ArchiveProgress = {
  phase: 'pack' | 'unpack' | 'commit';
  done: number;
  total: number;
};

export async function exportProjectArchiveBytes(
  project: ProjectDocument,
  onProgress?: (p: ArchiveProgress) => void
): Promise<Uint8Array> {
  onProgress?.({ phase: 'pack', done: 0, total: 1 });
  const payload = await documentToSavePayload(project, {
    projectId: project.id,
    revision: 1,
  });

  const files: Record<string, Uint8Array> = {};
  files[MANIFEST_NAME] = strToU8(JSON.stringify(payload.manifest, null, 0));

  let i = 0;
  const total = payload.assets.length + payload.poses.length + payload.meshCaches.length + 1;

  for (const asset of payload.assets) {
    i += 1;
    onProgress?.({ phase: 'pack', done: i, total });
    const buf = new Uint8Array(await asset.blob.arrayBuffer());
    files[`${ASSETS_DIR}${asset.id}.bin`] = buf;
    files[`${ASSETS_DIR}${asset.id}.meta.json`] = strToU8(
      JSON.stringify({ mime: asset.mime, byteLength: asset.byteLength })
    );
  }

  for (const pose of payload.poses) {
    i += 1;
    onProgress?.({ phase: 'pack', done: i, total });
    files[`${POSES_DIR}${pose.id}.json`] = strToU8(
      JSON.stringify({
        id: pose.id,
        ownerType: pose.ownerType,
        ownerId: pose.ownerId,
        vertexCount: pose.vertexCount,
        topologyHash: pose.topologyHash,
        updatedAt: pose.updatedAt,
      })
    );
    files[`${POSES_DIR}${pose.id}.positions.bin`] = new Uint8Array(pose.positions);
    if (pose.velocities) {
      files[`${POSES_DIR}${pose.id}.velocities.bin`] = new Uint8Array(pose.velocities);
    }
  }

  for (const cache of payload.meshCaches) {
    i += 1;
    onProgress?.({ phase: 'pack', done: i, total });
    files[`${MESH_DIR}${cache.id}.json`] = strToU8(
      JSON.stringify({
        id: cache.id,
        meshId: cache.meshId,
        settingsHash: cache.settingsHash,
        updatedAt: cache.updatedAt,
      })
    );
    files[`${MESH_DIR}${cache.id}.bin`] = new Uint8Array(cache.data);
  }

  return zipSync(files, { level: 6 });
}

export async function exportProjectArchive(
  project: ProjectDocument,
  onProgress?: (p: ArchiveProgress) => void
): Promise<Blob> {
  const zipped = await exportProjectArchiveBytes(project, onProgress);
  return new Blob([zipped as unknown as BlobPart], { type: 'application/zip' });
}

export type ParsedArchive = {
  manifest: ProjectManifestV3;
  assets: AssetRecord[];
  poses: PoseRecord[];
  meshCaches: MeshCacheRecord[];
};

export function parseArchiveBytes(bytes: Uint8Array): ParsedArchive {
  const unzipped = unzipSync(bytes);
  const manifestRaw = unzipped[MANIFEST_NAME];
  if (!manifestRaw) throw new Error('Archive missing manifest.json');
  const manifest = JSON.parse(strFromU8(manifestRaw)) as ProjectManifestV3;
  if (manifest.version !== 3) throw new Error(`Unsupported archive manifest version: ${manifest.version}`);

  const assets: AssetRecord[] = [];
  const poses: PoseRecord[] = [];
  const meshCaches: MeshCacheRecord[] = [];
  const now = Date.now();

  for (const path of Object.keys(unzipped)) {
    if (path.startsWith(ASSETS_DIR) && path.endsWith('.meta.json')) {
      const id = path.slice(ASSETS_DIR.length, -'.meta.json'.length);
      const meta = JSON.parse(strFromU8(unzipped[path]!)) as { mime: string; byteLength: number };
      const data = unzipped[`${ASSETS_DIR}${id}.bin`];
      if (!data) throw new Error(`Archive missing asset blob: ${id}`);
      assets.push({
        id,
        projectId: manifest.id,
        mime: meta.mime,
        byteLength: meta.byteLength,
        blob: new Blob([data], { type: meta.mime }),
        createdAt: now,
      });
    }
  }

  for (const path of Object.keys(unzipped)) {
    if (path.startsWith(POSES_DIR) && path.endsWith('.json') && !path.includes('.positions.') && !path.includes('.velocities.')) {
      const id = path.slice(POSES_DIR.length, -'.json'.length);
      const meta = JSON.parse(strFromU8(unzipped[path]!)) as Omit<PoseRecord, 'projectId' | 'positions' | 'velocities'>;
      const pos = unzipped[`${POSES_DIR}${id}.positions.bin`];
      if (!pos) throw new Error(`Archive missing pose positions: ${id}`);
      const vel = unzipped[`${POSES_DIR}${id}.velocities.bin`];
      poses.push({
        ...meta,
        projectId: manifest.id,
        positions: pos.buffer.slice(pos.byteOffset, pos.byteOffset + pos.byteLength),
        velocities: vel
          ? vel.buffer.slice(vel.byteOffset, vel.byteOffset + vel.byteLength)
          : undefined,
      });
    }
  }

  for (const path of Object.keys(unzipped)) {
    if (path.startsWith(MESH_DIR) && path.endsWith('.json')) {
      const id = path.slice(MESH_DIR.length, -'.json'.length);
      const meta = JSON.parse(strFromU8(unzipped[path]!)) as Omit<MeshCacheRecord, 'projectId' | 'data'>;
      const data = unzipped[`${MESH_DIR}${id}.bin`];
      if (!data) throw new Error(`Archive missing mesh cache: ${id}`);
      meshCaches.push({
        ...meta,
        projectId: manifest.id,
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      });
    }
  }

  return { manifest, assets, poses, meshCaches };
}

export async function importProjectArchive(bytes: Uint8Array): Promise<ProjectDocument> {
  const parsed = parseArchiveBytes(bytes);
  const assets = new Map(parsed.assets.map((a) => [a.id, a.blob]));
  const poses = new Map(parsed.poses.map((p) => [p.id, p]));
  const meshCaches = new Map(parsed.meshCaches.map((m) => [m.id, m]));
  return manifestToDocument(
    parsed.manifest,
    assets,
    poses,
    meshCaches,
    (_assetId, blob) => URL.createObjectURL(blob)
  );
}

/** Accept legacy JSON or .patterncanvas zip bytes. */
export async function importPortableProject(file: File): Promise<ProjectDocument> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.patterncanvas') || file.type === 'application/zip') {
    const buf = new Uint8Array(await file.arrayBuffer());
    return importProjectArchive(buf);
  }
  const text = await file.text();
  return normalizeProject(parseProject(text));
}

export async function downloadProjectArchive(project: ProjectDocument, filename?: string): Promise<void> {
  const blob = await exportProjectArchive(project);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? `${project.name.replace(/\s+/g, '_') || 'project'}.patterncanvas`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Build archive from legacy v2 JSON string (migration helper). */
export async function legacyJsonToArchive(json: string): Promise<Blob> {
  const project = normalizeProject(parseProject(json));
  return exportProjectArchive(project);
}

export { serializeProject, parseProject, packMeshGeometry, packPose };
