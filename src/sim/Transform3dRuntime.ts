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
import { FALLBACK_PIECE_ID } from './meshTopology';
import { DEFAULT_TRANSFORM_PIECE_ROTATION_DEG } from './transformDefaults';
import type {
  MeshGeometry,
  PatternDocument,
  PieceTransform3d,
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

function clonePieceTransform(t: PieceTransform3d): PieceTransform3d {
  return {
    position: [...t.position] as [number, number, number],
    rotationDeg: [...t.rotationDeg] as [number, number, number],
    rotationQuat: t.rotationQuat
      ? ([...t.rotationQuat] as [number, number, number, number])
      : undefined,
  };
}

/**
 * Keep placements for live piece ids. Also migrate legacy `__cloth__` keys that
 * were used when the mesh lacked per-vertex piece ownership — otherwise remesh
 * drops every saved transform and snaps back to the flat layout.
 */
function keepPieceTransforms(
  pieceTransforms: Record<string, PieceTransform3d>,
  liveIds: string[],
  cloth: ClothSimulator
): Record<string, PieceTransform3d> {
  const live = new Set(liveIds);
  const kept: Record<string, PieceTransform3d> = {};
  for (const [pieceId, t] of Object.entries(pieceTransforms)) {
    if (!live.has(pieceId) || pieceId === FALLBACK_PIECE_ID) continue;
    kept[pieceId] = clonePieceTransform(t);
  }

  const fallback = pieceTransforms[FALLBACK_PIECE_ID];
  if (!fallback || live.has(FALLBACK_PIECE_ID)) return kept;
  if (Object.keys(kept).length > 0) return kept;

  if (liveIds.length === 1) {
    kept[liveIds[0]] = clonePieceTransform(fallback);
    return kept;
  }

  // Whole-cloth arrangement → distribute the same rotation and group translation
  // across pieces (rest layout is already the post-remesh flat pose).
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const id of liveIds) {
    const c = cloth.getPieceCentroidTuple(id);
    cx += c[0];
    cy += c[1];
    cz += c[2];
  }
  const n = Math.max(liveIds.length, 1);
  const dx = fallback.position[0] - cx / n;
  const dy = fallback.position[1] - cy / n;
  const dz = fallback.position[2] - cz / n;
  for (const id of liveIds) {
    const c = cloth.getPieceCentroidTuple(id);
    kept[id] = {
      position: [c[0] + dx, c[1] + dy, c[2] + dz],
      rotationDeg: [...fallback.rotationDeg] as [number, number, number],
      rotationQuat: fallback.rotationQuat
        ? ([...fallback.rotationQuat] as [number, number, number, number])
        : undefined,
    };
  }
  return kept;
}

type NavMode = 'none' | 'orbit' | 'pan' | 'orbitHeight' | 'gizmo' | 'cloth';

