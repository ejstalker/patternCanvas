import type { Camera } from '../Camera';

export type AxisId = 'x' | 'y' | 'z' | '-x' | '-y' | '-z';

export type GnomonCallbacks = {
  /** Drag on the gizmo body — orbit around scene center (Blender LMB-drag). */
  onOrbit: (dx: number, dy: number) => void;
  /** Click an axis tip — align view; same axis again flips (Blender). */
  onAxisClick: (axis: AxisId) => void;
  /** Projection toggle under the gizmo. */
  onToggleProjection: () => void;
};

type AxisTip = {
  id: AxisId;
  label: string;
  color: string;
  x: number;
  y: number;
  depth: number;
  positive: boolean;
};

const SIZE = 84;
const CX = SIZE / 2;
const CY = SIZE / 2 - 4;
const ARM = 28;

/**
 * Blender-style viewport navigation gizmo (orbit widget).
 * @see https://docs.blender.org/manual/en/latest/editors/3dview/navigate/introduction.html
 */
export class ViewportGnomon {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private orthoBtn: HTMLButtonElement;
  private cbs: GnomonCallbacks;
  private dragging = false;
  private moved = false;
  private lastX = 0;
  private lastY = 0;
  private tips: AxisTip[] = [];
  private hoverId: AxisId | null = null;
  private azimuth = 0;
  private incline = 20;
  private orthographic = false;

