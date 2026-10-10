import {
  createDefaultProject,
  uid,
  DEFAULT_SIM_PARAMS,
  rectPiece,
  createMeshDocument,
  createTransform3dDocument,
  remeshDocument,
  normalizeProject,
  DEFAULT_MESH_FRAME_WIDTH,
  DEFAULT_MESH_FRAME_HEIGHT,
} from '../project/createDefault';
import {
  cloneSimCamera,
  getDefaultSimCamera,
  migrateLegacySimCamera,
  setDefaultSimCamera,
  syncDefaultCameraFromDrapeA,
} from '../sim/cameraDefaults';
import type {
  BlockInstance,
  CanvasNode,
  ImageNode,
  MeshDocument,
  MeshFrameNode,
  PatternDocument,
  PatternPiece,
  PieceTransform3d,
  ProjectDocument,
  SeamEdgeRef,
  SimInstance,
  SimViewportNode,
  TextAnnotationNode,
  Transform3dNode,
  Transform3dInstance,
  MeshAlgorithm,
  SimCameraState,
} from '../project/types';
import { PatternEditor } from '../pattern/PatternEditor';
import { sameSeamBindingPair } from '../pattern/geometry';
import { DEFAULT_SEAM_GAP_CM } from '../mesh/triangulate';
import { generateBlockPieces } from '../pattern/blocks/generate';
import { getBlockDefinition } from '../pattern/blocks/registry';
import {
  AvatarModal,
  type AvatarGenerationOptions,
  type AvatarPreviewElements,
  type AvatarReport,
} from './AvatarModal';
import { AvatarPreview } from '../avatar/AvatarPreview';
import { buildMeasurementRulers } from '../avatar/rulerOverlay';
import { cachedMeasurementLibrary, loadMeasurementLibrary } from '../persistence/measurementLibrary';
import { MeshPreview } from '../mesh/MeshPreview';
import { createSharedGpu, SimViewportRuntime } from '../sim/SimViewportRuntime';
import { Environment, loadEnvironmentSettings } from '../render/environment';
import { MaterialLibrary } from '../render/materials';
import { Transform3dRuntime } from '../sim/Transform3dRuntime';
import { DEFAULT_TRANSFORM_PIECE_ROTATION_DEG } from '../sim/transformDefaults';
import {
  createIcons,
  ClipboardList,
  FilePlus2,
  Folder,
  Image as ImageIcon,
  Redo2,
  Ruler,
  Scissors,
  Shirt,
  StickyNote,
  Undo2,
  UserRound,
} from 'lucide';
import {
  DEFAULT_AUTOSAVE_MINUTES,
  deleteProjectFromLibrary,
  exportProjectFile,
  formatProjectDate,
  getActiveProjectId,
  getAutosaveIntervalMinutes,
  getSavedProject,
  getStorageEstimate,
  importProjectFile,
  initializeProjectLibrary,
  listSavedProjects,
  saveProjectToLibrary,
  setActiveProjectId,
  setAutosaveIntervalMinutes,
} from '../project/projectLibrary';
import { HistoryManager } from '../project/history/HistoryManager';
import {
  AVATAR_UNIT_TO_WORLD,
  avatarStatusLabel,
  getAvatarPrefs,
  importAvatarModel,
  type AvatarCollisionMode,
} from '../sim/avatarAsset';
import { resetAvatarOverlayCache } from '../pattern/avatarPatternOverlay';
import { DEFAULT_SDF_RESOLUTION } from '../mesh/sdfBake';
import { buildAvatarMeshes, collisionSummaryText, createAvatarBodyFromAvatar } from '../avatar/avatarService';
import { updateAvatar } from '../persistence/avatarLibrary';
import type { Avatar } from '../project/avatars';

const WORLD_TO_CM = 10;

type WireSource = {
  kind: 'pattern' | 'mesh' | 'transform';
  id: string;
  nodeId: string;
};

type WireDrag = WireSource & {
  pointerId: number;
  x: number;
  y: number;
};

/** Visible pattern-space rectangle of a 2D editor (its zoom / pan). */
type PatternViewBox = { x: number; y: number; w: number; h: number };

/**
 * Live view states captured so undo/redo can preserve the current view. Pan and
 * zoom are the user's, not the document's: restoring history must never move a
 * viewport — the 3D cameras, the 2D editors, or the board itself.
 */
type CameraSnapshot = {
  transforms: Map<string, SimCameraState>;
  sims: Map<string, SimCameraState>;
  /** Board pan/zoom, kept across undo so the studio canvas stays put. */
  board: { panX: number; panY: number; zoom: number };
  /** Per pattern-frame node id: the editor's visible rectangle. */
  patterns: Map<string, PatternViewBox>;
};

function ensureVisibleConnections(project: ProjectDocument): ProjectDocument {
  const p = normalizeProject(project);
  const fallbackMesh = p.meshes[0];
  if (!fallbackMesh) return p;

  for (const transform of p.transforms) {
    if (!transform.meshId) transform.meshId = fallbackMesh.id;
    if (!p.meshTransformAssignments.some((assignment) => assignment.transformId === transform.id)) {
      p.meshTransformAssignments.push({
        id: uid('assign'),
        meshId: transform.meshId,
        transformId: transform.id,
      });
    }
  }

  for (const sim of p.sims) {
    if (p.transformSimAssignments.some((assignment) => assignment.simId === sim.id)) continue;
    if (!p.assignments.some((assignment) => assignment.simId === sim.id)) {
      p.assignments.push({
        id: uid('assign'),
        meshId: fallbackMesh.id,
        simId: sim.id,
      });
    }
  }
  return p;
}

export class StudioApp {
  private project: ProjectDocument;
  private board: HTMLElement;
  private wiresSvg: SVGSVGElement;
  private toolbar: HTMLElement;
  private studioBody: HTMLElement;
  private inspector: HTMLElement;
  private editors = new Map<string, PatternEditor>();
  private meshPreviews = new Map<string, MeshPreview>();
  private simRuntimes = new Map<string, SimViewportRuntime>();
  private transformRuntimes = new Map<string, Transform3dRuntime>();
  private transformInspectorPieceId: string | null = null;
  private device: GPUDevice | null = null;
  /**
   * HDRI background + light probe. One per device, shared by every 3D viewport,
   * so switching the environment moves them all together.
   */
  private environment: Environment | null = null;
  /** Scene materials, shared by every 3D viewport like the environment. */
  private materials = new MaterialLibrary();
  private selectedNodeId: string | null = null;
  /** Fixed-position tip host (escapes inspector overflow clipping). */
  private inspectorTipEl: HTMLDivElement | null = null;
  /** Avatar editor dialog, when open. */
  private avatarModal: AvatarModal | null = null;
  private avatarPreview: AvatarPreview | null = null;
  private avatarPreviewCanvas: HTMLCanvasElement | null = null;
  private avatarRulersVisible = true;
  private panning = false;
  private panLast = { x: 0, y: 0 };
  private draggingNode: { id: string; ox: number; oy: number } | null = null;
  private wireDrag: WireDrag | null = null;
  private resizingNode: {
    id: string;
    corner: 'nw' | 'ne' | 'sw' | 'se';
    startBoardX: number;
    startBoardY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null = null;
  private raf = 0;
  /** Bumped on each board remount so in-flight initGpuAndSims cannot register stale runtimes. */
  private gpuInitGeneration = 0;
  private modalRoot: HTMLElement;
  private importFileInput: HTMLInputElement;
  private avatarLoadAbort: AbortController | null = null;
  private undoStack = new HistoryManager();
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;
  private persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInFlight = false;
  private saveQueued = false;
  private restoringUndo = false;
  private expandedNodeId: string | null = null;
  private expandPlaceholder: HTMLElement | null = null;
  private expandOverlay: HTMLElement | null = null;
  private expandEscHandler: ((e: KeyboardEvent) => void) | null = null;
  /**
   * Split fullscreen: the 2D pattern on the left and one 3D stage on the right,
   * shown at once. Null when the normal single-node fullscreen is in use.
   */
  private splitView: {
    patternNodeId: string;
    stageNodeId: string;
    patternPlaceholder: HTMLElement;
    stagePlaceholder: HTMLElement;
    /** The expanded node's own chrome, hoisted to the top of the overlay. */
    chrome: HTMLElement;
    body: HTMLElement;
    /** The 3D pane; carries the stale tint and the banner over its action bar. */
    stagePane: HTMLElement;
    banner: HTMLElement;
  } | null = null;
  /** Guard so mirrored 2D ↔ 3D selection does not feed back on itself. */
  private splitSelectionSyncing = false;
  private imageFileInput: HTMLInputElement;
  private resizeShiftKey = false;

  private constructor(root: HTMLElement) {
    this.project = ensureVisibleConnections(createDefaultProject());
    root.innerHTML = `
      <div class="studio">
        <header class="studio-toolbar" id="toolbar"></header>
        <div class="studio-body">
          <div class="studio-board-wrap" id="boardWrap">
            <svg class="studio-wires" id="wires"></svg>
            <div class="studio-board" id="board"></div>
          </div>
          <aside class="studio-inspector" id="inspector"></aside>
        </div>
        <div class="studio-status" id="status"></div>
        <div class="studio-modal-root" id="modalRoot" hidden></div>
        <input type="file" id="importFile" accept="application/json,.json,.patterncanvas,application/zip" hidden />
        <input type="file" id="imageFile" accept="image/*" multiple hidden />
      </div>
    `;
    this.toolbar = root.querySelector('#toolbar')!;
    this.studioBody = root.querySelector('.studio-body')!;
    this.board = root.querySelector('#board')!;
    this.wiresSvg = root.querySelector('#wires')!;
    this.inspector = root.querySelector('#inspector')!;
    this.modalRoot = root.querySelector('#modalRoot')!;
    this.importFileInput = root.querySelector('#importFile')!;
    this.imageFileInput = root.querySelector('#imageFile')!;
    this.buildToolbar();
    this.bindImportFile();
    this.bindImageImport();
    this.bindBoardPan();
    this.bindNodeContextMenu();
    this.bindUndoHotkey();
    this.bindImagePasteAndDrop();
    window.addEventListener('resize', () => this.drawWires());
  }

  static async create(root: HTMLElement): Promise<StudioApp> {
    const app = new StudioApp(root);
    app.setStatus('Loading projects…');
    try {
      await initializeProjectLibrary();
      // Rulers read the body-measurement library for their labels, so warm the
      // cache before the first pattern editor mounts.
      void loadMeasurementLibrary().then(() => app.refreshRulerLibraries());
      app.project = app.prepareLoadedProject(await app.loadInitialProject());
      app.syncProjectChrome();
      app.restartAutosave();
      app.renderAll();
      void app.initGpuAndSims();
      void app.refreshStorageStatus();
    } catch (err) {
      console.warn('Project library init failed:', err);
      app.setStatus('Could not load saved projects — using new project');
      app.renderAll();
      void app.initGpuAndSims();
    }
    return app;
  }

  private async loadInitialProject(): Promise<ProjectDocument> {
    try {
      const activeId = await getActiveProjectId();
      if (activeId) {
        const project = await getSavedProject(activeId);
        if (project) return project;
      }
      const saved = await listSavedProjects();
      if (saved[0]) {
        await setActiveProjectId(saved[0].id);
        const project = await getSavedProject(saved[0].id);
        if (project) return project;
      }
    } catch {
      /* ignore */
    }
    const project = ensureVisibleConnections(createDefaultProject());
    const { write } = await saveProjectToLibrary(project);
    if (!write.ok) {
      console.warn('Initial project save failed:', write.error);
    }
    return project;
  }

  /**
   * Say so when a project came back with image bytes that are no longer in
   * storage. Reading the document rather than remembering a load-time set keeps
   * the warning honest: re-linking the image clears it.
   */
  private reportMissingImages(): void {
    const count = this.project.canvas.nodes.filter(
      (node) => node.type === 'image' && !node.src
    ).length;
    if (count === 0) return;
    const what = count === 1 ? 'An image reference has' : `${count} image references have`;
    this.setStatus(`${what} lost its stored data — use Re-link image… on the node to restore it`);
  }

  private async refreshStorageStatus(): Promise<void> {
    const est = await getStorageEstimate();
    if (est.usage != null && est.quota != null) {
      const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
      this.setStatus(`Ready · storage ${mb(est.usage)} / ${mb(est.quota)} MB`);
    }
  }

  /**
   * Something in the document changed. The save payload is derived from the
   * project itself, so there is no dirty-bit bookkeeping to keep in step — this
   * only debounces the write.
   */
  private markDirty(): void {
    this.scheduleDebouncedPersist();
  }

  private scheduleDebouncedPersist(): void {
    if (this.persistDebounceTimer) clearTimeout(this.persistDebounceTimer);
    this.persistDebounceTimer = setTimeout(() => {
      void this.persistLocal({ quiet: true });
    }, 750);
  }

  private prepareLoadedProject(project: ProjectDocument): ProjectDocument {
    syncDefaultCameraFromDrapeA(project);
    const defaults = getDefaultSimCamera(project);
    for (const sim of project.sims) {
      if (sim.name === 'Drape A') continue;
      migrateLegacySimCamera(sim.camera, defaults);
    }
    return ensureVisibleConnections(project);
  }

  private async persistLocal(opts: { quiet?: boolean; label?: string } = {}): Promise<void> {
    if (this.saveInFlight) {
      this.saveQueued = true;
      return;
    }
    this.saveInFlight = true;
    this.persistSimStates();
    try {
      const { write } = await saveProjectToLibrary(this.project);
      const label = opts.label ?? 'Saved';
      if (!write.ok) {
        this.setStatus(write.error ?? 'Local save failed — export your project');
        return;
      }
      if (!opts.quiet) {
        this.setStatus(`${label} “${this.project.name}”`);
      }
    } finally {
      this.saveInFlight = false;
      if (this.saveQueued) {
        this.saveQueued = false;
        void this.persistLocal(opts);
      }
    }
  }

  /** Snapshot current project before a user edit (max 15 levels). */
  private pushUndo(): void {
    if (this.restoringUndo) return;
    this.persistSimStates();
    this.undoStack.push(this.project);
    this.updateHistoryButtons();
  }

  private performUndo(): void {
    if (!this.undoStack.canUndo) return;
    // Camera moves/zooms are view state, not document edits — keep them across undo.
    const cameras = this.captureLiveCameras();
    this.snapshotProjectForHistory();
    const prev = this.undoStack.undo(this.project);
    this.updateHistoryButtons();
    if (!prev) return;
    this.markDirty();
    void this.restoreHistoryProject(prev, `Undo (${this.undoStack.size} left)`, cameras);
  }

  private performRedo(): void {
    if (!this.undoStack.canRedo) return;
    const cameras = this.captureLiveCameras();
    this.snapshotProjectForHistory();
    const next = this.undoStack.redo(this.project);
    this.updateHistoryButtons();
    if (!next) return;
    this.markDirty();
    void this.restoreHistoryProject(next, `Redo (${this.undoStack.redoSize} left)`, cameras);
  }

  private async restoreHistoryProject(
    project: ProjectDocument,
    status: string,
    cameras?: CameraSnapshot
  ): Promise<void> {
    const expandedId = this.expandedNodeId;
    const prevSelectedNodeId = this.selectedNodeId;
    const prevTransformPieceId = this.transformInspectorPieceId;
    const needsRemount =
      this.canvasRuntimeSignature(this.project) !== this.canvasRuntimeSignature(project);
    this.restoringUndo = true;
    try {
      this.project = this.prepareLoadedProject(project);
      // Overwrite the snapshot's cameras with the view the user is currently on
      // so undo/redo never moves or zooms the viewport.
      if (cameras) this.applyLiveCameras(cameras);
      void setActiveProjectId(this.project.id);
      this.selectedNodeId =
        prevSelectedNodeId &&
        this.project.canvas.nodes.some((n) => n.id === prevSelectedNodeId)
          ? prevSelectedNodeId
          : null;
      this.transformInspectorPieceId = prevTransformPieceId;
      this.syncProjectChrome();

      if (needsRemount) {
        this.renderAll();
        if (
          expandedId &&
          this.project.canvas.nodes.some((n) => n.id === expandedId)
        ) {
          this.openNodeFullscreen(expandedId);
        }
        await this.initGpuAndSims();
      } else {
        await this.syncLiveRuntimesFromProject();
        if (this.hasMissingViewportRuntimes()) {
          await this.initGpuAndSims();
        }
      }

      // Re-assert the preserved view after runtimes synced: their load path runs
      // legacy camera migration which must not shift the user's current view.
      if (cameras) {
        this.applyLiveCameras(cameras);
        this.applyLiveCamerasToRuntimes(cameras);
      }

      this.restoreTransformInspectorSelection();
      this.renderInspector();
      this.setStatus(status);
    } finally {
      this.restoringUndo = false;
    }
  }

  /** True when undo/redo can update live viewports without remounting the canvas board. */
  private canvasRuntimeSignature(project: ProjectDocument): string {
    const nodes = [...project.canvas.nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((n) => {
        switch (n.type) {
          case 'patternFrame':
            return `${n.id}:pattern:${n.patternId}`;
          case 'meshFrame':
            return `${n.id}:mesh:${n.meshId}`;
          case 'transform3d':
            return `${n.id}:transform:${n.transformId}`;
          case 'simViewport':
            return `${n.id}:sim:${n.simId}`;
          case 'image':
            return `${n.id}:image:${n.assetId ?? ''}`;
          case 'text':
            return `${n.id}:text`;
        }
      })
      .join('|');
    return [
      nodes,
      project.patterns.map((p) => p.id).sort().join(','),
      project.meshes.map((m) => m.id).sort().join(','),
      project.transforms.map((t) => t.id).sort().join(','),
      project.sims.map((s) => s.id).sort().join(','),
    ].join(';;');
  }

  private async syncLiveRuntimesFromProject(): Promise<void> {
    for (const node of this.project.canvas.nodes) {
      if (node.type === 'patternFrame') {
        const pattern = this.project.patterns.find((p) => p.id === node.patternId);
        const editor = this.editors.get(node.id);
        // Restoring history: keep the zoom/pan the user is looking through.
        if (pattern && editor) editor.setPattern(pattern, { preserveView: true });
        continue;
      }
      if (node.type === 'meshFrame') {
        const mesh = this.project.meshes.find((m) => m.id === node.meshId);
        const preview = this.meshPreviews.get(node.id);
        if (mesh && preview) {
          preview.setMesh(mesh, this.project.patterns.find((p) => p.id === mesh.patternId) ?? null);
        }
        continue;
      }
      if (node.type === 'image') {
        const el = this.findNodeEl(node.id);
        const img = el?.querySelector('img') as HTMLImageElement | null;
        if (img && node.src && img.src !== node.src) this.refreshImageElement(node);
        continue;
      }
      if (node.type === 'text') {
        const el = this.findNodeEl(node.id);
        const ta = el?.querySelector('textarea') as HTMLTextAreaElement | null;
        if (ta && ta.value !== node.text) ta.value = node.text;
      }
    }

    for (const transform of this.project.transforms) {
      const rt = this.transformRuntimes.get(transform.id);
      if (!rt) continue;
      rt.syncFromDocument(transform);
      rt.applyCamera(transform);
      rt.rebuildCloth(
        this.meshGeometryForTransform(transform.id),
        transform.pose,
        transform.pieceTransforms,
        this.patternForTransform(transform.id)
      );
    }

    syncDefaultCameraFromDrapeA(this.project);
    const defaults = getDefaultSimCamera(this.project);
    for (const sim of this.project.sims) {
      const rt = this.simRuntimes.get(sim.id);
      if (!rt) continue;
      rt.syncFromDocument(sim);
      rt.setDefaultCamera(defaults);
      rt.applyCamera(sim);
      this.rebuildConnectedSim(sim.id, false);
    }

    this.ensureRenderLoop();
    this.layoutNodes();
    this.drawWires();
    if (this.expandedNodeId) {
      this.notifyNodeViewportResize(this.expandedNodeId);
    }
  }

  private hasMissingViewportRuntimes(): boolean {
    for (const node of this.project.canvas.nodes) {
      if (node.type === 'transform3d') {
        if (!this.transformRuntimes.has(node.transformId)) return true;
      } else if (node.type === 'simViewport') {
        if (!this.simRuntimes.has(node.simId)) return true;
      }
    }
    return false;
  }

  private ensureRenderLoop(): void {
    if (this.raf) return;
    const loop = () => {
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private restoreTransformInspectorSelection(): void {
    if (!this.transformInspectorPieceId) return;
    const node = this.project.canvas.nodes.find((n) => n.id === this.selectedNodeId);
    if (node?.type !== 'transform3d') return;
    const rt = this.transformRuntimes.get(node.transformId);
    if (!rt) return;
    const pieceIds = rt.getPieceIds();
    if (!pieceIds.includes(this.transformInspectorPieceId)) {
      this.transformInspectorPieceId = null;
      return;
    }
    rt.setSelectedPieceId(this.transformInspectorPieceId);
    this.renderInspector();
  }

  private updateHistoryButtons(): void {
    const undoBtn = this.toolbar.querySelector('[data-act="undo"]') as HTMLButtonElement | null;
    if (undoBtn) {
      undoBtn.disabled = !this.undoStack.canUndo;
      undoBtn.title = this.undoStack.canUndo
        ? `Undo last change (${this.undoStack.size} in history) · ⌘/Ctrl+Z`
        : 'Nothing to undo';
    }
    const redoBtn = this.toolbar.querySelector('[data-act="redo"]') as HTMLButtonElement | null;
    if (redoBtn) {
      redoBtn.disabled = !this.undoStack.canRedo;
      redoBtn.title = this.undoStack.canRedo
        ? `Redo (${this.undoStack.redoSize} in history) · ⌘/Ctrl+Shift+Z`
        : 'Nothing to redo';
    }
  }

  private bindUndoHotkey(): void {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') this.resizeShiftKey = true;
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      const isZ = key === 'z';
      const isY = key === 'y';
      const isD = key === 'd';
      if (!isZ && !isY && !isD) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Duplicate selected node: ⌘/Ctrl+D
      if (isD && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.duplicateSelectedNode();
        return;
      }
      // Redo: ⌘/Ctrl+Shift+Z, or Ctrl+Y (Windows/Linux)
      if ((isZ && e.shiftKey) || (isY && !e.shiftKey && e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        this.performRedo();
        return;
      }
      if (isZ && !e.shiftKey) {
        e.preventDefault();
        this.performUndo();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.resizeShiftKey = false;
    });
  }

  private bindImageImport(): void {
    this.imageFileInput.addEventListener('change', () => {
      const files = Array.from(this.imageFileInput.files ?? []);
      this.imageFileInput.value = '';
      if (files.length === 0) return;
      void this.addImagesFromFiles(files);
    });
  }

  private bindImagePasteAndDrop(): void {
    window.addEventListener('paste', (e) => {
      if (this.isTextEditingTarget(e.target)) return;
      const files = this.imageFilesFromClipboard(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      void this.addImagesFromFiles(files);
    });

    const wrap = document.getElementById('boardWrap');
    if (!wrap) return;
    wrap.addEventListener('dragover', (e) => {
      if (!this.dataTransferHasImage(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      wrap.classList.add('is-image-drop');
    });
    wrap.addEventListener('dragleave', (e) => {
      if (e.target === wrap) wrap.classList.remove('is-image-drop');
    });
    wrap.addEventListener('drop', (e) => {
      wrap.classList.remove('is-image-drop');
      if (!this.dataTransferHasImage(e.dataTransfer)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length === 0) return;
      void this.addImagesFromFiles(files, {
        clientX: e.clientX,
        clientY: e.clientY,
      });
    });
  }

  private isTextEditingTarget(target: EventTarget | null): boolean {
    const t = target as HTMLElement | null;
    if (!t) return false;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
    return Boolean(t.closest('input, textarea, [contenteditable="true"]'));
  }

  private dataTransferHasImage(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    return Array.from(dt.items).some((item) => item.kind === 'file' && item.type.startsWith('image/'));
  }

  private imageFilesFromClipboard(dt: DataTransfer | null): File[] {
    if (!dt) return [];
    const files: File[] = [];
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
      reader.readAsDataURL(file);
    });
  }

  private loadImageNaturalSize(src: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () =>
        resolve({
          w: Math.max(1, img.naturalWidth || img.width),
          h: Math.max(1, img.naturalHeight || img.height),
        });
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = src;
    });
  }

  /** Board coords under a screen point (or viewport center when omitted). */
  private boardPointFromClient(clientX?: number, clientY?: number): { x: number; y: number } {
    const wrap = document.getElementById('boardWrap');
    const rect = wrap?.getBoundingClientRect();
    const { panX, panY, zoom } = this.project.canvas;
    const mx = clientX != null && rect ? clientX - rect.left : (rect?.width ?? 800) * 0.5;
    const my = clientY != null && rect ? clientY - rect.top : (rect?.height ?? 600) * 0.5;
    return {
      x: (mx - panX) / zoom,
      y: (my - panY) / zoom,
    };
  }

  /** Ask for a file to point `node` at. Used to add a replacement or re-link. */
  private pickImageFile(node: ImageNode): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.applyImageFile(node, file);
    });
    input.click();
  }

