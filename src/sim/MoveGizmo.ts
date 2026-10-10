import { vec3, vec4, mat4 } from 'gl-matrix';
import { pointAxisDirections } from './axisScreen';

export type MoveAxis = 'x' | 'y' | 'z' | 'free';
export type TransformMode = 'translate' | 'rotate';

/** Where the arrows are drawn from: a world point as the camera shows it. */
export type AxisView = {
  camera: { getViewProjectMtx(): mat4 };
  /** World point the gizmo sits on. */
  origin: vec3;
  /** Viewport size in CSS px, which sets how long a world unit looks. */
  width: number;
  height: number;
};

/** Length of a full-length arrow, in gizmo px. */
const ARROW_LEN = 42;
/** Below this the axis points too close to the camera to draw a direction. */
const MIN_FORESHORTEN = 0.06;

export type MoveGizmoCallbacks = {
  onDragStart: (axis: MoveAxis, clientX: number, clientY: number) => void;
  onDrag: (axis: MoveAxis, dxPx: number, dyPx: number, clientX: number, clientY: number) => void;
  onDragEnd: () => void;
};

/**
 * Object transform gnomon (translate) — shown at the selected fabric centroid.
 * Drag an axis arrow to constrain; drag the center to free-move.
 */
export class MoveGizmo {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private cbs: MoveGizmoCallbacks;
  private dragging: MoveAxis | null = null;
  private lastX = 0;
  private lastY = 0;
  private visible = false;
  private mode: TransformMode = 'translate';

  constructor(host: HTMLElement, cbs: MoveGizmoCallbacks) {
    this.cbs = cbs;
    this.root = document.createElement('div');
    this.root.className = 'move-gizmo';
    this.root.style.display = 'none';

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('width', '120');
    this.svg.setAttribute('height', '120');
    this.svg.setAttribute('viewBox', '-60 -60 120 120');
    this.root.appendChild(this.svg);

    this.build();
    host.appendChild(this.root);
    this.bind();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.style.display = visible ? 'block' : 'none';
  }

  isVisible(): boolean {
    return this.visible;
  }

  setMode(mode: TransformMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.root.classList.toggle('is-rotate', mode === 'rotate');
    this.build();
  }

  /** Place gizmo so its origin sits on the projected world point. */
  setScreenPosition(left: number, top: number): void {
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  destroy(): void {
    this.root.remove();
  }

  private build(): void {
    this.svg.innerHTML = '';
    const axes: { axis: MoveAxis; x2: number; y2: number; color: string; label: string }[] = [
      { axis: 'x', x2: ARROW_LEN, y2: 0, color: '#e74c3c', label: 'X' },
      { axis: 'y', x2: 0, y2: -ARROW_LEN, color: '#2ecc71', label: 'Y' },
      { axis: 'z', x2: 0, y2: ARROW_LEN, color: '#3498db', label: 'Z' },
    ];

    for (const a of axes) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.dataset.axis = a.axis;
      g.setAttribute('class', 'move-gizmo-axis');

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', '0');
      line.setAttribute('y1', '0');
      line.setAttribute('x2', String(a.x2));
      line.setAttribute('y2', String(a.y2));
      line.setAttribute('stroke', a.color);
      line.setAttribute('stroke-width', '3.5');
      line.setAttribute('stroke-linecap', 'round');
      g.appendChild(line);

      const ang = Math.atan2(a.y2, a.x2);
      const tx = a.x2;
      const ty = a.y2;
      if (this.mode === 'translate') {
        const tip = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        const s = 7;
        const p1 = `${tx},${ty}`;
        const p2 = `${tx - s * Math.cos(ang - 0.4)},${ty - s * Math.sin(ang - 0.4)}`;
        const p3 = `${tx - s * Math.cos(ang + 0.4)},${ty - s * Math.sin(ang + 0.4)}`;
        tip.setAttribute('points', `${p1} ${p2} ${p3}`);
        tip.setAttribute('fill', a.color);
        g.appendChild(tip);
      } else {
        const tip = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        tip.setAttribute('cx', String(tx));
        tip.setAttribute('cy', String(ty));
        tip.setAttribute('r', '7');
        tip.setAttribute('fill', 'rgba(28,26,23,0.75)');
        tip.setAttribute('stroke', a.color);
        tip.setAttribute('stroke-width', '3');
        g.appendChild(tip);
      }

      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      hit.setAttribute('x1', '0');
      hit.setAttribute('y1', '0');
      hit.setAttribute('x2', String(a.x2));
      hit.setAttribute('y2', String(a.y2));
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '14');
      hit.setAttribute('stroke-linecap', 'round');
      hit.setAttribute('pointer-events', 'stroke');
      hit.style.cursor = this.mode === 'rotate' ? 'alias' : 'pointer';
      g.appendChild(hit);

      this.svg.appendChild(g);
    }

    const center = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    center.setAttribute('cx', '0');
    center.setAttribute('cy', '0');
    center.setAttribute('r', '10');
    center.setAttribute('fill', '#f2ebe3');
    center.setAttribute('stroke', '#1c1a17');
    center.setAttribute('stroke-width', '2');
    center.dataset.axis = 'free';
    center.setAttribute('class', 'move-gizmo-free');
    center.setAttribute('pointer-events', 'all');
    center.style.cursor = this.mode === 'rotate' ? 'alias' : 'move';
    this.svg.appendChild(center);

