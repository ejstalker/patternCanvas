import { normalizeProject, parseProject, serializeProject } from './createDefault';
import type { ProjectDocument } from './types';

export const UNDO_LIMIT = 15;

/** Deep-clone a project document via JSON (stable for undo snapshots). */
export function cloneProject(project: ProjectDocument): ProjectDocument {
  return normalizeProject(parseProject(serializeProject(project)));
}

function deserialize(raw: string): ProjectDocument | null {
  try {
    return normalizeProject(parseProject(raw));
  } catch {
    return null;
  }
}

/**
 * Undo / redo stacks of full project snapshots.
 * Call {@link push} with a clone of the project *before* mutating it.
 * New edits clear the redo branch.
 */
export class UndoStack {
  private undoStack: string[] = [];
  private redoStack: string[] = [];

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

  /** Record state before an edit. Clears redo. */
  push(project: ProjectDocument): void {
    this.undoStack.push(serializeProject(project));
    if (this.undoStack.length > UNDO_LIMIT) {
      this.undoStack.splice(0, this.undoStack.length - UNDO_LIMIT);
    }
    this.redoStack = [];
  }

  /**
   * Undo: stash `current` onto redo, return previous undo snapshot.
   * Returns null if nothing to undo.
   */
  undo(current: ProjectDocument): ProjectDocument | null {
    const raw = this.undoStack.pop();
    if (!raw) return null;
    this.redoStack.push(serializeProject(current));
    if (this.redoStack.length > UNDO_LIMIT) {
      this.redoStack.splice(0, this.redoStack.length - UNDO_LIMIT);
    }
    return deserialize(raw);
  }

  /**
   * Redo: stash `current` onto undo, return next redo snapshot.
   * Returns null if nothing to redo.
   */
  redo(current: ProjectDocument): ProjectDocument | null {
    const raw = this.redoStack.pop();
    if (!raw) return null;
    this.undoStack.push(serializeProject(current));
    if (this.undoStack.length > UNDO_LIMIT) {
      this.undoStack.splice(0, this.undoStack.length - UNDO_LIMIT);
    }
    return deserialize(raw);
  }
}