  /** Point `node` at a new image's bytes and make sure they reach storage. */
  private async applyImageFile(node: ImageNode, file: File): Promise<void> {
    try {
      this.pushUndo();
      const src = await this.readFileAsDataUrl(file);
      const { w, h } = await this.loadImageNaturalSize(src);
      const wasMissing = !node.src;
      node.src = src;
      node.naturalAspect = w / h;
      node.label = file.name.replace(/\.[^.]+$/, '') || node.label || 'Image';
      this.refreshImageElement(node);
      this.renderInspector();
      // Re-linking an image whose bytes were lost is the point of this path, so
      // the new bytes have to actually land in storage before we claim success.
      await this.persistLocal();
      this.setStatus(wasMissing ? 'Image re-linked' : 'Image replaced');
    } catch {
      this.setStatus('Could not read that image');
    }
  }

  /** Swap the missing-note for the real image once the node has a src again. */
  private refreshImageElement(node: ImageNode): void {
    const el = this.board.querySelector(`.canvas-node[data-node-id="${node.id}"]`);
    const img = el?.querySelector('img') as HTMLImageElement | null;
    if (!img) return;
    img.alt = node.label || 'image reference';
    if (!node.src) return;
    img.hidden = false;
    img.src = node.src;
    el?.querySelector('.image-missing')?.remove();
  }

  private async addImagesFromFiles(
    files: File[],
    at?: { clientX?: number; clientY?: number }
  ): Promise<void> {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    this.pushUndo();
    const anchor = this.boardPointFromClient(at?.clientX, at?.clientY);
    let offset = 0;
    for (const file of images) {
      try {
        const src = await this.readFileAsDataUrl(file);
        if (!src) continue;
        const { w: nw, h: nh } = await this.loadImageNaturalSize(src);
        const maxEdge = 420;
        const scale = Math.min(1, maxEdge / Math.max(nw, nh));
        const width = Math.max(120, Math.round(nw * scale));
        const height = Math.max(90, Math.round(nh * scale));
        const label = file.name?.replace(/\.[^.]+$/, '') || 'Reference';
        const node: ImageNode = {
          type: 'image',
          id: uid('node'),
          x: anchor.x - width / 2 + offset,
          y: anchor.y - height / 2 + offset,
          width,
          height,
          zIndex: 40 + this.project.canvas.nodes.length,
          src,
          label,
          naturalAspect: nw / nh,
        };
        this.project.canvas.nodes.push(node);
        this.mountNode(node);
        this.selectedNodeId = node.id;
        offset += 24;
      } catch {
        this.setStatus(`Could not load image “${file.name}”`);
      }
    }
    this.layoutNodes();
    this.drawWires();
    this.renderInspector();
    this.markDirty();
    void this.persistLocal();
    this.setStatus(
      images.length === 1 ? 'Image reference placed on canvas' : `${images.length} image references placed`
    );
  }

  private restartAutosave(): void {
    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    const minutes = getAutosaveIntervalMinutes();
    if (minutes <= 0) return;
    this.autosaveTimer = setInterval(
      () => this.persistLocal({ label: 'Auto-saved' }),
      minutes * 60 * 1000
    );
  }

  private switchToProject(project: ProjectDocument, opts: { resetUndo?: boolean } = {}): void {
    this.project = this.prepareLoadedProject(project);
    void setActiveProjectId(project.id);
    this.markDirty();
    this.selectedNodeId = null;
    this.transformInspectorPieceId = null;
    if (opts.resetUndo !== false) {
      this.undoStack.clear();
      this.updateHistoryButtons();
    }
    this.teardownSims();
    this.syncProjectChrome();
    this.renderAll();
    void this.initGpuAndSims();
  }

  /**
   * Point the toolbar's document-mirroring chrome at the current project.
   *
   * Called on every project switch, not just at build time: the toolbar is
   * built against a placeholder project *before* the saved one loads, so a
   * one-shot sync would leave the units label showing the placeholder's unit.
   */
  private syncProjectChrome(): void {
    const input = this.toolbar.querySelector('#projectName') as HTMLInputElement | null;
    if (input) input.value = this.project.name;
    this.updateUnitButton();
  }