    if (this.mode === 'rotate') {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', '0');
      label.setAttribute('y', '3.5');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '9');
      label.setAttribute('font-weight', '700');
      label.setAttribute('fill', '#1c1a17');
      label.setAttribute('pointer-events', 'none');
      label.textContent = 'R';
      this.svg.appendChild(label);
    }
  }

  /** Update arrow directions from camera so axes stay world-aligned on screen. */
  updateAxisLayout(view: AxisView): void {
    const dirs = pointAxisDirections(
      view.camera.getViewProjectMtx(),
      view.origin,
      view.width,
      view.height
    );

    for (const axis of ['x', 'y', 'z'] as const) {
      const g = this.svg.querySelector(`g[data-axis="${axis}"]`) as SVGGElement | null;
      if (!g) continue;
      const d = dirs[axis];
      // An axis pointing at the camera has no direction on screen — drop it
      // rather than draw a stub in whatever direction rounding picked.
      if (d.foreshorten < MIN_FORESHORTEN) {
        g.style.display = 'none';
        continue;
      }
      g.style.display = '';
      const ax = d.x * ARROW_LEN * d.foreshorten;
      const ay = d.y * ARROW_LEN * d.foreshorten;
      const lines = g.querySelectorAll('line');
      lines.forEach((line) => {
        line.setAttribute('x2', String(ax));
        line.setAttribute('y2', String(ay));
      });
      const tip = g.querySelector('polygon');
      if (tip) {
        const ang = Math.atan2(ay, ax);
        const s = 7;
        tip.setAttribute(
          'points',
          `${ax},${ay} ${ax - s * Math.cos(ang - 0.4)},${ay - s * Math.sin(ang - 0.4)} ${ax - s * Math.cos(ang + 0.4)},${ay - s * Math.sin(ang + 0.4)}`
        );
      }
      const rotateTip = g.querySelector('circle');
      if (rotateTip) {
        rotateTip.setAttribute('cx', String(ax));
        rotateTip.setAttribute('cy', String(ay));
      }
    }
  }

  private bind(): void {
    const start = (axis: MoveAxis, e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.dragging = axis;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.root.setPointerCapture(e.pointerId);
      this.cbs.onDragStart(axis, e.clientX, e.clientY);
    };

    this.svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const t = e.target as SVGElement;
      const axisEl = t.closest('[data-axis]') as SVGElement | null;
      const axis = (axisEl?.dataset.axis as MoveAxis | undefined) ?? null;
      if (!axis) return;
      start(axis, e);
    });

    this.root.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.cbs.onDrag(this.dragging, dx, dy, e.clientX, e.clientY);
    });

    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = null;
      try {
        this.root.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.cbs.onDragEnd();
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);
  }
}

/**
 * Project a world point to CSS pixels relative to the canvas element (layout box).
 *
 * Typed against the pieces it actually reads rather than Camera/HTMLCanvasElement,
 * so overlays that only ever see a viewport through accessors can still use it.
 */
export function worldToCanvasPx(
  world: vec3,
  camera: { getViewProjectMtx(): mat4 },
  canvas: {
    clientWidth: number;
    clientHeight: number;
    getBoundingClientRect(): { width: number; height: number };
  }
): { x: number; y: number; behind: boolean } | null {
  const vp = camera.getViewProjectMtx();
  const clip = vec4.fromValues(world[0], world[1], world[2], 1);
  vec4.transformMat4(clip, clip, vp);
  if (Math.abs(clip[3]) < 1e-8) return null;
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  const ndcZ = clip[2] / clip[3];
  // Use clientWidth/Height (pre-transform layout), not getBoundingClientRect —
  // the board applies CSS scale, and absolute gizmo coords are in local layout space.
  const w = canvas.clientWidth || canvas.getBoundingClientRect().width;
  const h = canvas.clientHeight || canvas.getBoundingClientRect().height;
  return {
    x: (ndcX * 0.5 + 0.5) * w,
    y: (-ndcY * 0.5 + 0.5) * h,
    // Camera uses WebGPU ZO projection, whose NDC depth range is [0, 1].
    behind: ndcZ < 0 || ndcZ > 1 || clip[3] < 0,
  };
}

export function unprojectRay(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement,
  viewProj: mat4
): { origin: vec3; dir: vec3 } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
  const inv = mat4.create();
  if (!mat4.invert(inv, viewProj)) return null;
  // Camera projection is perspectiveZO/orthoZO for WebGPU. Using OpenGL's
  // -1 near depth skews perspective rays and is especially wrong in ortho.
  const near = vec4.fromValues(ndcX, ndcY, 0, 1);
  const far = vec4.fromValues(ndcX, ndcY, 1, 1);
  vec4.transformMat4(near, near, inv);
  vec4.transformMat4(far, far, inv);
  if (Math.abs(near[3]) < 1e-8 || Math.abs(far[3]) < 1e-8) return null;
  const origin = vec3.fromValues(near[0] / near[3], near[1] / near[3], near[2] / near[3]);
  const farPt = vec3.fromValues(far[0] / far[3], far[1] / far[3], far[2] / far[3]);
  const dir = vec3.create();
  vec3.sub(dir, farPt, origin);
  vec3.normalize(dir, dir);
  return { origin, dir };
}
