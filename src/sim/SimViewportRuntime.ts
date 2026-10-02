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
import { SelectionOverlay } from './SelectionOverlay';
import { DEFAULT_MESH_SETTINGS, triangulatePattern } from '../mesh/triangulate';
import {
  buildIncidentTriangles,
  buildPatternPointMarkers,
  computeVertexNormal,
  markerFacesCamera,
  type IncidentTriangles,
  type PatternPointMarker,
} from './patternPointMarkers';
import { PatternPointOverlay } from './PatternPointOverlay';
import {
  migrateLegacySimCamera,
  setDefaultSimCamera,
} from './cameraDefaults';
import type { MeshGeometry, PatternDocument, SimCameraState, SimInstance, SimParams } from '../project/types';

export type SimViewportRuntimeOptions = {
  /**
   * Called when the user applies an edit made in the pattern-point overlay.
   * The host is responsible for committing it (undo snapshot, remesh, rebuild).
   */
  onApplyPatternEdit?: (patternId: string, edited: PatternDocument) => void;
};

export type SharedGpu = {
  device: GPUDevice;
};

export async function createSharedGpu(): Promise<SharedGpu> {
  if (!navigator.gpu) throw new Error('WebGPU is not supported in this browser');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Failed to get GPU adapter');
  const device = await adapter.requestDevice();
  return { device };
}

