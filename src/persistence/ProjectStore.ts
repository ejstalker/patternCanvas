import { normalizeProject, parseProject, serializeProject } from './projectCodec';
import { documentToSavePayload, manifestToDocument } from './manifestCodec';
import {
  deleteProjectBundle,
  estimateStorage,
  gcUnreferencedAssets,
  getAssetsForProject,
  getMeshCachesForProject,
  getMeta,
  getPosesForProject,
  getProjectMeta,
  listProjects,
  requestPersistentStorage,
  saveProjectBundle,
  setMeta,
} from './idb';
import type { ProjectDocument } from '../project/types';
import type { ProjectMetaRecord } from './schema';
import { AssetUrlResolver } from './assetResolver';

const LEGACY_LIBRARY_KEY = 'patternCanvas.library.v1';
const LEGACY_SINGLE_KEY = 'patternCanvas.project.v2';

export type SavedProjectRecord = {
  id: string;
  name: string;
  updatedAt: number;
  revision: number;
};

export type SaveResult = {
  ok: boolean;
  revision: number;
  error?: string;
};

export type DirtyState = {
  manifest: boolean;
  assetIds: Set<string>;
  poseIds: Set<string>;
  meshCacheIds: Set<string>;
};

export function createDirtyState(all = true): DirtyState {
  return {
    manifest: all,
    assetIds: new Set(),
    poseIds: new Set(),
    meshCacheIds: new Set(),
  };
}

