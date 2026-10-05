import { vec3, quat } from 'gl-matrix';
import { Renderer } from '../Renderer';
import { Camera } from '../Camera';
import vertexShaderCode from '../shaders/cloth.vert.wgsl?raw';
import fragmentShaderCode from '../shaders/cloth.frag.wgsl?raw';
import type { ClothSimulator } from './ClothSimulator';
import { createClothSimulator, resolveEngineKind } from './createClothSimulator';
import {
  ViewportGnomon,
  axisViewAngles,
  currentAxisView,
  oppositeAxis,
  type AxisId,
} from './ViewportGnomon';
import {
  MoveGizmo,
  unprojectRay,
  worldToCanvasPx,
  type MoveAxis,
  type TransformMode,
} from './MoveGizmo';
import { loadAvatarBody } from './avatarAsset';
import type { AvatarBody } from '../mesh/AvatarBody';
import { DEFAULT_MESH_SETTINGS, triangulatePattern } from '../mesh/triangulate';
import { migrateLegacySimCamera } from './cameraDefaults';
import { createViewportRenderer } from './SimViewportRuntime';
import { SelectionOverlay } from './SelectionOverlay';
import { ClothSewTool } from './ClothSewTool';
import { keepPieceTransforms } from './pieceTransforms';
import {
  buildQuadrantLayout,
  pickQuadrant,
  quadrantCellCenter,
  quadrantCellVertices,
  type QuadrantLayout,
} from './quadrantGrid';
import { FALLBACK_PIECE_ID } from './meshTopology';
import { DEFAULT_TRANSFORM_PIECE_ROTATION_DEG } from './transformDefaults';
import type {
  MeshGeometry,
  PatternDocument,
  PieceTransform3d,
  SeamEdgeRef,
  SimCameraState,
  SimParams,
  SimPose,
  Transform3dInstance,
} from '../project/types';

/** Physics params for arrangement-only viewports (no simulation). */
export const ARRANGE_SIM_PARAMS: SimParams = {
  particleResolution: 15,
  mass: 100,
  springConst: 1000,
  dampingConst: 3.5,
  gravity: 0,
  wind: [0, 0, 0],
  fluidDensity: 1.225,
  dragCoeff: 1.0,
  engine: 'cpu-mass-spring',
};

function eulerDegToQuat(eulerDeg: [number, number, number]): [number, number, number, number] {
  const q = quat.create();
  quat.fromEuler(q, eulerDeg[0], eulerDeg[1], eulerDeg[2]);
  return [q[0], q[1], q[2], q[3]];
}

function quatToEulerDeg(qIn: quat | [number, number, number, number]): [number, number, number] {
  const q = quat.fromValues(qIn[0], qIn[1], qIn[2], qIn[3]);
  quat.normalize(q, q);
  const x = q[0];
  const y = q[1];
  const z = q[2];
  const w = q[3];
  const sinr = 2 * (w * x + y * z);
  const cosr = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinr, cosr);
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? (Math.sign(sinp) * Math.PI) / 2 : Math.asin(sinp);
  const siny = 2 * (w * z + x * y);
  const cosy = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(siny, cosy);
  return [(roll * 180) / Math.PI, (pitch * 180) / Math.PI, (yaw * 180) / Math.PI];
}

function resolvePieceQuat(t: PieceTransform3d): [number, number, number, number] {
  if (t.rotationQuat && t.rotationQuat.length === 4) {
    return t.rotationQuat;
  }
  return eulerDegToQuat(t.rotationDeg);
}

function applyPiecePlacement(cloth: ClothSimulator, pieceId: string, t: PieceTransform3d): void {
  cloth.applyPieceQuat(pieceId, resolvePieceQuat(t));
  cloth.setPieceCentroid(pieceId, t.position);
}

type NavMode = 'none' | 'orbit' | 'pan' | 'orbitHeight' | 'gizmo' | 'cloth';

export type Transform3dRuntimeOptions = {
  onPoseChange?: (transform: Transform3dInstance) => void;
  /** Fired once before a placement gesture so the host can snapshot undo history. */
  onBeforePoseChange?: () => void;
  onSelectionChange?: (pieceId: string | null) => void;
  /**
   * Two cloth edges were clicked together with the sew tool. The host owns the
   * pattern, the undo snapshot and the rebuild.
   */
  onSewEdges?: (a: SeamEdgeRef, b: SeamEdgeRef) => void;
  /** Right-clicked an edge that a seam runs along: flop that seam end for end. */
  onReverseSeam?: (seamId: string) => void;
};

export class Transform3dRuntime {
  readonly transformId: string;
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  renderer: Renderer | null = null;
  camera: Camera;
  cloth: ClothSimulator | null = null;
  private avatarBody: AvatarBody | null = null;
  private device: GPUDevice;
  private viewGnomon: ViewportGnomon | null = null;
  private moveGizmo: MoveGizmo | null = null;
  private selectionOverlay: SelectionOverlay | null = null;
  private transformToggle: HTMLButtonElement | null = null;
  private snapToggle: HTMLButtonElement | null = null;
  private sewToggle: HTMLButtonElement | null = null;
  /** Edge highlighting, clicking and reversing, shared with the drape viewport. */
  private sewTool: ClothSewTool | null = null;
  /** Seams live in the pattern; the tool reads them to know what to reverse. */
  private pattern: PatternDocument | null = null;
  /** Quadrant snap tool: shows the grids and centres pieces on click. */
  private snapToQuadrantEnabled = false;
  private quadrantLayout: QuadrantLayout = buildQuadrantLayout();
  private hoveredQuadrant: number | null = null;
  /** Cell picked on pointerdown; committed on click (not on drag). */
  private pendingQuadrantSnap: number | null = null;
  private hoverClientX = 0;
  private hoverClientY = 0;
  private hoverValid = false;
  /** Primary (last-clicked) piece — drives the inspector and local-axis ops. */
  private selectedPieceId: string | null = null;
  /** Full multi-selection; may contain several pieces for group transforms. */
  private selectedPieceIds: Set<string> = new Set();
  private transformMode: TransformMode = 'translate';
  private nav: NavMode = 'none';
  private lastX = 0;
  private lastY = 0;
  private pointerMoved = false;
  private lastAxisSnap: AxisId | null = null;
  /** Group pivot (mean of selected centroids) captured at drag start. */
  private dragPivot: vec3 = vec3.create();
  private gizmoAxis: MoveAxis | null = null;
  private lastPlaneHit: vec3 | null = null;
  private dragPlanePoint: vec3 = vec3.create();
  private dragPlaneNormal: vec3 = vec3.fromValues(0, 1, 0);
  private transform: Transform3dInstance;
  private defaultCamera: SimCameraState;
  private onPoseChange?: (transform: Transform3dInstance) => void;
  private onBeforePoseChange?: () => void;
  private onSelectionChange?: (pieceId: string | null) => void;
  private onSewEdges?: (a: SeamEdgeRef, b: SeamEdgeRef) => void;
  private onReverseSeam?: (seamId: string) => void;
  private poseHistoryArmed = false;