export async function createViewportRenderer(
  device: GPUDevice,
  canvas: HTMLCanvasElement
): Promise<{ renderer: Renderer; context: GPUCanvasContext; format: GPUTextureFormat }> {
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Failed to get WebGPU context');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });

  const depthTexture = device.createTexture({
    size: [canvas.width, canvas.height],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const depthTextureView = depthTexture.createView();

  const renderer = new Renderer(device, context, format, depthTexture, depthTextureView, canvas);
  await renderer.initialize(vertexShaderCode, fragmentShaderCode);
  return { renderer, context, format };
}

type NavMode = 'none' | 'orbit' | 'pan' | 'orbitHeight' | 'gizmo' | 'cloth';

export class SimViewportRuntime {
  readonly simId: string;
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
  /** "Draw pattern points" toggle + its marker layer and mini editor. */
  private pointsToggle: HTMLButtonElement | null = null;
  private pointsLayer: HTMLDivElement | null = null;
  private pointOverlay: PatternPointOverlay | null = null;
  private patternPointsEnabled = false;
  private pointMarkers: PatternPointMarker[] = [];
  private pointMarkerEls: HTMLButtonElement[] = [];
  private incidentTriangles: IncidentTriangles | null = null;
  private readonly markerNormal = new Float32Array(3);
  /**
   * Orientation fix-up so "outward" means the side that faced up when the panels
   * were laid flat — the mesh winding alone can point either way.
   */
  private markerNormalSign = 1;
  /** Mesh + pattern the current cloth was built from, for the point overlay. */
  private mesh: MeshGeometry | null = null;
  private pattern: PatternDocument | null = null;
  /** Primary (last-clicked) piece — drives the gizmo's local-axis ops. */
  private selectedPieceId: string | null = null;
  /** Full multi-selection; may contain several pieces for group transforms. */
  private selectedPieceIds: Set<string> = new Set();
  private transformMode: TransformMode = 'translate';
  private strainMapEnabled = false;
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
  private sim: SimInstance;
  private defaultCamera: SimCameraState;
  private options: SimViewportRuntimeOptions;

  constructor(
    simId: string,
    canvas: HTMLCanvasElement,
    host: HTMLElement,
    device: GPUDevice,
    sim: SimInstance,
    defaultCamera: SimCameraState,
    options: SimViewportRuntimeOptions = {}
  ) {
    this.simId = simId;
    this.sim = sim;
    this.defaultCamera = defaultCamera;
    this.canvas = canvas;
    this.host = host;
    this.device = device;
    this.options = options;
    this.camera = new Camera();
    this.applyCamera(sim);
  }

  setDefaultCamera(camera: SimCameraState): void {
    this.defaultCamera = camera;
  }

  /**
   * Tear the runtime down completely. Rebuilding a sim replaces its runtime, so
   * every element appended to the host has to go with it or the next one stacks
   * a second set of controls on top.
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
    this.transformToggle?.remove();
    this.transformToggle = null;
    this.pointsToggle?.remove();
    this.pointsToggle = null;
    this.pointsLayer?.remove();
    this.pointsLayer = null;
    this.pointOverlay?.destroy();
    this.pointOverlay = null;
    this.pointMarkerEls = [];
    this.pointMarkers = [];
    this.incidentTriangles = null;
  }

  syncFromDocument(sim: SimInstance): void {
    this.sim = sim;
  }

  applyCamera(sim: SimInstance): void {
    if (sim.name !== 'Drape A') {
      migrateLegacySimCamera(sim.camera, this.defaultCamera);
    }
    this.camera.setDistance(sim.camera.distance);
    this.camera.setAzimuth((sim.camera.azimuth * 180) / Math.PI);
    this.camera.setIncline((sim.camera.elevation * 180) / Math.PI);
    this.camera.setPanX(sim.camera.target[0]);
    this.camera.setPanY(sim.camera.target[1]);
    this.camera.setPanZ(sim.camera.target[2]);
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
  }

  captureCamera(sim: SimInstance): void {
    sim.camera.distance = this.camera.getDistance();
    sim.camera.azimuth = (this.camera.getAzimuth() * Math.PI) / 180;
    sim.camera.elevation = (this.camera.getIncline() * Math.PI) / 180;
    sim.camera.target = [this.camera.getPanX(), this.camera.getPanY(), this.camera.getPanZ()];
    if (sim.name === 'Drape A') {
      setDefaultSimCamera(sim.camera);
    }
  }

  async initRenderer(): Promise<void> {
    this.resize();
    const { renderer } = await createViewportRenderer(this.device, this.canvas);
    this.renderer = renderer;
    this.avatarBody = await loadAvatarBody(this.device);
    if (this.sim.name !== 'Drape A') {
      migrateLegacySimCamera(this.sim.camera, this.defaultCamera);
    }
    this.applyCamera(this.sim);
    this.mountViewGnomon();
    this.selectionOverlay = new SelectionOverlay(this.host);
    this.mountMoveGizmo();
    this.mountTransformToggle();
    this.mountPointsLayer();
    this.mountPointsToggle();
    this.bindPointer();
  }

  /**
   * DOM layer that carries the pattern-point markers. Sits above the canvas but
   * only the markers themselves accept pointer events.
   */
  private mountPointsLayer(): void {
    this.pointsLayer?.remove();
    this.pointOverlay?.destroy();
    const layer = document.createElement('div');
    layer.className = 'pattern-point-layer';
    layer.style.display = 'none';
    this.host.appendChild(layer);
    this.pointsLayer = layer;
    this.pointMarkerEls = [];
    this.pointOverlay = new PatternPointOverlay(this.host, {
      onApply: (edited) => this.commitPatternPointEdit(edited),
      onCancel: () => {
        /* markers stay visible; nothing to roll back */
      },
    });
  }

  private mountPointsToggle(): void {
    this.pointsToggle?.remove();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sim-points-toggle';
    button.textContent = 'Draw pattern points';
    button.addEventListener('pointerdown', (e) => e.stopPropagation());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setPatternPointsEnabled(!this.patternPointsEnabled);
    });
    this.host.appendChild(button);
    this.pointsToggle = button;
    this.setPatternPointsEnabled(this.patternPointsEnabled);
  }

  isPatternPointsEnabled(): boolean {
    return this.patternPointsEnabled;
  }

  setPatternPointsEnabled(enabled: boolean): void {
    this.patternPointsEnabled = enabled;
    if (this.pointsToggle) {
      this.pointsToggle.classList.toggle('is-on', enabled);
      this.pointsToggle.setAttribute('aria-pressed', String(enabled));
      this.pointsToggle.title = enabled
        ? 'Pattern points shown — click one to edit that point in the small overlay'
        : 'Show pattern point handles on the fabric (click one to edit it)';
    }
    if (this.pointsLayer) this.pointsLayer.style.display = enabled ? 'block' : 'none';
    if (!enabled) {
      this.pointOverlay?.close();
      this.removePointMarkerEls();
    } else {
      this.buildPointMarkerEls();
      this.refreshPointMarkers();
    }
  }

  /** Map each pattern anchor to its nearest cloth vertex and index its triangles. */
  private computePointMarkers(): void {
    this.pointMarkers = buildPatternPointMarkers(this.mesh, this.pattern);
    const indices = this.mesh?.triangles ?? null;
    const vertexCount = this.mesh?.vertices.length ?? 0;
    this.incidentTriangles = indices?.length
      ? buildIncidentTriangles(indices, vertexCount)
      : null;
  }

  /**
   * Decide which way counts as "outward" by voting on the rest pose, which is
   * always the flat layout (pattern up = +Y). Must run before `applyPose()`.
   */
  private computeMarkerNormalSign(): void {
    this.markerNormalSign = 1;
    const incident = this.incidentTriangles;
    const indices = this.mesh?.triangles ?? null;
    const positions = this.cloth?.getPositionsSnapshot?.() ?? null;
    if (!incident || !indices || !positions || !this.pointMarkers.length) return;
    let up = 0;
    let down = 0;
    for (const marker of this.pointMarkers) {
      if (!computeVertexNormal(positions, indices, incident, marker.vertexIndex, this.markerNormal)) {
        continue;
      }
      if (this.markerNormal[1] > 0.05) up++;
      else if (this.markerNormal[1] < -0.05) down++;
    }
    if (down > up) this.markerNormalSign = -1;
  }

  private removePointMarkerEls(): void {
    for (const el of this.pointMarkerEls) el.remove();
    this.pointMarkerEls = [];
  }

  private buildPointMarkerEls(): void {
    this.removePointMarkerEls();
    if (!this.patternPointsEnabled || !this.pointsLayer || !this.pointMarkers.length) return;
    this.pointMarkerEls = this.pointMarkers.map((marker, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'pattern-point-marker';
      el.title = 'Edit this pattern point';
      el.dataset.markerIndex = String(i);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openPointEditor(i);
      });
      this.pointsLayer!.appendChild(el);
      return el;
    });
  }

  private openPointEditor(index: number): void {
    const marker = this.pointMarkers[index];
    if (!marker || !this.pattern || !this.pointOverlay) return;
    this.pointOverlay.open(this.pattern, marker.pointId);
  }

  private commitPatternPointEdit(edited: PatternDocument): void {
    // The overlay closed itself; keep the live pattern reference pristine until
    // the host has taken its undo snapshot and remeshed.
    this.options.onApplyPatternEdit?.(edited.id, edited);
  }

  /** Project the markers and hide the ones facing away from the camera. */
  private refreshPointMarkers(): void {
    if (!this.patternPointsEnabled || !this.pointMarkerEls.length) return;
    const positions = this.cloth?.getPositionsSnapshot?.() ?? null;
    const indices = this.mesh?.triangles ?? null;
    const incident = this.incidentTriangles;
    const eye = this.camera.getEyePosition();
    for (let i = 0; i < this.pointMarkers.length; i++) {
      const el = this.pointMarkerEls[i];
      const marker = this.pointMarkers[i];
      if (!el || !marker) continue;
      if (!positions || !indices || !incident) {
        el.style.display = 'none';
        continue;
      }
      if (!markerFacesCamera(
        positions,
        indices,
        incident,
        marker.vertexIndex,
        eye,
        this.markerNormal,
        this.markerNormalSign
      )) {
        el.style.display = 'none';
        continue;
      }
      const p = vec3.fromValues(
        positions[marker.vertexIndex * 3] ?? 0,
        positions[marker.vertexIndex * 3 + 1] ?? 0,
        positions[marker.vertexIndex * 3 + 2] ?? 0
      );
      const px = worldToCanvasPx(p, this.camera, this.canvas);
      if (!px || px.behind || !Number.isFinite(px.x) || !Number.isFinite(px.y)) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = 'block';
      el.style.left = `${px.x}px`;
      el.style.top = `${px.y}px`;
    }
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
        ? 'Rotation mode — drag a gizmo axis to rotate the selection around the group pivot'
        : 'Move mode — drag the selection or a gizmo axis to translate · Shift-click to multi-select';
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
        this.selectedPieceId === pieceId
          ? (remaining[remaining.length - 1] ?? null)
          : this.selectedPieceId;
      this.setPieceSelection(remaining, primary);
    } else {
      this.setPieceSelection([...this.selectedPieceIds, pieceId], pieceId);
    }
  }

  private setPieceSelection(ids: string[], primary: string | null): void {
    this.selectedPieceIds = new Set(ids);
    this.selectedPieceId = primary;
    this.syncMoveGizmo();
    this.canvas.style.cursor = this.selectedPieceIds.size > 0 ? 'default' : 'grab';
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
    this.selectionOverlay?.sync(markers, pivotPx && !pivotPx.behind ? pivotPx : null);

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
    // Free rotation uses the camera-facing axis (screen-plane rotation).
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
    params: SimParams,
    pose: SimInstance['pose'],
    pattern?: PatternDocument | null
  ): void {
    if (!this.avatarBody) return;
    this.mesh = mesh && mesh.vertices.length >= 3 ? mesh : null;
    this.pattern = pattern ?? null;
    this.pointOverlay?.close();
    this.cloth?.destroy();
    const usable = !!(mesh && mesh.vertices.length >= 3 && mesh.triangles.length >= 3);
    this.mesh = usable ? mesh! : null;
    const geom = usable ? mesh! : triangulatePattern(undefined, DEFAULT_MESH_SETTINGS);
    this.cloth = createClothSimulator(
      resolveEngineKind(params),
      geom,
      params,
      this.device,
      this.avatarBody,
      pattern ?? undefined
    );
    // Markers and their outward orientation must be sampled from the rest pose,
    // before any saved drape is applied on top.
    this.computePointMarkers();
    this.computeMarkerNormalSign();
    if (pose && pose.positions.length >= 12) {
      this.cloth.applyPose(pose);
    }
    this.cloth.setStrainMapEnabled?.(this.strainMapEnabled);
    this.setPieceSelected(null);
    this.buildPointMarkerEls();
    this.refreshPointMarkers();
  }

  setStrainMapEnabled(enabled: boolean): void {
    this.strainMapEnabled = enabled;
    this.cloth?.setStrainMapEnabled?.(enabled);
  }

  isStrainMapEnabled(): boolean {
    return this.strainMapEnabled;
  }

  setAvatarBody(body: AvatarBody): void {
    this.avatarBody = body;
    this.cloth?.setAvatar(body);
  }

  /**
   * Pick the rendered cloth. The center ray stays exact; a small CSS-pixel
   * fallback ring makes thin folds and triangle edges selectable without
   * changing the actual cloth collision geometry.
   */
  private pickCloth(
    clientX: number,
    clientY: number
  ): ReturnType<ClothSimulator['raycast']> {
    if (!this.cloth) return null;
    // Fullscreen/node resize can happen between render frames. Keep the camera
    // aspect current before converting this pointer into a ray.
    this.resize();
    this.camera.update();

    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [-5, 0],
      [5, 0],
      [0, -5],
      [0, 5],
      [-3.5, -3.5],
      [3.5, -3.5],
      [-3.5, 3.5],
      [3.5, 3.5],
    ];
    let best: ReturnType<ClothSimulator['raycast']> = null;
    for (const [dx, dy] of offsets) {
      const ray = unprojectRay(
        clientX + dx,
        clientY + dy,
        this.canvas,
        this.camera.getViewProjectMtx()
      );
      if (!ray) continue;
      const hit = this.cloth.raycast(ray.origin, ray.dir);
      if (!hit) continue;
      // Exact center hit always wins. Otherwise choose the nearest visible
      // surface among the tolerance rays.
      if (dx === 0 && dy === 0) return hit;
      if (!best || hit.t < best.t) best = hit;
    }
    return best;
  }

  private bindPointer(): void {
    this.canvas.style.cursor = 'grab';

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1) {
        this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
      } else if (e.button === 2) {
        this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
      } else if (e.button === 0) {
        // LMB on fabric → select that pattern piece (shift toggles the group).
        const hit = this.pickCloth(e.clientX, e.clientY);
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
        } else {
          this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
        }
      } else {
        return;
      }
