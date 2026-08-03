import { normalizeProject, parseProject, serializeProject } from './createDefault';
import type { ProjectDocument } from './types';

const LIBRARY_KEY = 'patternCanvas.library.v1';
const LEGACY_KEY = 'patternCanvas.project.v2';

export type SavedProjectRecord = {
  id: string;
  name: string;
  updatedAt: number;
  data: ProjectDocument;
};

type ProjectLibrary = {
  version: 1;
  activeId: string | null;
  projects: SavedProjectRecord[];
};

function emptyLibrary(): ProjectLibrary {
  return { version: 1, activeId: null, projects: [] };
}

function readLibrary(): ProjectLibrary {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return emptyLibrary();
    const lib = JSON.parse(raw) as ProjectLibrary;
    if (lib.version !== 1 || !Array.isArray(lib.projects)) return emptyLibrary();
    return lib;
  } catch {
    return emptyLibrary();
  }
}

function writeLibrary(lib: ProjectLibrary): void {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
}

/** One-time migration from the single-project localStorage key. */
export function migrateLegacyProjectStorage(): void {
  const lib = readLibrary();
  if (lib.projects.length > 0) return;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const project = normalizeProject(parseProject(raw));
    const record: SavedProjectRecord = {
      id: project.id,
      name: project.name,
      updatedAt: Date.now(),
      data: project,
    };
    writeLibrary({ version: 1, activeId: project.id, projects: [record] });
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore corrupt legacy data */
  }
}

export function listSavedProjects(): SavedProjectRecord[] {
  return [...readLibrary().projects].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getActiveProjectId(): string | null {
  return readLibrary().activeId;
}

export function setActiveProjectId(id: string): void {
  const lib = readLibrary();
  lib.activeId = id;
  writeLibrary(lib);
}

export function getSavedProject(id: string): ProjectDocument | null {
  const record = readLibrary().projects.find((p) => p.id === id);
  return record ? normalizeProject(record.data) : null;
}

export function saveProjectToLibrary(project: ProjectDocument): SavedProjectRecord {
  const lib = readLibrary();
  const now = Date.now();
  const existing = lib.projects.find((p) => p.id === project.id);
  const record: SavedProjectRecord = {
    id: project.id,
    name: project.name,
    updatedAt: now,
    data: project,
  };
  if (existing) {
    existing.name = record.name;
    existing.updatedAt = now;
    existing.data = project;
  } else {
    lib.projects.push(record);
  }
  lib.activeId = project.id;
  writeLibrary(lib);
  return record;
}

export function deleteProjectFromLibrary(id: string): void {
  const lib = readLibrary();
  lib.projects = lib.projects.filter((p) => p.id !== id);
  if (lib.activeId === id) {
    lib.activeId = lib.projects[0]?.id ?? null;
  }
  writeLibrary(lib);
}

export function importProjectJson(json: string): ProjectDocument {
  return normalizeProject(parseProject(json));
}

export function exportProjectJson(project: ProjectDocument): string {
  return serializeProject(project);
}

export function formatProjectDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const AUTOSAVE_KEY = 'patternCanvas.autosaveMinutes';
/** Default auto-save interval in minutes. `0` disables auto-save. */
export const DEFAULT_AUTOSAVE_MINUTES = 5;

export function getAutosaveIntervalMinutes(): number {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw == null || raw === '') return DEFAULT_AUTOSAVE_MINUTES;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_AUTOSAVE_MINUTES;
    return Math.min(120, n);
  } catch {
    return DEFAULT_AUTOSAVE_MINUTES;
  }
}

export function setAutosaveIntervalMinutes(minutes: number): void {
  const n = Number.isFinite(minutes) ? Math.max(0, Math.min(120, minutes)) : DEFAULT_AUTOSAVE_MINUTES;
  localStorage.setItem(AUTOSAVE_KEY, String(n));
}
