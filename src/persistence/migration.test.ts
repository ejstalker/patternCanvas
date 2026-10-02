import { describe, expect, it, beforeEach } from 'vitest';
import { projectStore } from './ProjectStore';
import { createSmallFixture } from './fixtures';
import { serializeProject } from './projectCodec';

const LEGACY_LIBRARY_KEY = 'patternCanvas.library.v1';

async function deleteIdb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('patternCanvas');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe('localStorage migration', () => {
  beforeEach(async () => {
    localStorage.clear();
    projectStore._resetForTests();
    await deleteIdb();
  });

  it('migrates legacy library v1 into IndexedDB', async () => {
    const project = createSmallFixture();
    project.id = 'legacy_project';
    const legacy = {
      version: 1,
      activeId: project.id,
      projects: [
        {
          id: project.id,
          name: project.name,
          updatedAt: Date.now(),
          data: project,
        },
      ],
    };
    localStorage.setItem(LEGACY_LIBRARY_KEY, JSON.stringify(legacy));

    await projectStore.initialize();

    const list = await projectStore.list();
    expect(list.some((p) => p.id === 'legacy_project')).toBe(true);
    const loaded = await projectStore.load('legacy_project');
    expect(loaded?.name).toBe(project.name);
    expect(localStorage.getItem(LEGACY_LIBRARY_KEY)).toBeNull();
  });
});

describe('legacy JSON compatibility', () => {
  it('parses v2 JSON exports', () => {
    const project = createSmallFixture();
    const json = serializeProject(project);
    const imported = projectStore.importJson(json);
    expect(imported.patterns.length).toBe(project.patterns.length);
  });
});