this.nav === 'none'
                ? this.selectedPieceIds.size > 0
                  ? 'default'
                  : 'grab'
                : 
      this.pointerMoved = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
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
        if (this.transformMode === 'rotate' && this.cloth && this.selectedPieceIds.size > 0) {
          // Direct drag is a simple trackball: horizontal movement rotates the
          // whole selection around world Y (through the group pivot); vertical
          // movement uses camera-right.
          const yawAxis = vec3.fromValues(0, 1, 0);
          const yaw = dx * 0.01;
          const az = (this.camera.getAzimuth() * Math.PI) / 180;
          const cameraRight = vec3.fromValues(Math.cos(az), 0, -Math.sin(az));
          const pitch = dy * 0.01;
          const pivot = vec3.clone(this.dragPivot);
          this.rotateSelectionAroundPivot(yawAxis, yaw, pivot);
          this.rotateSelectionAroundPivot(cameraRight, pitch, pivot);
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
      const movedCamera = this.nav === 'orbit' || this.nav === 'orbitHeight' || this.nav === 'pan';
      if (wasCloth) {
        this.cloth?.setDragging(false);
        this.gizmoAxis = null;
        this.lastPlaneHit = null;
      }
      if (movedCamera && this.pointerMoved) {
        this.captureCamera(this.sim);
      }
      this.nav = 'none';
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }

      if (wasOrbitClick) {
        // Empty click — clear the whole selection.
        this.setPieceSelected(null);
      }
      this.canvas.style.cursor = this.selectedPieceIds.size > 0 ? 'default' : 'grab';
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

  /** Start free-dragging the cloth on a camera-facing plane (same as gizmo free axis). */
  private beginClothDrag(clientX: number, clientY: number): void {
    if (!this.cloth || this.selectedPieceIds.size === 0) return;
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

  frame(active: boolean): void {
    if (active) this.stepAndRender();
    else this.renderPaused();
  }

  stepAndRender(): void {
    if (!this.renderer || !this.cloth) return;
    this.resize();
    this.cloth.update(true);
    this.camera.update();
    this.renderer.render(this.cloth, this.camera);
    this.syncMoveGizmo();
    this.refreshPointMarkers();
  }

  renderPaused(): void {
    if (!this.renderer || !this.cloth) return;
    this.resize();
    this.cloth.update(false);
    this.camera.update();
    this.renderer.render(this.cloth, this.camera);
    this.syncMoveGizmo();
    this.refreshPointMarkers();
  }

  async snapshotDataUrl(): Promise<string> {
    this.renderPaused();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    try {
      const url = this.canvas.toDataURL('image/png');
      if (url.length < 100) throw new Error('empty capture');
      return url;
    } catch {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 400;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#1a1815';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#f2ebe3';
      ctx.font = '20px sans-serif';
      ctx.fillText('Sim snapshot (GPU readback pending)', 24, 48);
      return c.toDataURL('image/png');
    }
  }
}