  constructor(host: HTMLElement, cbs: GnomonCallbacks) {
    this.cbs = cbs;
    this.root = document.createElement('div');
    this.root.className = 'viewport-gnomon';
    this.root.title = 'Drag to orbit · Click axis to snap · Click again to flip';

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('width', String(SIZE));
    this.svg.setAttribute('height', String(SIZE - 8));
    this.svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE - 8}`);
    this.root.appendChild(this.svg);

    this.orthoBtn = document.createElement('button');
    this.orthoBtn.type = 'button';
    this.orthoBtn.className = 'gnomon-proj-btn';
    this.orthoBtn.title = 'Toggle perspective / orthographic';
    this.orthoBtn.textContent = 'Persp';
    this.orthoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cbs.onToggleProjection();
    });
    this.root.appendChild(this.orthoBtn);

    host.appendChild(this.root);
    this.bind();
    this.redraw();
  }

  syncFromCamera(camera: Camera): void {
    this.azimuth = camera.getAzimuth();
    this.incline = camera.getIncline();
    this.orthographic = camera.isOrthographic();
    this.orthoBtn.textContent = this.orthographic ? 'Ortho' : 'Persp';
    this.orthoBtn.classList.toggle('is-ortho', this.orthographic);
    this.redraw();
  }

  destroy(): void {
    this.root.remove();
  }

  private bind(): void {
    this.svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.dragging = true;
      this.moved = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.svg.setPointerCapture(e.pointerId);
    });

    this.svg.addEventListener('pointermove', (e) => {
      const tip = this.hitTip(e.clientX, e.clientY);
      if (tip?.id !== this.hoverId) {
        this.hoverId = tip?.id ?? null;
        this.redraw();
      }
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.moved) this.cbs.onOrbit(dx, dy);
    });

    this.svg.addEventListener('pointerup', (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      try {
        this.svg.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (!this.moved) {
        const tip = this.hitTip(e.clientX, e.clientY);
        if (tip) this.cbs.onAxisClick(tip.id);
      }
    });

    this.svg.addEventListener('pointerleave', () => {
      if (this.hoverId) {
        this.hoverId = null;
        this.redraw();
      }
    });
  }

  private hitTip(clientX: number, clientY: number): AxisTip | null {
    const rect = this.svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * SIZE;
    const y = ((clientY - rect.top) / rect.height) * (SIZE - 8);
    let best: AxisTip | null = null;
    let bestDist = 14;
    for (const tip of this.tips) {
      const d = Math.hypot(tip.x - x, tip.y - y);
      if (d < bestDist) {
        bestDist = d;
        best = tip;
      }
    }
    return best;
  }

  /** Map world direction into view space matching Camera (Y-up). */
  private worldToView(x: number, y: number, z: number): { x: number; y: number; z: number } {
    const az = (this.azimuth * Math.PI) / 180;
    const inc = (this.incline * Math.PI) / 180;
    // rotX(incline)
    const y1 = y * Math.cos(inc) - z * Math.sin(inc);
    const z1 = y * Math.sin(inc) + z * Math.cos(inc);
    const x1 = x;
    // rotY(azimuth)
    const x2 = x1 * Math.cos(az) + z1 * Math.sin(az);
    const z2 = -x1 * Math.sin(az) + z1 * Math.cos(az);
    return { x: x2, y: y1, z: z2 };
  }

  private redraw(): void {
    const axes: { id: AxisId; label: string; color: string; dir: [number, number, number]; positive: boolean }[] = [
      { id: 'x', label: 'X', color: '#e74c3c', dir: [1, 0, 0], positive: true },
      { id: 'y', label: 'Y', color: '#2ecc71', dir: [0, 1, 0], positive: true },
      { id: 'z', label: 'Z', color: '#3498db', dir: [0, 0, 1], positive: true },
      { id: '-x', label: '', color: '#e74c3c', dir: [-1, 0, 0], positive: false },
      { id: '-y', label: '', color: '#2ecc71', dir: [0, -1, 0], positive: false },
      { id: '-z', label: '', color: '#3498db', dir: [0, 0, -1], positive: false },
    ];

    this.tips = axes.map((a) => {
      const v = this.worldToView(a.dir[0], a.dir[1], a.dir[2]);
      return {
        id: a.id,
        label: a.label,
        color: a.color,
        x: CX + v.x * ARM,
        y: CY - v.y * ARM,
        depth: -v.z,
        positive: a.positive,
      };
    });
    this.tips.sort((a, b) => a.depth - b.depth);

    this.svg.innerHTML = '';

    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bg.setAttribute('cx', String(CX));
    bg.setAttribute('cy', String(CY));
    bg.setAttribute('r', '36');
    bg.setAttribute('class', 'gnomon-bg');
    this.svg.appendChild(bg);

    for (const tip of this.tips) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(CX));
      line.setAttribute('y1', String(CY));
      line.setAttribute('x2', String(tip.x));
      line.setAttribute('y2', String(tip.y));
      line.setAttribute('stroke', tip.color);
      line.setAttribute('stroke-width', tip.positive ? '2.2' : '1.2');
      line.setAttribute('stroke-opacity', tip.positive ? '0.95' : '0.35');
      line.setAttribute('stroke-linecap', 'round');
      this.svg.appendChild(line);

      const r = tip.positive ? (this.hoverId === tip.id ? 9 : 7.5) : this.hoverId === tip.id ? 6 : 4.5;
      const ball = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      ball.setAttribute('cx', String(tip.x));
      ball.setAttribute('cy', String(tip.y));
      ball.setAttribute('r', String(r));
      ball.setAttribute('fill', tip.positive ? tip.color : '#2a2620');
      ball.setAttribute('stroke', tip.color);
      ball.setAttribute('stroke-width', tip.positive ? '0' : '1.5');
      ball.setAttribute('class', this.hoverId === tip.id ? 'gnomon-tip hover' : 'gnomon-tip');
      this.svg.appendChild(ball);

      if (tip.label) {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', String(tip.x));
        text.setAttribute('y', String(tip.y + 1));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'middle');
        text.setAttribute('class', 'gnomon-label');
        text.textContent = tip.label;
        this.svg.appendChild(text);
      }
    }
  }
}

/** Camera azimuth/incline for a Blender-like axis view (Y-up). */
export function axisViewAngles(axis: AxisId): { azimuth: number; incline: number } {
  switch (axis) {
    case 'x':
      return { azimuth: -90, incline: 0 };
    case '-x':
      return { azimuth: 90, incline: 0 };
    case 'y':
      return { azimuth: 0, incline: 89.9 };
    case '-y':
      return { azimuth: 0, incline: -89.9 };
    case 'z':
      return { azimuth: 0, incline: 0 };
    case '-z':
      return { azimuth: 180, incline: 0 };
  }
}

export function oppositeAxis(axis: AxisId): AxisId {
  switch (axis) {
    case 'x':
      return '-x';
    case '-x':
      return 'x';
    case 'y':
      return '-y';
    case '-y':
      return 'y';
    case 'z':
      return '-z';
    case '-z':
      return 'z';
  }
}

export function currentAxisView(azimuth: number, incline: number, eps = 8): AxisId | null {
  const candidates: AxisId[] = ['x', '-x', 'y', '-y', 'z', '-z'];
  for (const id of candidates) {
    const a = axisViewAngles(id);
    let daz = ((azimuth - a.azimuth + 540) % 360) - 180;
    const din = incline - a.incline;
    if (Math.abs(daz) < eps && Math.abs(din) < eps) return id;
  }
  return null;
}