export type Transform3dRuntimeOptions = {
  onPoseChange?: (transform: Transform3dInstance) => void;
  /** Fired once before a placement gesture so the host can snapshot undo history. */
  onBeforePoseChange?: () => void;
  onSelectionChange?: (pieceId: string | null) => void;
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
  private transformToggle: HTMLButtonElement | null = null;
  private selectedPieceId: string | null = null;
  private transformMode: TransformMode = 'translate';
  private nav: NavMode = 'none';
  private lastX = 0;
  private lastY = 0;
  private pointerMoved = false;
  private lastAxisSnap: AxisId | null = null;
  private gizmoAxis: MoveAxis | null = null;
  private lastPlaneHit: vec3 | null = null;
  private dragPlanePoint: vec3 = vec3.create();
  private dragPlaneNormal: vec3 = vec3.fromValues(0, 1, 0);
  private transform: Transform3dInstance;
  private defaultCamera: SimCameraState;
  private onPoseChange?: (transform: Transform3dInstance) => void;
  private onBeforePoseChange?: () => void;
  private onSelectionChange?: (pieceId: string | null) => void;
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
    this.canvas = canvas;
    this.host = host;
    this.device = device;
    this.camera = new Camera();
    this.applyCamera(transform);
  }

  setDefaultCamera(camera: SimCameraState): void {
    this.defaultCamera = camera;
  }

  getSelectedPieceId(): string | null {
    return this.selectedPieceId;
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

  /** Record an incremental local-axis rotation so remesh can restore orientation. */
  private accumulatePieceLocalRotation(
    pieceId: string,
    localAxis: vec3,
    radians: number
  ): void {
    if (!this.cloth || Math.abs(radians) < 1e-8) return;
    const existing = this.transform.pieceTransforms[pieceId];
    const current = quat.fromValues(
      ...resolvePieceQuat(
        existing ?? {
          position: this.cloth.getPieceCentroidTuple(pieceId),
          rotationDeg: [0, 0, 0],
        }
      )
    );
    const delta = quat.create();
    const normalizedLocal = vec3.clone(localAxis);
    if (vec3.squaredLength(normalizedLocal) < 1e-8) return;
    vec3.normalize(normalizedLocal, normalizedLocal);
    quat.setAxisAngle(delta, normalizedLocal, radians);
    quat.multiply(current, current, delta);
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
    this.mountMoveGizmo();
    this.mountTransformToggle();
    this.bindPointer();
    this.bindKeyboard();
  }

  /** Rotate the selected piece by 90° around its local X axis. */
  rotateSelectedPieceQuarterTurn(): void {
    if (!this.cloth || !this.selectedPieceId) return;
    const localX = vec3.fromValues(1, 0, 0);
    const axis = this.pieceLocalAxisInWorld(this.selectedPieceId, localX);
    if (!axis) return;
    const quarter = Math.PI / 2;
    this.markBeforePoseChange();
    this.cloth.rotateBy(axis, quarter, this.selectedPieceId);
    this.accumulatePieceLocalRotation(this.selectedPieceId, localX, quarter);
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
      if (!this.cloth || !this.selectedPieceId) return;
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
        ? 'Rotation mode — drag a gizmo axis to rotate the selected piece · R = 90° on local X'
        : 'Move mode — drag the selected piece or a gizmo axis to translate · R = 90° on local X';
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
        if (!this.cloth || !this.selectedPieceId) return;
        this.markBeforePoseChange();
        this.nav = 'gizmo';
        this.gizmoAxis = axis;
        this.cloth.setDragging(true);
        this.camera.update();
        const c = this.cloth.getCentroid(this.selectedPieceId);
        vec3.copy(this.dragPlanePoint, c);
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
        if (!this.cloth || !this.gizmoAxis || !this.selectedPieceId) return;
        if (this.transformMode === 'rotate') {
          const axis = this.rotationAxis(this.gizmoAxis);
          const angle = (_dx - _dy) * 0.012;
          this.cloth.rotateBy(axis, angle, this.selectedPieceId);
          this.accumulatePieceRotation(this.selectedPieceId, axis, angle);
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
          this.cloth.translateBy(delta, this.selectedPieceId);
          this.lastPlaneHit = hit;
          vec3.copy(this.dragPlanePoint, this.cloth.getCentroid(this.selectedPieceId));
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
    this.selectedPieceId = pieceId;
    this.moveGizmo?.setVisible(pieceId !== null);
    this.syncMoveGizmo();
    this.canvas.style.cursor = pieceId ? 'default' : 'grab';
    this.onSelectionChange?.(pieceId);
  }

  private syncMoveGizmo(): void {
    if (!this.moveGizmo || !this.cloth || !this.selectedPieceId) return;
    this.camera.update();
    const c = this.cloth.getCentroid(this.selectedPieceId);
    const px = worldToCanvasPx(c, this.camera, this.canvas);
    if (!px || px.behind) {
      this.moveGizmo.setVisible(false);
      return;
    }
    this.moveGizmo.setVisible(true);
    this.moveGizmo.setScreenPosition(px.x, px.y);
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

    const liveIds = this.getPieceIds();
    // Keep caller-provided placements for pieces that still exist (remesh / add piece).
    // Remap legacy `__cloth__` keys when the new mesh has real pattern piece ids.
    const kept = keepPieceTransforms(pieceTransforms, liveIds, this.cloth);
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
      if (e.button === 1) {
        this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
      } else if (e.button === 2) {
        this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
      } else if (e.button === 0) {
        this.camera.update();
        const ray = unprojectRay(e.clientX, e.clientY, this.canvas, this.camera.getViewProjectMtx());
        const hit = ray && this.cloth ? this.cloth.raycast(ray.origin, ray.dir) : null;
        if (hit && this.cloth) {
          this.setPieceSelected(hit.pieceId);
          this.beginClothDrag(e.clientX, e.clientY);
        } else {
          this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
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
              : 'grabbing';
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (this.nav === 'none' || this.nav === 'gizmo') return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.pointerMoved = true;

      if (this.nav === 'cloth') {
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        if (this.transformMode === 'rotate' && this.cloth && this.selectedPieceId) {
          const yawAxis = vec3.fromValues(0, 1, 0);
          const yaw = dx * 0.01;
          this.cloth.rotateBy(yawAxis, yaw, this.selectedPieceId);
          this.accumulatePieceRotation(this.selectedPieceId, yawAxis, yaw);
          const az = (this.camera.getAzimuth() * Math.PI) / 180;
          const cameraRight = vec3.fromValues(Math.cos(az), 0, -Math.sin(az));
          const pitch = dy * 0.01;
          this.cloth.rotateBy(cameraRight, pitch, this.selectedPieceId);
          this.accumulatePieceRotation(this.selectedPieceId, cameraRight, pitch);
          this.syncMoveGizmo();
          return;
        }
        this.camera.update();
        const hit = this.hitPlane(e.clientX, e.clientY);
        if (hit && this.lastPlaneHit && this.cloth) {
          const delta = vec3.create();
          vec3.sub(delta, hit, this.lastPlaneHit);
          if (!this.selectedPieceId) return;
          this.cloth.translateBy(delta, this.selectedPieceId);
          this.lastPlaneHit = hit;
          vec3.copy(this.dragPlanePoint, this.cloth.getCentroid(this.selectedPieceId));
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
      const movedCamera = this.nav === 'orbit' || this.nav === 'orbitHeight' || this.nav === 'pan';
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

      if (wasOrbitClick) {
        this.setPieceSelected(null);
      }
      this.canvas.style.cursor = this.selectedPieceId ? 'default' : 'grab';
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
    if (!this.cloth || !this.selectedPieceId) return;
    this.markBeforePoseChange();
    this.nav = 'cloth';
    this.gizmoAxis = 'free';
    this.cloth.setDragging(true);
    this.camera.update();
    const c = this.cloth.getCentroid(this.selectedPieceId);
    vec3.copy(this.dragPlanePoint, c);
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

  frame(): void {
    if (!this.renderer || !this.cloth) return;
    this.resize();
    this.cloth.update(false);
    this.camera.update();
    this.renderer.render(this.cloth, this.camera);
    this.syncMoveGizmo();
  }
}
