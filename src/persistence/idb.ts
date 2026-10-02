import {
  IDB_NAME,
  IDB_STORES,
  IDB_VERSION,
  type AssetRecord,
  type MeshCacheRecord,
  type PoseRecord,
  type ProjectMetaRecord,
} from './schema';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORES.projects)) {
        db.createObjectStore(IDB_STORES.projects, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IDB_STORES.assets)) {
        const s = db.createObjectStore(IDB_STORES.assets, { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains(IDB_STORES.poses)) {
        const s = db.createObjectStore(IDB_STORES.poses, { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains(IDB_STORES.meshCaches)) {
        const s = db.createObjectStore(IDB_STORES.meshCaches, { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains(IDB_STORES.meta)) {
        db.createObjectStore(IDB_STORES.meta, { keyPath: 'key' });
      }
    };
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export type MetaKey = 'activeProjectId' | 'storageVersion' | 'migratedFromLocalStorage';

export async function getMeta(key: MetaKey): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.meta, 'readonly');
    const req = tx.objectStore(IDB_STORES.meta).get(key);
    req.onsuccess = () => {
      const row = req.result as { key: string; value: string } | undefined;
      resolve(row?.value ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key: MetaKey, value: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(IDB_STORES.meta, 'readwrite');
  tx.objectStore(IDB_STORES.meta).put({ key, value });
  await txDone(tx);
}

export async function listProjects(): Promise<ProjectMetaRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.projects, 'readonly');
    const req = tx.objectStore(IDB_STORES.projects).getAll();
    req.onsuccess = () => resolve((req.result as ProjectMetaRecord[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function getProjectMeta(id: string): Promise<ProjectMetaRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.projects, 'readonly');
    const req = tx.objectStore(IDB_STORES.projects).get(id);
    req.onsuccess = () => resolve((req.result as ProjectMetaRecord) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAssetsForProject(projectId: string): Promise<AssetRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.assets, 'readonly');
    const idx = tx.objectStore(IDB_STORES.assets).index('projectId');
    const req = idx.getAll(projectId);
    req.onsuccess = () => resolve((req.result as AssetRecord[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function getPosesForProject(projectId: string): Promise<PoseRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.poses, 'readonly');
    const idx = tx.objectStore(IDB_STORES.poses).index('projectId');
    const req = idx.getAll(projectId);
    req.onsuccess = () => resolve((req.result as PoseRecord[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function getMeshCachesForProject(projectId: string): Promise<MeshCacheRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORES.meshCaches, 'readonly');
    const idx = tx.objectStore(IDB_STORES.meshCaches).index('projectId');
    const req = idx.getAll(projectId);
    req.onsuccess = () => resolve((req.result as MeshCacheRecord[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function saveProjectBundle(
  meta: ProjectMetaRecord,
  assets: AssetRecord[],
  poses: PoseRecord[],
  meshCaches: MeshCacheRecord[],
  expectedRevision?: number
): Promise<void> {
  const db = await openDb();
  if (expectedRevision != null) {
    const existing = await getProjectMeta(meta.id);
    if (existing && existing.revision !== expectedRevision) {
      throw new Error('Project revision conflict — reload and retry save');
    }
  }

  const tx = db.transaction(
    [IDB_STORES.projects, IDB_STORES.assets, IDB_STORES.poses, IDB_STORES.meshCaches],
    'readwrite'
  );

  tx.objectStore(IDB_STORES.projects).put(meta);

  const assetStore = tx.objectStore(IDB_STORES.assets);
  const poseStore = tx.objectStore(IDB_STORES.poses);
  const meshStore = tx.objectStore(IDB_STORES.meshCaches);

  for (const a of assets) assetStore.put(a);
  for (const p of poses) poseStore.put(p);
  for (const m of meshCaches) meshStore.put(m);

  await txDone(tx);
}

export async function deleteProjectBundle(projectId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(
    [IDB_STORES.projects, IDB_STORES.assets, IDB_STORES.poses, IDB_STORES.meshCaches],
    'readwrite'
  );

  tx.objectStore(IDB_STORES.projects).delete(projectId);

  for (const storeName of [IDB_STORES.assets, IDB_STORES.poses, IDB_STORES.meshCaches] as const) {
    const store = tx.objectStore(storeName);
    const idx = store.index('projectId');
    const req = idx.openCursor(IDBKeyRange.only(projectId));
    await new Promise<void>((resolve, reject) => {
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  await txDone(tx);
}

export async function gcUnreferencedAssets(projectId: string, referencedAssetIds: Set<string>): Promise<number> {
  const assets = await getAssetsForProject(projectId);
  let removed = 0;
  const db = await openDb();
  const tx = db.transaction(IDB_STORES.assets, 'readwrite');
  const store = tx.objectStore(IDB_STORES.assets);
  for (const asset of assets) {
    if (!referencedAssetIds.has(asset.id)) {
      store.delete(asset.id);
      removed += 1;
    }
  }
  await txDone(tx);
  return removed;
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function estimateStorage(): Promise<{ usage?: number; quota?: number }> {
  if (!navigator.storage?.estimate) return {};
  try {
    return await navigator.storage.estimate();
  } catch {
    return {};
  }
}

export { openDb };
