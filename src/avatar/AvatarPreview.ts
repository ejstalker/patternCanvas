/**
 * Minimal WebGPU preview of the generated avatar, with measurement "tape" lines
 * drawn over it. Measurement values are hidden by default and revealed (with a
 * highlight) only for the ruler the pointer is hovering.
 *
 * Orbit pivots on the model's **hips** (MakeHuman's origin, y = 0), so dragging
 * swings the head and feet rather than spinning about the bounding-box centre.
 */

import { mat4, vec3 } from 'gl-matrix';
import type { MeasurementRuler } from './rulerOverlay';

const SHADER = /* wgsl */ `
struct Camera {
  mvp: mat4x4<f32>,
  model: mat4x4<f32>,
  light: vec3<f32>,
  pad: f32,
};
@group(0) @binding(0) var<uniform> cam: Camera;

struct MeshOut { @builtin(position) clip: vec4<f32>, @location(0) normal: vec3<f32> };

@vertex
fn vs_mesh(@location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>) -> MeshOut {
  var out: MeshOut;
  out.clip = cam.mvp * vec4<f32>(pos, 1.0);
  out.normal = (cam.model * vec4<f32>(nrm, 0.0)).xyz;
  return out;
}

@fragment
fn fs_mesh(in: MeshOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  var n = normalize(in.normal);
  if (!front) { n = -n; }
  let l = normalize(cam.light);
  let diff = max(dot(n, l), 0.0);
  let base = vec3<f32>(0.84, 0.70, 0.61);
  let col = base * (0.34 + 0.66 * diff);
  return vec4<f32>(col, 1.0);
}

struct LineOut { @builtin(position) clip: vec4<f32>, @location(0) col: vec3<f32> };

@vertex
fn vs_line(@location(0) pos: vec3<f32>, @location(1) col: vec3<f32>) -> LineOut {
  var out: LineOut;
  out.clip = cam.mvp * vec4<f32>(pos, 1.0);
  out.col = col;
  return out;
}

@fragment
fn fs_line(in: LineOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.col, 1.0);
}
`;

const MESH_STRIDE = 24;
const LINE_STRIDE = 24;
/** Pointer-to-ruler hit tolerance, in CSS pixels. */
const HOVER_TOLERANCE_PX = 10;
/** Vertical field of view, in degrees. */
const FOV_DEGREES = 46;
/** How far the camera + pivot can slide vertically, in fitted model units. */
const PAN_LIMIT = 1;
/** Colour used for the hovered ruler, and the dim factor for the others. */
const HIGHLIGHT: [number, number, number] = [1, 0.97, 0.9];
const DIM = 0.55;

export class AvatarPreview {
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLElement;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly meshPipeline: GPURenderPipeline;
  private readonly linePipeline: GPURenderPipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly uniform = new Float32Array(36);
  private readonly light = vec3.fromValues(0.35, 0.82, 0.55);

  private depthTexture: GPUTexture | null = null;
  private meshVB: GPUBuffer | null = null;
  private meshIB: GPUBuffer | null = null;
  private indexCount = 0;
  private lineVB: GPUBuffer | null = null;
  private lineVertexCount = 0;
  private lineData: Float32Array | null = null;

  private readonly model = mat4.create();
  private readonly proj = mat4.create();
  private readonly view = mat4.create();
  private readonly mvp = mat4.create();

  private distance = 2.4;
  private yaw = 0;
  private pitch = 0.1;
  /** Vertical offset of the camera *and* the orbit pivot. */
  private panY = 0;
  private shiftHeld = false;

  private rulers: MeasurementRuler[] = [];
  private labels = new Map<string, HTMLElement>();
  private dots = new Map<string, HTMLElement>();
  private hoveredField: string | null = null;