export class ProjectStore {
  readonly assets = new AssetUrlResolver();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private saveChain: Promise<SaveResult> = Promise.resolve({ ok: true, revision: 0 });
  private revisionByProject = new Map<string, number>();
  /** src data URL → assetId for deduping within a session. */
  private assetIdsBySrc = new Map<string, string>();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    await requestPersistentStorage();
    const migrated = await getMeta('migratedFromLocalStorage');
    if (!migrated) {
      await this.migrateFromLocalStorage();
    }
    const version = await getMeta('storageVersion');
    if (!version) {
      await setMeta('storageVersion', '3');
    }
    const metas = await listProjects();
    for (const meta of metas) {
      this.revisionByProject.set(meta.id, meta.revision);
    }
    this.initialized = true;
  }

  private async migrateFromLocalStorage(): Promise<void> {
    let migratedCount = 0;
    try {
      const rawLib = localStorage.getItem(LEGACY_LIBRARY_KEY);
      if (rawLib) {
        const lib = JSON.parse(rawLib) as {
          version: number;
          activeId: string | null;
          projects: Array<{ id: string; name: string; updatedAt: number; data: ProjectDocument }>;
        };
        if (lib.version === 1 && Array.isArray(lib.projects)) {
          for (const record of lib.projects) {
            const project = normalizeProject(record.data);
            await this.saveProject(project, { revision: 0, forceFull: true, duringInit: true });
            migratedCount += 1;
          }
          if (lib.activeId) {
            await setMeta('activeProjectId', lib.activeId);
          }
        }
      } else {
        const rawSingle = localStorage.getItem(LEGACY_SINGLE_KEY);
        if (rawSingle) {
          const project = normalizeProject(parseProject(rawSingle));
          await this.saveProject(project, { revision: 0, forceFull: true });
          await setMeta('activeProjectId', project.id);
          migratedCount += 1;
        }
      }
    } catch (err) {
      console.warn('Legacy localStorage migration failed:', err);
      return;
    }

    if (migratedCount === 0) {
      await setMeta('migratedFromLocalStorage', 'empty');
      return;
    }

    // Verify round-trip before removing legacy storage.
    const metas = await listProjects();
    if (metas.length >= migratedCount) {
      localStorage.removeItem(LEGACY_LIBRARY_KEY);
      localStorage.removeItem(LEGACY_SINGLE_KEY);
      await setMeta('migratedFromLocalStorage', String(migratedCount));
    }
  }

  async list(): Promise<SavedProjectRecord[]> {
    await this.initialize();
    const metas = await listProjects();
    return metas
      .map((m) => ({
        id: m.id,
        name: m.name,
        updatedAt: m.updatedAt,
        revision: m.revision,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getActiveId(): Promise<string | null> {
    await this.initialize();
    return getMeta('activeProjectId');
  }

  async setActiveId(id: string): Promise<void> {
    await this.initialize();
    await setMeta('activeProjectId', id);
  }

  async load(id: string): Promise<ProjectDocument | null> {
    await this.initialize();
    const meta = await getProjectMeta(id);
    if (!meta) return null;

    const [assetRecords, poseRecords, meshRecords] = await Promise.all([
      getAssetsForProject(id),
      getPosesForProject(id),
      getMeshCachesForProject(id),
    ]);

    const assets = new Map<string, Blob>();
    for (const a of assetRecords) {
      assets.set(a.id, a.blob);
      this.assetIdsBySrc.set(`blob:${a.id}`, a.id);
    }

    const poses = new Map(poseRecords.map((p) => [p.id, p]));
    const meshCaches = new Map(meshRecords.map((m) => [m.id, m]));

    const doc = manifestToDocument(
      meta.manifest,
      assets,
      poses,
      meshCaches,
      (assetId, blob) => this.assets.resolve(assetId, blob)
    );

    this.revisionByProject.set(id, meta.revision);
    return doc;
  }

  async saveProject(
    project: ProjectDocument,
    opts: {
      revision?: number;
      dirty?: DirtyState;
      forceFull?: boolean;
      /** Used while migrating legacy localStorage during initialize(). */
      duringInit?: boolean;
    } = {}
  ): Promise<SaveResult> {
    if (!opts.duringInit) {
      await this.initialize();
    }
    const run = this.saveChain.then(() => this.doSave(project, opts));
    this.saveChain = run.catch(() => ({ ok: false, revision: 0 }));
    return run;
  }

  private async doSave(
    project: ProjectDocument,
    opts: { revision?: number; dirty?: DirtyState; forceFull?: boolean }
  ): Promise<SaveResult> {
    const prevRevision = this.revisionByProject.get(project.id) ?? opts.revision ?? 0;
    const nextRevision = prevRevision + 1;

    try {
      const existingAssetsBySrc = new Map(this.assetIdsBySrc);
      for (const node of project.canvas.nodes) {
        if (node.type !== 'image') continue;
        const img = node as { src?: string; assetId?: string };
        if (img.assetId && img.src?.startsWith('blob:')) {
          existingAssetsBySrc.set(img.src, img.assetId);
        }
      }

      const payload = await documentToSavePayload(project, {
        projectId: project.id,
        revision: nextRevision,
        existingAssetsBySrc,
      });

      for (const asset of payload.assets) {
        this.assetIdsBySrc.set(`blob:${asset.id}`, asset.id);
      }
      for (const node of payload.manifest.canvas.nodes) {
        if (node.type === 'image') {
          const img = node as { assetId: string };
          const runtime = project.canvas.nodes.find((n) => n.id === node.id && n.type === 'image') as
            | { src?: string; assetId?: string }
            | undefined;
          if (runtime?.src) {
            this.assetIdsBySrc.set(runtime.src, img.assetId);
            runtime.assetId = img.assetId;
          }
        }
      }

      const dirty = opts.dirty;
      const meta: ProjectMetaRecord = {
        id: project.id,
        name: project.name,
        updatedAt: Date.now(),
        revision: nextRevision,
        manifest: payload.manifest,
      };

      let assets = payload.assets;
      let poses = payload.poses;
      let meshCaches = payload.meshCaches;

      if (dirty && !opts.forceFull) {
        if (!dirty.manifest) {
          /* manifest always written with meta */
        }
        if (dirty.assetIds.size === 0) assets = [];
        else assets = assets.filter((a) => dirty.assetIds.has(a.id));
        if (dirty.poseIds.size === 0) poses = [];
        else poses = poses.filter((p) => dirty.poseIds.has(p.id));
        if (dirty.meshCacheIds.size === 0) meshCaches = [];
        else meshCaches = meshCaches.filter((m) => dirty.meshCacheIds.has(m.id));
      }

      await saveProjectBundle(meta, assets, poses, meshCaches, prevRevision);

      const referencedAssets = new Set<string>();
      for (const node of payload.manifest.canvas.nodes) {
        if (node.type === 'image') referencedAssets.add((node as { assetId: string }).assetId);
      }
      await gcUnreferencedAssets(project.id, referencedAssets);
      this.assets.retain(referencedAssets);

      this.revisionByProject.set(project.id, nextRevision);
      await setMeta('activeProjectId', project.id);
      return { ok: true, revision: nextRevision };
    } catch (err) {
      return {
        ok: false,
        revision: prevRevision,
        error: err instanceof Error ? err.message : 'Save failed',
      };
    }
  }

  async delete(id: string): Promise<void> {
    await this.initialize();
    await deleteProjectBundle(id);
    this.revisionByProject.delete(id);
    const active = await getMeta('activeProjectId');
    if (active === id) {
      const remaining = await this.list();
      await setMeta('activeProjectId', remaining[0]?.id ?? '');
    }
  }

  async storageEstimate(): Promise<{ usage?: number; quota?: number }> {
    return estimateStorage();
  }

  /** @internal Reset singleton between tests. */
  _resetForTests(): void {
    this.initialized = false;
    this.initPromise = null;
    this.saveChain = Promise.resolve({ ok: true, revision: 0 });
    this.revisionByProject.clear();
    this.assetIdsBySrc.clear();
    this.assets.revokeAll();
  }

  /** Legacy JSON import/export helpers (portable, not IDB). */
  importJson(json: string): ProjectDocument {
    return normalizeProject(parseProject(json));
  }

  exportJson(project: ProjectDocument): string {
    return serializeProject(project);
  }
}

export const projectStore = new ProjectStore();