  private bindImportFile(): void {
    this.importFileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      void (async () => {
        try {
          const project = await importProjectFile(file);
          const { write } = await saveProjectToLibrary(project);
          this.switchToProject(project);
          if (!write.ok) {
            this.setStatus(write.error ?? 'Import loaded, but local save failed');
          } else {
            this.setStatus(`Imported “${project.name}”`);
          }
          this.closeModal();
        } catch (err) {
          alert(`Import failed: ${err}`);
        }
      })();
      (e.target as HTMLInputElement).value = '';
    });
  }

  private closeModal(): void {
    // Undo/redo remounts the canvas; don't dismiss an open dialog as a side effect.
    if (this.restoringUndo) return;
    this.avatarLoadAbort?.abort();
    this.avatarLoadAbort = null;
    // Flushes any pending write before the dialog is torn down.
    this.avatarModal?.close();
    this.avatarModal = null;
    this.avatarPreview?.destroy();
    this.avatarPreview = null;
    this.avatarPreviewCanvas = null;
    this.modalRoot.hidden = true;
    this.modalRoot.innerHTML = '';
  }

  private openAvatarEditor(): void {
    this.modalRoot.hidden = false;
    const modal = new AvatarModal(this.modalRoot, {
      onClose: () => this.closeModal(),
      onChange: (library) => {
        const active = library.sets.find((s) => s.id === library.activeId) ?? library.sets[0];
        this.setStatus(
          active
            ? `Avatars · ${active.name} (${library.sets.length} ${library.sets.length === 1 ? 'avatar' : 'avatars'})`
            : 'Avatars updated'
        );
        // Rulers are sized and labelled from these numbers — repaint them.
        this.refreshRulerLibraries();
      },
      onGenerate: (avatar, setStatus, options) => this.generateAvatarFor(avatar, setStatus, options),
      onPreview: (avatar, elements, setStatus) => this.previewAvatarFor(avatar, elements, setStatus),
      onPreviewDispose: (canvas) => this.disposeAvatarPreview(canvas),
      onShowRulers: (show) => {
        this.avatarRulersVisible = show;
        this.avatarPreview?.setShowRulers(show);
      },
      onHighlightField: (field) => this.avatarPreview?.setHighlightField(field),
    });
    this.avatarModal = modal;
    void modal.open();
  }

  private disposeAvatarPreview(canvas: HTMLCanvasElement): void {
    if (this.avatarPreviewCanvas !== canvas) return;
    this.avatarPreview?.destroy();
    this.avatarPreview = null;
    this.avatarPreviewCanvas = null;
  }

  /** Render the 3D preview + measurement rulers (no sim changes). */
  private async previewAvatarFor(
    avatar: Avatar,
    elements: AvatarPreviewElements,
    setStatus: (text: string) => void
  ): Promise<AvatarReport | null> {
    try {
      if (!this.device) {
        setStatus('Starting WebGPU…');
        const gpu = await createSharedGpu();
        this.device = gpu.device;
      }
      if (this.avatarPreviewCanvas !== elements.canvas || !this.avatarPreview) {
        this.avatarPreview?.destroy();
        this.avatarPreview = new AvatarPreview(elements.canvas, elements.overlay, this.device);
        this.avatarPreviewCanvas = elements.canvas;
        this.avatarPreview.setShowRulers(this.avatarRulersVisible);
      }
      setStatus('');
      const mesh = await buildAvatarMeshes(avatar);
      this.avatarPreview.setMesh(mesh.render.positions, mesh.render.indices);
      this.avatarPreview.setRulers(
        buildMeasurementRulers(
          mesh.positions,
          mesh.measured,
          new Set(mesh.driven),
          avatar.unit,
          mesh.rulerPolylines
        )
      );
      return {
        heightCm: mesh.heightCm,
        measured: mesh.measured,
        saturated: mesh.saturated,
        driven: mesh.driven,
      };
    } catch (err) {
      setStatus(`Preview failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Generate a 3D body for `avatar` from its measurements and push it into every
   * sim / transform viewport. Returns a report for the editor.
   */
  private async generateAvatarFor(
    avatar: Avatar,
    setStatus: (text: string) => void,
    options: AvatarGenerationOptions
  ): Promise<AvatarReport | null> {
    try {
      if (!this.device) {
        setStatus('Starting WebGPU…');
        const gpu = await createSharedGpu();
        this.device = gpu.device;
      }

      setStatus('Generating body…');
      const { body, mesh, collision } = await createAvatarBodyFromAvatar(this.device, avatar, {
        sdfResolution: options.sdfResolution,
        onProgress: (value) => setStatus(`Baking collision SDF… ${Math.round(value * 100)}%`),
      });

      for (const rt of this.simRuntimes.values()) rt.setAvatarBody(body);
      for (const rt of this.transformRuntimes.values()) rt.setAvatarBody(body);
      resetAvatarOverlayCache();
      for (const ed of this.editors.values()) ed.reloadAvatarOverlay();

      await updateAvatar(avatar.id, {
        kind: '3d',
        model: {
          cacheKey: mesh.cacheKey,
          ...(options.sdfResolution ? { sdfResolution: options.sdfResolution } : {}),
        },
        ...(options.sdfResolution ? { sdfResolution: options.sdfResolution } : {}),
      });

      // Say what the drape is now colliding against, and whether it had to be
      // built from scratch (which is where the seconds go).
      const collisionText = collisionSummaryText(collision);
      const reused = collision.meshFromCache ? ' · mesh reused' : ` · ${(collision.totalMs / 1000).toFixed(1)} s`;
      this.setStatus(
        `Generated avatar “${avatar.name}” — ${mesh.heightCm.toFixed(0)} cm · ${collisionText}${reused}`
      );
      return {
        heightCm: mesh.heightCm,
        measured: mesh.measured,
        saturated: mesh.saturated,
        driven: mesh.driven,
        applied: true,
        collision,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Generation failed: ${message}`);
      this.setStatus(`Avatar generation failed: ${message}`);
      return null;
    }
  }

  /** Re-label every open pattern editor after the measurement library changes. */
  private refreshRulerLibraries(): void {
    for (const editor of this.editors.values()) editor.reloadRulers();
  }

  private openNewProjectPrompt(): void {
    this.modalRoot.hidden = false;
    this.modalRoot.innerHTML = `
      <div class="studio-modal-backdrop" data-modal-dismiss>
        <div class="studio-modal studio-modal-sm" role="dialog" aria-labelledby="newProjectTitle">
          <h2 id="newProjectTitle">Start new project?</h2>
          <p class="muted">Save “${this.escapeHtml(this.project.name)}” before discarding it?</p>
          <div class="studio-modal-actions">
            <button type="button" class="primary" data-new-act="save">Save &amp; start new</button>
            <button type="button" data-new-act="discard">Discard</button>
            <button type="button" data-new-act="cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
    this.modalRoot.querySelector('[data-modal-dismiss]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closeModal();
    });
    this.modalRoot.querySelector('[data-new-act="save"]')?.addEventListener('click', () => {
      this.persistLocal();
      this.startNewProject();
      this.closeModal();
    });
    this.modalRoot.querySelector('[data-new-act="discard"]')?.addEventListener('click', () => {
      this.startNewProject();
      this.closeModal();
    });
    this.modalRoot.querySelector('[data-new-act="cancel"]')?.addEventListener('click', () => {
      this.closeModal();
    });
  }

  private startNewProject(): void {
    void (async () => {
      const project = ensureVisibleConnections(createDefaultProject());
      const { write } = await saveProjectToLibrary(project);
      this.switchToProject(project);
      if (!write.ok) {
        this.setStatus(write.error ?? 'New project started, but local save failed');
      } else {
        this.setStatus('New project started');
      }
    })();
  }

  private openProjectsModal(): void {
    this.modalRoot.hidden = false;
    void this.renderProjectsModal();
  }

  private openAvatarModal(): void {
    const prefs = getAvatarPrefs();
    const collisionMode: AvatarCollisionMode = prefs.useSdf
      ? prefs.sdfFileName
        ? 'load-sdf'
        : 'bake-sdf'
      : 'triangle';
    this.modalRoot.hidden = false;
    this.modalRoot.innerHTML = `
      <div class="studio-modal-backdrop" data-modal-dismiss>
        <div class="studio-modal studio-modal-sm" role="dialog" aria-labelledby="avatarTitle">
          <div class="studio-modal-header">
            <h2 id="avatarTitle">Load avatar model</h2>
            <button type="button" class="studio-modal-close" data-modal-close aria-label="Close">×</button>
          </div>
          <p class="muted avatar-modal-current">Current: ${this.escapeHtml(avatarStatusLabel())}</p>
          <div class="avatar-modal-form">
            <label class="avatar-field">
              <span>Viewport mesh (OBJ)</span>
              <input type="file" accept=".obj" id="avatarFile" />
              <small class="muted">Leave empty to keep the current mesh (${this.escapeHtml(prefs.objFileName)}).</small>
            </label>
            <label class="avatar-field">
              <span>Import scale</span>
              <input type="number" id="avatarScale" min="0.001" step="0.1" value="${prefs.unitToWorld}" />
              <small class="muted">World units per OBJ unit (default 10 for meter OBJs). Does not rescale an imported SDF.</small>
            </label>
            <label class="avatar-field">
              <span>Collision</span>
              <select id="avatarCollisionMode">
                <option value="triangle" ${collisionMode === 'triangle' ? 'selected' : ''}>Triangle mesh</option>
                <option value="load-sdf" ${collisionMode === 'load-sdf' ? 'selected' : ''}>Load SDF / OpenVDB from disk</option>
                <option value="bake-sdf" ${collisionMode === 'bake-sdf' ? 'selected' : ''}>Bake SDF from viewport mesh</option>
              </select>
            </label>
            <label class="avatar-field" id="avatarSdfFileWrap" hidden>
              <span>Collision SDF (.sdf / .vdb)</span>
              <input type="file" accept=".sdf,.vdb,application/octet-stream" id="avatarSdfFile" />
              <small class="muted">PCSD .sdf loads instantly. OpenVDB .vdb is densified on import (uses resolution below) and cached as .sdf in refPpl/.</small>
            </label>
            <label class="avatar-field" id="avatarSdfResWrap" hidden>
              <span>SDF resolution</span>
              <input type="number" id="avatarSdfRes" min="32" max="128" step="8" value="${prefs.sdfResolution || DEFAULT_SDF_RESOLUTION}" />
              <small class="muted">Used for bake and OpenVDB densify. 48 = fast · 64 = balanced · 96 = high quality.</small>
            </label>
            <div class="avatar-progress" id="avatarProgress" hidden>
              <div class="avatar-progress-bar"><div class="avatar-progress-fill" id="avatarProgressFill"></div></div>
              <span class="muted" id="avatarProgressText"></span>
            </div>
          </div>
          <div class="studio-modal-actions">
            <button type="button" data-avatar-act="cancel" id="avatarCancelBtn">Cancel</button>
            <button type="button" class="primary" data-avatar-act="load" disabled id="avatarLoadBtn">Load</button>
          </div>
        </div>
      </div>
    `;

    const fileInput = this.modalRoot.querySelector('#avatarFile') as HTMLInputElement;
    const sdfFileInput = this.modalRoot.querySelector('#avatarSdfFile') as HTMLInputElement;
    const loadBtn = this.modalRoot.querySelector('#avatarLoadBtn') as HTMLButtonElement;
    const cancelBtn = this.modalRoot.querySelector('#avatarCancelBtn') as HTMLButtonElement;
    const modeSelect = this.modalRoot.querySelector('#avatarCollisionMode') as HTMLSelectElement;
    const sdfFileWrap = this.modalRoot.querySelector('#avatarSdfFileWrap') as HTMLElement;
    const sdfResWrap = this.modalRoot.querySelector('#avatarSdfResWrap') as HTMLElement;

    const syncModeUi = () => {
      const mode = modeSelect.value as AvatarCollisionMode;
      sdfFileWrap.hidden = mode !== 'load-sdf';
      // Resolution applies to bake and OpenVDB densify.
      sdfResWrap.hidden = mode === 'triangle';
      updateLoadEnabled();
    };

    const updateLoadEnabled = () => {
      const mode = modeSelect.value as AvatarCollisionMode;
      const hasSdf = !!sdfFileInput.files?.length;
      if (mode === 'load-sdf') {
        loadBtn.disabled = !hasSdf;
      } else {
        // Bake / triangle can use the current mesh if no new OBJ is chosen.
        loadBtn.disabled = false;
      }
    };

    modeSelect.addEventListener('change', syncModeUi);
    fileInput.addEventListener('change', updateLoadEnabled);
    sdfFileInput.addEventListener('change', updateLoadEnabled);
    syncModeUi();

    this.modalRoot.querySelector('[data-modal-dismiss]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        if (this.avatarLoadAbort) this.avatarLoadAbort.abort();
        else this.closeModal();
      }
    });
    this.modalRoot.querySelector('[data-modal-close]')?.addEventListener('click', () => {
      if (this.avatarLoadAbort) this.avatarLoadAbort.abort();
      else this.closeModal();
    });
    cancelBtn.addEventListener('click', () => {
      if (this.avatarLoadAbort) {
        this.avatarLoadAbort.abort();
        return;
      }
      this.closeModal();
    });
    this.modalRoot.querySelector('[data-avatar-act="load"]')?.addEventListener('click', () => {
      void this.handleAvatarLoad();
    });
  }

  private async handleAvatarLoad(): Promise<void> {
    const fileInput = this.modalRoot.querySelector('#avatarFile') as HTMLInputElement;
    const sdfFileInput = this.modalRoot.querySelector('#avatarSdfFile') as HTMLInputElement;
    const scaleInput = this.modalRoot.querySelector('#avatarScale') as HTMLInputElement;
    const modeSelect = this.modalRoot.querySelector('#avatarCollisionMode') as HTMLSelectElement;
    const sdfResInput = this.modalRoot.querySelector('#avatarSdfRes') as HTMLInputElement;
    const progressWrap = this.modalRoot.querySelector('#avatarProgress') as HTMLElement;
    const progressFill = this.modalRoot.querySelector('#avatarProgressFill') as HTMLElement;
    const progressText = this.modalRoot.querySelector('#avatarProgressText') as HTMLElement;
    const loadBtn = this.modalRoot.querySelector('#avatarLoadBtn') as HTMLButtonElement;
    const cancelBtn = this.modalRoot.querySelector('#avatarCancelBtn') as HTMLButtonElement;

    const meshFile = fileInput.files?.[0] ?? null;
    const sdfFile = sdfFileInput.files?.[0] ?? null;
    const collisionMode = modeSelect.value as AvatarCollisionMode;

    if (collisionMode === 'load-sdf' && !sdfFile) {
      this.setStatus('Choose a collision SDF file');
      return;
    }

    if (!this.device) {
      try {
        const gpu = await createSharedGpu();
        this.device = gpu.device;
      } catch (err) {
        this.setStatus(`WebGPU unavailable: ${err}`);
        return;
      }
    }

    const unitToWorld = parseFloat(scaleInput.value) || AVATAR_UNIT_TO_WORLD;
    const sdfResolution = parseInt(sdfResInput.value, 10) || DEFAULT_SDF_RESOLUTION;

    this.avatarLoadAbort?.abort();
    const abort = new AbortController();
    this.avatarLoadAbort = abort;

    loadBtn.disabled = true;
    fileInput.disabled = true;
    sdfFileInput.disabled = true;
    scaleInput.disabled = true;
    modeSelect.disabled = true;
    sdfResInput.disabled = true;
    cancelBtn.textContent =
      collisionMode === 'bake-sdf' || collisionMode === 'load-sdf' ? 'Cancel import' : 'Cancel';
    progressWrap.hidden = false;
    progressFill.style.width = '0%';
    progressText.textContent = 'Starting…';

    const resetForm = () => {
      this.avatarLoadAbort = null;
      loadBtn.disabled = false;
      fileInput.disabled = false;
      sdfFileInput.disabled = false;
      scaleInput.disabled = false;
      modeSelect.disabled = false;
      sdfResInput.disabled = false;
      cancelBtn.textContent = 'Cancel';
    };

    try {
      const body = await importAvatarModel({
        meshFile,
        sdfFile,
        unitToWorld,
        collisionMode,
        sdfResolution,
        device: this.device,
        signal: abort.signal,
        onProgress: (message, progress) => {
          progressText.textContent = message;
          if (progress !== undefined) {
            progressFill.style.width = `${Math.round(progress * 100)}%`;
          }
        },
      });

      for (const rt of this.simRuntimes.values()) {
        rt.setAvatarBody(body);
      }
      for (const rt of this.transformRuntimes.values()) {
        rt.setAvatarBody(body);
      }
      resetAvatarOverlayCache();
      for (const ed of this.editors.values()) {
        ed.reloadAvatarOverlay();
      }

      this.avatarLoadAbort = null;
      this.closeModal();
      const modeLabel =
        collisionMode === 'load-sdf'
          ? 'SDF from disk'
          : collisionMode === 'bake-sdf'
            ? 'baked SDF'
            : 'triangle collision';
      this.setStatus(`Avatar loaded (${modeLabel}) — ${avatarStatusLabel()}`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        progressText.textContent = 'Cancelled — previous avatar unchanged.';
        progressFill.style.width = '0%';
        this.setStatus('Avatar import cancelled');
        resetForm();
        return;
      }
      progressText.textContent = err instanceof Error ? err.message : String(err);
      this.setStatus(`Avatar import failed: ${err}`);
      resetForm();
    }
  }

  private async renderProjectsModal(): Promise<void> {
    const projects = await listSavedProjects();
    const est = await getStorageEstimate();
    const storageHint =
      est.usage != null && est.quota != null
        ? ` · ${(est.usage / (1024 * 1024)).toFixed(1)} / ${(est.quota / (1024 * 1024)).toFixed(1)} MB used`
        : '';
    const rows =
      projects.length === 0
        ? `<p class="muted studio-modal-empty">No saved projects yet.</p>`
        : projects
            .map((record) => {
              const isActive = record.id === this.project.id;
              return `
                <li class="project-row ${isActive ? 'is-active' : ''}" data-project-id="${record.id}">
                  <div class="project-row-main">
                    <strong>${this.escapeHtml(record.name)}</strong>
                    <span class="muted">${formatProjectDate(record.updatedAt)}${isActive ? ' · current' : ''}</span>
                  </div>
                  <div class="project-row-actions">
                    <button type="button" data-project-act="load" ${isActive ? 'disabled' : ''}>Load</button>
                    <button type="button" data-project-act="export">Export</button>
                    <button type="button" class="danger" data-project-act="delete">Delete</button>
                  </div>
                </li>
              `;
            })
            .join('');

    this.modalRoot.innerHTML = `
      <div class="studio-modal-backdrop" data-modal-dismiss>
        <div class="studio-modal studio-modal-lg" role="dialog" aria-labelledby="projectsTitle">
          <div class="studio-modal-header">
            <h2 id="projectsTitle">Projects</h2>
            <button type="button" class="studio-modal-close" data-modal-close aria-label="Close">×</button>
          </div>
          <p class="muted">Current: <strong>${this.escapeHtml(this.project.name)}</strong>${storageHint}</p>
          <div class="studio-modal-toolbar">
            <button type="button" class="primary" data-projects-act="save">Save current</button>
            <button type="button" data-projects-act="import">Import</button>
            <button type="button" data-projects-act="export-archive">Export archive</button>
            <label class="autosave-field">
              Auto-save every
              <input type="number" id="autosaveMinutes" min="0" max="120" step="1" value="${getAutosaveIntervalMinutes()}" />
              min
            </label>
            <span class="muted autosave-hint">0 disables · default ${DEFAULT_AUTOSAVE_MINUTES}</span>
          </div>
          <ul class="project-list">${rows}</ul>
        </div>
      </div>
    `;

    this.modalRoot.querySelector('[data-modal-dismiss]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closeModal();
    });
    this.modalRoot.querySelector('[data-modal-close]')?.addEventListener('click', () => {
      this.closeModal();
    });
    this.modalRoot.querySelector('[data-projects-act="save"]')?.addEventListener('click', () => {
      void this.persistLocal().then(() => this.renderProjectsModal());
    });
    this.modalRoot.querySelector('[data-projects-act="import"]')?.addEventListener('click', () => {
      this.importFileInput.click();
    });
    this.modalRoot.querySelector('[data-projects-act="export-archive"]')?.addEventListener('click', () => {
      this.persistSimStates();
      void exportProjectFile(this.project, true);
    });
    this.modalRoot.querySelector('#autosaveMinutes')?.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const minutes = parseFloat(input.value);
      const next = Number.isFinite(minutes) ? minutes : DEFAULT_AUTOSAVE_MINUTES;
      setAutosaveIntervalMinutes(next);
      input.value = String(getAutosaveIntervalMinutes());
      this.restartAutosave();
      const m = getAutosaveIntervalMinutes();
      this.setStatus(
        m <= 0 ? 'Auto-save disabled' : `Auto-save every ${m} min`
      );
    });

    this.modalRoot.querySelectorAll('.project-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-project-act]');
        if (!btn || btn.disabled) return;
        e.stopPropagation();
        const id = (row as HTMLElement).dataset.projectId!;
        const act = btn.dataset.projectAct!;
        void (async () => {
          if (act === 'load') {
            const project = await getSavedProject(id);
            if (project) {
              this.switchToProject(project);
              this.setStatus(`Loaded “${project.name}”`);
              this.closeModal();
            }
          } else if (act === 'export') {
            const record = projects.find((p) => p.id === id);
            if (!record) return;
            if (id === this.project.id) this.persistSimStates();
            if (id === this.project.id) {
              await exportProjectFile(this.project, true);
            } else {
              const loaded = await getSavedProject(id);
              if (loaded) await exportProjectFile(loaded, true);
            }
          } else if (act === 'delete') {
            const record = projects.find((p) => p.id === id);
            if (!record) return;
            if (!confirm(`Delete “${record.name}”? This cannot be undone.`)) return;
            const wasActive = id === this.project.id;
            await deleteProjectFromLibrary(id);
            if (wasActive) {
              const nextId = await getActiveProjectId();
              const next =
                (nextId ? await getSavedProject(nextId) : null) ??
                ensureVisibleConnections(createDefaultProject());
              if (!(await getSavedProject(next.id))) {
                await saveProjectToLibrary(next);
              }
              this.switchToProject(next);
              this.setStatus(`Deleted “${record.name}”`);
              this.closeModal();
            } else {
              void this.renderProjectsModal();
              this.setStatus(`Deleted “${record.name}”`);
            }
          }
        })();
      });
    });
  }

  private downloadJson(json: string, filename: string): void {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Label row: name + ⓘ on the left, numeric readout flush right.
   * Pass `valueId` so sliders can update `#${valueId}` live.
   */
  private paramTip(name: string, tip: string, value = '', valueId?: string): string {
    const valueAttr = valueId ? ` id="${valueId}"` : '';
    return `<span class="inspector-label-row"><span class="inspector-label-left">${this.escapeHtml(name)}<button type="button" class="inspector-tip" aria-label="About ${this.escapeHtml(name)}" data-tip="${this.escapeHtml(tip)}">i</button></span><span class="inspector-param-value"${valueAttr}>${this.escapeHtml(value)}</span></span>`;
  }

  private ensureInspectorTipEl(): HTMLDivElement {
    if (!this.inspectorTipEl) {
      const el = document.createElement('div');
      el.className = 'inspector-floating-tip';
      el.hidden = true;
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
      this.inspectorTipEl = el;
      this.inspector.addEventListener('scroll', () => this.hideInspectorTip(), { passive: true });
    }
    return this.inspectorTipEl;
  }

  private hideInspectorTip(): void {
    if (this.inspectorTipEl) this.inspectorTipEl.hidden = true;
  }

  private showInspectorTip(anchor: HTMLElement): void {
    const text = anchor.dataset.tip ?? '';
    if (!text) return;
    const tip = this.ensureInspectorTipEl();
    tip.textContent = text;
    tip.hidden = false;
    tip.style.visibility = 'hidden';
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const r = anchor.getBoundingClientRect();
    const pad = 8;
    // Prefer left of the icon (inspector is on the right); flip if needed.
    let left = r.left - tw - pad;
    if (left < pad) left = Math.min(r.right + pad, window.innerWidth - tw - pad);
    let top = r.top + r.height / 2 - th / 2;
    top = Math.max(pad, Math.min(top, window.innerHeight - th - pad));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = 'visible';
  }

  /** Wire ⓘ buttons to a body-level floating tip (not clipped by overflow). */
  private bindInspectorTips(): void {
    this.hideInspectorTip();
    this.inspector.querySelectorAll('.inspector-tip').forEach((btn) => {
      const el = btn as HTMLElement;
      el.addEventListener('click', (e) => e.preventDefault());
      el.addEventListener('mouseenter', () => this.showInspectorTip(el));
      el.addEventListener('mouseleave', () => this.hideInspectorTip());
      el.addEventListener('focus', () => this.showInspectorTip(el));
      el.addEventListener('blur', () => this.hideInspectorTip());
    });
  }

  private setStatus(msg: string): void {
    const el = document.getElementById('status');
    if (el) el.textContent = msg;
  }

  private buildToolbar(): void {
    this.toolbar.innerHTML = `
      <button type="button" data-act="new"><i data-lucide="file-plus-2" aria-hidden="true"></i><span>New</span></button>
      <button type="button" data-act="projects"><i data-lucide="folder" aria-hidden="true"></i><span>Projects</span></button>
      <div class="toolbar-sep"></div>
      <input class="project-name" id="projectName" value="" aria-label="Project name" />
      <div class="toolbar-sep"></div>
      <button type="button" data-act="undo" disabled title="Nothing to undo" aria-label="Undo"><i data-lucide="undo-2" aria-hidden="true"></i><span>Undo</span></button>
      <button type="button" data-act="redo" disabled title="Nothing to redo" aria-label="Redo"><i data-lucide="redo-2" aria-hidden="true"></i><span>Redo</span></button>
      <div class="toolbar-sep"></div>
      <button type="button" data-act="loadAvatar"><i data-lucide="user-round" aria-hidden="true"></i><span>Load avatar model</span></button>
      <button type="button" data-act="avatars" title="Avatars: measurements + generated 3D models"><i data-lucide="clipboard-list" aria-hidden="true"></i><span>Avatars</span></button>
      <div class="toolbar-sep"></div>
      <button type="button" data-act="unit" title="Display units"><i data-lucide="ruler" aria-hidden="true"></i><span>Units</span></button>
      <div class="toolbar-sep"></div>
      <button type="button" data-act="addPattern"><i data-lucide="scissors" aria-hidden="true"></i><span>+ Pattern</span></button>
      <button type="button" data-act="addSim"><i data-lucide="shirt" aria-hidden="true"></i><span>+ Sim</span></button>
      <button type="button" data-act="addText"><i data-lucide="sticky-note" aria-hidden="true"></i><span>+ Note</span></button>
      <button type="button" data-act="addImage" title="Add image reference (or paste / drop on canvas)"><i data-lucide="image" aria-hidden="true"></i><span>+ Image</span></button>
    `;
    this.syncProjectChrome();
    this.updateHistoryButtons();
    this.toolbar.querySelector('#projectName')!.addEventListener('change', (e) => {
      this.pushUndo();
      this.project.name = (e.target as HTMLInputElement).value;
    });
    this.toolbar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      void this.onToolbar(btn.dataset.act!);
    });
    this.updateUnitButton();
    // Swap every <i data-lucide="…"> for its inline SVG.
    createIcons({
      icons: {
        FilePlus2,
        Folder,
        Undo2,
        Redo2,
        UserRound,
        Ruler,
        ClipboardList,
        Scissors,
        Shirt,
        StickyNote,
        Image: ImageIcon,
      },
    });
  }

  private updateUnitButton(): void {
    const btn = this.toolbar.querySelector('[data-act="unit"]') as HTMLButtonElement | null;
    // Leave the icon in place — only the label changes.
    const label = btn?.querySelector('span');
    if (label) label.textContent = `Units: ${this.project.displayUnit}`;
  }

  private async onToolbar(act: string): Promise<void> {
    switch (act) {
      case 'undo':
        this.performUndo();
        break;
      case 'redo':
        this.performRedo();
        break;
      case 'new':
        this.openNewProjectPrompt();
        break;
      case 'projects':
        this.openProjectsModal();
        break;
      case 'loadAvatar':
        this.openAvatarModal();
        break;
      case 'measurements':
      case 'avatars':
        this.openAvatarEditor();
        break;
      case 'unit':
        this.pushUndo();
        this.project.displayUnit = this.project.displayUnit === 'cm' ? 'in' : 'cm';
        this.updateUnitButton();
        this.editors.forEach((ed) => ed.setUnit(this.project.displayUnit));
        this.meshPreviews.forEach((p) => p.setUnit(this.project.displayUnit));
        // The unit is document data — make sure the choice reaches the file.
        this.markDirty();
        break;
      case 'addPattern':
        this.pushUndo();
        this.addPatternFrame();
        break;
      case 'addSim':
        this.pushUndo();
        this.addSimViewport();
        break;
      case 'addText':
        this.pushUndo();
        this.addTextNote();
        break;
      case 'addImage':
        this.imageFileInput.click();
        break;
    }
  }

  private nodeMenu: HTMLElement | null = null;

  /** Right-click a node on the board for its duplicate / delete popover. */
  private bindNodeContextMenu(): void {
    this.board.addEventListener('contextmenu', (e) => {
      const el = (e.target as HTMLElement).closest('.canvas-node') as HTMLElement | null;
      const node = el
        ? this.project.canvas.nodes.find((n) => n.id === el.dataset.nodeId)
        : undefined;
      // Empty board keeps the browser menu.
      if (!node) return;
      e.preventDefault();
      this.showNodeMenu(node, e.clientX, e.clientY);
    });
    // Any press elsewhere, plus Esc / resize / pan / zoom, dismisses the popover.
    document.addEventListener('pointerdown', () => this.closeNodeMenu());
    window.addEventListener('resize', () => this.closeNodeMenu());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeNodeMenu();
    });
  }

  private showNodeMenu(node: CanvasNode, clientX: number, clientY: number): void {
    this.selectedNodeId = node.id;
    this.layoutNodes();
    this.renderInspector();
    this.openNodeMenu(node, clientX, clientY);
  }

  private openNodeMenu(node: CanvasNode, clientX: number, clientY: number): void {
    this.closeNodeMenu();
    const menu = document.createElement('div');
    menu.className = 'node-context-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <p class="node-context-title">${this.escapeHtml(this.nodeLabel(node))}</p>
      <button type="button" role="menuitem" data-node-act="duplicate">Duplicate node</button>
      <button type="button" role="menuitem" data-node-act="delete" class="is-danger">Delete node</button>
    `;
    // Keep the press inside the popover from reaching the dismiss listener.
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest(
        'button[data-node-act]'
      ) as HTMLButtonElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.nodeAct;
      this.closeNodeMenu();
      if (act === 'duplicate') {
        const dup = this.duplicateNode(node.id, { recordUndo: true, select: true });
        if (dup) this.setStatus(`Duplicated · ${this.nodeLabel(dup)}`);
      } else if (act === 'delete') {
        this.deleteNode(node.id);
      }
    });
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    document.body.appendChild(menu);
    this.nodeMenu = menu;

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
    }
  }

  private closeNodeMenu(): void {
    this.nodeMenu?.remove();
    this.nodeMenu = null;
  }

  private bindBoardPan(): void {
    const wrap = document.getElementById('boardWrap')!;
    wrap.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.canvas-node')) return;
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        this.panning = true;
        this.panLast = { x: e.clientX, y: e.clientY };
        wrap.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    // Suppress browser middle-click autoscroll affordance on the board.
    wrap.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    wrap.addEventListener('pointermove', (e) => {
      if (this.wireDrag) {
        const rect = wrap.getBoundingClientRect();
        this.wireDrag.x = e.clientX - rect.left;
        this.wireDrag.y = e.clientY - rect.top;
        this.drawWires();
        this.highlightWireTarget(e.clientX, e.clientY);
        return;
      }
      if (this.panning) {
        const dx = e.clientX - this.panLast.x;
        const dy = e.clientY - this.panLast.y;
        this.panLast = { x: e.clientX, y: e.clientY };
        this.project.canvas.panX += dx;
        this.project.canvas.panY += dy;
        this.applyBoardTransform();
        this.drawWires();
        return;
      }
      if (this.resizingNode) {
        this.resizeShiftKey = e.shiftKey;
        this.applyNodeResize(e.clientX, e.clientY);
        return;
      }
      if (this.draggingNode) {
        const zoom = this.project.canvas.zoom;
        const node = this.project.canvas.nodes.find((n) => n.id === this.draggingNode!.id);
        if (node) {
          node.x = (e.clientX - this.project.canvas.panX) / zoom - this.draggingNode.ox;
          node.y = (e.clientY - this.project.canvas.panY) / zoom - this.draggingNode.oy;
          this.layoutNodes();
          this.drawWires();
        }
      }
    });
    wrap.addEventListener('pointerup', (e) => {
      if (this.wireDrag) {
        this.finishWireDrag(e.clientX, e.clientY);
        try {
          wrap.releasePointerCapture(e.pointerId);
        } catch {
          /* capture may already be released */
        }
      }
      this.panning = false;
      this.draggingNode = null;
      this.resizingNode = null;
    });
    wrap.addEventListener('pointercancel', () => {
      this.cancelWireDrag();
      this.panning = false;
      this.draggingNode = null;
      this.resizingNode = null;
    });
    wrap.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const oldZoom = this.project.canvas.zoom;
        const newZoom = Math.min(2.5, Math.max(0.35, oldZoom * factor));
        if (newZoom === oldZoom) return;
        // Zoom toward cursor: keep the board point under the pointer fixed on screen.
        const rect = wrap.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const { panX, panY } = this.project.canvas;
        const boardX = (mx - panX) / oldZoom;
        const boardY = (my - panY) / oldZoom;
        this.project.canvas.zoom = newZoom;
        this.project.canvas.panX = mx - boardX * newZoom;
        this.project.canvas.panY = my - boardY * newZoom;
        this.applyBoardTransform();
        this.drawWires();
      },
      { passive: false }
    );
  }

  private applyBoardTransform(): void {
    const { panX, panY, zoom } = this.project.canvas;
    this.board.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }

  private renderAll(): void {
    this.gpuInitGeneration++;
    this.closeNodeFullscreen();
    this.teardownSims();
    this.board.innerHTML = '';
    this.editors.clear();
    this.meshPreviews.clear();
    this.applyBoardTransform();
    const nodes = [...this.project.canvas.nodes].sort((a, b) => a.zIndex - b.zIndex);
    for (const node of nodes) {
      this.mountNode(node);
    }
    this.drawWires();
    this.renderInspector();
  }

  private findNodeEl(nodeId: string): HTMLElement | null {
    // `.canvas-node` only: the placeholder a fullscreen node leaves behind
    // carries the same `data-node-id`, and matching it would move the
    // placeholder instead of the node.
    return (
      (this.board.querySelector(`.canvas-node[data-node-id="${nodeId}"]`) as HTMLElement | null) ||
      (this.expandOverlay?.querySelector(
        `.canvas-node[data-node-id="${nodeId}"]`
      ) as HTMLElement | null)
    );
  }

  private layoutNodes(): void {
    for (const node of this.project.canvas.nodes) {
      const expanded = this.expandedNodeId === node.id;
      if (this.expandPlaceholder && expanded) {
        this.expandPlaceholder.style.left = `${node.x}px`;
        this.expandPlaceholder.style.top = `${node.y}px`;
        this.expandPlaceholder.style.width = `${node.width}px`;
        this.expandPlaceholder.style.height = `${node.height}px`;
      }
      const el = this.findNodeEl(node.id);
      if (!el || expanded) continue;
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
      el.style.width = `${node.width}px`;
      el.style.height = `${node.height}px`;
      el.classList.toggle('selected', node.id === this.selectedNodeId);
      el.classList.toggle(
        'sim-active',
        node.type === 'simViewport' && (node as SimViewportNode).simId === this.project.activeSimId
      );
    }
  }

  private openNodeFullscreen(nodeId: string): void {
    if (this.expandedNodeId === nodeId) {
      this.closeNodeFullscreen();
      return;
    }
    if (this.expandedNodeId) {
      // Already fullscreen — switch to another node in the pipeline
      if (this.pipelineNodesFor(this.expandedNodeId).some((n) => n.id === nodeId)) {
        this.switchFullscreenNode(nodeId);
        return;
      }
      this.closeNodeFullscreen();
    }
    // A transform / drape carries the remesh with it: catch it up on arrival.
    this.remeshIfStale(nodeId);
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
    const el = this.findNodeEl(nodeId);
    if (!el || !node) return;

    const placeholder = document.createElement('div');
    placeholder.className = `canvas-node-placeholder${
      this.isEmbeddedNode(node) ? ' is-embedded' : ''
    }`;
    placeholder.dataset.nodeId = nodeId;
    placeholder.style.left = `${node.x}px`;
    placeholder.style.top = `${node.y}px`;
    placeholder.style.width = `${node.width}px`;
    placeholder.style.height = `${node.height}px`;
    placeholder.style.zIndex = String(node.zIndex);
    placeholder.title = 'Expanded on screen';
    el.parentElement?.insertBefore(placeholder, el);

    const overlay = document.createElement('div');
    overlay.className = 'node-fullscreen-overlay';
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) this.closeNodeFullscreen();
    });

    el.classList.add('is-expanded');
    el.style.left = '';
    el.style.top = '';
    el.style.width = '';
    el.style.height = '';
    el.style.zIndex = '';
    overlay.appendChild(el);
    document.body.appendChild(overlay);

    this.setExpandButtonMode(el, true);

    this.expandedNodeId = nodeId;
    this.expandPlaceholder = placeholder;
    this.expandOverlay = overlay;
    this.selectedNodeId = nodeId;
    this.dockInspectorToFullscreen();
    this.syncFullscreenTabs(el, nodeId);
    this.layoutNodes();
    this.renderInspector();
    this.drawWires();

    this.expandEscHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeNodeFullscreen();
      }
    };
    window.addEventListener('keydown', this.expandEscHandler);

    requestAnimationFrame(() => {
      this.notifyNodeViewportResize(nodeId);
      this.setStatus('Full screen — Esc or ✕ to close · tabs switch connected views');
    });
  }

  private closeNodeFullscreen(): void {
    if (!this.expandedNodeId || !this.expandPlaceholder || !this.expandOverlay) return;
    // Put the split's stage back on the board before the node elements move.
    if (this.splitView) this.exitSplitView();
    const nodeId = this.expandedNodeId;
    const el = this.expandOverlay.querySelector(
      `[data-node-id="${nodeId}"]`
    ) as HTMLElement | null;
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);

    // Pull inspector out before moving the node back onto the board.
    this.undockInspectorFromFullscreen();

    if (el && node) {
      el.classList.remove('is-expanded');
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
      el.style.width = `${node.width}px`;
      el.style.height = `${node.height}px`;
      el.style.zIndex = String(node.zIndex);
      this.setExpandButtonMode(el, false);
      this.clearFullscreenTabs(el);
      this.expandPlaceholder.replaceWith(el);
    } else {
      this.expandPlaceholder.remove();
    }

    this.expandOverlay.remove();
    if (this.expandEscHandler) {
      window.removeEventListener('keydown', this.expandEscHandler);
      this.expandEscHandler = null;
    }
    this.expandedNodeId = null;
    this.expandPlaceholder = null;
    this.expandOverlay = null;
    this.layoutNodes();
    this.drawWires();
    requestAnimationFrame(() => this.notifyNodeViewportResize(nodeId));
  }

  /** Dock inspector inside the expanded modal, under chrome, beside the viewport. */
  private dockInspectorToFullscreen(): void {
    if (!this.expandOverlay || !this.expandedNodeId) return;
    // The 2D pattern stage is about drawing: the tool rail and the option bars
    // are the useful chrome there, so the inspector stays out of the way.
    const expanded = this.project.canvas.nodes.find((n) => n.id === this.expandedNodeId);
    if (expanded?.type === 'patternFrame') return;
    const nodeEl = this.expandOverlay.querySelector(
      `[data-node-id="${this.expandedNodeId}"]`
    ) as HTMLElement | null;
    if (!nodeEl) return;

    let main = nodeEl.querySelector(':scope > .node-expand-main') as HTMLElement | null;
    if (!main) {
      const body = nodeEl.querySelector(':scope > .node-body') as HTMLElement | null;
      if (!body) return;
      main = document.createElement('div');
      main.className = 'node-expand-main';
      body.replaceWith(main);
      main.appendChild(body);
    }

    this.inspector.classList.add('is-fullscreen-docked');
    main.appendChild(this.inspector);
  }

  /** Restore the inspector to the studio body and unwrap the expand layout. */
  private undockInspectorFromFullscreen(): void {
    this.inspector.classList.remove('is-fullscreen-docked');
    const main = this.inspector.parentElement;
    if (main?.classList.contains('node-expand-main')) {
      const nodeEl = main.parentElement;
      const body = main.querySelector(':scope > .node-body');
      if (nodeEl && body) {
        nodeEl.insertBefore(body, main);
        main.remove();
      }
    }
    if (this.inspector.parentElement !== this.studioBody) {
      this.studioBody.appendChild(this.inspector);
    }
  }

  private switchFullscreenNode(nextId: string): void {
    if (!this.expandOverlay || !this.expandPlaceholder || !this.expandedNodeId) return;
    if (nextId === this.expandedNodeId) return;
    // Collapse the split back to the pattern so the switch moves a plain overlay.
    if (this.splitView) this.exitSplitView('pattern');

    const prevId = this.expandedNodeId;
    const prevEl = this.expandOverlay.querySelector(
      `[data-node-id="${prevId}"]`
    ) as HTMLElement | null;
    const nextEl = this.findNodeEl(nextId);
    const prevNode = this.project.canvas.nodes.find((n) => n.id === prevId);
    const nextNode = this.project.canvas.nodes.find((n) => n.id === nextId);
    if (!prevEl || !nextEl || !prevNode || !nextNode) return;

    // Moving on to a later stage rebuilds the mesh first if the pattern moved on.
    this.remeshIfStale(nextId);

    this.undockInspectorFromFullscreen();

    // Restore previous node onto the board where the placeholder was
    prevEl.classList.remove('is-expanded');
    prevEl.style.left = `${prevNode.x}px`;
    prevEl.style.top = `${prevNode.y}px`;
    prevEl.style.width = `${prevNode.width}px`;
    prevEl.style.height = `${prevNode.height}px`;
    prevEl.style.zIndex = String(prevNode.zIndex);
    this.setExpandButtonMode(prevEl, false);
    this.clearFullscreenTabs(prevEl);
    this.expandPlaceholder.replaceWith(prevEl);

    // Placeholder for the node we're about to expand
    const placeholder = document.createElement('div');
    placeholder.className = `canvas-node-placeholder${
      this.isEmbeddedNode(nextNode) ? ' is-embedded' : ''
    }`;
    placeholder.dataset.nodeId = nextId;
    placeholder.style.left = `${nextNode.x}px`;
    placeholder.style.top = `${nextNode.y}px`;
    placeholder.style.width = `${nextNode.width}px`;
    placeholder.style.height = `${nextNode.height}px`;
    placeholder.style.zIndex = String(nextNode.zIndex);
    placeholder.title = 'Expanded on screen';
    nextEl.parentElement?.insertBefore(placeholder, nextEl);
    this.expandPlaceholder = placeholder;

    nextEl.classList.add('is-expanded');
    nextEl.style.left = '';
    nextEl.style.top = '';
    nextEl.style.width = '';
    nextEl.style.height = '';
    nextEl.style.zIndex = '';
    this.setExpandButtonMode(nextEl, true);
    this.expandOverlay.appendChild(nextEl);
    this.expandedNodeId = nextId;
    this.selectedNodeId = nextId;
    this.dockInspectorToFullscreen();
    this.syncFullscreenTabs(nextEl, nextId);
    this.layoutNodes();
    this.renderInspector();
    this.drawWires();
    requestAnimationFrame(() => {
      this.notifyNodeViewportResize(prevId);
      this.notifyNodeViewportResize(nextId);
    });
  }

  /**
   * The mesh behind a downstream stage (transform / drape) when it still needs a
   * rebuild — `geometry` is nulled by `invalidateMeshesForPattern`.
   */
  private staleMeshForStage(nodeId: string): MeshDocument | undefined {
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;
    let mesh: MeshDocument | undefined;
    if (node.type === 'transform3d') {
      const transform = this.project.transforms.find((t) => t.id === node.transformId);
      mesh = transform
        ? this.project.meshes.find((m) => m.id === transform.meshId)
        : undefined;
    } else if (node.type === 'simViewport') {
      mesh = this.simChain(node.simId).mesh;
    } else {
      return undefined;
    }
    return mesh && !mesh.geometry ? mesh : undefined;
  }

  /** Downstream stages carry the remesh with them, so catch it up on arrival. */
  private remeshIfStale(nodeId: string): void {
    const mesh = this.staleMeshForStage(nodeId);
    if (!mesh) return;
    this.remesh(mesh.id, { recordUndo: false });
  }

  /** Re-paint the fullscreen pipeline strip (stale markers change live). */
  private refreshFullscreenTabs(): void {
    if (this.splitView) {
      this.renderSplitHeader();
      this.syncSplitBanner();
      return;
    }
    if (!this.expandedNodeId || !this.expandOverlay) return;
    const el = this.expandOverlay.querySelector(
      `[data-node-id="${this.expandedNodeId}"]`
    ) as HTMLElement | null;
    if (el) this.syncFullscreenTabs(el, this.expandedNodeId);
  }

  private setExpandButtonMode(el: HTMLElement, fullscreen: boolean): void {
    const expandBtn = el.querySelector('.node-expand-btn') as HTMLButtonElement | null;
    if (!expandBtn) return;
    if (fullscreen) {
      expandBtn.textContent = '✕';
      expandBtn.title = 'Exit full screen · Esc';
      expandBtn.setAttribute('aria-label', 'Exit full screen');
    } else {
      expandBtn.textContent = '⛶';
      expandBtn.title = 'Open full screen';
      expandBtn.setAttribute('aria-label', 'Open full screen');
    }
  }

  /** Resolve the drape a node ultimately feeds (a pattern may feed several). */
  private drapeNodeFor(nodeId: string): SimViewportNode | undefined {
    const simNode = (simId: string) =>
      this.project.canvas.nodes.find(
        (n): n is SimViewportNode => n.type === 'simViewport' && n.simId === simId
      );
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;
    if (node.type === 'simViewport') return node;

    if (node.type === 'transform3d') {
      const link = this.project.transformSimAssignments.find(
        (a) => a.transformId === node.transformId
      );
      return link ? simNode(link.simId) : undefined;
    }

    if (node.type === 'meshFrame') {
      const viaTransform = this.project.meshTransformAssignments.find(
        (a) => a.meshId === node.meshId
      );
      if (viaTransform) {
        const link = this.project.transformSimAssignments.find(
          (a) => a.transformId === viaTransform.transformId
        );
        if (link) return simNode(link.simId);
      }
      const direct = this.project.assignments.find((a) => a.meshId === node.meshId);
      return direct ? simNode(direct.simId) : undefined;
    }

    if (node.type === 'patternFrame') {
      for (const mesh of this.project.meshes) {
        if (mesh.patternId !== node.patternId) continue;
        const meshNode = this.project.canvas.nodes.find(
          (n) => n.type === 'meshFrame' && n.meshId === mesh.id
        );
        const drape = meshNode ? this.drapeNodeFor(meshNode.id) : undefined;
        if (drape) return drape;
      }
    }
    return undefined;
  }

  /**
   * The stages of the drape this node belongs to, in modifier order:
   * pattern → remesh → transform → drape. Scoped to that one drape, so a shared
   * pattern feeding several drapes does not merge them into one list.
   */
  private pipelineNodesFor(nodeId: string): CanvasNode[] {
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
    const drape = this.drapeNodeFor(nodeId);
    if (!drape) return node ? [node] : [];

    const chain = this.simChain(drape.simId);
    const stage = <T extends CanvasNode['type']>(type: T): CanvasNode | undefined => {
      if (type === 'patternFrame') {
        return this.project.canvas.nodes.find(
          (n) => n.type === 'patternFrame' && n.patternId === chain.pattern?.id
        );
      }
      if (type === 'meshFrame') {
        return this.project.canvas.nodes.find(
          (n) => n.type === 'meshFrame' && n.meshId === chain.mesh?.id
        );
      }
      if (type === 'transform3d') {
        return this.project.canvas.nodes.find(
          (n) => n.type === 'transform3d' && n.transformId === chain.transform?.id
        );
      }
      return drape;
    };

    return [
      stage('patternFrame'),
      stage('meshFrame'),
      stage('transform3d'),
      drape,
    ].filter((n): n is CanvasNode => !!n);
  }

  /**
   * The stages a drape owns internally, walked backwards along the real wiring:
   * drape → transform → mesh → pattern.
   */
  private simChain(simId: string): {
    pattern?: PatternDocument;
    mesh?: MeshDocument;
    transform?: Transform3dInstance;
  } {
    const tLink = this.project.transformSimAssignments.find((a) => a.simId === simId);
    const transform = tLink
      ? this.project.transforms.find((t) => t.id === tLink.transformId)
      : undefined;
    let mesh = transform
      ? (this.project.meshes.find((m) => m.id === transform.meshId) ??
        this.project.meshes.find((m) =>
          this.project.meshTransformAssignments.some(
            (a) => a.transformId === transform.id && a.meshId === m.id
          )
        ))
      : undefined;
    if (!mesh) {
      const link = this.project.assignments.find((a) => a.simId === simId);
      mesh = link ? this.project.meshes.find((m) => m.id === link.meshId) : undefined;
    }
    const pattern = mesh
      ? this.project.patterns.find((p) => p.id === mesh!.patternId)
      : undefined;
    return { pattern, mesh, transform };
  }

  /**
   * True when a remesh / transform node is owned by a drape rather than being a
   * standalone stage on the board. Derived from the wiring, so it can never go
   * stale the way a persisted flag would.
   */
  private isEmbeddedNode(node: CanvasNode): boolean {
    if (node.type !== 'meshFrame' && node.type !== 'transform3d') return false;
    for (const sim of this.project.sims) {
      const chain = this.simChain(sim.id);
      if (node.type === 'meshFrame' && chain.mesh?.id === node.meshId) return true;
      if (node.type === 'transform3d' && chain.transform?.id === node.transformId) return true;
    }
    return false;
  }

  /** Keep the `is-embedded` class in step with the current wiring. */
  private syncEmbeddedNodes(): void {
    for (const node of this.project.canvas.nodes) {
      const el = this.findNodeEl(node.id);
      if (!el) continue;
      el.classList.toggle('is-embedded', this.isEmbeddedNode(node));
    }
    this.drawWires();
  }

  /**
   * Wire a 2D pattern straight into a drape. Remesh and transform are part of
   * the drape, so they are created on demand and never shown on the board.
   * Returns true when a transform stage had to be added.
   */
  private connectPatternToSim(pattern: PatternDocument, sim: SimInstance): boolean {
    const chain = this.simChain(sim.id);
    const created: string[] = [];

    let mesh = chain.mesh;
    if (!mesh) {
      mesh = createMeshDocument(pattern.id, `Mesh ${this.project.meshes.length + 1}`);
      remeshDocument(mesh, pattern);
      this.project.meshes.push(mesh);
      const node: MeshFrameNode = {
        type: 'meshFrame',
        id: uid('node'),
        meshId: mesh.id,
        x: 40,
        y: 40,
        width: DEFAULT_MESH_FRAME_WIDTH,
        height: DEFAULT_MESH_FRAME_HEIGHT,
        zIndex: this.project.canvas.nodes.length + 1,
      };
      this.project.canvas.nodes.push(node);
      this.mountNode(node);
      created.push('remesh');
    }

    mesh.patternId = pattern.id;
    remeshDocument(mesh, pattern);
    for (const [nodeId, preview] of this.meshPreviews) {
      const node = this.project.canvas.nodes.find((c) => c.id === nodeId);
      if (node?.type === 'meshFrame' && node.meshId === mesh.id) preview.setMesh(mesh, pattern);
    }

    let transform = chain.transform;
    let addedTransform = false;
    if (!transform) {
      transform = createTransform3dDocument(
        mesh.id,
        `Transform ${this.project.transforms.length + 1}`
      );
      this.project.transforms.push(transform);
      const node: Transform3dNode = {
        type: 'transform3d',
        id: uid('node'),
        transformId: transform.id,
        x: 40,
        y: 40,
        width: 380,
        height: 320,
        zIndex: this.project.canvas.nodes.length + 1,
      };
      this.project.canvas.nodes.push(node);
      this.mountNode(node);
      created.push('transform');
      addedTransform = true;
    }
    transform.meshId = mesh.id;

    // A drape runs pattern → remesh → transform → drape, so a direct mesh→drape
    // link is replaced by the transform stage.
    this.project.meshTransformAssignments = this.project.meshTransformAssignments.filter(
      (a) => a.transformId !== transform!.id
    );
    this.project.meshTransformAssignments.push({
      id: uid('assign'),
      meshId: mesh.id,
      transformId: transform.id,
    });
    this.project.assignments = this.project.assignments.filter((a) => a.simId !== sim.id);
    this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
      (a) => a.simId !== sim.id
    );
    this.project.transformSimAssignments.push({
      id: uid('assign'),
      transformId: transform.id,
      simId: sim.id,
    });

    this.rebuildConnectedTransform(transform.id);
    this.rebuildConnectedSim(sim.id, true);
    this.syncEmbeddedNodes();
    this.setStatus(
      created.length
        ? `Connected ${pattern.name} → ${sim.name} · added internal ${created.join(' + ')} stage${
            created.length === 1 ? '' : 's'
          }`
        : `Connected ${pattern.name} → ${sim.name}`
    );
    this.renderInspector();
    return addedTransform;
  }

  private pipelineTabLabel(node: CanvasNode): string {
    switch (node.type) {
      case 'patternFrame':
        return `Pattern · ${this.nodeLabel(node)}`;
      case 'meshFrame':
        return `Remesh · ${this.nodeLabel(node)}`;
      case 'transform3d':
        return `Transform · ${this.nodeLabel(node)}`;
      case 'simViewport':
        return `Drape · ${this.nodeLabel(node)}`;
      default:
        return this.nodeLabel(node);
    }
  }

  private syncFullscreenTabs(el: HTMLElement, activeId: string): void {
    const chrome = el.querySelector('.node-chrome');
    const title = el.querySelector('.node-title') as HTMLElement | null;
    const tabs = el.querySelector('.node-fullscreen-tabs') as HTMLElement | null;
    if (!chrome || !tabs) return;

    const pipeline = this.pipelineNodesFor(activeId);
    if (pipeline.length < 2) {
      tabs.hidden = true;
      tabs.innerHTML = '';
      if (title) title.hidden = false;
      return;
    }

    if (title) title.hidden = true;
    tabs.hidden = false;
    // Stroked chips joined by arrows so the chain reads as a run of sequential
    // modifiers: pattern → remesh → transform → drape. A remesh whose pattern
    // moved on since the last build is flagged red.
    tabs.innerHTML = pipeline
      .map((n, i) => {
        const stale =
          n.type === 'meshFrame' &&
          !this.project.meshes.find((m) => m.id === n.meshId)?.geometry;
        const chip = `<button type="button" role="tab" class="node-fullscreen-tab${
          n.id === activeId ? ' is-active' : ''
        }${stale ? ' is-stale' : ''}" data-fs-node="${n.id}" aria-selected="${
          n.id === activeId
        }"${stale ? ' title="Pattern changed since this mesh was built — it rebuilds when you open a later stage"' : ''}>${this.escapeHtml(
          this.pipelineTabLabel(n)
        )}</button>`;
        if (i >= pipeline.length - 1) return chip;
        const link = this.splitLinkHtml();
        // The 2D + 3D split toggle sits where the run leaves the pattern, before
        // the remesh.
        const splitBtn =
          i === 0 && pipeline[0].type === 'patternFrame'
            ? this.splitToggleButtonHtml() + link
            : link;
        return chip + splitBtn;
      })
      .join('');

    tabs.querySelectorAll('button[data-fs-node]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = (btn as HTMLButtonElement).dataset.fsNode;
        if (id) this.switchFullscreenNode(id);
      });
    });
    tabs.querySelector('button[data-fs-split]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleSplitView();
    });

    // The strip scrolls horizontally; make sure the stage you are looking at is
    // the one in view (and that a stage is never clipped out of reach).
    tabs.querySelector('.node-fullscreen-tab.is-active')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }

  private clearFullscreenTabs(el: HTMLElement): void {
    const title = el.querySelector('.node-title') as HTMLElement | null;
    const tabs = el.querySelector('.node-fullscreen-tabs') as HTMLElement | null;
    if (title) title.hidden = false;
    if (tabs) {
      tabs.hidden = true;
      tabs.innerHTML = '';
    }
  }

  // ---------------------------------------------------------------------------
  // Split view: the 2D pattern and one 3D stage side by side.
  // ---------------------------------------------------------------------------

  /** Icon-only toggle that splits the fullscreen into 2D + 3D. */
  private splitToggleButtonHtml(): string {
    const active = this.splitView !== null;
    return `<button type="button" class="node-fullscreen-split-btn${
      active ? ' is-active' : ''
    }" data-fs-split aria-pressed="${active}" title="Split view — 2D pattern beside the 3D stage" aria-label="Toggle split 2D and 3D view"><svg viewBox="0 0 16 14" width="15" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.4" y="1.4" width="13.2" height="11.2" rx="1.4"/><path d="M8 1.4 V 12.6"/></svg></button>`;
  }

  /** The 3D stages of the pipeline, in run order (remesh → transform → drape). */
  private splitStageNodes(pipeline: CanvasNode[]): CanvasNode[] {
    return pipeline.filter(
      (n) => n.type === 'meshFrame' || n.type === 'transform3d' || n.type === 'simViewport'
    );
  }

  private toggleSplitView(): void {
    if (this.splitView) {
      this.exitSplitView();
      return;
    }
    const expandedId = this.expandedNodeId;
    if (!expandedId) return;
    const pipeline = this.pipelineNodesFor(expandedId);
    const pattern = pipeline.find((n) => n.type === 'patternFrame');
    const stages = this.splitStageNodes(pipeline);
    // Splitting from a 3D view keeps that view on the right; the pattern (or a
    // pipeline with no stage to inherit) falls back to the run's first stage.
    const stage = stages.find((n) => n.id === expandedId) ?? stages[0];
    if (!pattern || !stage) return;
    this.enterSplitView(pattern.id, stage.id);
  }

  /**
   * Show the pattern and a 3D stage at once. The pattern stays in the overlay as
   * the active node; the stage is adopted off the board into the right pane. The
   * pattern's own chrome is hoisted to the top of the existing overlay and its
   * chips pick which stage fills the right pane.
   */
  private enterSplitView(patternNodeId: string, stageNodeId: string): void {
    const overlay = this.expandOverlay;
    if (!overlay || this.splitView) return;
    const patternNode = this.canvasNode(patternNodeId);
    const stageNode = this.canvasNode(stageNodeId);
    if (!patternNode || !stageNode) return;

    const patternEl = this.findNodeEl(patternNodeId);
    const stageEl = this.findNodeEl(stageNodeId);
    // The split reuses the expanded node's own chrome as its title bar, so this is
    // the current overlay with its header kept at the top — not a second overlay.
    const chrome = patternEl?.querySelector(':scope > .node-chrome') as HTMLElement | null;
    const stageStack = this.viewportActionStack(stageEl);
    // Everything that can bail out is checked before the first DOM move, so a
    // refusal never leaves the overlay half-built.
    if (!patternEl || !stageEl || !chrome || !stageStack) return;

    this.remeshIfStale(stageNodeId);
    // Whatever was fullscreen goes back on the board first, so both elements we
    // are about to adopt still have their board parents.
    this.restoreExpandedNodeToBoard();

    const banner = document.createElement('div');
    banner.className = 'node-split-banner';
    banner.hidden = true;

    const body = document.createElement('div');
    body.className = 'node-split-body';
    const left = document.createElement('div');
    left.className = 'node-split-pane is-2d';
    const right = document.createElement('div');
    right.className = 'node-split-pane is-3d';

    const patternPlaceholder = this.detachIntoPane(patternEl, patternNode, left);
    const stagePlaceholder = this.detachIntoPane(stageEl, stageNode, right);

    // The warning belongs in the 3D viewport it is talking about, riding above
    // that viewport's floating action bar.
    stageStack.insertBefore(banner, stageStack.firstElementChild);

    body.append(left, right);
    overlay.classList.add('is-split');
    overlay.append(chrome, body);
    this.setExpandButtonMode(chrome, true);

    // The pattern owns the fullscreen lifecycle while split; the stage rides along.
    this.expandedNodeId = patternNodeId;
    this.expandPlaceholder = patternPlaceholder;
    this.splitView = {
      patternNodeId,
      stageNodeId,
      patternPlaceholder,
      stagePlaceholder,
      chrome,
      body,
      stagePane: right,
      banner,
    };
    this.renderSplitHeader();
    this.syncSplitBanner();
    // Seed the 3D selection from whatever is picked in 2D.
    this.syncSplitSelectionFrom2d(this.editors.get(patternNodeId)?.getSelectedPieces() ?? []);
    this.layoutNodes();
    requestAnimationFrame(() => {
      this.notifyNodeViewportResize(patternNodeId);
      this.notifyNodeViewportResize(stageNodeId);
    });
  }

  /** Put the node that is currently fullscreen back on the board. */
  private restoreExpandedNodeToBoard(): void {
    const id = this.expandedNodeId;
    if (id && this.expandPlaceholder) {
      const el = this.findNodeEl(id);
      const node = this.canvasNode(id);
      if (el && node) this.restoreFromPane(el, node, this.expandPlaceholder);
    }
    this.expandedNodeId = null;
    this.expandPlaceholder = null;
  }

  /** Take a node off the board into `pane`, leaving a placeholder behind. */
  private detachIntoPane(
    el: HTMLElement,
    node: CanvasNode,
    pane: HTMLElement
  ): HTMLElement {
    const placeholder = document.createElement('div');
    placeholder.className = `canvas-node-placeholder${
      this.isEmbeddedNode(node) ? ' is-embedded' : ''
    }`;
    placeholder.dataset.nodeId = node.id;
    placeholder.style.left = `${node.x}px`;
    placeholder.style.top = `${node.y}px`;
    placeholder.style.width = `${node.width}px`;
    placeholder.style.height = `${node.height}px`;
    placeholder.style.zIndex = String(node.zIndex);
    el.parentElement?.insertBefore(placeholder, el);

    el.classList.add('is-expanded');
    el.style.left = '';
    el.style.top = '';
    el.style.width = '';
    el.style.height = '';
    el.style.zIndex = '';
    pane.appendChild(el);
    return placeholder;
  }

  /** Put a node back on the board where its placeholder sits. */
  private restoreFromPane(el: HTMLElement, node: CanvasNode, placeholder: HTMLElement): void {
    el.classList.remove('is-expanded');
    // A boarded node carries no fullscreen chrome of its own.
    this.setExpandButtonMode(el, false);
    this.clearFullscreenTabs(el);
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${node.width}px`;
    el.style.height = `${node.height}px`;
    el.style.zIndex = String(node.zIndex);
    placeholder.replaceWith(el);
  }

  /**
   * Leave split mode. The pane you keep becomes the single fullscreen node (the
   * stage by default, so exiting lands you back in 3D); the other returns to the
   * board.
   */
  private exitSplitView(focus: 'stage' | 'pattern' = 'stage'): void {
    const split = this.splitView;
    if (!split || !this.expandOverlay) return;
    const overlay = this.expandOverlay;
    const patternEl = this.findNodeEl(split.patternNodeId);
    const patternNode = this.canvasNode(split.patternNodeId);
    const stageEl = this.findNodeEl(split.stageNodeId);
    const stageNode = this.canvasNode(split.stageNodeId);

    const keepPattern = focus === 'pattern';
    const keepEl = keepPattern ? patternEl : stageEl;
    const keepNode = keepPattern ? patternNode : stageNode;
    const keepId = keepPattern ? split.patternNodeId : split.stageNodeId;
    const keepPlaceholder = keepPattern ? split.patternPlaceholder : split.stagePlaceholder;
    const dropEl = keepPattern ? stageEl : patternEl;
    const dropNode = keepPattern ? stageNode : patternNode;
    const dropPlaceholder = keepPattern ? split.stagePlaceholder : split.patternPlaceholder;

    if (dropEl && dropNode) this.restoreFromPane(dropEl, dropNode, dropPlaceholder);
    else dropPlaceholder.remove();

    // Hand the hoisted title bar back to the pattern it belongs to. Its close
    // button only belongs in fullscreen mode when the pattern is the one kept.
    this.clearFullscreenTabs(split.chrome);
    this.setExpandButtonMode(split.chrome, keepPattern);
    if (patternEl && split.chrome.parentElement !== patternEl) {
      patternEl.insertBefore(split.chrome, patternEl.firstChild);
    }
    split.banner.remove();
    split.body.remove();
    overlay.classList.remove('is-split');

    this.splitView = null;
    if (keepEl && keepNode && keepId) {
      overlay.appendChild(keepEl);
      keepEl.classList.add('is-expanded');
      this.setExpandButtonMode(keepEl, true);
      keepEl.style.left = '';
      keepEl.style.top = '';
      keepEl.style.width = '';
      keepEl.style.height = '';
      keepEl.style.zIndex = '';
      this.expandedNodeId = keepId;
      this.expandPlaceholder = keepPlaceholder;
      this.dockInspectorToFullscreen();
      this.syncFullscreenTabs(keepEl, keepId);
    } else {
      this.expandedNodeId = null;
      this.expandPlaceholder = null;
    }
    this.renderInspector();
    this.layoutNodes();
    requestAnimationFrame(() => {
      this.notifyNodeViewportResize(split.patternNodeId);
      this.notifyNodeViewportResize(split.stageNodeId);
    });
  }

  /** Swap which 3D stage fills the right pane, keeping the pattern in place. */
  private switchSplitStage(nextStageNodeId: string): void {
    const split = this.splitView;
    if (!split || split.stageNodeId === nextStageNodeId) return;
    const prevEl = this.findNodeEl(split.stageNodeId);
    const prevNode = this.canvasNode(split.stageNodeId);
    const nextEl = this.findNodeEl(nextStageNodeId);
    const nextNode = this.canvasNode(nextStageNodeId);
    if (!nextEl || !nextNode) return;

    // The 3D pane outlives the stage it shows, but the warning travels with the
    // action stack of whichever viewport is now on the right.
    const nextStack = this.viewportActionStack(nextEl);
    if (!nextStack) return;

    this.remeshIfStale(nextStageNodeId);
    if (prevEl && prevNode) this.restoreFromPane(prevEl, prevNode, split.stagePlaceholder);
    else split.stagePlaceholder.remove();

    split.stagePlaceholder = this.detachIntoPane(nextEl, nextNode, split.stagePane);
    nextStack.insertBefore(split.banner, nextStack.firstElementChild);
    split.stageNodeId = nextStageNodeId;
    this.renderSplitHeader();
    this.syncSplitBanner();
    this.syncSplitSelectionFrom2d(this.editors.get(split.patternNodeId)?.getSelectedPieces() ?? []);
    this.layoutNodes();
    requestAnimationFrame(() => this.notifyNodeViewportResize(nextStageNodeId));
  }

  /**
   * The run the split's chips describe. A pattern can feed more than one 3D
   * chain, so follow the chain the right pane is actually showing whenever the
   * pattern's default chain does not contain it.
   */
  private splitPipeline(): CanvasNode[] {
    const split = this.splitView;
    if (!split) return [];
    const fromPattern = this.pipelineNodesFor(split.patternNodeId);
    if (fromPattern.some((n) => n.id === split.stageNodeId)) return fromPattern;
    const fromStage = this.pipelineNodesFor(split.stageNodeId);
    return fromStage.some((n) => n.type === 'patternFrame') ? fromStage : fromPattern;
  }

  /** The hoisted title bar's chips: the run's stages, the stage picking the 3D pane. */
  private renderSplitHeader(): void {
    const split = this.splitView;
    if (!split) return;
    const tabs = split.chrome.querySelector('.node-fullscreen-tabs') as HTMLElement | null;
    if (!tabs) return;
    const title = split.chrome.querySelector('.node-title') as HTMLElement | null;
    if (title) title.hidden = true;
    tabs.hidden = false;
    const pipeline = this.splitPipeline();
    tabs.innerHTML = pipeline
      .map((n, i) => {
        const isStage = this.splitStageNodes([n]).length > 0;
        const active = isStage && n.id === split.stageNodeId;
        const stale =
          n.type === 'meshFrame' &&
          !this.project.meshes.find((m) => m.id === n.meshId)?.geometry;
        const chip = `<button type="button" role="tab" class="node-fullscreen-tab${
          active ? ' is-active' : ''
        }${stale ? ' is-stale' : ''}${isStage ? '' : ' is-fixed'}" data-split-node="${n.id}" aria-selected="${active}">${this.escapeHtml(
          this.pipelineTabLabel(n)
        )}</button>`;
        if (i >= pipeline.length - 1) return chip;
        if (n.type === 'patternFrame') {
          return chip + this.splitToggleButtonHtml() + this.splitLinkHtml();
        }
        return chip + this.splitLinkHtml();
      })
      .join('');
    tabs.querySelectorAll('button[data-split-node]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = (btn as HTMLButtonElement).dataset.splitNode;
        if (!id) return;
        const node = this.canvasNode(id);
        if (node && this.splitStageNodes([node]).length > 0) this.switchSplitStage(id);
        else this.exitSplitView();
      });
    });
    tabs.querySelector('button[data-fs-split]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.exitSplitView();
    });
  }

  private splitLinkHtml(): string {
    return `<span class="node-fullscreen-link" aria-hidden="true"><svg viewBox="0 0 26 10" width="26" height="10" fill="none"><path class="node-fullscreen-link-line" d="M0 5 H 17" /><path class="node-fullscreen-link-head" d="M16 2 L 21 5 L 16 8" /></svg></span>`;
  }

  private canvasNode(nodeId: string): CanvasNode | undefined {
    return this.project.canvas.nodes.find((n) => n.id === nodeId);
  }

  /** The mesh behind the split's pattern that still needs a rebuild, if any. */
  private staleMeshForSplit(): MeshDocument | undefined {
    const split = this.splitView;
    if (!split) return undefined;
    const node = this.canvasNode(split.patternNodeId);
    if (node?.type !== 'patternFrame') return undefined;
    return this.project.meshes.find(
      (m) => m.patternId === node.patternId && !m.geometry
    );
  }

  /** Warn, over the split's 3D viewport, that the build behind it is out of date. */
  private syncSplitBanner(): void {
    const split = this.splitView;
    if (!split) return;
    const stale = this.staleMeshForSplit();
    split.banner.hidden = !stale;
    split.stagePane.classList.toggle('is-stale', !!stale);
    if (!stale) {
      split.banner.innerHTML = '';
      return;
    }
    split.banner.innerHTML = `
      <span class="node-split-banner-text">Pattern changed — the 3D build is out of date.</span>
      <button type="button" class="node-split-resync" data-split-resync>Resync 3D</button>
    `;
    split.banner
      .querySelector('button[data-split-resync]')
      ?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.resyncSplit();
      });
  }

  /** Remesh and rebuild every stale mesh behind the split's pattern. */
  private resyncSplit(): void {
    const split = this.splitView;
    if (!split) return;
    const node = this.canvasNode(split.patternNodeId);
    if (node?.type !== 'patternFrame') return;
    this.pushUndo();
    const meshes = this.project.meshes.filter(
      (m) => m.patternId === node.patternId && !m.geometry
    );
    for (const mesh of meshes) this.remesh(mesh.id, { recordUndo: false });
    this.syncSplitBanner();
    this.renderSplitHeader();
    this.renderInspector();
    this.setStatus(
      meshes.length
        ? `Resynced ${meshes.length} mesh${meshes.length === 1 ? '' : 'es'} from the pattern`
        : 'Resynced'
    );
  }

  /** 2D → 3D: mirror the pattern editor's picked pieces onto the 3D stage. */
  private syncSplitSelectionFrom2d(pieceIds: readonly string[]): void {
    const split = this.splitView;
    if (!split || this.splitSelectionSyncing) return;
    const stage = this.canvasNode(split.stageNodeId);
    if (!stage) return;
    this.splitSelectionSyncing = true;
    try {
      if (stage.type === 'simViewport') {
        this.simRuntimes.get(stage.simId)?.setSelectedPieces(pieceIds);
      } else if (stage.type === 'transform3d') {
        this.transformRuntimes.get(stage.transformId)?.setSelectedPieces(pieceIds);
      }
    } finally {
      this.splitSelectionSyncing = false;
    }
  }

  /** 3D → 2D: mirror the stage's piece selection onto the pattern editor. */
  private syncSplitSelectionFrom3d(
    kind: 'simViewport' | 'transform3d',
    entityId: string,
    pieceIds: readonly string[]
  ): void {
    const split = this.splitView;
    if (!split || this.splitSelectionSyncing) return;
    const stage = this.canvasNode(split.stageNodeId);
    // Only the stage that is actually on screen in the split drives the 2D side.
    const matches =
      (kind === 'simViewport' && stage?.type === 'simViewport' && stage.simId === entityId) ||
      (kind === 'transform3d' && stage?.type === 'transform3d' && stage.transformId === entityId);
    if (!matches) return;
    this.splitSelectionSyncing = true;
    try {
      this.editors.get(split.patternNodeId)?.setSelectedPieces(pieceIds);
    } finally {
      this.splitSelectionSyncing = false;
    }
  }

  private notifyNodeViewportResize(nodeId: string): void {
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (node.type === 'simViewport') {
      const rt = this.simRuntimes.get(node.simId);
      // Paused viewports render on demand, so a resize has to ask for a redraw.
      rt?.invalidate();
      rt?.resize();
    } else if (node.type === 'transform3d') {
      const rt = this.transformRuntimes.get(node.transformId);
      rt?.invalidate();
      rt?.resize();
    } else if (node.type === 'patternFrame') {
      this.editors.get(node.id)?.relayoutChrome();
    }
  }

  private beginNodeDrag(node: CanvasNode, e: PointerEvent): void {
    // Secondary buttons belong to the context menu, not to dragging.
    if (e.button !== 0) return;
    if (this.expandedNodeId === node.id) return;
    this.pushUndo();

    let dragTarget = node;
    // Option/Alt-drag: leave the original in place and drag a duplicate
    if (e.altKey) {
      const dup = this.duplicateNode(node.id, {
        offsetX: 0,
        offsetY: 0,
        recordUndo: false,
        select: true,
      });
      if (dup) dragTarget = dup;
    } else {
      this.selectedNodeId = node.id;
      this.renderInspector();
    }

    const zoom = this.project.canvas.zoom;
    this.draggingNode = {
      id: dragTarget.id,
      ox: (e.clientX - this.project.canvas.panX) / zoom - dragTarget.x,
      oy: (e.clientY - this.project.canvas.panY) / zoom - dragTarget.y,
    };
    this.layoutNodes();
    e.preventDefault();
  }

  /**
   * The floating action bar at the bottom middle of a viewport. Created on
   * demand and returned as the `.node-actions` element, so the existing button
   * styling and click handlers still apply.
   */
  private viewportActions(body: HTMLElement): HTMLElement {
    let wrap = body.querySelector(':scope > .node-viewport-actions') as HTMLElement | null;
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'node-viewport-actions';
      const actions = document.createElement('div');
      actions.className = 'node-actions';
      wrap.appendChild(actions);
      body.appendChild(wrap);
    }
    return wrap.querySelector('.node-actions') as HTMLElement;
  }

  /**
   * The bottom-centre action stack of a viewport node. It is a column, so
   * anything added above the bar (the split's stale warning) rides with it.
   */
  private viewportActionStack(nodeEl: HTMLElement | null): HTMLElement | null {
    // A docked inspector wraps the body in `.node-expand-main`.
    const body = nodeEl?.querySelector(
      ':scope > .node-body, :scope > .node-expand-main > .node-body'
    ) as HTMLElement | null;
    if (!body) return null;
    return this.viewportActions(body).parentElement;
  }

  private mountNode(node: CanvasNode): void {
    const el = document.createElement('div');
    // Remesh / transform stages owned by a drape live inside it: they keep their
    // DOM (so the fullscreen tabs can adopt them) but stay off the board.
    el.className = `canvas-node node-${node.type}${
      this.isEmbeddedNode(node) ? ' is-embedded' : ''
    }`;
    el.dataset.nodeId = node.id;
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.width = `${node.width}px`;
    el.style.height = `${node.height}px`;
    el.style.zIndex = String(node.zIndex);

    const body = document.createElement('div');
    body.className = 'node-body';
    let chrome: HTMLElement | null = null;

    // Image refs are chrome-less: drag the image itself (no title / fullscreen).
    if (node.type !== 'image') {
      chrome = document.createElement('div');
      chrome.className = 'node-chrome';
      // Only the close / fullscreen button lives in the header; the node's own
      // actions float at the bottom middle of the viewport (see
      // `viewportActions`) so the top-right stays a single X.
      chrome.innerHTML = `
        <span class="node-title"></span>
        <div class="node-fullscreen-tabs" hidden role="tablist"></div>
        <div class="node-chrome-right">
          <button type="button" class="node-expand-btn" title="Open full screen" aria-label="Open full screen">⛶</button>
        </div>
      `;
      el.appendChild(chrome);
      chrome.querySelector('.node-expand-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openNodeFullscreen(node.id);
      });
      chrome.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        this.beginNodeDrag(node, e);
      });
      // The header always offers the node's own menu, whatever the body does
      // with right-clicks (the pattern editor uses them for piece actions).
      chrome.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showNodeMenu(node, e.clientX, e.clientY);
      });
    } else {
      body.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('.resize-handle')) return;
        this.beginNodeDrag(node, e);
      });
    }

    el.appendChild(body);

    for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
      const handle = document.createElement('div');
      handle.className = `resize-handle resize-${corner}`;
      handle.dataset.corner = corner;
      handle.title = 'Drag to resize';
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectedNodeId = node.id;
        this.pushUndo();
        this.draggingNode = null;
        const zoom = this.project.canvas.zoom;
        this.resizingNode = {
          id: node.id,
          corner,
          startBoardX: (e.clientX - this.project.canvas.panX) / zoom,
          startBoardY: (e.clientY - this.project.canvas.panY) / zoom,
          origX: node.x,
          origY: node.y,
          origW: node.width,
          origH: node.height,
        };
        this.layoutNodes();
        this.renderInspector();
        const wrap = document.getElementById('boardWrap');
        wrap?.setPointerCapture(e.pointerId);
      });
      el.appendChild(handle);
    }

    if (node.type === 'patternFrame') {
      const pattern = this.project.patterns.find((p) => p.id === node.patternId)!;
      chrome!.querySelector('.node-title')!.textContent = `Pattern · ${pattern.name}`;
      const editorHost = document.createElement('div');
      editorHost.className = 'pattern-host';
      body.appendChild(editorHost);
      const editor = new PatternEditor(editorHost, pattern, this.project.displayUnit, {
        onBeforeChange: () => this.pushUndo(),
        onChange: () => {
          this.setStatus('Pattern edited — remesh to update');
          this.invalidateMeshesForPattern(pattern.id);
          // Flag the remesh chip immediately when editing inside fullscreen.
          this.refreshFullscreenTabs();
          // Pattern edits are document data — make sure they reach the file.
          this.markDirty();
        },
        // Rulers are drafting references: they repaint, but never invalidate.
        onRulerChange: () => this.markDirty(),
        getMeasurementLibrary: () => cachedMeasurementLibrary(),
        // Picked pieces drive the split view's 3D half.
        onSelectionChange: (pieceIds) => this.syncSplitSelectionFrom2d(pieceIds),
      });
      this.editors.set(node.id, editor);
    } else if (node.type === 'meshFrame') {
      const mesh = this.project.meshes.find((m) => m.id === node.meshId)!;
      chrome!.querySelector('.node-title')!.textContent = `Mesh · ${mesh.name}`;
      const actions = this.viewportActions(body);
      actions.innerHTML = `<button type="button" data-mesh="remesh">Remesh</button>`;
      actions.addEventListener('click', () => this.remesh(mesh.id));
      const previewHost = document.createElement('div');
      previewHost.className = 'mesh-host';
      body.appendChild(previewHost);
      const pattern = this.project.patterns.find((p) => p.id === mesh.patternId);
      if (!mesh.geometry) remeshDocument(mesh, pattern);
      const preview = new MeshPreview(previewHost, mesh, this.project.displayUnit, pattern ?? null);
      this.meshPreviews.set(node.id, preview);
    } else if (node.type === 'simViewport') {
      const sim = this.project.sims.find((s) => s.id === node.simId)!;
      chrome!.querySelector('.node-title')!.textContent = `Sim · ${sim.name}`;
      const actions = this.viewportActions(body);
      const strainOn = this.simRuntimes.get(sim.id)?.isStrainMapEnabled() ?? false;
      actions.innerHTML = `
        <button type="button" data-sim="activate">Play</button>
        <button type="button" data-sim="pause">Pause</button>
        <button type="button" data-sim="reset">Reset</button>
        <button type="button" data-sim="rebuild">Rebuild</button>
        <button type="button" data-sim="snap">Snapshot</button>
        <button type="button" data-sim="strain" class="sim-strain-btn${strainOn ? ' is-on' : ''}" title="Toggle fabric strain map (blue=compress, green=rest, red=stretch)" aria-pressed="${strainOn}">Strain</button>
      `;
      actions.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button[data-sim]') as HTMLButtonElement | null;
        if (!b) return;
        void this.onSimAction(node.simId, b.dataset.sim!);
      });
      const canvas = document.createElement('canvas');
      canvas.className = 'sim-canvas';
      body.classList.add('sim-body');
      body.appendChild(canvas);
      // runtime attached after GPU init
      (el as HTMLElement & { _simCanvas?: HTMLCanvasElement; _simHost?: HTMLElement })._simCanvas =
        canvas;
      (el as HTMLElement & { _simHost?: HTMLElement })._simHost = body;
    } else if (node.type === 'transform3d') {
      const transform = this.project.transforms.find((t) => t.id === node.transformId)!;
      chrome!.querySelector('.node-title')!.textContent = `Transform 3D · ${transform.name}`;
      const actions = this.viewportActions(body);
      actions.innerHTML = `
        <button type="button" data-transform="reset">Reset layout</button>
        <button type="button" data-transform="rebuild">Rebuild</button>
      `;
      actions.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button[data-transform]') as HTMLButtonElement | null;
        if (!b) return;
        void this.onTransformAction(node.transformId, b.dataset.transform!);
      });
      const canvas = document.createElement('canvas');
      canvas.className = 'sim-canvas';
      body.classList.add('sim-body');
      body.appendChild(canvas);
      (el as HTMLElement & { _transformCanvas?: HTMLCanvasElement; _transformHost?: HTMLElement })._transformCanvas =
        canvas;
      (el as HTMLElement & { _transformHost?: HTMLElement })._transformHost = body;
    } else if (node.type === 'image') {
      const img = document.createElement('img');
      img.alt = node.label || 'image reference';
      img.draggable = false;
      if (node.src) {
        img.src = node.src;
      } else {
        // Never leave a bare `<img>` with no source: the browser paints nothing,
        // so a reference whose bytes went missing read as a dead node. The board
        // inspector is only shown in fullscreen, so the note carries its own way
        // back rather than pointing at a panel that is not there.
        img.hidden = true;
        const note = document.createElement('div');
        note.className = 'image-missing';
        note.innerHTML =
          '<strong>Image data missing</strong>' +
          '<span>The stored copy of this reference was lost.</span>' +
          '<button type="button" class="image-missing-relink">Re-link image…</button>';
        body.appendChild(note);
        const relink = note.querySelector('.image-missing-relink') as HTMLButtonElement;
        // The node body starts a drag on pointerdown; the button is not a drag.
        relink.addEventListener('pointerdown', (e) => e.stopPropagation());
        relink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.pickImageFile(node);
        });
      }
      body.appendChild(img);
      // Fill in aspect from the decoded image when missing (older snapshots).
      if (node.naturalAspect == null || !(node.naturalAspect > 0)) {
        img.addEventListener(
          'load',
          () => {
            const nw = img.naturalWidth;
            const nh = img.naturalHeight;
            if (nw > 0 && nh > 0) node.naturalAspect = nw / nh;
          },
          { once: true }
        );
      }
    } else if (node.type === 'text') {
      chrome!.querySelector('.node-title')!.textContent = 'Note';
      const ta = document.createElement('textarea');
      ta.value = node.text;
      ta.addEventListener('input', () => {
        node.text = ta.value;
      });
      body.appendChild(ta);
    }

    this.mountNodePorts(el, node);
    this.board.appendChild(el);
  }

  private mountNodePorts(el: HTMLElement, node: CanvasNode): void {
    const addPort = (
      direction: 'in' | 'out',
      kind: 'pattern' | 'mesh' | 'transform' | 'sim',
      entityId: string
    ) => {
      const port = document.createElement('button');
      port.type = 'button';
      port.className = `node-port node-port-${direction}`;
      port.dataset.portDirection = direction;
      port.dataset.portKind = kind;
      port.dataset.entityId = entityId;
      port.dataset.nodeId = node.id;
      port.title =
        direction === 'out'
          ? `Drag ${kind} output to a compatible input`
          : `Drop a compatible connection on this ${kind} input`;
      port.setAttribute('aria-label', `${kind} ${direction === 'out' ? 'output' : 'input'} port`);

      if (direction === 'out' && kind !== 'sim') {
        port.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          this.beginWireDrag(
            { kind, id: entityId, nodeId: node.id },
            e.pointerId
          );
        });
      }
      el.appendChild(port);
    };

    if (node.type === 'patternFrame') {
      addPort('out', 'pattern', node.patternId);
    } else if (node.type === 'meshFrame') {
      addPort('in', 'mesh', node.meshId);
      addPort('out', 'mesh', node.meshId);
    } else if (node.type === 'transform3d') {
      addPort('in', 'mesh', node.transformId);
      addPort('out', 'transform', node.transformId);
    } else if (node.type === 'simViewport') {
      addPort('in', 'sim', node.simId);
      const port = el.querySelector('.node-port-in') as HTMLElement | null;
      if (port) {
        port.title =
          'Drop a pattern (or a mesh / transform) here — the remesh and transform stages live inside this drape';
      }
    }
  }

  private async initGpuAndSims(): Promise<void> {
    const generation = this.gpuInitGeneration;
    const stillCurrent = (): boolean => generation === this.gpuInitGeneration;

    try {
      if (!this.device) {
        const gpu = await createSharedGpu();
        if (!stillCurrent()) return;
        this.device = gpu.device;
      }
      if (!this.environment) {
        // The constructor already starts the saved HDRI (or the neutral studio
        // probe); this only reports a failure to load it.
        this.environment = new Environment(this.device, navigator.gpu.getPreferredCanvasFormat());
        const settings = loadEnvironmentSettings();
        if (settings.hdri) {
          void this.environment.whenIdle().catch((error: unknown) => {
            this.setStatus(
              `Could not load HDRI “${settings.hdri}”${error instanceof Error ? `: ${error.message}` : ''}`
            );
          });
        }
      }
    } catch (err) {
      if (!stillCurrent()) return;
      this.setStatus(`WebGPU unavailable: ${err}`);
      return;
    }

    for (const node of this.project.canvas.nodes) {
      if (!stillCurrent()) return;
      if (node.type !== 'simViewport') continue;
      const el = this.findNodeEl(node.id) as (HTMLElement & {
        _simCanvas?: HTMLCanvasElement;
        _simHost?: HTMLElement;
      }) | null;
      const canvas = el?._simCanvas;
      const host = el?._simHost ?? el ?? null;
      const sim = this.project.sims.find((s) => s.id === node.simId);
      if (!el || !canvas || !host || !sim) continue;

      const existingSim = this.simRuntimes.get(sim.id);
      if (existingSim) {
        existingSim.dispose();
        this.simRuntimes.delete(sim.id);
      }

      const runtime = new SimViewportRuntime(
        sim.id,
        canvas,
        host,
        this.device,
        sim,
        getDefaultSimCamera(this.project),
        {
          onApplyPatternEdit: (patternId, edited) =>
            this.applyPatternPointEdit(patternId, edited),
          onSelectionChange: (pieceIds) =>
            this.syncSplitSelectionFrom3d('simViewport', sim.id, pieceIds),
          environment: this.environment,
          materials: this.materials,
          onSewEdges: (a, b) => this.sewEdgesFromView(this.patternForSim(sim.id), a, b),
          onReverseSeam: (seamId) => this.reverseSeamFromView(this.patternForSim(sim.id), seamId),
          onDeleteSeam: (seamId) => this.deleteSeamFromView(this.patternForSim(sim.id), seamId),
          onBeforeFreezeChange: () => this.pushUndo(),
          onFreezeChange: (pieceId, frozen) => {
            this.markDirty();
            const name = this.patternForSim(sim.id)?.pieces.find(
              (p) => p.id === pieceId
            )?.name;
            const label = name?.trim() || 'piece';
            this.setStatus(
              frozen
                ? `Froze ${label} — it holds its shape while the rest drapes`
                : `Unfroze ${label}`
            );
          },
        }
      );
      await runtime.initRenderer();
      if (!stillCurrent()) {
        runtime.dispose();
        return;
      }
      runtime.rebuildCloth(
        this.meshGeometryForSim(sim.id),
        sim.params,
        this.poseForSim(sim.id),
        this.patternForSim(sim.id)
      );
      this.simRuntimes.set(sim.id, runtime);
    }

    for (const node of this.project.canvas.nodes) {
      if (!stillCurrent()) return;
      if (node.type !== 'transform3d') continue;
      const el = this.findNodeEl(node.id) as (HTMLElement & {
        _transformCanvas?: HTMLCanvasElement;
        _transformHost?: HTMLElement;
      }) | null;
      const canvas = el?._transformCanvas;
      const host = el?._transformHost ?? el ?? null;
      const transform = this.project.transforms.find((t) => t.id === node.transformId);
      if (!el || !canvas || !host || !transform) continue;

      const existingTransform = this.transformRuntimes.get(transform.id);
      if (existingTransform) {
        existingTransform.dispose();
        this.transformRuntimes.delete(transform.id);
      }

      const runtime = new Transform3dRuntime(
        transform.id,
        canvas,
        host,
        this.device,
        transform,
        getDefaultSimCamera(this.project),
        {
          onBeforePoseChange: () => this.pushUndo(),
          onPoseChange: () => {
            // Ignore the write-back that `persistSimStates()` performs.
            if (this.restoringUndo || this.capturingState) return;
            this.rebuildSimsFromTransform(transform.id);
            if (this.selectedNodeId === node.id) this.renderInspector();
            // Transform settings are document data — make sure they reach the file.
            this.markDirty();
          },
          onSelectionChange: (pieceIds, primary) => {
            this.transformInspectorPieceId = primary;
            this.syncSplitSelectionFrom3d('transform3d', transform.id, pieceIds);
            if (this.selectedNodeId === node.id) this.renderInspector();
          },
          environment: this.environment,
          materials: this.materials,
          onSewEdges: (a, b) => this.sewEdgesFromView(this.patternForTransform(transform.id), a, b),
          onReverseSeam: (seamId) =>
            this.reverseSeamFromView(this.patternForTransform(transform.id), seamId),
          onDeleteSeam: (seamId) =>
            this.deleteSeamFromView(this.patternForTransform(transform.id), seamId),
        }
      );
      await runtime.initRenderer();
      if (!stillCurrent()) {
        runtime.dispose();
        return;
      }
      runtime.rebuildCloth(
        this.meshGeometryForTransform(transform.id),
        transform.pose,
        transform.pieceTransforms,
        this.patternForTransform(transform.id)
      );
      this.transformRuntimes.set(transform.id, runtime);
    }

    if (!stillCurrent()) return;

    cancelAnimationFrame(this.raf);
    const loop = () => {
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.layoutNodes();
    this.setStatus('Ready — Pattern → Mesh → Transform 3D → Sim');
    // Re-asserted here because the pipeline line above is rewritten whenever the
    // board redraws, and lost image bytes are not something to let scroll away.
    this.reportMissingImages();
  }

  private teardownSims(): void {
    cancelAnimationFrame(this.raf);
    for (const rt of this.simRuntimes.values()) {
      rt.cloth?.destroy();
    }
    for (const rt of this.transformRuntimes.values()) {
      rt.cloth?.destroy();
    }
    this.simRuntimes.clear();
    this.transformRuntimes.clear();
  }

  private transformForSim(simId: string) {
    const link = this.project.transformSimAssignments.find((a) => a.simId === simId);
    if (!link) return undefined;
    return this.project.transforms.find((t) => t.id === link.transformId);
  }

  private meshForTransform(transformId: string): MeshDocument | undefined {
    const transform = this.project.transforms.find((t) => t.id === transformId);
    if (!transform) return undefined;
    const link = this.project.meshTransformAssignments.find((a) => a.transformId === transformId);
    const meshId = link?.meshId ?? transform.meshId;
    return this.project.meshes.find((m) => m.id === meshId);
  }

  private patternForTransform(transformId: string): PatternDocument | undefined {
    const mesh = this.meshForTransform(transformId);
    if (!mesh) return this.project.patterns[0];
    return this.project.patterns.find((p) => p.id === mesh.patternId);
  }

  private meshGeometryForTransform(transformId: string) {
    const mesh = this.meshForTransform(transformId);
    if (!mesh) return null;
    const pattern = this.project.patterns.find((p) => p.id === mesh.patternId);
    if (
      !mesh.geometry ||
      mesh.geometry.vertexPieceIds?.length !== mesh.geometry.vertices.length
    ) {
      remeshDocument(mesh, pattern);
    }
    return mesh.geometry;
  }

  private poseForSim(simId: string) {
    const transform = this.transformForSim(simId);
    if (transform?.pose) return transform.pose;
    const sim = this.project.sims.find((s) => s.id === simId);
    return sim?.pose ?? null;
  }

  private rebuildSimsFromTransform(transformId: string): void {
    for (const link of this.project.transformSimAssignments.filter(
      (a) => a.transformId === transformId
    )) {
      this.rebuildConnectedSim(link.simId, false);
    }
  }

  private onTransformAction(transformId: string, action: string): void {
    const transform = this.project.transforms.find((t) => t.id === transformId);
    const rt = this.transformRuntimes.get(transformId);
    if (!transform || !rt) return;

    switch (action) {
      case 'reset':
        // resetLayout snapshots undo via onBeforePoseChange
        rt.resetLayout();
        this.rebuildSimsFromTransform(transformId);
        this.setStatus('Transform layout reset to default arrangement (-90° X)');
        break;
      case 'rebuild':
        this.pushUndo();
        rt.rebuildCloth(
          this.meshGeometryForTransform(transformId),
          transform.pose,
          transform.pieceTransforms,
          this.patternForTransform(transformId)
        );
        this.rebuildSimsFromTransform(transformId);
        this.setStatus('Transform viewport rebuilt from mesh');
        break;
    }
    this.renderInspector();
  }

  private rebuildConnectedTransform(transformId: string): void {
    const transform = this.project.transforms.find((t) => t.id === transformId);
    if (!transform) return;
    if (!transform.pieceTransforms) transform.pieceTransforms = {};
    const runtime = this.transformRuntimes.get(transformId);
    // Vertex pose cannot transfer across remesh; pieceTransforms can.
    // Snapshot before rebuild so a second linked rebuild can't persist a
    // already-reset layout (duplicate mesh→transform assignments).
    if (runtime) {
      runtime.persistArrangement();
    }
    const savedPieceTransforms = structuredClone(transform.pieceTransforms);
    transform.pose = null;
    if (!runtime) {
      transform.pieceTransforms = savedPieceTransforms;
      return;
    }
    runtime.rebuildCloth(
      this.meshGeometryForTransform(transformId),
      null,
      savedPieceTransforms,
      this.patternForTransform(transformId)
    );
    this.rebuildSimsFromTransform(transformId);
  }

  private meshForSim(simId: string): MeshDocument | undefined {
    const transform = this.transformForSim(simId);
    if (transform) {
      return this.meshForTransform(transform.id);
    }
    const a = this.project.assignments.find((x) => x.simId === simId);
    if (!a) return this.project.meshes[0];
    return this.project.meshes.find((m) => m.id === a.meshId);
  }

  private patternForSim(simId: string): PatternDocument | undefined {
    const mesh = this.meshForSim(simId);
    if (!mesh) return this.project.patterns[0];
    return this.project.patterns.find((p) => p.id === mesh.patternId);
  }

  private meshGeometryForSim(simId: string) {
    const mesh = this.meshForSim(simId);
    if (!mesh) return null;
    const pattern = this.project.patterns.find((p) => p.id === mesh.patternId);
    // Older saved/generated meshes predate per-vertex piece ownership. Rebuild
    // them automatically so individual panel picking works immediately.
    if (
      !mesh.geometry ||
      mesh.geometry.vertexPieceIds?.length !== mesh.geometry.vertices.length
    ) {
      remeshDocument(mesh, pattern);
    }
    return mesh.geometry;
  }

  private remesh(meshId: string, opts: { recordUndo?: boolean } = {}): void {
    const mesh = this.project.meshes.find((m) => m.id === meshId);
    if (!mesh) return;
    if (opts.recordUndo !== false) this.pushUndo();
    const pattern = this.project.patterns.find((p) => p.id === mesh.patternId);
    remeshDocument(mesh, pattern);
    for (const [nodeId, preview] of this.meshPreviews) {
      const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
      if (node?.type === 'meshFrame' && node.meshId === meshId) {
        preview.setMesh(mesh, pattern ?? null);
      }
    }
    this.setStatus(`Remeshed ${mesh.name}`);
    // Dedupe: duplicate mesh→transform links used to rebuild twice and lock in a reset.
    const transformIds = new Set<string>();
    for (const link of this.project.meshTransformAssignments) {
      if (link.meshId === meshId) transformIds.add(link.transformId);
    }
    for (const transform of this.project.transforms) {
      if (transform.meshId === meshId) transformIds.add(transform.id);
    }
    for (const transformId of transformIds) {
      this.rebuildConnectedTransform(transformId);
    }
    for (const a of this.project.assignments.filter((x) => x.meshId === meshId)) {
      this.rebuildConnectedSim(a.simId, true);
    }
    this.renderInspector();
  }

  /**
   * Commit a point edit made in the drape viewport's overlay: snapshot for undo,
   * swap in the edited pieces (point IDs are preserved so seams stay valid), then
   * remesh every dependent mesh — which rebuilds the transforms and the drape.
   */
  private applyPatternPointEdit(patternId: string, edited: PatternDocument): void {
    const target = this.project.patterns.find((p) => p.id === patternId);
    if (!target) return;
    this.pushUndo();
    target.pieces = edited.pieces;
    for (const node of this.project.canvas.nodes) {
      if (node.type !== 'patternFrame' || node.patternId !== patternId) continue;
      this.editors.get(node.id)?.setPattern(target);
    }
    const meshes = this.project.meshes.filter((m) => m.patternId === patternId);
    for (const mesh of meshes) {
      this.remesh(mesh.id, { recordUndo: false });
    }
    this.setStatus(
      meshes.length
        ? `Pattern point edit applied — remeshed ${meshes.length} mesh${meshes.length === 1 ? '' : 'es'}`
        : 'Pattern point edit applied'
    );
  }

  /**
   * Sew two cloth edges picked in a 3D viewport.
   *
   * The viewport knows ids and spans; the document, the undo snapshot and the
   * remesh belong to the app. Seams are not decoration — the mesher forces a
   * shared sample count along a sewn edge so stitch pairing is exact, so the
   * mesh has to be rebuilt for the seam to appear at all. The layout survives
   * that: a remesh keeps `pieceTransforms` and only drops the vertex pose.
   */
  private sewEdgesFromView(
    pattern: PatternDocument | null | undefined,
    a: SeamEdgeRef,
    b: SeamEdgeRef
  ): void {
    if (!pattern) return;
    if (pattern.seams.some((seam) => sameSeamBindingPair(seam.a, seam.b, a, b))) return;
    this.pushUndo();
    pattern.seams.push({ id: uid('seam'), a, b, restGapCm: DEFAULT_SEAM_GAP_CM });
    this.commitSeamEdit(pattern, 'Sewed two cloth edges');
  }

  /**
   * Turn a seam end for end, so its two sides are read the same way round.
   *
   * Which end of an edge meets which is decided by direction, and on a mirrored
   * piece "the same way" is not the way it looks — this is the correction. Same
   * operation as the pattern editor's seam menu, reached from the cloth instead.
   */
  private reverseSeamFromView(
    pattern: PatternDocument | null | undefined,
    seamId: string
  ): void {
    const seam = pattern?.seams.find((s) => s.id === seamId);
    if (!pattern || !seam) return;
    this.pushUndo();
    const t0 = seam.b.t0;
    seam.b.t0 = seam.b.t1;
    seam.b.t1 = t0;
    this.commitSeamEdit(pattern, 'Reversed the seam direction');
  }

  /** Drop a seam chosen from a 3D viewport's edge popover, then remesh. */
  private deleteSeamFromView(
    pattern: PatternDocument | null | undefined,
    seamId: string
  ): void {
    if (!pattern) return;
    const index = pattern.seams.findIndex((seam) => seam.id === seamId);
    if (index < 0) return;
    this.pushUndo();
    pattern.seams.splice(index, 1);
    this.commitSeamEdit(pattern, 'Deleted the seam');
  }

  private commitSeamEdit(pattern: PatternDocument, status: string): void {
    for (const node of this.project.canvas.nodes) {
      if (node.type !== 'patternFrame' || node.patternId !== pattern.id) continue;
      this.editors.get(node.id)?.setPattern(pattern);
    }
    const meshes = this.project.meshes.filter((m) => m.patternId === pattern.id);
    for (const mesh of meshes) {
      this.remesh(mesh.id, { recordUndo: false });
    }
    this.markDirty();
    this.setStatus(
      meshes.length
        ? `${status} — remeshed ${meshes.length} mesh${meshes.length === 1 ? '' : 'es'}`
        : `${status} — remesh to update the drape`
    );
    this.renderInspector();
  }

  private invalidateMeshesForPattern(patternId: string): void {
    const pattern = this.project.patterns.find((p) => p.id === patternId);
    for (const mesh of this.project.meshes) {
      if (mesh.patternId === patternId) mesh.geometry = null;
    }
    for (const [nodeId, preview] of this.meshPreviews) {
      const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
      if (node?.type !== 'meshFrame') continue;
      const mesh = this.project.meshes.find((m) => m.id === node.meshId);
      if (mesh?.patternId === patternId) preview.setMesh(mesh, pattern ?? null);
    }
  }

  private tick(): void {
    const active = this.project.activeSimId;
    for (const [simId, rt] of this.simRuntimes) {
      rt.frame(simId === active, this.viewportIsVisible('simViewport', simId));
    }
    for (const [transformId, rt] of this.transformRuntimes) {
      rt.frame(this.viewportIsVisible('transform3d', transformId));
    }
  }

  /**
   * Whether a viewport is on screen. A fullscreen stage covers the board, so the
   * stages behind it must not keep rendering — that is continuous GPU work for
   * something nobody can see, and it is what made interaction feel sluggish on
   * slower compositors. The split view shows its two panes only.
   */
  private viewportIsVisible(
    type: 'simViewport' | 'transform3d',
    id: string
  ): boolean {
    const expanded = this.expandedNodeId;
    if (!expanded && !this.splitView) return true;
    const visibleId = (nodeId: string): boolean => {
      if (this.splitView) {
        return nodeId === this.splitView.patternNodeId || nodeId === this.splitView.stageNodeId;
      }
      return nodeId === expanded;
    };
    const node = this.project.canvas.nodes.find((n) =>
      type === 'simViewport'
        ? n.type === 'simViewport' && n.simId === id
        : n.type === 'transform3d' && n.transformId === id
    );
    // A runtime with no node of its own cannot be judged — keep drawing it.
    return node ? visibleId(node.id) : true;
  }

  private persistTransformStates(): void {
    for (const transform of this.project.transforms) {
      const rt = this.transformRuntimes.get(transform.id);
      if (!rt?.cloth) continue;
      rt.captureCamera(transform);
      rt.persistArrangement();
    }
  }

  /** Sync live sim/transform state into the project before recording undo/redo. */
  private snapshotProjectForHistory(): void {
    this.persistTransformStates();
    for (const sim of this.project.sims) {
      const rt = this.simRuntimes.get(sim.id);
      if (!rt?.cloth) continue;
      rt.captureCamera(sim);
      sim.pose = rt.cloth.exportPose();
      sim.dropped = true;
    }
    syncDefaultCameraFromDrapeA(this.project);
  }

  /**
   * Capture the current live camera for every mounted viewport. Camera moves and
   * zooms are view state, so this is used to keep the user's view fixed while
   * undo/redo restores the document.
   */
  private captureLiveCameras(): CameraSnapshot {
    const transforms = new Map<string, SimCameraState>();
    const sims = new Map<string, SimCameraState>();
    for (const transform of this.project.transforms) {
      const rt = this.transformRuntimes.get(transform.id);
      if (!rt?.cloth) continue;
      rt.captureCamera(transform);
      transforms.set(transform.id, cloneSimCamera(transform.camera));
    }
    for (const sim of this.project.sims) {
      const rt = this.simRuntimes.get(sim.id);
      if (!rt?.cloth) continue;
      rt.captureCamera(sim);
      sims.set(sim.id, cloneSimCamera(sim.camera));
    }
    const board = {
      panX: this.project.canvas.panX,
      panY: this.project.canvas.panY,
      zoom: this.project.canvas.zoom,
    };
    const patterns = new Map<string, PatternViewBox>();
    for (const node of this.project.canvas.nodes) {
      if (node.type !== 'patternFrame') continue;
      const editor = this.editors.get(node.id);
      if (editor) patterns.set(node.id, editor.getViewBox());
    }
    return { transforms, sims, board, patterns };
  }

  /** Restore the captured cameras onto a freshly loaded history snapshot. */
  private applyLiveCameras(snapshot: CameraSnapshot): void {
    for (const transform of this.project.transforms) {
      const cam = snapshot.transforms.get(transform.id);
      if (cam) transform.camera = cloneSimCamera(cam);
    }
    for (const sim of this.project.sims) {
      const cam = snapshot.sims.get(sim.id);
      if (cam) sim.camera = cloneSimCamera(cam);
    }
    // The board's pan/zoom rides in the document, so the freshly loaded snapshot
    // would otherwise snap the canvas back to where it was at that edit.
    this.project.canvas.panX = snapshot.board.panX;
    this.project.canvas.panY = snapshot.board.panY;
    this.project.canvas.zoom = snapshot.board.zoom;
    this.applyBoardTransform();
  }

  /** Push the preserved cameras onto live runtimes verbatim (no migration). */
  private applyLiveCamerasToRuntimes(snapshot: CameraSnapshot): void {
    for (const transform of this.project.transforms) {
      const cam = snapshot.transforms.get(transform.id);
      if (cam) this.transformRuntimes.get(transform.id)?.setCameraState(cam);
    }
    for (const sim of this.project.sims) {
      const cam = snapshot.sims.get(sim.id);
      if (cam) this.simRuntimes.get(sim.id)?.setCameraState(cam);
    }
    // Pattern editors are recreated (and re-framed) on a remount, so re-assert
    // each one's captured zoom/pan after the runtimes have been rebuilt.
    for (const node of this.project.canvas.nodes) {
      if (node.type !== 'patternFrame') continue;
      const box = snapshot.patterns.get(node.id);
      if (box) this.editors.get(node.id)?.setViewBox(box);
    }
  }

  /**
   * True while live viewport state is being copied into the document. The
   * runtimes report those copies as pose changes, and re-acting to them would
   * rebuild sims mid-save and re-schedule the save we are already running.
   */
  private capturingState = false;

  private persistSimStates(): void {
    const previous = this.capturingState;
    this.capturingState = true;
    try {
      this.persistTransformStates();
      for (const sim of this.project.sims) {
        const rt = this.simRuntimes.get(sim.id);
        if (!rt?.cloth) continue;
        rt.captureCamera(sim);
        sim.pose = rt.cloth.exportPose();
        sim.dropped = true;
      }
      syncDefaultCameraFromDrapeA(this.project);
      const defaults = getDefaultSimCamera(this.project);
      for (const rt of this.simRuntimes.values()) {
        rt.setDefaultCamera(defaults);
      }
    } finally {
      this.capturingState = previous;
    }
  }

  private async onSimAction(simId: string, action: string): Promise<void> {
    const sim = this.project.sims.find((s) => s.id === simId);
    const rt = this.simRuntimes.get(simId);
    if (!sim || !rt) return;

    switch (action) {
      case 'activate':
        if (this.project.activeSimId && this.project.activeSimId !== simId) {
          this.pauseSim(this.project.activeSimId);
        }
        this.project.activeSimId = simId;
        sim.dropped = true;
        this.setStatus(`Active: ${sim.name} — drag fabric to move · empty drag to orbit`);
        break;
      case 'pause':
        this.pauseSim(simId);
        if (this.project.activeSimId === simId) this.project.activeSimId = null;
        this.setStatus(`Paused: ${sim.name}`);
        break;
      case 'reset':
        rt.cloth?.resetToInitialState();
        sim.pose = null;
        // Reset returns every piece to its rest layout, so nothing stays frozen.
        delete sim.frozenPieces;
        this.setStatus(`Reset: ${sim.name}`);
        break;
      case 'rebuild':
        this.persistSimStates();
        const initialPose = this.poseForSim(simId);
        sim.pose = initialPose;
        sim.dropped = true;
        rt.rebuildCloth(
          this.meshGeometryForSim(simId),
          sim.params,
          initialPose,
          this.patternForSim(simId)
        );
        this.setStatus(
          initialPose ? 'Drape rebuilt from Transform 3D layout' : 'Drape rebuilt from mesh node'
        );
        break;
      case 'snap':
        await this.snapshotSim(simId);
        break;
      case 'strain': {
        const next = !rt.isStrainMapEnabled();
        rt.setStrainMapEnabled(next);
        const node = this.project.canvas.nodes.find(
          (n) => n.type === 'simViewport' && n.simId === simId
        );
        if (node) {
          const strainBtn = this.findNodeEl(node.id)?.querySelector(
            'button[data-sim="strain"]'
          ) as HTMLButtonElement | null;
          if (strainBtn) {
            strainBtn.classList.toggle('is-on', next);
            strainBtn.setAttribute('aria-pressed', String(next));
          }
        }
        this.setStatus(
          next
            ? 'Strain map on — blue compress · green rest · red stretch'
            : 'Strain map off'
        );
        break;
      }
    }
    this.layoutNodes();
    this.renderInspector();
  }

  private pauseSim(simId: string): void {
    const sim = this.project.sims.find((s) => s.id === simId);
    const rt = this.simRuntimes.get(simId);
    if (!sim || !rt?.cloth) return;
    rt.captureCamera(sim);
    sim.pose = rt.cloth.exportPose();
    sim.dropped = true;
  }

  private async snapshotSim(simId: string): Promise<void> {
    const rt = this.simRuntimes.get(simId);
    const sim = this.project.sims.find((s) => s.id === simId);
    if (!rt || !sim) return;
    const src = await rt.snapshotDataUrl();
    const node: ImageNode = {
      type: 'image',
      id: uid('node'),
      x: 980,
      y: 80 + this.project.canvas.nodes.filter((n) => n.type === 'image').length * 40,
      width: 280,
      height: 200,
      zIndex: 50 + this.project.canvas.nodes.length,
      src,
      label: `Snapshot · ${sim.name}`,
      naturalAspect: 280 / 200,
    };
    void this.loadImageNaturalSize(src)
      .then(({ w, h }) => {
        node.naturalAspect = w / h;
      })
      .catch(() => {
        /* keep fallback aspect */
      });
    this.project.canvas.nodes.push(node);
    this.mountNode(node);
    this.drawWires();
    this.setStatus('Snapshot placed on canvas');
  }

  private nodePortPoint(
    node: { x: number; y: number; width: number; height: number },
    direction: 'in' | 'out'
  ): { x: number; y: number } {
    const { panX, panY, zoom } = this.project.canvas;
    return {
      x: panX + (node.x + (direction === 'out' ? node.width : 0)) * zoom,
      y: panY + (node.y + node.height / 2) * zoom,
    };
  }

  private appendWirePath(
    from: { x: number; y: number },
    to: { x: number; y: number },
    className: string
  ): void {
    const pull = Math.max(48, Math.abs(to.x - from.x) * 0.5);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      `M ${from.x} ${from.y} C ${from.x + pull} ${from.y}, ${to.x - pull} ${to.y}, ${to.x} ${to.y}`
    );
    path.setAttribute('class', className);
    this.wiresSvg.appendChild(path);
  }

  private beginWireDrag(source: WireSource, pointerId: number): void {
    const node = this.project.canvas.nodes.find((candidate) => candidate.id === source.nodeId);
    if (!node) return;
    const start = this.nodePortPoint(node, 'out');
    this.wireDrag = { ...source, pointerId, x: start.x, y: start.y };
    const wrap = document.getElementById('boardWrap');
    wrap?.setPointerCapture(pointerId);
    wrap?.classList.add('is-wiring');
    this.drawWires();
  }

  private isMeshFrameInput(target: HTMLElement): boolean {
    const node = this.project.canvas.nodes.find((n) => n.id === target.dataset.nodeId);
    return node?.type === 'meshFrame';
  }

  private isTransformInput(target: HTMLElement): boolean {
    const node = this.project.canvas.nodes.find((n) => n.id === target.dataset.nodeId);
    return node?.type === 'transform3d';
  }

  private isValidWireTarget(target: HTMLElement | null): boolean {
    if (!target || !this.wireDrag) return false;
    const kind = target.dataset.portKind;
    return (
      target.dataset.portDirection === 'in' &&
      ((this.wireDrag.kind === 'pattern' &&
        ((kind === 'mesh' && this.isMeshFrameInput(target)) || kind === 'sim')) ||
        (this.wireDrag.kind === 'mesh' &&
          ((kind === 'mesh' && this.isTransformInput(target)) || kind === 'sim')) ||
        (this.wireDrag.kind === 'transform' && kind === 'sim'))
    );
  }

  private highlightWireTarget(clientX: number, clientY: number): void {
    this.board.querySelectorAll('.node-port.is-drop-target').forEach((port) => {
      port.classList.remove('is-drop-target');
    });
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('.node-port-in');
    if (this.isValidWireTarget(target ?? null)) target?.classList.add('is-drop-target');
  }

  private finishWireDrag(clientX: number, clientY: number): void {
    const source = this.wireDrag;
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('.node-port-in');

    if (source && this.isValidWireTarget(target ?? null)) {
      this.pushUndo();
      const targetId = target!.dataset.entityId!;
      if (source.kind === 'pattern') {
        const pattern = this.project.patterns.find((candidate) => candidate.id === source.id);
        if (pattern && target!.dataset.portKind === 'sim') {
          // Pattern dropped straight on a drape: remesh + transform are created
          // inside it, so no mesh/transform nodes are needed on the board.
          const sim = this.project.sims.find((candidate) => candidate.id === targetId);
          if (sim) {
            const addedTransform = this.connectPatternToSim(pattern, sim);
            if (addedTransform) void this.initGpuAndSims();
          }
        } else {
          const mesh = this.project.meshes.find((candidate) => candidate.id === targetId);
          if (mesh && pattern) {
            mesh.patternId = pattern.id;
            remeshDocument(mesh, pattern);
            for (const [nodeId, preview] of this.meshPreviews) {
              const node = this.project.canvas.nodes.find((candidate) => candidate.id === nodeId);
              if (node?.type === 'meshFrame' && node.meshId === mesh.id) {
                preview.setMesh(mesh, pattern);
              }
            }
            for (const assignment of this.project.assignments) {
              if (assignment.meshId === mesh.id) this.rebuildConnectedSim(assignment.simId, true);
            }
            for (const link of this.project.meshTransformAssignments.filter(
              (assignment) => assignment.meshId === mesh.id
            )) {
              this.rebuildConnectedTransform(link.transformId);
            }
            this.setStatus(`Connected ${pattern.name} → ${mesh.name}`);
          }
        }
      } else if (source.kind === 'transform') {
        const transform = this.project.transforms.find((candidate) => candidate.id === source.id);
        const sim = this.project.sims.find((candidate) => candidate.id === target!.dataset.entityId);
        if (transform && sim) {
          this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
            (assignment) => assignment.simId !== sim.id
          );
          this.project.transformSimAssignments.push({
            id: uid('assign'),
            transformId: transform.id,
            simId: sim.id,
          });
          this.project.assignments = this.project.assignments.filter(
            (assignment) => assignment.simId !== sim.id
          );
          this.rebuildConnectedSim(sim.id, false);
          this.setStatus(`Connected ${transform.name} → ${sim.name}`);
        }
      } else {
        const mesh = this.project.meshes.find((candidate) => candidate.id === source.id);
        const targetKind = target!.dataset.portKind;
        const targetId = target!.dataset.entityId!;
        if (targetKind === 'mesh') {
          const transform = this.project.transforms.find((candidate) => candidate.id === targetId);
          if (mesh && transform) {
            transform.meshId = mesh.id;
            this.project.meshTransformAssignments = this.project.meshTransformAssignments.filter(
              (assignment) => assignment.transformId !== transform.id
            );
            this.project.meshTransformAssignments.push({
              id: uid('assign'),
              meshId: mesh.id,
              transformId: transform.id,
            });
            this.rebuildConnectedTransform(transform.id);
            this.setStatus(`Connected ${mesh.name} → ${transform.name}`);
          }
        } else if (targetKind === 'sim') {
          const sim = this.project.sims.find((candidate) => candidate.id === targetId);
          if (mesh && sim) {
            this.project.assignments = this.project.assignments.filter(
              (assignment) => assignment.simId !== sim.id
            );
            this.project.assignments.push({
              id: uid('assign'),
              meshId: mesh.id,
              simId: sim.id,
            });
            this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
              (assignment) => assignment.simId !== sim.id
            );
            this.rebuildConnectedSim(sim.id, true);
            this.setStatus(`Connected ${mesh.name} → ${sim.name}`);
          }
        }
      }
      this.renderInspector();
    }
    this.cancelWireDrag();
  }

  private rebuildConnectedSim(simId: string, clearPose = true): void {
    const runtime = this.simRuntimes.get(simId);
    const sim = this.project.sims.find((candidate) => candidate.id === simId);
    if (!runtime || !sim) return;
    const viaTransform = this.transformForSim(simId);
    const pose = viaTransform ? this.poseForSim(simId) : clearPose ? null : sim.pose;
    if (!viaTransform && clearPose) sim.pose = null;
    runtime.rebuildCloth(
      this.meshGeometryForSim(simId),
      sim.params,
      pose,
      this.patternForSim(simId)
    );
  }

  private cancelWireDrag(): void {
    this.wireDrag = null;
    document.getElementById('boardWrap')?.classList.remove('is-wiring');
    this.board.querySelectorAll('.node-port.is-drop-target').forEach((port) => {
      port.classList.remove('is-drop-target');
    });
    this.drawWires();
  }

  private drawWires(): void {
    const wrap = document.getElementById('boardWrap')!;
    const rect = wrap.getBoundingClientRect();
    this.wiresSvg.setAttribute('width', String(rect.width));
    this.wiresSvg.setAttribute('height', String(rect.height));
    this.wiresSvg.innerHTML = '';
    this.board.querySelectorAll('.node-port.is-connected').forEach((port) => {
      port.classList.remove('is-connected');
    });

    const wiredIn = new Set<string>();
    const wire = (
      a: CanvasNode,
      b: CanvasNode,
      cls: string
    ) => {
      // Stages embedded in a drape have no board presence, so no board wire.
      if (this.isEmbeddedNode(a) || this.isEmbeddedNode(b)) return;
      this.appendWirePath(this.nodePortPoint(a, 'out'), this.nodePortPoint(b, 'in'), cls);
      wiredIn.add(b.id);
      this.board
        .querySelector(`[data-node-id="${a.id}"] > .node-port-out`)
        ?.classList.add('is-connected');
      this.board
        .querySelector(`[data-node-id="${b.id}"] > .node-port-in`)
        ?.classList.add('is-connected');
    };

    // Pattern → Mesh (via mesh.patternId)
    for (const mesh of this.project.meshes) {
      const patNode = this.project.canvas.nodes.find(
        (n) => n.type === 'patternFrame' && n.patternId === mesh.patternId
      );
      const meshNode = this.project.canvas.nodes.find(
        (n) => n.type === 'meshFrame' && n.meshId === mesh.id
      );
      if (patNode && meshNode) wire(patNode, meshNode, 'assign-wire wire-pattern-mesh');
    }

    // Mesh → Sim (direct)
    for (const a of this.project.assignments) {
      const meshNode = this.project.canvas.nodes.find(
        (n) => n.type === 'meshFrame' && n.meshId === a.meshId
      );
      const simNode = this.project.canvas.nodes.find(
        (n) => n.type === 'simViewport' && n.simId === a.simId
      );
      if (meshNode && simNode) wire(meshNode, simNode, 'assign-wire wire-mesh-sim');
    }

    // Mesh → Transform 3D
    for (const a of this.project.meshTransformAssignments) {
      const meshNode = this.project.canvas.nodes.find(
        (n) => n.type === 'meshFrame' && n.meshId === a.meshId
      );
      const transformNode = this.project.canvas.nodes.find(
        (n) => n.type === 'transform3d' && n.transformId === a.transformId
      );
      if (meshNode && transformNode) {
        wire(meshNode, transformNode, 'assign-wire wire-mesh-transform');
      }
    }

    // Transform 3D → Sim
    for (const a of this.project.transformSimAssignments) {
      const transformNode = this.project.canvas.nodes.find(
        (n) => n.type === 'transform3d' && n.transformId === a.transformId
      );
      const simNode = this.project.canvas.nodes.find(
        (n) => n.type === 'simViewport' && n.simId === a.simId
      );
      if (transformNode && simNode) {
        wire(transformNode, simNode, 'assign-wire wire-transform-sim');
      }
    }

    // A drape whose stages are embedded still reads as one connection: draw it
    // from the first visible upstream stage (usually the pattern).
    for (const sim of this.project.sims) {
      const simNode = this.project.canvas.nodes.find(
        (n) => n.type === 'simViewport' && n.simId === sim.id
      );
      if (!simNode || wiredIn.has(simNode.id)) continue;
      const chain = this.simChain(sim.id);
      const upstream =
        (chain.pattern &&
          this.project.canvas.nodes.find(
            (n) => n.type === 'patternFrame' && n.patternId === chain.pattern!.id
          )) ||
        (chain.mesh &&
          this.project.canvas.nodes.find(
            (n) => n.type === 'meshFrame' && n.meshId === chain.mesh!.id
          ));
      if (upstream) wire(upstream, simNode, 'assign-wire wire-pattern-mesh');
    }

    if (this.wireDrag) {
      const sourceNode = this.project.canvas.nodes.find(
        (candidate) => candidate.id === this.wireDrag!.nodeId
      );
      if (sourceNode) {
        const previewClass =
          this.wireDrag.kind === 'pattern'
            ? 'pattern-mesh'
            : this.wireDrag.kind === 'transform'
              ? 'transform-sim'
              : 'mesh-transform';
        this.appendWirePath(
          this.nodePortPoint(sourceNode, 'out'),
          { x: this.wireDrag.x, y: this.wireDrag.y },
          `assign-wire wire-preview wire-${previewClass}`
        );
      }
    }
  }

  private renderInspector(): void {
    this.hideInspectorTip();
    const node = this.project.canvas.nodes.find((n) => n.id === this.selectedNodeId);
    if (!node) {
      this.inspector.innerHTML = `<h3>Inspector</h3><p class="muted">Drag an output port to a compatible input to reconnect nodes. Middle-drag (or Alt-drag) board to pan · scroll wheel to zoom.<br/>Transform 3D: arrange pieces before draping — no simulation. Drag fabric to move · Shift-click pieces to multi-select (drag or rotate the group around their shared pivot) · empty drag to orbit · Shift-drag empty space to raise/lower orbit · Move/Rotate toggle · R = 90° local X · Snap to quadrant reveals the two 2 × 8 grids: click a piece, then click a cell to centre it there · wheel zoom.<br/>Sim: drag fabric to move · Shift-click to multi-select · Play to simulate drape · Draw pattern points shows the pattern's anchor points on the fabric — click one to edit it in a small overlay (Cancel/Apply above it; Apply remeshes and rebuilds the drape).</p>`;
      return;
    }

    if (node.type === 'transform3d') {
      const transform = this.project.transforms.find((t) => t.id === node.transformId)!;
      const rt = this.transformRuntimes.get(transform.id);
      const mesh = this.meshForTransform(transform.id);
      const pattern = this.patternForTransform(transform.id);
      const pieceIds =
        rt?.getPieceIds() ??
        Object.keys(transform.pieceTransforms ?? {});
      const selectedPiece =
        this.transformInspectorPieceId ??
        rt?.getSelectedPieceId() ??
        pieceIds[0] ??
        null;
      const pieceOptions = pieceIds
        .map((pieceId) => {
          const piece = pattern?.pieces.find((p) => p.id === pieceId);
          const label = piece?.name ?? pieceId.slice(0, 8);
          return `<option value="${pieceId}" ${pieceId === selectedPiece ? 'selected' : ''}>${label}</option>`;
        })
        .join('');
      const stored: PieceTransform3d = selectedPiece
        ? (transform.pieceTransforms[selectedPiece] ??
          (rt?.cloth
            ? {
                position: rt.cloth.getPieceCentroidTuple(selectedPiece),
                rotationDeg: [...DEFAULT_TRANSFORM_PIECE_ROTATION_DEG],
              }
            : {
                position: [0, 0, 0],
                rotationDeg: [...DEFAULT_TRANSFORM_PIECE_ROTATION_DEG],
              }))
        : {
            position: [0, 0, 0],
            rotationDeg: [...DEFAULT_TRANSFORM_PIECE_ROTATION_DEG],
          };
      const posCm = stored.position.map((v) => (v * WORLD_TO_CM).toFixed(2));
      const rot = stored.rotationDeg.map((v) => v.toFixed(1));
      this.inspector.innerHTML = `
        <h3>${transform.name}</h3>
        <label>Name <input id="transformName" value="${transform.name}" /></label>
        <p class="muted">Mesh source: <strong>${mesh?.name ?? 'none'}</strong> · arrangement only (no simulation)</p>
        <label>Piece
          <select id="transformPiece">${pieceOptions || '<option value="">—</option>'}</select>
        </label>
        <fieldset class="inspector-fieldset">
          <legend>Initial position (cm)</legend>
          <label>X <input id="transformPosX" type="number" step="0.1" value="${posCm[0]}" /></label>
          <label>Y <input id="transformPosY" type="number" step="0.1" value="${posCm[1]}" /></label>
          <label>Z <input id="transformPosZ" type="number" step="0.1" value="${posCm[2]}" /></label>
        </fieldset>
        <fieldset class="inspector-fieldset">
          <legend>Initial rotation (deg)</legend>
          <label>X <input id="transformRotX" type="number" step="1" value="${rot[0]}" /></label>
          <label>Y <input id="transformRotY" type="number" step="1" value="${rot[1]}" /></label>
          <label>Z <input id="transformRotZ" type="number" step="1" value="${rot[2]}" /></label>
        </fieldset>
        <p class="muted">Pose ${transform.pose ? 'saved' : 'default (-90° X)'} · edits apply to selected piece</p>
        ${this.deleteButtonHtml()}
      `;
      this.inspector.querySelector('#transformName')?.addEventListener('change', (e) => {
        this.pushUndo();
        transform.name = (e.target as HTMLInputElement).value;
        this.markDirty();
        this.renderAll();
        void this.initGpuAndSims();
      });
      this.inspector.querySelector('#transformPiece')?.addEventListener('change', (e) => {
        this.transformInspectorPieceId = (e.target as HTMLSelectElement).value || null;
        rt?.setSelectedPieceId(this.transformInspectorPieceId);
        this.renderInspector();
      });
      const applyPieceTransform = () => {
        if (!selectedPiece || !rt) return;
        const position: [number, number, number] = [
          parseFloat((this.inspector.querySelector('#transformPosX') as HTMLInputElement).value) /
            WORLD_TO_CM,
          parseFloat((this.inspector.querySelector('#transformPosY') as HTMLInputElement).value) /
            WORLD_TO_CM,
          parseFloat((this.inspector.querySelector('#transformPosZ') as HTMLInputElement).value) /
            WORLD_TO_CM,
        ];
        const rotationDeg: [number, number, number] = [
          parseFloat((this.inspector.querySelector('#transformRotX') as HTMLInputElement).value),
          parseFloat((this.inspector.querySelector('#transformRotY') as HTMLInputElement).value),
          parseFloat((this.inspector.querySelector('#transformRotZ') as HTMLInputElement).value),
        ];
        rt.applyPieceTransform(selectedPiece, position, rotationDeg);
      };
      for (const id of [
        'transformPosX',
        'transformPosY',
        'transformPosZ',
        'transformRotX',
        'transformRotY',
        'transformRotZ',
      ]) {
        this.inspector.querySelector(`#${id}`)?.addEventListener('change', applyPieceTransform);
      }
      this.bindDeleteButton(node.id);
      return;
    }

    if (node.type === 'simViewport') {
      const sim = this.project.sims.find((s) => s.id === node.simId)!;
      const p = sim.params;
      const mesh = this.meshForSim(sim.id);
      const engine = p.engine ?? 'cpu-mass-spring';
      const isGpu = engine === 'gpu-xpbd';
      const tip = (name: string, text: string, value: string, valueId: string) =>
        this.paramTip(name, text, value, valueId);
      const stretchPct = (((p.maxStretch ?? 1.12) * 100) - 100).toFixed(0);
      const bendPct = (((p.bendSpringScale ?? 0.2) * 100)).toFixed(0);
      this.inspector.innerHTML = `
        <h3>${sim.name}</h3>
        <label>Name <input id="simName" value="${sim.name}" /></label>
        <p class="muted">Mesh source: <strong>${mesh?.name ?? 'none'}</strong>${this.transformForSim(sim.id) ? ' · via Transform 3D' : ''} — density is set on the Mesh node.</p>
        <label>Engine
          <select id="pEngine">
            <option value="cpu-mass-spring" ${!isGpu ? 'selected' : ''}>CPU (mass-spring)</option>
            <option value="gpu-xpbd" ${isGpu ? 'selected' : ''}>GPU (XPBD)</option>
          </select>
        </label>
        <div id="cpuParams" style="${isGpu ? 'display:none' : ''}">
          <div class="inspector-section">
            <h4 class="inspector-section-title">Fabric</h4>
            <p class="muted inspector-section-hint">How the cloth feels — stretch, weight, folds, grip.</p>
            <label>${tip('Spring', 'Edge stretch stiffness. Lower = stretchier / silkier; higher = firmer woven cloth. Recommended: 800–1500 (default 1000).', String(Math.round(p.springConst)), 'vSpring')}
              <input id="pSpring" type="range" min="100" max="5000" value="${p.springConst}" /></label>
            <label>${tip('Damping', 'Spring energy loss. Higher settles faster with less jitter; too high feels sluggish. Recommended: 2–6 (default 3.5).', p.dampingConst.toFixed(1), 'vDamp')}
              <input id="pDamp" type="range" min="0" max="20" step="0.1" value="${p.dampingConst}" /></label>
            <label>${tip('Mass', 'Total garment mass (split across particles). Heavier = more inertia and drape; lighter reacts faster. Recommended: 50–150 (default 100).', String(Math.round(p.mass)), 'vMass')}
              <input id="pMass" type="range" min="10" max="300" value="${p.mass}" /></label>
            <label>${tip('Max stretch', 'Hard cap on how far fabric edges may elongate (Provot). Higher % = stretchier knit; lower = stable woven. Recommended: 5–15% (default 12%). Set near 0% only if you need almost inextensible cloth.', `${stretchPct}%`, 'vMaxStretch')}
              <input id="pMaxStretch" type="range" min="1" max="1.5" step="0.01" value="${p.maxStretch ?? 1.12}" /></label>
            <label>${tip('Bend springs', 'Resistance to folding, as a fraction of Spring. Low = soft drapey folds; high locks panels flat and fights seams. Recommended: 10–40% (default 20%). Avoid 100% for garments.', `${bendPct}%`, 'vBendScale')}
              <input id="pBendScale" type="range" min="0" max="1" step="0.05" value="${p.bendSpringScale ?? 0.2}" /></label>
            <label>${tip('Contact grip', 'Friction against the avatar / ground. Higher sticks and resists sliding; lower lets cloth glide. Range 0–2 (default 0.45).', (p.contactFriction ?? 0.45).toFixed(2), 'vFriction')}
              <input id="pFriction" type="range" min="0" max="2" step="0.05" value="${p.contactFriction ?? 0.45}" /></label>
            <label>${tip('Gravity', 'Downward acceleration scale for drape. Higher hangs heavier; lower floats. Recommended: 0.6–1.2 (default 0.8).', p.gravity.toFixed(2), 'vGrav')}
              <input id="pGrav" type="range" min="0" max="5" step="0.05" value="${p.gravity}" /></label>
          </div>
          <div class="inspector-section">
            <h4 class="inspector-section-title">Simulation</h4>
            <p class="muted inspector-section-hint">Stability &amp; cost — more steps usually beat cranking Spring alone.</p>
            <label>${tip('Substeps', 'Physics steps per frame (Macklin “small steps”). More = less stretch/jitter, higher CPU. Recommended: 16–32 (default 24). Raise before raising Spring if things explode.', String(p.substeps ?? 24), 'vCpuSubsteps')}
              <input id="pCpuSubsteps" type="range" min="4" max="64" value="${p.substeps ?? 24}" /></label>
            <label>${tip('Strain-limit iters', 'Provot stretch-limit passes per substep. Cuts rubber-band stretch after springs. Recommended: 4–10 (default 6). 0 disables limiting (uses Max stretch only via springs).', String(p.constraintIterations ?? 6), 'vStrainIters')}
              <input id="pStrainIters" type="range" min="0" max="20" value="${p.constraintIterations ?? 6}" /></label>
            <label>${tip('Velocity retain', 'Multiply velocity each substep (1 = none). Slightly below 1 damps high-frequency ringing without heavy Damping. Recommended: 0.995–0.999 (default 0.998).', (p.velocityDamping ?? 0.998).toFixed(3), 'vVelDamp')}
              <input id="pVelDamp" type="range" min="0.95" max="1" step="0.001" value="${p.velocityDamping ?? 0.998}" /></label>
            <label>${tip('Max speed', 'Clamp particle speed (world units/s) to stop explosions from bad steps. Recommended: 20–40 (default 30). Lower if the cloth still rockets; raise if motion feels capped.', String(Math.round(p.maxSpeed ?? 30)), 'vMaxSpeed')}
              <input id="pMaxSpeed" type="range" min="5" max="80" step="1" value="${p.maxSpeed ?? 30}" /></label>
          </div>
        </div>
        <div id="gpuParams" style="${isGpu ? '' : 'display:none'}">
          <div class="inspector-section">
            <h4 class="inspector-section-title">Fabric</h4>
            <p class="muted inspector-section-hint">How the cloth feels under XPBD constraints.</p>
            <label>${tip('Stretch', 'Edge stretch resistance (maps to XPBD stretch stiffness). Lower = stretchier / silkier; higher = firmer woven cloth. Recommended: 800–1500 (default 1000).', String(Math.round(p.springConst)), 'vSpringGpu')}
              <input id="pSpringGpu" type="range" min="100" max="5000" value="${p.springConst}" /></label>
            <label>${tip('Mass', 'Total garment mass (split across particles). Heavier = more inertia and drape; lighter reacts faster. Recommended: 50–150 (default 100).', String(Math.round(p.mass)), 'vMassGpu')}
              <input id="pMassGpu" type="range" min="10" max="300" value="${p.mass}" /></label>
            <label>${tip('Contact grip', 'Friction against the avatar / ground. Higher sticks and resists sliding; lower lets cloth glide. Range 0–2 (default 0.45).', (p.contactFriction ?? 0.45).toFixed(2), 'vFrictionGpu')}
              <input id="pFrictionGpu" type="range" min="0" max="2" step="0.05" value="${p.contactFriction ?? 0.45}" /></label>
            <label>${tip('LRA stretchiness', 'Long-range attachment / sew slack multiplier. Higher = looser seams and attachments; lower pulls tighter. Recommended: 1.1–1.4 (default 1.2).', (p.longRangeStretchiness ?? 1.2).toFixed(2), 'vLra')}
              <input id="pLra" type="range" min="1" max="2" step="0.05" value="${p.longRangeStretchiness ?? 1.2}" /></label>
            <label>${tip('Gravity', 'Downward acceleration scale for drape. Higher hangs heavier; lower floats. Recommended: 0.6–1.2 (default 0.8).', p.gravity.toFixed(2), 'vGravGpu')}
              <input id="pGravGpu" type="range" min="0" max="5" step="0.05" value="${p.gravity}" /></label>
          </div>
          <div class="inspector-section">
            <h4 class="inspector-section-title">Simulation</h4>
            <p class="muted inspector-section-hint">Solver quality vs GPU cost.</p>
            <label>${tip('Substeps', 'XPBD steps per frame. More = stabler stretch and collisions, more GPU time. Recommended: 4–12 (default 8).', String(p.substeps ?? 8), 'vSubsteps')}
              <input id="pSubsteps" type="range" min="2" max="32" value="${p.substeps ?? 8}" /></label>
            <label>${tip('Iterations', 'Constraint solver passes per substep. More = harder stretch/seams, costlier. Recommended: 2–8 (default 4).', String(p.constraintIterations ?? 4), 'vIters')}
              <input id="pIters" type="range" min="1" max="16" value="${p.constraintIterations ?? 4}" /></label>
            <label>${tip('Max speed', 'Clamp particle travel/speed each substep. Lower reduces slam-through during sew wrap; raise if drape feels sluggish. Recommended: 8–20 (default 30). While seams close, wrap is further capped near 10.', String(Math.round(p.maxSpeed ?? 30)), 'vMaxSpeedGpu')}
              <input id="pMaxSpeedGpu" type="range" min="4" max="40" step="1" value="${p.maxSpeed ?? 30}" /></label>
            <label class="inspector-check">${tip('Self-collision', 'Cloth–cloth contact via spatial hash. Prevents self-intersection; expensive. Leave off for simple drapes; on for layered or bunched garments.', p.enableSelfCollision ? 'On' : 'Off', 'vSelfCol')}
              <input id="pSelfCol" type="checkbox" ${p.enableSelfCollision ? 'checked' : ''} /></label>
          </div>
        </div>
        <p class="muted">${this.project.activeSimId === sim.id ? '● Active' : 'Paused'} · pose ${sim.pose ? 'saved' : 'none'}</p>
        ${this.deleteButtonHtml()}
      `;
      const setValue = (id: string, text: string) => {
        const el = this.inspector.querySelector(`#${id}`);
        if (el) el.textContent = text;
      };
      const syncParamValues = () => {
        setValue('vSpring', String(Math.round(p.springConst)));
        setValue('vSpringGpu', String(Math.round(p.springConst)));
        setValue('vDamp', p.dampingConst.toFixed(1));
        setValue('vMass', String(Math.round(p.mass)));
        setValue('vMassGpu', String(Math.round(p.mass)));
        setValue('vMaxStretch', `${(((p.maxStretch ?? 1.12) * 100) - 100).toFixed(0)}%`);
        setValue('vBendScale', `${(((p.bendSpringScale ?? 0.2) * 100)).toFixed(0)}%`);
        setValue('vFriction', (p.contactFriction ?? 0.45).toFixed(2));
        setValue('vFrictionGpu', (p.contactFriction ?? 0.45).toFixed(2));
        setValue('vGrav', p.gravity.toFixed(2));
        setValue('vGravGpu', p.gravity.toFixed(2));
        setValue('vCpuSubsteps', String(p.substeps ?? 24));
        setValue('vStrainIters', String(p.constraintIterations ?? 6));
        setValue('vVelDamp', (p.velocityDamping ?? 0.998).toFixed(3));
        setValue('vMaxSpeed', String(Math.round(p.maxSpeed ?? 30)));
        setValue('vLra', (p.longRangeStretchiness ?? 1.2).toFixed(2));
        setValue('vSubsteps', String(p.substeps ?? 8));
        setValue('vIters', String(p.constraintIterations ?? 4));
        setValue('vMaxSpeedGpu', String(Math.round(p.maxSpeed ?? 30)));
        setValue('vSelfCol', p.enableSelfCollision ? 'On' : 'Off');
      };
      const bind = (id: string, fn: (v: number) => void) => {
        const el = this.inspector.querySelector(`#${id}`) as HTMLInputElement | null;
        if (!el) return;
        let armed = false;
        el.addEventListener('pointerdown', () => {
          if (armed) return;
          armed = true;
          this.pushUndo();
        });
        el.addEventListener('change', () => {
          armed = false;
        });
        el.addEventListener('input', (e) => {
          fn(parseFloat((e.target as HTMLInputElement).value));
          syncParamValues();
          const rt = this.simRuntimes.get(sim.id);
          rt?.cloth?.applyParams(sim.params);
        });
      };
      this.inspector.querySelector('#simName')?.addEventListener('change', (e) => {
        this.pushUndo();
        sim.name = (e.target as HTMLInputElement).value;
        this.renderAll();
        void this.initGpuAndSims();
      });
      this.inspector.querySelector('#pEngine')?.addEventListener('change', (e) => {
        this.pushUndo();
        const next = (e.target as HTMLSelectElement).value as 'cpu-mass-spring' | 'gpu-xpbd';
        const rt = this.simRuntimes.get(sim.id);
        if (rt?.cloth) sim.pose = rt.cloth.exportPose();
        p.engine = next;
        // CPU and GPU share one params object but mean different things by
        // substeps/iterations. Switching must not leave GPU tuning on the CPU solver.
        if (next === 'cpu-mass-spring') {
          p.substeps = 24;
          p.constraintIterations = 6;
          if (!(p.gravity > 0)) p.gravity = DEFAULT_SIM_PARAMS.gravity;
          if (p.velocityDamping == null) p.velocityDamping = DEFAULT_SIM_PARAMS.velocityDamping;
        } else {
          p.substeps = 8;
          p.constraintIterations = 4;
        }
        const geom = this.meshGeometryForSim(sim.id);
        const pattern = this.patternForSim(sim.id);
        rt?.rebuildCloth(geom, sim.params, sim.pose, pattern);
        this.renderInspector();
        this.persistLocal();
      });
      bind('pSpring', (v) => {
        p.springConst = v;
      });
      bind('pSpringGpu', (v) => {
        p.springConst = v;
      });
      bind('pDamp', (v) => {
        p.dampingConst = v;
      });
      bind('pGrav', (v) => {
        p.gravity = v;
      });
      bind('pGravGpu', (v) => {
        p.gravity = v;
      });
      bind('pMass', (v) => {
        p.mass = v;
      });
      bind('pMassGpu', (v) => {
        p.mass = v;
      });
      bind('pCpuSubsteps', (v) => {
        p.substeps = Math.round(v);
      });
      bind('pStrainIters', (v) => {
        p.constraintIterations = Math.round(v);
      });
      bind('pMaxStretch', (v) => {
        p.maxStretch = v;
      });
      bind('pBendScale', (v) => {
        p.bendSpringScale = v;
      });
      bind('pVelDamp', (v) => {
        p.velocityDamping = v;
      });
      bind('pMaxSpeed', (v) => {
        p.maxSpeed = v;
      });
      bind('pMaxSpeedGpu', (v) => {
        p.maxSpeed = v;
      });
      bind('pFriction', (v) => {
        p.contactFriction = v;
      });
      bind('pFrictionGpu', (v) => {
        p.contactFriction = v;
      });
      bind('pSubsteps', (v) => {
        p.substeps = Math.round(v);
      });
      bind('pIters', (v) => {
        p.constraintIterations = Math.round(v);
      });
      bind('pLra', (v) => {
        p.longRangeStretchiness = v;
      });
      this.inspector.querySelector('#pSelfCol')?.addEventListener('change', (e) => {
        p.enableSelfCollision = (e.target as HTMLInputElement).checked;
        syncParamValues();
        const rt = this.simRuntimes.get(sim.id);
        rt?.cloth?.applyParams(sim.params);
      });
      this.bindInspectorTips();
      this.bindDeleteButton(node.id);
      return;
    }

    if (node.type === 'meshFrame') {
      const mesh = this.project.meshes.find((m) => m.id === node.meshId)!;
      const s = mesh.settings;
      const patterns = this.project.patterns
        .map((p) => `<option value="${p.id}" ${p.id === mesh.patternId ? 'selected' : ''}>${p.name}</option>`)
        .join('');
      this.inspector.innerHTML = `
        <h3>${mesh.name}</h3>
        <label>Name <input id="meshName" value="${mesh.name}" /></label>
        <label>Source pattern
          <select id="meshPattern">${patterns}</select>
        </label>
        <label>Algorithm
          <select id="meshAlgo">
            <option value="delaunay" ${s.algorithm === 'delaunay' ? 'selected' : ''}>Delaunay (boundary + interior)</option>
            <option value="centroidal" ${s.algorithm === 'centroidal' ? 'selected' : ''}>Centroidal (Lloyd-smoothed)</option>
            <option value="structuredGrid" ${s.algorithm === 'structuredGrid' ? 'selected' : ''}>Structured grid</option>
          </select>
        </label>
        <label>Target edge (cm)
          <input id="meshEdge" type="range" min="1" max="12" step="0.25" value="${s.targetEdgeCm}" />
          <span id="meshEdgeVal">${s.targetEdgeCm.toFixed(2)} cm</span>
        </label>
        <label>Boundary spacing (cm)
          <input id="meshBound" type="range" min="0.5" max="8" step="0.25" value="${s.boundarySpacingCm}" />
          <span id="meshBoundVal">${s.boundarySpacingCm.toFixed(2)}</span>
        </label>
        <label>Lloyd iterations
          <input id="meshLloyd" type="range" min="0" max="8" step="1" value="${s.lloydIterations}" ${s.algorithm !== 'centroidal' ? 'disabled' : ''} />
          <span id="meshLloydVal">${s.lloydIterations}</span>
        </label>
        <button type="button" id="meshRemesh">Remesh</button>
        <p class="muted">Top-down preview. Remesh after changing settings, then Rebuild on the sim.</p>
        ${this.deleteButtonHtml()}
      `;
      const syncLabels = () => {
        (this.inspector.querySelector('#meshEdgeVal') as HTMLElement).textContent =
          `${s.targetEdgeCm.toFixed(2)} cm`;
        (this.inspector.querySelector('#meshBoundVal') as HTMLElement).textContent =
          s.boundarySpacingCm.toFixed(2);
        (this.inspector.querySelector('#meshLloydVal') as HTMLElement).textContent = String(
          s.lloydIterations
        );
      };
      this.inspector.querySelector('#meshName')?.addEventListener('change', (e) => {
        this.pushUndo();
        mesh.name = (e.target as HTMLInputElement).value;
        this.renderAll();
        void this.initGpuAndSims();
      });
      this.inspector.querySelector('#meshPattern')?.addEventListener('change', (e) => {
        this.pushUndo();
        mesh.patternId = (e.target as HTMLSelectElement).value;
        this.remesh(mesh.id, { recordUndo: false });
        this.drawWires();
      });
      this.inspector.querySelector('#meshAlgo')?.addEventListener('change', (e) => {
        this.pushUndo();
        s.algorithm = (e.target as HTMLSelectElement).value as MeshAlgorithm;
        const lloyd = this.inspector.querySelector('#meshLloyd') as HTMLInputElement;
        lloyd.disabled = s.algorithm !== 'centroidal';
        this.remesh(mesh.id, { recordUndo: false });
      });
      for (const id of ['meshEdge', 'meshBound', 'meshLloyd']) {
        this.inspector.querySelector(`#${id}`)?.addEventListener('pointerdown', () => {
          this.pushUndo();
        });
      }
      this.inspector.querySelector('#meshEdge')?.addEventListener('input', (e) => {
        s.targetEdgeCm = parseFloat((e.target as HTMLInputElement).value);
        syncLabels();
      });
      this.inspector.querySelector('#meshEdge')?.addEventListener('change', () =>
        this.remesh(mesh.id, { recordUndo: false })
      );
      this.inspector.querySelector('#meshBound')?.addEventListener('input', (e) => {
        s.boundarySpacingCm = parseFloat((e.target as HTMLInputElement).value);
        syncLabels();
      });
      this.inspector.querySelector('#meshBound')?.addEventListener('change', () =>
        this.remesh(mesh.id, { recordUndo: false })
      );
      this.inspector.querySelector('#meshLloyd')?.addEventListener('input', (e) => {
        s.lloydIterations = Math.round(parseFloat((e.target as HTMLInputElement).value));
        syncLabels();
      });
      this.inspector.querySelector('#meshLloyd')?.addEventListener('change', () =>
        this.remesh(mesh.id, { recordUndo: false })
      );
      this.inspector.querySelector('#meshRemesh')?.addEventListener('click', () => this.remesh(mesh.id));
      this.bindDeleteButton(node.id);
      return;
    }

    if (node.type === 'patternFrame') {
      const pattern = this.project.patterns.find((p) => p.id === node.patternId)!;
      this.inspector.innerHTML = `
        <h3>${pattern.name}</h3>
        <label>Name <input id="patName" value="${pattern.name}" /></label>
        <button type="button" id="addPt">Add point</button>
        <p class="muted">Tools: Move · Add (pen, rect, circle, blocks, SVG) · Modify (extrude, join, bridge) · Remove (knife, dart) · Sew · Ruler. Middle-drag pan · scroll wheel zoom. Shift-drag a scale handle locks the aspect · Alt-drag one scales about the centre of the selection.</p>
        ${this.deleteButtonHtml()}
      `;
      this.inspector.querySelector('#patName')?.addEventListener('change', (e) => {
        pattern.name = (e.target as HTMLInputElement).value;
        this.renderAll();
        void this.initGpuAndSims();
      });
      this.inspector.querySelector('#addPt')?.addEventListener('click', () => {
        this.editors.get(node.id)?.addPointOnEdge();
      });
      this.bindDeleteButton(node.id);
      return;
    }

    if (node.type === 'text') {
      this.inspector.innerHTML = `
        <h3>Note</h3>
        <p class="muted">Edit text directly on the canvas.</p>
        ${this.deleteButtonHtml()}
      `;
      this.bindDeleteButton(node.id);
      return;
    }

    if (node.type === 'image') {
      this.inspector.innerHTML = `
        <h3>${this.escapeHtml(node.label || 'Image')}</h3>
        <p class="muted">Reference image — drag to move, corner handles to resize. Hold Shift to lock aspect.</p>
        ${node.src ? '' : '<p class="muted is-alert">Its image data is no longer in storage. Use Replace image… to re-link it.</p>'}
        <label>Label <input id="imgLabel" value="${this.escapeHtml(node.label || '')}" /></label>
        <label>Width
          <input id="imgW" type="number" min="80" step="1" value="${Math.round(node.width)}" />
        </label>
        <label>Height
          <input id="imgH" type="number" min="60" step="1" value="${Math.round(node.height)}" />
        </label>
        <button type="button" id="imgReplace">Replace image…</button>
        ${this.deleteButtonHtml()}
      `;
      this.inspector.querySelector('#imgLabel')?.addEventListener('change', (e) => {
        this.pushUndo();
        node.label = (e.target as HTMLInputElement).value.trim() || 'Image';
        const imgEl = this.board.querySelector(
          `[data-node-id="${node.id}"] img`
        ) as HTMLImageElement | null;
        if (imgEl) imgEl.alt = node.label;
        this.renderInspector();
      });
      const bindDim = (id: string, apply: (v: number) => void) => {
        this.inspector.querySelector(`#${id}`)?.addEventListener('change', (e) => {
          const v = parseFloat((e.target as HTMLInputElement).value);
          if (!Number.isFinite(v)) return;
          this.pushUndo();
          apply(v);
          this.layoutNodes();
          this.drawWires();
          this.renderInspector();
        });
      };
      bindDim('imgW', (v) => {
        node.width = Math.max(80, v);
      });
      bindDim('imgH', (v) => {
        node.height = Math.max(60, v);
      });
      this.inspector.querySelector('#imgReplace')?.addEventListener('click', () => {
        this.pickImageFile(node);
      });
      this.bindDeleteButton(node.id);
    }
  }

  private deleteButtonHtml(): string {
    return `<button type="button" id="deleteNode" class="danger">Delete node</button>`;
  }

  private bindDeleteButton(nodeId: string): void {
    this.inspector.querySelector('#deleteNode')?.addEventListener('click', () => {
      this.deleteNode(nodeId);
    });
  }

  /**
   * Drop the stages a deleted drape owned. Without this they would fall out of
   * every sim's chain and reappear on the board as orphan nodes.
   */
  private dropEmbeddedChain(chain: {
    mesh?: MeshDocument;
    transform?: Transform3dInstance;
  }): void {
    const transformId = chain.transform?.id;
    const meshId = chain.mesh?.id;

    if (transformId) {
      // Another drape may still drive this transform — leave it alone then.
      if (this.project.transformSimAssignments.some((a) => a.transformId === transformId)) return;
      this.transformRuntimes.get(transformId)?.cloth?.destroy();
      this.transformRuntimes.delete(transformId);
      this.project.transforms = this.project.transforms.filter((t) => t.id !== transformId);
      this.project.canvas.nodes = this.project.canvas.nodes.filter(
        (n) => !(n.type === 'transform3d' && n.transformId === transformId)
      );
      this.project.meshTransformAssignments = this.project.meshTransformAssignments.filter(
        (a) => a.transformId !== transformId
      );
      this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
        (a) => a.transformId !== transformId
      );
    }

    if (!meshId) return;
    const meshStillUsed =
      this.project.assignments.some((a) => a.meshId === meshId) ||
      this.project.meshTransformAssignments.some((a) => a.meshId === meshId);
    if (meshStillUsed) return;
    this.project.meshes = this.project.meshes.filter((m) => m.id !== meshId);
    this.project.canvas.nodes = this.project.canvas.nodes.filter(
      (n) => !(n.type === 'meshFrame' && n.meshId === meshId)
    );
    this.project.assignments = this.project.assignments.filter((a) => a.meshId !== meshId);
  }

  private deleteNode(nodeId: string): void {
    const node = this.project.canvas.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (!confirm('Delete this node?')) return;
    this.pushUndo();

    this.project.canvas.nodes = this.project.canvas.nodes.filter((n) => n.id !== nodeId);

    if (node.type === 'simViewport') {
      const simId = node.simId;
      // Capture the internal chain before the wiring is torn down.
      const chain = this.simChain(simId);
      const stillUsed = this.project.canvas.nodes.some(
        (n) => n.type === 'simViewport' && n.simId === simId
      );
      if (!stillUsed) {
        const rt = this.simRuntimes.get(simId);
        rt?.cloth?.destroy();
        this.simRuntimes.delete(simId);
        this.project.sims = this.project.sims.filter((s) => s.id !== simId);
        this.project.assignments = this.project.assignments.filter((a) => a.simId !== simId);
        this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
          (a) => a.simId !== simId
        );
        this.dropEmbeddedChain(chain);
        if (this.project.activeSimId === simId) this.project.activeSimId = null;
      }
    } else if (node.type === 'meshFrame') {
      const meshId = node.meshId;
      const stillUsed = this.project.canvas.nodes.some(
        (n) => n.type === 'meshFrame' && n.meshId === meshId
      );
      if (!stillUsed) {
        this.project.meshes = this.project.meshes.filter((m) => m.id !== meshId);
        this.project.assignments = this.project.assignments.filter((a) => a.meshId !== meshId);
        this.project.meshTransformAssignments = this.project.meshTransformAssignments.filter(
          (a) => a.meshId !== meshId
        );
      }
    } else if (node.type === 'transform3d') {
      const transformId = node.transformId;
      const stillUsed = this.project.canvas.nodes.some(
        (n) => n.type === 'transform3d' && n.transformId === transformId
      );
      if (!stillUsed) {
        const rt = this.transformRuntimes.get(transformId);
        rt?.cloth?.destroy();
        this.transformRuntimes.delete(transformId);
        this.project.transforms = this.project.transforms.filter((t) => t.id !== transformId);
        this.project.meshTransformAssignments = this.project.meshTransformAssignments.filter(
          (a) => a.transformId !== transformId
        );
        this.project.transformSimAssignments = this.project.transformSimAssignments.filter(
          (a) => a.transformId !== transformId
        );
      }
    } else if (node.type === 'patternFrame') {
      const patternId = node.patternId;
      const stillUsed = this.project.canvas.nodes.some(
        (n) => n.type === 'patternFrame' && n.patternId === patternId
      );
      if (!stillUsed) {
        this.project.patterns = this.project.patterns.filter((p) => p.id !== patternId);
        // Orphan meshes that pointed at this pattern keep the id until user reassigns;
        // clear geometry so remesh fails loudly until a new pattern is chosen.
        for (const mesh of this.project.meshes) {
          if (mesh.patternId === patternId) mesh.geometry = null;
        }
      }
    }

    this.selectedNodeId = null;
    this.renderAll();
    void this.initGpuAndSims();
    this.setStatus('Node deleted');
  }

  private applyNodeResize(clientX: number, clientY: number): void {
    const r = this.resizingNode;
    if (!r) return;
    const node = this.project.canvas.nodes.find((n) => n.id === r.id);
    if (!node) return;

    const zoom = this.project.canvas.zoom;
    const boardX = (clientX - this.project.canvas.panX) / zoom;
    const boardY = (clientY - this.project.canvas.panY) / zoom;
    const dx = boardX - r.startBoardX;
    const dy = boardY - r.startBoardY;

    const minW = node.type === 'text' ? 120 : node.type === 'image' ? 80 : 200;
    const minH = node.type === 'text' ? 40 : node.type === 'image' ? 60 : 160;

    let x = r.origX;
    let y = r.origY;
    let w = r.origW;
    let h = r.origH;

    if (r.corner.includes('e')) w = r.origW + dx;
    if (r.corner.includes('s')) h = r.origH + dy;
    if (r.corner.includes('w')) {
      w = r.origW - dx;
      x = r.origX + dx;
    }
    if (r.corner.includes('n')) {
      h = r.origH - dy;
      y = r.origY + dy;
    }

    if (w < minW) {
      if (r.corner.includes('w')) x = r.origX + r.origW - minW;
      w = minW;
    }
    if (h < minH) {
      if (r.corner.includes('n')) y = r.origY + r.origH - minH;
      h = minH;
    }

    // Image refs: hold Shift to lock natural (or current) aspect ratio.
    if (node.type === 'image' && this.resizeShiftKey) {
      const aspect =
        node.naturalAspect && node.naturalAspect > 0 ? node.naturalAspect : r.origW / Math.max(1, r.origH);
      const fromWidth = Math.abs(dx) >= Math.abs(dy);
      if (fromWidth) {
        h = Math.max(minH, w / aspect);
        if (r.corner.includes('n')) y = r.origY + r.origH - h;
        if (r.corner.includes('w')) x = r.origX + r.origW - w;
      } else {
        w = Math.max(minW, h * aspect);
        if (r.corner.includes('w')) x = r.origX + r.origW - w;
        if (r.corner.includes('n')) y = r.origY + r.origH - h;
      }
    }

    node.x = x;
    node.y = y;
    node.width = w;
    node.height = h;
    this.layoutNodes();
    this.drawWires();
  }

  private duplicateSelectedNode(): void {
    if (!this.selectedNodeId) {
      this.setStatus('Select a node to duplicate');
      return;
    }
    if (this.isStudioModalOpen()) return;
    const dup = this.duplicateNode(this.selectedNodeId, {
      offsetX: 32,
      offsetY: 32,
      recordUndo: true,
      select: true,
    });
    if (dup) this.setStatus(`Duplicated · ${this.nodeLabel(dup)}`);
  }

  private isStudioModalOpen(): boolean {
    return !this.modalRoot.hidden;
  }

  private nodeLabel(node: CanvasNode): string {
    switch (node.type) {
      case 'patternFrame': {
        const p = this.project.patterns.find((x) => x.id === node.patternId);
        return p?.name ?? 'Pattern';
      }
      case 'meshFrame': {
        const m = this.project.meshes.find((x) => x.id === node.meshId);
        return m?.name ?? 'Mesh';
      }
      case 'transform3d': {
        const t = this.project.transforms.find((x) => x.id === node.transformId);
        return t?.name ?? 'Transform 3D';
      }
      case 'simViewport': {
        const s = this.project.sims.find((x) => x.id === node.simId);
        return s?.name ?? 'Sim';
      }
      case 'image':
        return node.label ?? 'Image';
      case 'text':
        return 'Note';
    }
  }

  /**
   * Clone a canvas node and its backing document (pattern/mesh/transform/sim),
   * preserving settings, geometry, pose, camera, and graph connections where applicable.
   */
  private duplicateNode(
    nodeId: string,
    opts: {
      offsetX?: number;
      offsetY?: number;
      recordUndo?: boolean;
      select?: boolean;
    } = {}
  ): CanvasNode | null {
    const src = this.project.canvas.nodes.find((n) => n.id === nodeId);
    if (!src) return null;

    if (opts.recordUndo !== false) this.pushUndo();

    const ox = opts.offsetX ?? 32;
    const oy = opts.offsetY ?? 32;
    const zIndex = this.project.canvas.nodes.length + 1;
    let needsGpu = false;
    let node: CanvasNode;

    switch (src.type) {
      case 'patternFrame': {
        const pattern = this.project.patterns.find((p) => p.id === src.patternId);
        if (!pattern) return null;
        const cloned = this.clonePatternDocument(pattern);
        this.project.patterns.push(cloned);
        node = {
          type: 'patternFrame',
          id: uid('node'),
          patternId: cloned.id,
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
        };
        break;
      }
      case 'meshFrame': {
        const mesh = this.project.meshes.find((m) => m.id === src.meshId);
        if (!mesh) return null;
        const cloned: MeshDocument = {
          id: uid('mesh'),
          name: `${mesh.name} copy`,
          patternId: mesh.patternId,
          settings: { ...mesh.settings },
          geometry: mesh.geometry ? structuredClone(mesh.geometry) : null,
        };
        this.project.meshes.push(cloned);
        node = {
          type: 'meshFrame',
          id: uid('node'),
          meshId: cloned.id,
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
        };
        break;
      }
      case 'transform3d': {
        const transform = this.project.transforms.find((t) => t.id === src.transformId);
        if (!transform) return null;
        const cloned = {
          id: uid('transform'),
          name: `${transform.name} copy`,
          meshId: transform.meshId,
          camera: structuredClone(transform.camera),
          pose: transform.pose ? structuredClone(transform.pose) : null,
          pieceTransforms: structuredClone(transform.pieceTransforms),
        };
        this.project.transforms.push(cloned);
        this.project.meshTransformAssignments.push({
          id: uid('assign'),
          meshId: cloned.meshId,
          transformId: cloned.id,
        });
        node = {
          type: 'transform3d',
          id: uid('node'),
          transformId: cloned.id,
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
        };
        needsGpu = true;
        break;
      }
      case 'simViewport': {
        const sim = this.project.sims.find((s) => s.id === src.simId);
        if (!sim) return null;
        // Capture live pose/camera before cloning
        this.persistSimStates();
        const live = this.project.sims.find((s) => s.id === src.simId)!;
        const cloned: SimInstance = {
          id: uid('sim'),
          name: `${live.name} copy`,
          params: {
            ...live.params,
            wind: [...live.params.wind] as [number, number, number],
          },
          pose: live.pose ? structuredClone(live.pose) : null,
          camera: structuredClone(live.camera),
          dropped: live.dropped,
        };
        this.project.sims.push(cloned);
        for (const a of this.project.assignments.filter((x) => x.simId === src.simId)) {
          this.project.assignments.push({
            id: uid('assign'),
            meshId: a.meshId,
            simId: cloned.id,
          });
        }
        for (const a of this.project.transformSimAssignments.filter(
          (x) => x.simId === src.simId
        )) {
          this.project.transformSimAssignments.push({
            id: uid('assign'),
            transformId: a.transformId,
            simId: cloned.id,
          });
        }
        node = {
          type: 'simViewport',
          id: uid('node'),
          simId: cloned.id,
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
        };
        needsGpu = true;
        break;
      }
      case 'image': {
        node = {
          type: 'image',
          id: uid('node'),
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
          src: src.src,
          label: src.label ? `${src.label} copy` : undefined,
          naturalAspect: src.naturalAspect,
        };
        break;
      }
      case 'text': {
        node = {
          type: 'text',
          id: uid('node'),
          x: src.x + ox,
          y: src.y + oy,
          width: src.width,
          height: src.height,
          zIndex,
          text: src.text,
          fontSize: src.fontSize,
        };
        break;
      }
    }

    this.project.canvas.nodes.push(node);
    this.mountNode(node);
    if (opts.select !== false) {
      this.selectedNodeId = node.id;
      this.renderInspector();
    }
    this.layoutNodes();
    this.drawWires();
    if (needsGpu) void this.initGpuAndSims();
    return node;
  }

  private clonePatternDocument(src: PatternDocument): PatternDocument {
    const pieceIdMap = new Map<string, string>();
    const pointIdMap = new Map<string, string>();

    // Blocks are *regenerated* rather than copied. Their piece and point ids are
    // derived from the instance id, so handing the clone a fresh instance id
    // means the outlines have to be rebuilt to match — otherwise the first
    // regeneration afterwards would silently orphan every seam on the block.
    const library = cachedMeasurementLibrary();
    const sourceBlocks = src.blocks ?? [];
    const ownedPieceIds = new Set(
      sourceBlocks.flatMap((instance) => instance.pieces.map((entry) => entry.pieceId))
    );
    const blocks: BlockInstance[] = [];
    const generatedPieces: PatternPiece[] = [];

    for (const instance of sourceBlocks) {
      const definition = getBlockDefinition(instance.definitionId);
      if (!definition) continue;
      const copy: BlockInstance = {
        ...instance,
        id: uid('blk'),
        origin: { ...instance.origin },
        bindings: structuredClone(instance.bindings),
        pieces: [],
      };
      const set =
        library?.sets.find((s) => s.id === instance.personId) ??
        (instance.personId ? null : (library?.sets.find((s) => s.id === library.activeId) ?? null));
      const generated = generateBlockPieces(definition, copy, set);

      // Carry the old ids across so any seam pointing at the original still does.
      for (const entry of generated) {
        const original = instance.pieces.find((e) => e.role === entry.role);
        if (!original) continue;
        pieceIdMap.set(original.pieceId, entry.piece.id);
        const from = src.pieces.find((p) => p.id === original.pieceId);
        if (!from) continue;
        for (const [index, point] of from.points.entries()) {
          const to = entry.piece.points[index];
          if (to) pointIdMap.set(point.id, to.id);
        }
      }

      copy.pieces = generated.map((entry) => ({ role: entry.role, pieceId: entry.piece.id }));
      blocks.push(copy);
      generatedPieces.push(...generated.map((entry) => entry.piece));
    }

    const pieces = src.pieces
      .filter((piece) => !ownedPieceIds.has(piece.id))
      .map((piece) => {
      const newPieceId = uid('piece');
      pieceIdMap.set(piece.id, newPieceId);
      const points = piece.points.map((pt) => {
        const newPtId = uid('pt');
        pointIdMap.set(pt.id, newPtId);
        return {
          id: newPtId,
          anchor: { ...pt.anchor },
          handleIn: pt.handleIn ? { ...pt.handleIn } : null,
          handleOut: pt.handleOut ? { ...pt.handleOut } : null,
          handlesParallel: pt.handlesParallel,
        };
      });
      return {
        id: newPieceId,
        name: piece.name,
        closed: piece.closed,
        points,
        grainline: piece.grainline
          ? {
              from: { ...piece.grainline.from },
              to: { ...piece.grainline.to },
            }
          : undefined,
      };
    });
    const remapEdge = (edge: PatternDocument['seams'][number]['a']) => ({
      pieceId: pieceIdMap.get(edge.pieceId) ?? edge.pieceId,
      fromPointId: pointIdMap.get(edge.fromPointId) ?? edge.fromPointId,
      toPointId: pointIdMap.get(edge.toPointId) ?? edge.toPointId,
      t0: edge.t0,
      t1: edge.t1,
    });
    return {
      id: uid('pattern'),
      name: `${src.name} copy`,
      pieces: [...pieces, ...generatedPieces],
      seams: src.seams.map((seam) => ({
        id: uid('seam'),
        a: remapEdge(seam.a),
        b: remapEdge(seam.b),
        restGapCm: seam.restGapCm,
      })),
      rulers: src.rulers ? structuredClone(src.rulers) : undefined,
      blocks: blocks.length > 0 ? blocks : undefined,
      pieceSuccessors: src.pieceSuccessors ? structuredClone(src.pieceSuccessors) : undefined,
    };
  }

  private addPatternFrame(): void {
    const patternId = uid('pattern');
    this.project.patterns.push({
      id: patternId,
      name: `Pattern ${this.project.patterns.length + 1}`,
      pieces: [rectPiece('Panel', 40, 50, { x: 5, y: 5 })],
      seams: [],
    });
    const node = {
      type: 'patternFrame' as const,
      id: uid('node'),
      patternId,
      x: 60,
      y: 100 + this.project.patterns.length * 30,
      width: 400,
      height: 440,
      zIndex: this.project.canvas.nodes.length + 1,
    };
    this.project.canvas.nodes.push(node);
    this.mountNode(node);
    this.drawWires();
  }

  private addSimViewport(): void {
    const simId = uid('sim');
    const sim: SimInstance = {
      id: simId,
      name: `Drape ${this.project.sims.length + 1}`,
      params: { ...DEFAULT_SIM_PARAMS },
      pose: null,
      camera: getDefaultSimCamera(this.project),
      dropped: false,
    };
    this.project.sims.push(sim);
    const node: SimViewportNode = {
      type: 'simViewport',
      id: uid('node'),
      simId,
      x: 560,
      y: 80 + this.project.sims.length * 40,
      width: 420,
      height: 320,
      zIndex: this.project.canvas.nodes.length + 1,
    };
    this.project.canvas.nodes.push(node);
    this.mountNode(node);
    // A drape carries its own remesh + transform stages; wire in the first
    // pattern so the fullscreen tab strip is complete straight away.
    const pattern = this.project.patterns[0];
    if (pattern) {
      this.connectPatternToSim(pattern, sim);
    } else {
      this.syncEmbeddedNodes();
    }
    void this.initGpuAndSims();
    this.drawWires();
  }

  private addTextNote(): void {
    const node: TextAnnotationNode = {
      type: 'text',
      id: uid('node'),
      x: 40,
      y: 580,
      width: 280,
      height: 80,
      zIndex: this.project.canvas.nodes.length + 1,
      text: 'New note',
      fontSize: 14,
    };
    this.project.canvas.nodes.push(node);
    this.mountNode(node);
  }
}