  constructor(
    transformId: string,
    canvas: HTMLCanvasElement,
    host: HTMLElement,
    device: GPUDevice,
    transform: Transform3dInstance,
    defaultCamera: SimCameraState,
    options: Transform3dRuntimeOptions = {}
  ) {
    this.transformId = transformId;
    this.transform = transform;
    this.defaultCamera = defaultCamera;
    this.onPoseChange = options.onPoseChange;
    this.onBeforePoseChange = options.onBeforePoseChange;
    this.onSelectionChange = options.onSelectionChange;
    this.onSewEdges = options.onSewEdges;
    this.onReverseSeam = options.onReverseSeam;
    this.canvas = canvas;
    this.host = host;
    this.device = device;
    this.camera = new Camera();
    this.applyCamera(transform);
  }

  setDefaultCamera(camera: SimCameraState): void {
    this.defaultCamera = camera;
  }

  /**
   * Tear the runtime down completely. Rebuilding replaces the runtime, so every
   * element appended to the host has to go with it or the next one stacks a
   * second set of controls on top.
   */
  dispose(): void {
    this.cloth?.destroy();
    this.cloth = null;
    this.renderer = null;
    this.viewGnomon?.destroy();
    this.viewGnomon = null;
    this.moveGizmo?.destroy();
    this.moveGizmo = null;
    this.selectionOverlay?.destroy();
    this.selectionOverlay = null;
    this.sewTool?.destroy();
    this.sewTool = null;
    this.transformToggle?.remove();
    this.transformToggle = null;
    this.snapToggle?.remove();
    this.snapToggle = null;
    this.sewToggle?.remove();
    this.sewToggle = null;
  }

  getSelectedPieceId(): string | null {
    return this.selectedPieceId;
  }

  /** All currently selected piece ids (multi-select aware). */
  getSelectedPieceIds(): string[] {
    return [...this.selectedPieceIds];
  }

  isPieceSelected(pieceId: string): boolean {
    return this.selectedPieceIds.has(pieceId);
  }

  setSelectedPieceId(pieceId: string | null): void {
    this.setPieceSelected(pieceId);
  }

  getPieceIds(): string[] {
    if (!this.cloth) return [];
    const ids = new Set<string>();
    for (const id of this.cloth.getVertexPieceIds()) {
      if (id) ids.add(id);
    }
    return [...ids];
  }

  syncFromDocument(transform: Transform3dInstance): void {
    this.transform = transform;
  }

  applyCamera(transform: Transform3dInstance): void {
    migrateLegacySimCamera(transform.camera, this.defaultCamera);
    this.camera.setDistance(transform.camera.distance);
    this.camera.setAzimuth((transform.camera.azimuth * 180) / Math.PI);
    this.camera.setIncline((transform.camera.elevation * 180) / Math.PI);
    this.camera.setPanX(transform.camera.target[0]);
    this.camera.setPanY(transform.camera.target[1]);
    this.camera.setPanZ(transform.camera.target[2]);
  }

  captureCamera(transform: Transform3dInstance): void {
    transform.camera.distance = this.camera.getDistance();
    transform.camera.azimuth = (this.camera.getAzimuth() * Math.PI) / 180;
    transform.camera.elevation = (this.camera.getIncline() * Math.PI) / 180;
    transform.camera.target = [this.camera.getPanX(), this.camera.getPanY(), this.camera.getPanZ()];
  }

  /**
   * Apply a camera state verbatim, skipping legacy migration / re-framing.
   * Used to preserve the user's exact view when undo/redo restores a snapshot.
   */
  setCameraState(camera: SimCameraState): void {
    this.camera.setDistance(camera.distance);
    this.camera.setAzimuth((camera.azimuth * 180) / Math.PI);
    this.camera.setIncline((camera.elevation * 180) / Math.PI);
    this.camera.setPanX(camera.target[0]);
    this.camera.setPanY(camera.target[1]);
    this.camera.setPanZ(camera.target[2]);
    this.syncMoveGizmo();
  }

  private markBeforePoseChange(): void {
    if (this.poseHistoryArmed) return;
    this.poseHistoryArmed = true;
    this.onBeforePoseChange?.();
  }

  private endPoseHistoryGesture(): void {
    this.poseHistoryArmed = false;
  }

  persistArrangement(): void {
    if (!this.cloth) return;
    this.syncPieceTransformsFromCloth();
    this.transform.pose = this.cloth.exportPose();
    this.onPoseChange?.(this.transform);
    this.endPoseHistoryGesture();
  }