  private showRulers = true;
  private dragging: { id: number; x: number; y: number; moved: boolean } | null = null;
  private resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, overlay: HTMLElement, device: GPUDevice) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.device = device;

    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('WebGPU canvas context unavailable');
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });

    const module = device.createShaderModule({ code: SHADER });
    const depthStencil: GPUDepthStencilState = {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    };
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

    this.meshPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module,
        entryPoint: 'vs_mesh',
        buffers: [
          {
            arrayStride: MESH_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs_mesh', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });

    this.linePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module,
        entryPoint: 'vs_line',
        buffers: [
          {
            arrayStride: LINE_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs_line', targets: [{ format: this.format }] },
      primitive: { topology: 'line-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
    });

    this.uniformBuffer = device.createBuffer({
      size: this.uniform.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.bindInteraction();
    this.resize();
  }

  setMesh(positions: Float32Array, indices: Uint32Array): void {
    if (this.disposed) return;
    const normals = computeNormals(positions, indices);

    const interleaved = new Float32Array((positions.length / 3) * 6);
    for (let i = 0; i < positions.length / 3; i++) {
      interleaved[i * 6] = positions[i * 3]!;
      interleaved[i * 6 + 1] = positions[i * 3 + 1]!;
      interleaved[i * 6 + 2] = positions[i * 3 + 2]!;
      interleaved[i * 6 + 3] = normals[i * 3]!;
      interleaved[i * 6 + 4] = normals[i * 3 + 1]!;
      interleaved[i * 6 + 5] = normals[i * 3 + 2]!;
    }

    this.meshVB?.destroy();
    this.meshIB?.destroy();
    this.meshVB = this.device.createBuffer({
      size: interleaved.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.meshVB, 0, interleaved);
    this.meshIB = this.device.createBuffer({
      size: Math.max(4, indices.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(
      this.meshIB,
      0,
      indices.buffer as ArrayBuffer,
      indices.byteOffset,
      indices.byteLength
    );
    this.indexCount = indices.length;

    this.fitModel(positions);
    this.render();
  }

  setRulers(rulers: MeasurementRuler[]): void {
    if (this.disposed) return;
    this.rulers = rulers;
    this.hoveredField = null;
    this.rebuildRulerDom();
    this.uploadRulerLines();
    this.render();
  }

  setShowRulers(show: boolean): void {
    this.showRulers = show;
    if (!show) this.setHovered(null);
    this.overlay.style.display = show ? '' : 'none';
    this.render();
  }

  /**
   * Highlight the ruler for a measurement, driven from outside the viewport
   * (hovering its row in the measurement list). Fields with no 3D
   * representation — or when the ruler overlay is switched off — are ignored.
   */
  setHighlightField(field: string | null): void {
    if (this.disposed || !this.showRulers) return;
    if (field !== null && !this.rulers.some((r) => r.field === field)) return;
    this.setHovered(field);
  }

  destroy(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.meshVB?.destroy();
    this.meshIB?.destroy();
    this.lineVB?.destroy();
    this.uniformBuffer.destroy();
    this.depthTexture?.destroy();
    this.overlay.innerHTML = '';
    this.labels.clear();
    this.dots.clear();
    this.rulers = [];
  }

  // ---- rulers / hover -------------------------------------------------------

  private rebuildRulerDom(): void {
    this.overlay.innerHTML = '';
    this.labels.clear();
    this.dots.clear();
    for (const ruler of this.rulers) {
      const rgb = `rgb(${ruler.color.map((c) => Math.round(c * 255)).join(',')})`;
      const label = document.createElement('span');
      label.className = `avatar-ruler-label${ruler.driven ? ' is-driven' : ''}`;
      label.textContent = ruler.label;
      label.style.color = rgb;
      label.style.display = 'none';
      const dot = document.createElement('span');
      dot.className = 'avatar-ruler-dot';
      dot.style.background = rgb;
      dot.style.display = 'none';
      this.overlay.appendChild(label);
      this.overlay.appendChild(dot);
      this.labels.set(ruler.field, label);
      this.dots.set(ruler.field, dot);
    }
  }

  /** (Re)build the interleaved line buffer, applying the hover highlight. */
  private uploadRulerLines(): void {
    let segments = 0;
    for (const ruler of this.rulers) segments += Math.max(0, ruler.points.length / 3 - 1);
    const data = new Float32Array(segments * 12);

    let w = 0;
    for (const ruler of this.rulers) {
      const hovered = ruler.field === this.hoveredField;
      const dim = this.hoveredField !== null && !hovered;
      const color: [number, number, number] = hovered
        ? HIGHLIGHT
        : dim
          ? [ruler.color[0] * DIM, ruler.color[1] * DIM, ruler.color[2] * DIM]
          : ruler.color;
      const pts = ruler.points;
      for (let i = 0; i + 5 < pts.length; i += 3) {
        data[w++] = pts[i]!;
        data[w++] = pts[i + 1]!;
        data[w++] = pts[i + 2]!;
        data[w++] = color[0];
        data[w++] = color[1];
        data[w++] = color[2];
        data[w++] = pts[i + 3]!;
        data[w++] = pts[i + 4]!;
        data[w++] = pts[i + 5]!;
        data[w++] = color[0];
        data[w++] = color[1];
        data[w++] = color[2];
      }
    }

    this.lineData = data;
    this.lineVertexCount = data.length / 6;
    if (!this.lineVB || this.lineVB.size < Math.max(4, data.byteLength)) {
      this.lineVB?.destroy();
      this.lineVB = this.device.createBuffer({
        size: Math.max(4, data.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (data.length) this.device.queue.writeBuffer(this.lineVB, 0, data);
  }

  private setHovered(field: string | null): void {
    if (this.hoveredField === field) return;
    this.hoveredField = field;
    this.uploadRulerLines();
    this.applyCursor();
    this.render();
  }

  private applyCursor(): void {
    this.canvas.style.cursor = this.shiftHeld ? 'move' : this.hoveredField ? 'pointer' : 'grab';
  }

  /** Pointer hit-test against the projected ruler polylines. */
  private pickRuler(clientX: number, clientY: number): string | null {
    if (!this.showRulers || this.rulers.length === 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const p = vec3.create();

    let best: string | null = null;
    let bestDist = HOVER_TOLERANCE_PX;
    for (const ruler of this.rulers) {
      const pts = ruler.points;
      let prevX = 0;
      let prevY = 0;
      let hasPrev = false;
      for (let i = 0; i + 2 < pts.length; i += 3) {
        vec3.set(p, pts[i]!, pts[i + 1]!, pts[i + 2]!);
        const clip = projectPoint(this.mvp, p);
        if (!clip) {
          hasPrev = false;
          continue;
        }
        const [x, y] = ndcToCanvas(clip, rect);
        if (hasPrev) {
          const d = pointSegmentDistance(px, py, prevX, prevY, x, y);
          if (d < bestDist) {
            bestDist = d;
            best = ruler.field;
          }
        }
        prevX = x;
        prevY = y;
        hasPrev = true;
      }
    }
    return best;
  }

  private updateHoverVisuals(): void {
    const rect = this.canvas.getBoundingClientRect();
    const p = vec3.create();
    for (const [field, label] of this.labels) {
      const ruler = this.rulers.find((r) => r.field === field);
      const dot = this.dots.get(field);
      if (!ruler || !dot || field !== this.hoveredField) {
        label.style.display = 'none';
        if (dot) dot.style.display = 'none';
        continue;
      }
      vec3.set(p, ruler.anchor[0], ruler.anchor[1], ruler.anchor[2]);
      const clip = projectPoint(this.mvp, p);
      if (!clip) {
        label.style.display = 'none';
        dot.style.display = 'none';
        continue;
      }
      const [x, y] = ndcToCanvas(clip, rect);
      dot.style.display = '';
      dot.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      label.style.display = '';
      // Nudge the label off the dot, keeping it inside the canvas.
      const lx = Math.min(Math.max(x + 12, 4), Math.max(4, rect.width - 4));
      const ly = Math.min(Math.max(y - 8, 4), Math.max(4, rect.height - 6));
      label.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`;
    }
  }

  // ---- camera / model -------------------------------------------------------

  private fitModel(positions: Float32Array): void {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]!);
      minY = Math.min(minY, positions[i + 1]!);
      minZ = Math.min(minZ, positions[i + 2]!);
      maxX = Math.max(maxX, positions[i]!);
      maxY = Math.max(maxY, positions[i + 1]!);
      maxZ = Math.max(maxZ, positions[i + 2]!);
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // MakeHuman's origin sits at the hips, so y = 0 is the orbit pivot.
    const hipY = 0;
    const radius = Math.max(
      Math.hypot(maxX - cx, maxY - hipY, maxZ - cz),
      Math.hypot(minX - cx, minY - hipY, minZ - cz),
      1e-3
    );
    const scale = 1 / radius;

    // Scale then translate, so a point p maps to scale * (p - pivot) and the
    // pivot lands exactly at the origin (the camera target).
    mat4.identity(this.model);
    mat4.scale(this.model, this.model, [scale, scale, scale]);
    mat4.translate(this.model, this.model, [-cx, -hipY, -cz]);
    // A new body starts framed on the hips again.
    this.panY = 0;
  }

  private resize(): void {
    if (this.disposed) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.render();
  }

  private updateUniforms(): void {
    const aspect = Math.max(1e-3, this.canvas.width / Math.max(1, this.canvas.height));
    mat4.perspective(this.proj, (FOV_DEGREES * Math.PI) / 180, aspect, 0.01, 50);
    const cp = Math.cos(this.pitch);
    // The pan lifts the eye and the target by the same amount, so the model
    // keeps its framing while the point you orbit around moves up or down.
    const eye = vec3.fromValues(
      this.distance * cp * Math.sin(this.yaw),
      this.panY + this.distance * Math.sin(this.pitch),
      this.distance * cp * Math.cos(this.yaw)
    );
    mat4.lookAt(this.view, eye, vec3.fromValues(0, this.panY, 0), vec3.fromValues(0, 1, 0));
    mat4.multiply(this.mvp, this.view, this.model);
    mat4.multiply(this.mvp, this.proj, this.mvp);

    this.uniform.set(this.mvp as unknown as number[], 0);
    this.uniform.set(this.model as unknown as number[], 16);
    this.uniform[32] = this.light[0]!;
    this.uniform[33] = this.light[1]!;
    this.uniform[34] = this.light[2]!;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniform);
  }

  private render(): void {
    if (this.disposed || !this.depthTexture) return;
    this.updateUniforms();

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.09, g: 0.08, b: 0.08, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    if (this.meshVB && this.meshIB && this.indexCount > 0) {
      pass.setPipeline(this.meshPipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.meshVB);
      pass.setIndexBuffer(this.meshIB, 'uint32');
      pass.drawIndexed(this.indexCount);
    }
    if (this.showRulers && this.lineVB && this.lineVertexCount > 0) {
      pass.setPipeline(this.linePipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.lineVB);
      pass.draw(this.lineVertexCount);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.updateHoverVisuals();
  }

  private bindInteraction(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      this.shiftHeld = e.shiftKey;
      this.applyCursor();
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      this.shiftHeld = e.shiftKey;
      if (this.dragging && this.dragging.id === e.pointerId) {
        const dx = e.clientX - this.dragging.x;
        const dy = e.clientY - this.dragging.y;
        this.dragging.x = e.clientX;
        this.dragging.y = e.clientY;
        if (dx !== 0 || dy !== 0) this.dragging.moved = true;
        if (e.shiftKey) {
          // Shift-drag slides the camera and the pivot up/down together. Scaled
          // by the world height at the pivot's depth so the model tracks the
          // pointer one-to-one.
          const height = Math.max(1, this.canvas.clientHeight);
          const worldPerPixel = (2 * this.distance * Math.tan((FOV_DEGREES * Math.PI) / 360)) / height;
          const next = this.panY - dy * worldPerPixel;
          this.panY = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, next));
        } else {
          this.yaw -= dx * 0.01;
          this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + dy * 0.01));
        }
        this.applyCursor();
        this.render();
        return;
      }
      this.setHovered(this.pickRuler(e.clientX, e.clientY));
      this.applyCursor();
    });
    const endDrag = (e: PointerEvent) => {
      if (this.dragging?.id === e.pointerId) this.dragging = null;
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
    this.canvas.addEventListener('pointerleave', () => {
      this.shiftHeld = false;
      if (!this.dragging) this.setHovered(null);
      this.applyCursor();
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Multiplicative so zoom is smooth and can get much closer.
        this.distance = Math.max(0.35, Math.min(12, this.distance * Math.exp(e.deltaY * 0.0012)));
        this.render();
      },
      { passive: false }
    );
  }
}

function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const abx = positions[b]! - positions[a]!;
    const aby = positions[b + 1]! - positions[a + 1]!;
    const abz = positions[b + 2]! - positions[a + 2]!;
    const acx = positions[c]! - positions[a]!;
    const acy = positions[c + 1]! - positions[a + 1]!;
    const acz = positions[c + 2]! - positions[a + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    normals[a] += nx;
    normals[a + 1] += ny;
    normals[a + 2] += nz;
    normals[b] += nx;
    normals[b + 1] += ny;
    normals[b + 2] += nz;
    normals[c] += nx;
    normals[c + 1] += ny;
    normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
    normals[i] = normals[i]! / len;
    normals[i + 1] = normals[i + 1]! / len;
    normals[i + 2] = normals[i + 2]! / len;
  }
  return normals;
}

/** Project a model-space point to normalized device coordinates; null if behind the camera. */
function projectPoint(mvp: mat4, p: vec3): [number, number] | null {
  const x = mvp[0]! * p[0]! + mvp[4]! * p[1]! + mvp[8]! * p[2]! + mvp[12]!;
  const y = mvp[1]! * p[0]! + mvp[5]! * p[1]! + mvp[9]! * p[2]! + mvp[13]!;
  const w = mvp[3]! * p[0]! + mvp[7]! * p[1]! + mvp[11]! * p[2]! + mvp[15]!;
  if (w <= 1e-4) return null;
  return [x / w, y / w];
}

/** NDC (-1..1, y up) to canvas pixels (y down). */
function ndcToCanvas(ndc: [number, number], rect: { width: number; height: number }): [number, number] {
  return [((ndc[0] + 1) / 2) * rect.width, ((1 - ndc[1]) / 2) * rect.height];
}

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
