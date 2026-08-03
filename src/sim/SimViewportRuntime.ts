import { vec3 } from 'gl-matrix';
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
import {
  migrateLegacySimCamera,
  setDefaultSimCamera,
} from './cameraDefaults';
import type { MeshGeometry, PatternDocument, SimCameraState, SimInstance, SimParams } from '../project/types';

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
  private transformToggle: HTMLButtonElement | null = null;
  private selectedPieceId: string | null = null;
  private transformMode: TransformMode = 'translate';
  private strainMapEnabled = false;
  private nav: NavMode = 'none';
  private lastX = 0;
  private lastY = 0;
  private pointerMoved = false;
  private lastAxisSnap: AxisId | null = null;
  private gizmoAxis: MoveAxis | null = null;
  private lastPlaneHit: vec3 | null = null;
  private dragPlanePoint: vec3 = vec3.create();
  private dragPlaneNormal: vec3 = vec3.fromValues(0, 1, 0);
  private sim: SimInstance;
  private defaultCamera: SimCameraState;

  constructor(
    simId: string,
    canvas: HTMLCanvasElement,
    host: HTMLElement,
    device: GPUDevice,
    sim: SimInstance,
    defaultCamera: SimCameraState
  ) {
    this.simId = simId;
    this.sim = sim;
    this.defaultCamera = defaultCamera;
    this.canvas = canvas;
    this.host = host;
    this.device = device;
    this.camera = new Camera();
    this.applyCamera(sim);
  }

  setDefaultCamera(camera: SimCameraState): void {
    this.defaultCamera = camera;
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
    this.mountMoveGizmo();
    this.mountTransformToggle();
    this.bindPointer();
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
        ? 'Rotation mode — drag a gizmo axis to rotate the selected piece'
        : 'Move mode — drag the selected piece or a gizmo axis to translate';
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
    this.cloth?.destroy();
    const geom =
      mesh && mesh.vertices.length >= 3 && mesh.triangles.length >= 3
        ? mesh
        : triangulatePattern(undefined, DEFAULT_MESH_SETTINGS);
    this.cloth = createClothSimulator(
      resolveEngineKind(params),
      geom,
      params,
      this.device,
      this.avatarBody,
      pattern ?? undefined
    );
    if (pose && pose.positions.length >= 12) {
      this.cloth.applyPose(pose);
    }
    this.cloth.setStrainMapEnabled?.(this.strainMapEnabled);
    this.setPieceSelected(null);
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

  private bindPointer(): void {
    this.canvas.style.cursor = 'grab';

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1) {
        this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
      } else if (e.button === 2) {
        this.nav = e.shiftKey ? 'orbitHeight' : 'orbit';
      } else if (e.button === 0) {
        // LMB on fabric → select that pattern piece and transform only it.
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
          // Direct drag is a simple trackball: horizontal movement rotates
          // around world Y; vertical movement rotates around camera-right.
          this.cloth.rotateBy(vec3.fromValues(0, 1, 0), dx * 0.01, this.selectedPieceId);
          const az = (this.camera.getAzimuth() * Math.PI) / 180;
          const cameraRight = vec3.fromValues(Math.cos(az), 0, -Math.sin(az));
          this.cloth.rotateBy(cameraRight, dy * 0.01, this.selectedPieceId);
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
        // Empty click — deselect the current pattern piece.
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

  /** Start free-dragging the cloth on a camera-facing plane (same as gizmo free axis). */
  private beginClothDrag(clientX: number, clientY: number): void {
    if (!this.cloth || !this.selectedPieceId) return;
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
  }

  renderPaused(): void {
    if (!this.renderer || !this.cloth) return;
    this.resize();
    this.cloth.update(false);
    this.camera.update();
    this.renderer.render(this.cloth, this.camera);
    this.syncMoveGizmo();
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