  private syncPieceTransformsFromCloth(): void {
    if (!this.cloth) return;
    const liveIds = new Set(this.getPieceIds());
    // A cloth without per-piece ownership (legacy mesh whose vertices all map to
    // the fallback id) can't describe individual pieces. Leave existing
    // placements alone rather than wiping every real piece id.
    const hasPieceOwnership = [...liveIds].some((id) => id !== FALLBACK_PIECE_ID);
    if (!hasPieceOwnership) return;

    for (const pieceId of liveIds) {
      const existing = this.transform.pieceTransforms[pieceId];
      const q = resolvePieceQuat(
        existing ?? {
          position: this.cloth.getPieceCentroidTuple(pieceId),
          rotationDeg: [0, 0, 0],
        }
      );
      this.transform.pieceTransforms[pieceId] = {
        position: this.cloth.getPieceCentroidTuple(pieceId),
        rotationDeg: existing?.rotationDeg ?? quatToEulerDeg(q),
        rotationQuat: [q[0], q[1], q[2], q[3]],
      };
    }
    // Drop placements for pieces that were removed from the pattern/mesh.
    for (const pieceId of Object.keys(this.transform.pieceTransforms)) {
      if (!liveIds.has(pieceId)) delete this.transform.pieceTransforms[pieceId];
    }
  }

  private pieceLocalAxisInWorld(pieceId: string, localAxis: vec3): vec3 | null {
    const existing = this.transform.pieceTransforms[pieceId];
    const orientation = quat.fromValues(
      ...resolvePieceQuat(
        existing ?? {
          position: this.cloth?.getPieceCentroidTuple(pieceId) ?? [0, 0, 0],
          rotationDeg: [0, 0, 0],
        }
      )
    );
    const worldAxis = vec3.create();
    vec3.transformQuat(worldAxis, localAxis, orientation);
    if (vec3.squaredLength(worldAxis) < 1e-8) return null;
    vec3.normalize(worldAxis, worldAxis);
    return worldAxis;
  }

  /** Record an incremental world-axis rotation so remesh can restore orientation. */
  private accumulatePieceRotation(pieceId: string, axis: vec3, radians: number): void {
    if (!this.cloth || Math.abs(radians) < 1e-8) return;
    const existing = this.transform.pieceTransforms[pieceId];
    const current = quat.fromValues(...resolvePieceQuat(existing ?? {
      position: this.cloth.getPieceCentroidTuple(pieceId),
      rotationDeg: [0, 0, 0],
    }));
    const delta = quat.create();
    const normalized = vec3.clone(axis);
    if (vec3.squaredLength(normalized) < 1e-8) return;
    vec3.normalize(normalized, normalized);
    quat.setAxisAngle(delta, normalized, radians);
    quat.multiply(current, delta, current);
    quat.normalize(current, current);
    const rotationQuat: [number, number, number, number] = [
      current[0],
      current[1],
      current[2],
      current[3],
    ];
    this.transform.pieceTransforms[pieceId] = {
      position: this.cloth.getPieceCentroidTuple(pieceId),
      rotationDeg: quatToEulerDeg(rotationQuat),
      rotationQuat,
    };
  }

  applyPieceTransform(
    pieceId: string,
    position: [number, number, number],
    rotationDeg: [number, number, number]
  ): void {
    if (!this.cloth) return;
    this.markBeforePoseChange();
    const rotationQuat = eulerDegToQuat(rotationDeg);
    this.transform.pieceTransforms[pieceId] = { position, rotationDeg, rotationQuat };
    applyPiecePlacement(this.cloth, pieceId, this.transform.pieceTransforms[pieceId]);
    this.persistArrangement();
    this.syncMoveGizmo();
  }

  resetLayout(): void {
    this.markBeforePoseChange();
    if (this.cloth) {
      this.cloth.resetToInitialState();
      this.applyDefaultArrangement();
      this.setPieceSelected(null);
      this.persistArrangement();
    } else {
      this.transform.pose = null;
      this.transform.pieceTransforms = {};
    }
    this.endPoseHistoryGesture();
  }

  /** Stand pattern pieces upright (-90° X) from the flat mesh layout. */
  private applyDefaultArrangement(): void {
    if (!this.cloth) return;
    const axis = vec3.fromValues(1, 0, 0);
    const radians = (DEFAULT_TRANSFORM_PIECE_ROTATION_DEG[0] * Math.PI) / 180;
    if (Math.abs(radians) > 1e-8) {
      for (const pieceId of this.getPieceIds()) {
        this.cloth.rotateBy(axis, radians, pieceId);
      }
    }
    const rotationQuat = eulerDegToQuat(DEFAULT_TRANSFORM_PIECE_ROTATION_DEG);
    const pieceTransforms: Record<string, PieceTransform3d> = {};
    for (const pieceId of this.getPieceIds()) {
      pieceTransforms[pieceId] = {
        position: this.cloth.getPieceCentroidTuple(pieceId),
        rotationDeg: [...DEFAULT_TRANSFORM_PIECE_ROTATION_DEG],
        rotationQuat: [...rotationQuat],
      };
    }
    this.transform.pieceTransforms = pieceTransforms;
    this.transform.pose = this.cloth.exportPose();
  }

  async initRenderer(): Promise<void> {
    this.resize();
    const { renderer } = await createViewportRenderer(this.device, this.canvas);
    this.renderer = renderer;
    this.avatarBody = await loadAvatarBody(this.device);
    migrateLegacySimCamera(this.transform.camera, this.defaultCamera);
    this.applyCamera(this.transform);
    this.mountViewGnomon();
    this.selectionOverlay = new SelectionOverlay(this.host);
    this.sewTool = new ClothSewTool({
      host: this.host,
      canvas: this.canvas,
      getCloth: () => this.cloth,
      getCamera: () => this.camera,
      getPattern: () => this.pattern,
      onSewEdges: (a, b) => this.onSewEdges?.(a, b),
      onReverseSeam: (seamId) => this.onReverseSeam?.(seamId),
    });
    this.mountMoveGizmo();
    this.mountTransformToggle();
    this.mountSnapToggle();
    this.mountSewToggle();
    this.bindPointer();
    this.bindKeyboard();
  }

