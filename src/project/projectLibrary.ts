import type { ProjectDocument } from '../project/types';
import {
  createDirtyState,
  projectStore,
  type DirtyState,
  type SaveResult,
  type SavedProjectRecord,
} from '../persistence/ProjectStore';
import { downloadProjectArchive, importPortableProject } from '../persistence/projectArchive';
import { normalizeProject, parseProject, serializeProject } from '../persistence/projectCodec';

export type { SavedProjectRecord, SaveResult, DirtyState };
export { createDirtyState };

const AUTOSAVE_KEY = 'patternCanvas.autosaveMinutes';
export const DEFAULT_AUTOSAVE_MINUTES = 5;

export type LibraryWriteResult = {
  ok: boolean;
  error?: string;
  revision?: number;
};

export type SaveProjectResult = {
  record: SavedProjectRecord;
  write: LibraryWriteResult;
};

export async function initializeProjectLibrary(): Promise<void> {
  await projectStore.initialize();
}

export async function listSavedProjects(): Promise<SavedProjectRecord[]> {
  return projectStore.list();
}

export async function getActiveProjectId(): Promise<string | null> {
  const id = await projectStore.getActiveId();
  return id || null;
}

export async function setActiveProjectId(id: string): Promise<LibraryWriteResult> {
  await projectStore.setActiveId(id);
  return { ok: true };
}

export async function getSavedProject(id: string): Promise<ProjectDocument | null> {
  return projectStore.load(id);
}

export async function saveProjectToLibrary(
  project: ProjectDocument,
  dirty?: DirtyState
): Promise<SaveProjectResult> {
  const result = await projectStore.saveProject(project, { dirty });
  const record: SavedProjectRecord = {
    id: project.id,
    name: project.name,
    updatedAt: Date.now(),
    revision: result.revision,
  };
  return {
    record,
    write: { ok: result.ok, error: result.error, revision: result.revision },
  };
}

export async function deleteProjectFromLibrary(id: string): Promise<LibraryWriteResult> {
  await projectStore.delete(id);
  return { ok: true };
}

export function importProjectJson(json: string): ProjectDocument {
  return projectStore.importJson(json);
}

export function exportProjectJson(project: ProjectDocument): string {
  return projectStore.exportJson(project);
}

export async function importProjectFile(file: File): Promise<ProjectDocument> {
  return importPortableProject(file);
}

export async function exportProjectFile(project: ProjectDocument, archive = true): Promise<void> {
  if (archive) {
    await downloadProjectArchive(project);
    return;
  }
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name.replace(/\s+/g, '_') || 'project'}.patterncanvas.json`;
  a.click();
  URL.revokeObjectURL(url);
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

export async function getStorageEstimate(): Promise<{ usage?: number; quota?: number }> {
  return projectStore.storageEstimate();
}

/** @deprecated Legacy sync migration — IndexedDB migration runs in ProjectStore.initialize(). */
export function migrateLegacyProjectStorage(): void {
  /* no-op */
}

export { normalizeProject, parseProject, serializeProject };
