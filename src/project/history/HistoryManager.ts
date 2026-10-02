import type { ProjectDocument } from '../../project/types';
import { normalizeProject, parseProject, serializeProject } from '../../persistence/projectCodec';

export const UNDO_LIMIT = 15;

/** Sidecar heavy payloads keyed by history entry index. */
export type HeavySidecar = {
  imageSrcByNodeId: Map<string, string>;
  poseBySimId: Map<string, NonNullable<ProjectDocument['sims'][0]['pose']>>;
  poseByTransformId: Map<string, NonNullable<ProjectDocument['transforms'][0]['pose']>>;
  pieceTransformsByTransformId: Map<
    string,
    ProjectDocument['transforms'][0]['pieceTransforms']
  >;
  geometryByMeshId: Map<string, NonNullable<ProjectDocument['meshes'][0]['geometry']>>;
};

export function extractHeavy(project: ProjectDocument): HeavySidecar {
  const sidecar: HeavySidecar = {
    imageSrcByNodeId: new Map(),
    poseBySimId: new Map(),
    poseByTransformId: new Map(),
    pieceTransformsByTransformId: new Map(),
    geometryByMeshId: new Map(),
  };
  for (const node of project.canvas.nodes) {
    if (node.type === 'image' && node.src) sidecar.imageSrcByNodeId.set(node.id, node.src);
  }
  for (const sim of project.sims) {
    if (sim.pose) sidecar.poseBySimId.set(sim.id, sim.pose);
  }
  for (const transform of project.transforms) {
    if (transform.pose) sidecar.poseByTransformId.set(transform.id, transform.pose);
    if (transform.pieceTransforms && Object.keys(transform.pieceTransforms).length > 0) {
      sidecar.pieceTransformsByTransformId.set(
        transform.id,
        structuredClone(transform.pieceTransforms)
      );
    }
  }
  for (const mesh of project.meshes) {
    if (mesh.geometry) sidecar.geometryByMeshId.set(mesh.id, mesh.geometry);
  }
  return sidecar;
}

export function stripHeavy(project: ProjectDocument): ProjectDocument {
  const clone = normalizeProject(parseProject(serializeProject(project)));
  for (const node of clone.canvas.nodes) {
    if (node.type === 'image') node.src = '';
  }
  for (const sim of clone.sims) sim.pose = null;
  for (const transform of clone.transforms) transform.pose = null;
  for (const mesh of clone.meshes) mesh.geometry = null;
  return clone;
}

export function mergeHeavy(project: ProjectDocument, sidecar: HeavySidecar): ProjectDocument {
  const merged = normalizeProject(parseProject(serializeProject(project)));
  for (const node of merged.canvas.nodes) {
    if (node.type === 'image') {
      const src = sidecar.imageSrcByNodeId.get(node.id);
      if (src) node.src = src;
    }
  }
  for (const sim of merged.sims) {
    const pose = sidecar.poseBySimId.get(sim.id);
    if (pose) sim.pose = pose;
  }
  for (const transform of merged.transforms) {
    const pose = sidecar.poseByTransformId.get(transform.id);
    if (pose) transform.pose = pose;
    const pieceTransforms = sidecar.pieceTransformsByTransformId.get(transform.id);
    if (pieceTransforms) transform.pieceTransforms = structuredClone(pieceTransforms);
  }
  for (const mesh of merged.meshes) {
    const geometry = sidecar.geometryByMeshId.get(mesh.id);
    if (geometry) mesh.geometry = geometry;
  }
  return merged;
}

export type HistoryEntry = {
  stripped: string;
  sidecar: HeavySidecar;
};

/**
 * Lightweight undo/redo: stores stripped project JSON plus heavy sidecars
 * instead of 15 full serialized copies.
 */
export class HistoryManager {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  get size(): number {
    return this.undoStack.length;
  }

  get redoSize(): number {
    return this.redoStack.length;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Record state before an edit. Clears redo branch. */
  push(project: ProjectDocument): void {
    const sidecar = extractHeavy(project);
    const stripped = serializeProject(stripHeavy(project));
    this.undoStack.push({ stripped, sidecar });
    if (this.undoStack.length > UNDO_LIMIT) {
      this.undoStack.splice(0, this.undoStack.length - UNDO_LIMIT);
    }
    this.redoStack = [];
  }

  undo(current: ProjectDocument): ProjectDocument | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({
      stripped: serializeProject(stripHeavy(current)),
      sidecar: extractHeavy(current),
    });
    if (this.redoStack.length > UNDO_LIMIT) {
      this.redoStack.splice(0, this.redoStack.length - UNDO_LIMIT);
    }
    try {
      const stripped = normalizeProject(parseProject(entry.stripped));
      return mergeHeavy(stripped, entry.sidecar);
    } catch {
      return null;
    }
  }

  redo(current: ProjectDocument): ProjectDocument | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({
      stripped: serializeProject(stripHeavy(current)),
      sidecar: extractHeavy(current),
    });
    if (this.undoStack.length > UNDO_LIMIT) {
      this.undoStack.splice(0, this.undoStack.length - UNDO_LIMIT);
    }
    try {
      const stripped = normalizeProject(parseProject(entry.stripped));
      return mergeHeavy(stripped, entry.sidecar);
    } catch {
      return null;
    }
  }
}

/** Deep-clone via codec round-trip (used sparingly). */
export function cloneProject(project: ProjectDocument): ProjectDocument {
  return normalizeProject(parseProject(serializeProject(project)));
}