  /**
   * Sew tool: hover a cloth edge to light it up, click two of them to join them.
   *
   * Edges are the piece outlines, so this is the same operation the pattern
   * editor's sew tool performs, done against the cloth in three dimensions. The
   * tool takes clicks while it is on, so the move/rotate/snap tools stand down —
   * dragging still orbits, which is how you get to the other side of a garment.
   * The behaviour itself lives in `ClothSewTool`, shared with the drape viewport.
   */
  private mountSewToggle(): void {
    this.sewToggle?.remove();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sim-sew-toggle';
    button.textContent = 'Sew edges';
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('pointerdown', (e) => e.stopPropagation());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setSewEnabled(!this.isSewEnabled());
    });
    this.host.appendChild(button);
    this.sewToggle = button;
    this.syncSewToggle();
  }

  setSewEnabled(enabled: boolean): void {
    if (enabled && this.snapToQuadrantEnabled) this.setSnapToQuadrant(false);
    this.sewTool?.setEnabled(enabled);
    this.syncSewToggle();
    this.syncCursor();
  }

  isSewEnabled(): boolean {
    return this.sewTool?.isEnabled() ?? false;
  }

  private syncSewToggle(): void {
    if (!this.sewToggle) return;
    const usable = this.sewTool?.isAvailable() ?? false;
    const active = this.isSewEnabled();
    this.sewToggle.disabled = !usable;
    this.sewToggle.classList.toggle('is-active', active);
    this.sewToggle.setAttribute('aria-pressed', String(active));
    this.sewToggle.title = usable
      ? 'Sew edges — highlight and click two cloth edges to sew them together · right-click a sewn edge to reverse it'
      : 'Sew edges — needs a mesh built from a pattern, so its outlines are known';
  }

  private syncCursor(): void {
    this.canvas.style.cursor =
      this.isSewEnabled() || this.snapToQuadrantEnabled
        ? 'crosshair'
        : this.selectedPieceIds.size > 0
          ? 'default'
          : 'grab';
  }

  /** Tool button that reveals the quadrant grids (sits under the Move/Rotate toggle). */
  private mountSnapToggle(): void {
    this.snapToggle?.remove();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sim-snap-toggle';
    button.textContent = 'Snap to quadrant';
    button.title =
      'Snap to quadrant — show the 2 × 8 grids, click a piece then click a cell to centre it there';
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('pointerdown', (e) => e.stopPropagation());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setSnapToQuadrant(!this.snapToQuadrantEnabled);
    });
    this.host.appendChild(button);
    this.snapToggle = button;
    this.syncSnapToggle();
  }

  setSnapToQuadrant(enabled: boolean): void {
    this.snapToQuadrantEnabled = enabled;
    this.hoveredQuadrant = null;
    this.pendingQuadrantSnap = null;
    if (enabled) this.setSewEnabled(false);
    this.syncSnapToggle();
    this.pushQuadrantOverlay();
    this.syncCursor();
  }

  isSnapToQuadrantEnabled(): boolean {
    return this.snapToQuadrantEnabled;
  }

  private syncSnapToggle(): void {
    if (!this.snapToggle) return;
    this.snapToggle.classList.toggle('is-active', this.snapToQuadrantEnabled);
    this.snapToggle.setAttribute('aria-pressed', String(this.snapToQuadrantEnabled));
  }

  private pushQuadrantOverlay(): void {
    if (!this.renderer) return;
    if (!this.snapToQuadrantEnabled) {
      this.renderer.setGridOverlay(null);
      return;
    }
    this.renderer.setGridOverlay({
      cells: this.quadrantLayout.cells,
      highlight:
        this.hoveredQuadrant == null
          ? null
          : quadrantCellVertices(this.quadrantLayout, this.hoveredQuadrant),
    });
  }

  /** Recompute which grid cell is under the pointer (uses the last pointer position). */
  private refreshQuadrantHover(): void {
    if (!this.snapToQuadrantEnabled) return;
    let next: number | null = null;
    if (this.hoverValid && this.cloth) {
      this.camera.update();
      const ray = unprojectRay(
        this.hoverClientX,
        this.hoverClientY,
        this.canvas,
        this.camera.getViewProjectMtx()
      );
      const hit = ray ? pickQuadrant(this.quadrantLayout, ray.origin, ray.dir) : null;
      next = hit ? hit.index : null;
    }
    if (next !== this.hoveredQuadrant) {
      this.hoveredQuadrant = next;
      this.pushQuadrantOverlay();
    }
  }

  /** Centre the current selection on a quadrant cell. */
  private snapSelectionToQuadrant(index: number): void {
    if (!this.cloth || this.selectedPieceIds.size === 0) return;
    const center = quadrantCellCenter(this.quadrantLayout, index);
    if (!center) return;
    this.markBeforePoseChange();
    const pivot = this.selectionPivot();
    this.translateSelection(
      vec3.fromValues(center[0] - pivot[0], center[1] - pivot[1], center[2] - pivot[2])
    );
    this.persistArrangement();
    this.syncMoveGizmo();
  }

  /**
   * Rotate the selection 90° around the primary piece's local X axis. For a
   * multi-selection the whole group orbits the shared pivot around that axis.
   */
  rotateSelectedPieceQuarterTurn(): void {
    if (!this.cloth || this.selectedPieceIds.size === 0) return;
    const primary = this.selectedPieceId ?? [...this.selectedPieceIds][0];
    const localX = vec3.fromValues(1, 0, 0);
    const axis = this.pieceLocalAxisInWorld(primary, localX);
    if (!axis) return;
    const quarter = Math.PI / 2;
    this.markBeforePoseChange();
    this.rotateSelectionAroundPivot(axis, quarter, this.selectionPivot());
    for (const id of this.selectedPieceIds) {
      this.accumulatePieceRotation(id, axis, quarter);
    }
    this.persistArrangement();
    this.syncMoveGizmo();
  }

  private bindKeyboard(): void {
    this.canvas.tabIndex = 0;
    this.canvas.style.outline = 'none';
    this.canvas.addEventListener('keydown', (e) => {
      if (e.key !== 'r' && e.key !== 'R') return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        t !== this.canvas &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      if (!this.cloth || this.selectedPieceIds.size === 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.rotateSelectedPieceQuarterTurn();
    });
  }

  private mountTransformToggle(): void {
    this.transformToggle?.remove();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sim-transform-toggle';
    button.addEventListener('pointerdown', (e) => e.stopPropagation());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setTransformMode(this.transformMode === 'translate' ? 'rotate' : 'translate');
    });
    this.host.appendChild(button);
    this.transformToggle = button;
    this.setTransformMode(this.transformMode);
  }

  private setTransformMode(mode: TransformMode): void {
    this.transformMode = mode;
    this.moveGizmo?.setMode(mode);
    if (this.transformToggle) {
      const rotating = mode === 'rotate';
      this.transformToggle.classList.toggle('is-rotate', rotating);
      this.transformToggle.textContent = rotating ? 'Rotate' : 'Move';
      this.transformToggle.title = rotating
        ? 'Rotation mode — drag a gizmo axis to rotate the selection around the group pivot · R = 90° on local X'
        : 'Move mode — drag the selection or a gizmo axis to translate · Shift-click to multi-select · R = 90° on local X';
      this.transformToggle.setAttribute('aria-pressed', String(rotating));
    }
    this.syncMoveGizmo();
  }

  private mountViewGnomon(): void {
    this.viewGnomon?.destroy();
    this.viewGnomon = new ViewportGnomon(this.host, {
      onOrbit: (dx, dy) => {
        this.camera.setOrthographic(false);
        this.lastAxisSnap = null;
        this.camera.setAzimuth(this.camera.getAzimuth() + dx * 0.45);
        this.camera.setIncline(this.camera.getIncline() + dy * 0.35);
        this.viewGnomon?.syncFromCamera(this.camera);
        this.syncMoveGizmo();
      },
      onAxisClick: (axis) => this.snapToAxis(axis),
      onToggleProjection: () => {
        this.camera.toggleOrthographic();
        this.viewGnomon?.syncFromCamera(this.camera);
        this.syncMoveGizmo();
      },
    });
    this.viewGnomon.syncFromCamera(this.camera);
  }

  private mountMoveGizmo(): void {
    this.moveGizmo?.destroy();
    this.moveGizmo = new MoveGizmo(this.host, {
      onDragStart: (axis, clientX, clientY) => {
        if (!this.cloth || this.selectedPieceIds.size === 0) return;
        this.markBeforePoseChange();
        this.nav = 'gizmo';
        this.gizmoAxis = axis;
        this.cloth.setDragging(true);
        this.camera.update();
        const c = this.selectionPivot();
        vec3.copy(this.dragPlanePoint, c);
        vec3.copy(this.dragPivot, c);
        if (this.transformMode === 'rotate') return;
        if (axis === 'y') {
          const az = (this.camera.getAzimuth() * Math.PI) / 180;
          vec3.set(this.dragPlaneNormal, Math.sin(az), 0, Math.cos(az));
        } else if (axis === 'x') {
          vec3.set(this.dragPlaneNormal, 0, 0, 1);
        } else if (axis === 'z') {
          vec3.set(this.dragPlaneNormal, 1, 0, 0);
        } else {
          const az = (this.camera.getAzimuth() * Math.PI) / 180;
          const inc = (this.camera.getIncline() * Math.PI) / 180;
          vec3.set(
            this.dragPlaneNormal,
            -Math.sin(az) * Math.cos(inc),
            Math.sin(inc),
            -Math.cos(az) * Math.cos(inc)
          );
          vec3.normalize(this.dragPlaneNormal, this.dragPlaneNormal);
        }
        this.lastPlaneHit = this.hitPlane(clientX, clientY) ?? vec3.clone(c);
      },
      onDrag: (_axis, _dx, _dy, clientX, clientY) => {
        if (!this.cloth || !this.gizmoAxis || this.selectedPieceIds.size === 0) return;
        if (this.transformMode === 'rotate') {
          const axis = this.rotationAxis(this.gizmoAxis);
          const angle = (_dx - _dy) * 0.012;
          this.rotateSelectionAroundPivot(axis, angle, vec3.clone(this.dragPivot));
          for (const id of this.selectedPieceIds) {
            this.accumulatePieceRotation(id, axis, angle);
          }
          this.syncMoveGizmo();
          return;
        }
        this.camera.update();
        const hit = this.hitPlane(clientX, clientY);
        if (hit && this.lastPlaneHit) {
          const delta = vec3.create();
          vec3.sub(delta, hit, this.lastPlaneHit);
          if (this.gizmoAxis === 'x') {
            delta[1] = 0;
            delta[2] = 0;
          } else if (this.gizmoAxis === 'y') {
            delta[0] = 0;
            delta[2] = 0;
          } else if (this.gizmoAxis === 'z') {
            delta[0] = 0;
            delta[1] = 0;
          }
          this.translateSelection(delta);
          this.lastPlaneHit = hit;
          vec3.copy(this.dragPlanePoint, this.selectionPivot());
        }
        this.syncMoveGizmo();
      },
      onDragEnd: () => {
        this.cloth?.setDragging(false);
        this.nav = 'none';
        this.gizmoAxis = null;
        this.lastPlaneHit = null;
        this.persistArrangement();
      },
    });
  }

  private snapToAxis(axis: AxisId): void {
    const current = currentAxisView(this.camera.getAzimuth(), this.camera.getIncline());
    let target = axis;
    if (current === axis || this.lastAxisSnap === axis) {
      target = oppositeAxis(axis);
    }
    const angles = axisViewAngles(target);
    this.camera.setAzimuth(angles.azimuth);
    this.camera.setIncline(angles.incline);
    this.camera.setOrthographic(true);
    this.lastAxisSnap = target;
    this.viewGnomon?.syncFromCamera(this.camera);
    this.syncMoveGizmo();
  }

  private setPieceSelected(pieceId: string | null): void {
    this.setPieceSelection(pieceId ? [pieceId] : [], pieceId);
  }

  /** Shift-click behaviour: add the piece to / remove it from the selection. */
  private togglePieceSelected(pieceId: string): void {
    if (this.selectedPieceIds.has(pieceId)) {
      const remaining = [...this.selectedPieceIds].filter((id) => id !== pieceId);
      const primary =
        this.selectedPieceId === pieceId ? (remaining[remaining.length - 1] ?? null) : this.selectedPieceId;
      this.setPieceSelection(remaining, primary);
    } else {
      this.setPieceSelection([...this.selectedPieceIds, pieceId], pieceId);
    }
  }

  private setPieceSelection(ids: string[], primary: string | null): void {
    this.selectedPieceIds = new Set(ids);
    this.selectedPieceId = primary;
    this.syncMoveGizmo();
    this.syncCursor();
    this.onSelectionChange?.(primary);
  }

  /** Mean of the selected pieces' centroids — the shared transform pivot. */
  private selectionPivot(): vec3 {
    const pivot = vec3.create();
    if (!this.cloth || this.selectedPieceIds.size === 0) return pivot;
    for (const id of this.selectedPieceIds) {
      vec3.add(pivot, pivot, this.cloth.getCentroid(id));
    }
    vec3.scale(pivot, pivot, 1 / this.selectedPieceIds.size);
    return pivot;
  }

  /** Translate every selected piece by the same world-space delta. */
  private translateSelection(delta: vec3): void {
    if (!this.cloth || this.selectedPieceIds.size === 0) return;
    for (const id of this.selectedPieceIds) {
      this.cloth.translateBy(delta, id);
    }
  }

  /**
   * Rotate every selected piece rigidly around a shared world-space pivot:
   * reorient each piece about its own centroid, then orbit that centroid around
   * the pivot. A single selected piece (pivot === its centroid) degrades to a
   * plain in-place rotation.
   */
  private rotateSelectionAroundPivot(axis: vec3, radians: number, pivot: vec3): void {
    if (!this.cloth || this.selectedPieceIds.size === 0) return;
    if (!Number.isFinite(radians) || Math.abs(radians) < 1e-8) return;
    const normalized = vec3.clone(axis);
    if (vec3.squaredLength(normalized) < 1e-8) return;
    vec3.normalize(normalized, normalized);
    const rotation = quat.create();
    quat.setAxisAngle(rotation, normalized, radians);
    const rel = vec3.create();
    const target = vec3.create();
    const delta = vec3.create();
    for (const id of this.selectedPieceIds) {
      const before = this.cloth.getCentroid(id);
      this.cloth.rotateBy(normalized, radians, id);
      vec3.sub(rel, before, pivot);
      vec3.transformQuat(rel, rel, rotation);
      vec3.add(target, pivot, rel);
      vec3.sub(delta, target, before);
      this.cloth.translateBy(delta, id);
    }
  }

  private syncMoveGizmo(): void {
    if (!this.moveGizmo) return;
    if (!this.cloth || this.selectedPieceIds.size === 0) {
      this.moveGizmo.setVisible(false);
      this.selectionOverlay?.sync([], null);
      return;
    }
    this.camera.update();

    const markers: Array<{ id: string; x: number; y: number }> = [];
    for (const id of this.selectedPieceIds) {
      const c = this.cloth.getCentroid(id);
      const px = worldToCanvasPx(c, this.camera, this.canvas);
      if (px && !px.behind) markers.push({ id, x: px.x, y: px.y });
    }
    const pivot = this.selectionPivot();
    const pivotPx = worldToCanvasPx(pivot, this.camera, this.canvas);
    this.selectionOverlay?.sync(
      markers,
      pivotPx && !pivotPx.behind ? pivotPx : null
    );

    if (!pivotPx || pivotPx.behind) {
      this.moveGizmo.setVisible(false);
      return;
    }
    this.moveGizmo.setVisible(true);
    this.moveGizmo.setScreenPosition(pivotPx.x, pivotPx.y);
    this.moveGizmo.updateAxisLayout(this.camera);
  }

  private rotationAxis(axis: MoveAxis): vec3 {
    if (axis === 'x') return vec3.fromValues(1, 0, 0);
    if (axis === 'y') return vec3.fromValues(0, 1, 0);
    if (axis === 'z') return vec3.fromValues(0, 0, 1);
    const az = (this.camera.getAzimuth() * Math.PI) / 180;
    const inc = (this.camera.getIncline() * Math.PI) / 180;
    const out = vec3.fromValues(
      -Math.sin(az) * Math.cos(inc),
      Math.sin(inc),
      -Math.cos(az) * Math.cos(inc)
    );
    vec3.normalize(out, out);
    return out;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(2, Math.floor(rect.width * devicePixelRatio));
    const h = Math.max(2, Math.floor(rect.height * devicePixelRatio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.renderer?.resize(w, h);
      this.camera.setAspect(w / h);
    }
  }

  rebuildCloth(
    mesh: MeshGeometry | null | undefined,
    pose: SimPose | null,
    pieceTransforms: Record<string, PieceTransform3d>,
    pattern?: PatternDocument | null
  ): void {
    if (!this.avatarBody) return;
    this.cloth?.destroy();
    const geom =
      mesh && mesh.vertices.length >= 3 && mesh.triangles.length >= 3
        ? mesh
        : triangulatePattern(undefined, DEFAULT_MESH_SETTINGS);
    // Transform 3D: prefer CPU for arrangement; GPU piece ops are available if engine set.
    this.cloth = createClothSimulator(
      resolveEngineKind(ARRANGE_SIM_PARAMS, 'cpu-mass-spring'),
      geom,
      ARRANGE_SIM_PARAMS,
      this.device,
      this.avatarBody,
      pattern ?? undefined
    );

    // Index the new cloth's outline for the sew tool. The tags come from the
    // mesh, so a cloth without them (no pattern behind it) simply has nothing to
    // pick, and the tool says so rather than picking edges that are not there.
    this.pattern = pattern ?? null;
    this.sewTool?.rebuild(geom);
    this.syncSewToggle();

    const liveIds = this.getPieceIds();
    // Retain placements by durable piece id across remesh / add / delete. Pieces
    // replaced by new ids (a knife cut) inherit via `pattern.pieceSuccessors`,
    // and legacy `__cloth__` keys are migrated when the new mesh has real ids.
    const kept = keepPieceTransforms(
      pieceTransforms,
      liveIds,
      this.cloth,
      pattern?.pieceSuccessors
    );
    this.transform.pieceTransforms = kept;

    const poseMatchesTopology =
      !!pose && pose.positions.length === geom.vertices.length * 3 && pose.positions.length >= 12;

    if (poseMatchesTopology) {
      this.cloth.applyPose(pose);
      this.syncPieceTransformsFromCloth();
    } else if (Object.keys(kept).length > 0) {
      for (const [pieceId, t] of Object.entries(kept)) {
        applyPiecePlacement(this.cloth, pieceId, t);
      }
      this.transform.pose = this.cloth.exportPose();
    } else {
      this.applyDefaultArrangement();
    }
    this.setPieceSelected(null);
  }

  setAvatarBody(body: AvatarBody): void {
    this.avatarBody = body;
    this.cloth?.setAvatar(body);
  }

  private bindPointer(): void {
    this.canvas.style.cursor = 'grab';

    this.canvas.addEventListener('pointerdown', (e) => {
      // Edges under the pointer are resolved now and acted on at pointerup, so a
      // drag that started on an edge still orbits and a click still picks.
      if (this.isSewEnabled()) this.sewTool?.beginPress(e.clientX, e.clientY, e.button);

      if (e.button === 1) {
        this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
      } else if (e.button === 2) {
        this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
      } else if (e.button === 0) {
        if (this.isSewEnabled()) {
          // The sew tool takes the click; the move/rotate tools stand down, but
          // dragging still orbits so the far side of the garment is reachable.
          this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
          this.hoverClientX = e.clientX;
          this.hoverClientY = e.clientY;
          this.hoverValid = true;
        } else {
          this.camera.update();
          const ray = unprojectRay(
            e.clientX,
            e.clientY,
            this.canvas,
            this.camera.getViewProjectMtx()
          );
          const hit = ray && this.cloth ? this.cloth.raycast(ray.origin, ray.dir) : null;
          if (hit && this.cloth) {
            if (e.shiftKey) {
              // Shift-click toggles membership; never starts a drag so pieces
              // aren't nudged while building a multi-selection.
              this.togglePieceSelected(hit.pieceId);
              this.nav = 'none';
            } else {
              // Clicking a piece that's already part of a group keeps the group
              // and moves/rotates all of it together.
              if (!this.selectedPieceIds.has(hit.pieceId)) {
                this.setPieceSelected(hit.pieceId);
              }
              this.beginClothDrag(e.clientX, e.clientY);
            }
          } else if (this.snapToQuadrantEnabled && this.selectedPieceIds.size > 0 && ray) {
            // Quadrant tool with a selection: a click centres it on the hovered
            // cell; a drag still orbits (resolved on pointerup via pointerMoved).
            const target = pickQuadrant(this.quadrantLayout, ray.origin, ray.dir);
            this.pendingQuadrantSnap = target ? target.index : null;
            this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
          } else {
            this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
          }
        }
      } else {
        return;
      }

      this.pointerMoved = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.canvas.focus({ preventScroll: true });
      this.canvas.style.cursor =
        this.nav === 'pan'
          ? 'move'
          : this.nav === 'orbitHeight'
            ? 'ns-resize'
            : this.nav === 'cloth'
              ? 'move'
              : this.nav === 'none'
                ? this.isSewEnabled() || this.snapToQuadrantEnabled
                  ? 'crosshair'
                  : this.selectedPieceIds.size > 0
                    ? 'default'
                    : 'grab'
                : 'grabbing';
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    this.canvas.addEventListener('pointerleave', () => {
      this.hoverValid = false;
      if (this.hoveredQuadrant != null) {
        this.hoveredQuadrant = null;
        this.pushQuadrantOverlay();
      }
      if (this.isSewEnabled()) this.sewTool?.clear();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.snapToQuadrantEnabled || this.isSewEnabled()) {
        this.hoverClientX = e.clientX;
        this.hoverClientY = e.clientY;
        this.hoverValid = true;
        if (this.nav === 'none') this.refreshQuadrantHover();
      }
      if (this.isSewEnabled() && this.nav === 'none') {
        this.sewTool?.refreshHover(e.clientX, e.clientY);
      }
      if (this.nav === 'none' || this.nav === 'gizmo') return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.pointerMoved = true;

      if (this.nav === 'cloth') {
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        if (this.transformMode === 'rotate' && this.cloth && this.selectedPieceIds.size > 0) {
          const yawAxis = vec3.fromValues(0, 1, 0);
          const yaw = dx * 0.01;
          const az = (this.camera.getAzimuth() * Math.PI) / 180;
          const cameraRight = vec3.fromValues(Math.cos(az), 0, -Math.sin(az));
          const pitch = dy * 0.01;
          const pivot = vec3.clone(this.dragPivot);
          this.rotateSelectionAroundPivot(yawAxis, yaw, pivot);
          for (const id of this.selectedPieceIds) {
            this.accumulatePieceRotation(id, yawAxis, yaw);
          }
          this.rotateSelectionAroundPivot(cameraRight, pitch, pivot);
          for (const id of this.selectedPieceIds) {
            this.accumulatePieceRotation(id, cameraRight, pitch);
          }
          this.syncMoveGizmo();
          return;
        }
        this.camera.update();
        const hit = this.hitPlane(e.clientX, e.clientY);
        if (hit && this.lastPlaneHit && this.cloth) {
          const delta = vec3.create();
          vec3.sub(delta, hit, this.lastPlaneHit);
          if (this.selectedPieceIds.size === 0) return;
          this.translateSelection(delta);
          this.lastPlaneHit = hit;
          vec3.copy(this.dragPlanePoint, this.selectionPivot());
        }
        this.syncMoveGizmo();
        return;
      }

      if (this.nav === 'orbit') {
        if (!this.pointerMoved) return;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.camera.setOrthographic(false);
        this.lastAxisSnap = null;
        this.camera.setAzimuth(this.camera.getAzimuth() + dx * 0.4);
        this.camera.setIncline(this.camera.getIncline() + dy * 0.3);
        this.viewGnomon?.syncFromCamera(this.camera);
        this.syncMoveGizmo();
        return;
      }
      if (this.nav === 'orbitHeight') {
        if (!this.pointerMoved) return;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        const rect = this.canvas.getBoundingClientRect();
        this.camera.panOrbitVertical(dy, rect.height);
        this.viewGnomon?.syncFromCamera(this.camera);
        this.syncMoveGizmo();
        return;
      }
      if (this.nav === 'pan') {
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        const rect = this.canvas.getBoundingClientRect();
        this.camera.panScreen(dx, dy, rect.height);
        this.syncMoveGizmo();
      }
    });

    const endDrag = (e: PointerEvent) => {
      const wasOrbitClick = this.nav === 'orbit' && (e.button === 0 || e.button === -1) && !this.pointerMoved;
      const wasCloth = this.nav === 'cloth';
      const pendingSnap = this.pendingQuadrantSnap;
      this.pendingQuadrantSnap = null;
      const movedCamera = this.nav === 'orbit' || this.nav === 'orbitHeight' || this.nav === 'pan';
      // The tool reads its own gesture off pointerup, so a drag never sews.
      const sewConsumed = this.isSewEnabled()
        ? this.sewTool?.endPress(this.pointerMoved, e.button) ?? false
        : false;
      if (wasCloth) {
        this.cloth?.setDragging(false);
        this.gizmoAxis = null;
        this.lastPlaneHit = null;
        this.persistArrangement();
      }
      if (movedCamera && this.pointerMoved) {
        this.captureCamera(this.transform);
      }
      this.nav = 'none';
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }

      if (sewConsumed) {
        // The sew tool acted on this click — it does not also mean "deselect".
      } else if (pendingSnap != null && !this.pointerMoved) {
        // Quadrant click (not a drag) — centre the selection on that cell.
        this.snapSelectionToQuadrant(pendingSnap);
      } else if (wasOrbitClick && !this.isSewEnabled()) {
        this.setPieceSelected(null);
      }
      // A drag that moved the camera moves the cloth under the pointer too.
      if (this.isSewEnabled() && this.pointerMoved) {
        this.sewTool?.refreshHover(e.clientX, e.clientY);
      }
      this.syncCursor();
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.06 : 0.94;
        this.camera.setDistance(Math.max(1.5, Math.min(80, this.camera.getDistance() * factor)));
        this.viewGnomon?.syncFromCamera(this.camera);
        this.syncMoveGizmo();
      },
      { passive: false }
    );
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private beginClothDrag(clientX: number, clientY: number): void {
    if (!this.cloth || this.selectedPieceIds.size === 0) return;
    this.markBeforePoseChange();
    this.nav = 'cloth';
    this.gizmoAxis = 'free';
    this.cloth.setDragging(true);
    this.camera.update();
    const c = this.selectionPivot();
    vec3.copy(this.dragPlanePoint, c);
    vec3.copy(this.dragPivot, c);
    const az = (this.camera.getAzimuth() * Math.PI) / 180;
    const inc = (this.camera.getIncline() * Math.PI) / 180;
    vec3.set(
      this.dragPlaneNormal,
      -Math.sin(az) * Math.cos(inc),
      Math.sin(inc),
      -Math.cos(az) * Math.cos(inc)
    );
    vec3.normalize(this.dragPlaneNormal, this.dragPlaneNormal);
    this.lastPlaneHit =
      this.transformMode === 'translate'
        ? this.hitPlane(clientX, clientY) ?? vec3.clone(c)
        : null;
  }

  private hitPlane(clientX: number, clientY: number): vec3 | null {
    const ray = unprojectRay(clientX, clientY, this.canvas, this.camera.getViewProjectMtx());
    if (!ray) return null;
    const denom = vec3.dot(this.dragPlaneNormal, ray.dir);
    if (Math.abs(denom) < 1e-8) return null;
    const toPlane = vec3.create();
    vec3.sub(toPlane, this.dragPlanePoint, ray.origin);
    const t = vec3.dot(toPlane, this.dragPlaneNormal) / denom;
    if (t < 0) return null;
    const hit = vec3.create();
    vec3.scaleAndAdd(hit, ray.origin, ray.dir, t);
    return hit;
  }

  /**
   * One frame. Nothing here changes with time — the arrangement is static — so a
   * covered viewport simply does not draw until it is uncovered.
   */
  frame(visible = true): void {
    if (!visible) return;
    if (!this.renderer || !this.cloth) return;
    this.resize();
    this.cloth.update(false);
    this.camera.update();
    // Keep the quadrant highlight in sync as the camera orbits/zooms.
    if (this.snapToQuadrantEnabled) this.refreshQuadrantHover();
    // Same for the sew highlight: it is projected once per frame, so it follows
    // the camera and the cloth rather than drifting off the edge it marks.
    if (this.isSewEnabled()) this.sewTool?.sync();
    this.renderer.render(this.cloth, this.camera);
    this.syncMoveGizmo();
  }
}
