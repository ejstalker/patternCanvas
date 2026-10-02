import { vec3, quat, mat4 } from 'gl-matrix';
import type { AvatarBody } from '../../../mesh/AvatarBody';
import { Ground } from '../../../Ground';
import { Particle } from '../../../physics/Particle';
import { identity } from '../../../utils/math';
import type { MeshGeometry, PatternDocument, SimParams, SimPose } from '../../../project/types';
import type { ClothCollider, ClothFloor, ClothSimulator } from '../../ClothSimulator';
import { buildClothTopology, FALLBACK_PIECE_ID, type ClothTopology } from '../../meshTopology';
import { colorStretchConstraints } from '../../graphColoring';
import { fillStrainColors, type StrainEdge } from '../../strainMap';
import {
  createDummySdfTexture,
  createSdfGpuTexture,
  packObstacles,
  type ObstacleGpu,
} from './sdfGpuTexture';

import predictWgsl from './shaders/predict.wgsl?raw';
import solveStretchWgsl from './shaders/solve_stretch.wgsl?raw';
import solveAttachmentWgsl from './shaders/solve_attachment.wgsl?raw';
import applyDeltasWgsl from './shaders/apply_deltas.wgsl?raw';
import finalizeWgsl from './shaders/finalize.wgsl?raw';
import computeNormalsWgsl from './shaders/compute_normals.wgsl?raw';
import collideSdfWgsl from './shaders/collide_sdf.wgsl?raw';
import collideParticlesWgsl from './shaders/collide_particles.wgsl?raw';

const DELTA_SCALE = 1 << 20;
/** Slower sew so panels wrap around the body instead of tunneling through it. */
const SEAM_RAMP_SECONDS = 6.0;
/** Max particle speed while seams are still closing (world units/s). */
const WRAP_MAX_SPEED = 10;
const WG = 256;

function groups(n: number): number {
  return Math.max(1, Math.ceil(n / WG));
}

/** Map fabric spring / stretchCompliance → XPBD stretch softness (0=rigid, 1=floppy). */
function stretchComplianceFromParams(params: SimParams): number {
  if (params.stretchCompliance != null && Number.isFinite(params.stretchCompliance)) {
    return Math.min(0.9, Math.max(0.02, params.stretchCompliance));
  }
  // springConst 100 → soft (~0.55), 1000 → default (~0.12), 5000 → firm (~0.03)
  const k = Math.min(5000, Math.max(100, params.springConst));
  const t = (k - 100) / (5000 - 100);
  return 0.55 * (1 - t) + 0.03 * t;
}

/** Copy typed array into an ArrayBuffer-backed view for WebGPU writeBuffer. */
function gpuData(data: ArrayBufferView): GPUAllowSharedBufferSource {
  const copy = new Uint8Array(data.byteLength);
  copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return copy;
}

function rayTriangle(
  origin: vec3,
  dir: vec3,
  v0: vec3,
  v1: vec3,
  v2: vec3,
  eps: number
): number | null {
  const edge1 = vec3.create();
  const edge2 = vec3.create();
  vec3.sub(edge1, v1, v0);
  vec3.sub(edge2, v2, v0);
  const pvec = vec3.create();
  vec3.cross(pvec, dir, edge2);
  const det = vec3.dot(edge1, pvec);
  if (Math.abs(det) < eps) return null;
  const invDet = 1 / det;
  const tvec = vec3.create();
  vec3.sub(tvec, origin, v0);
  const u = vec3.dot(tvec, pvec) * invDet;
  if (u < 0 || u > 1) return null;
  const qvec = vec3.create();
  vec3.cross(qvec, tvec, edge1);
  // Möller–Trumbore: v uses the ray direction. Using edge2 here made the
  // barycentric test geometry-dependent and caused GPU cloth picks to fail
  // once simulation deformed the triangles.
  const v = vec3.dot(dir, qvec) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = vec3.dot(edge2, qvec) * invDet;
  return t >= 0 ? t : null;
}

/**
 * Velvet-style Jacobi XPBD cloth on WebGPU compute.
 */
export class XpbdGpuEngine implements ClothSimulator {
  private device: GPUDevice;
  private avatar: AvatarBody;
  private floor: Ground;
  private floorY = 0;
  private topo: ClothTopology;

  private cpuPos: Float32Array;
  private cpuVel: Float32Array;
  /** When true, next simulate frame re-uploads CPU pos/vel to GPU (pose/drag/reset). */
  private simStateDirty = true;
  private cpuInitial: Float32Array;
  private invMasses: Float32Array;
  private radii: Float32Array;
  private indices: Uint32Array;
  private vertexPieceIds: string[];
  private seamPairs: Array<[number, number]>;

  private substeps: number;
  private iterations: number;
  private gravity: number;
  /** Continuous drag coeff for predict (`1 - damping * h`). From dampingConst. */
  private damping: number;
  /** Per-substep velocity retain in finalize (matches CPU `velocityDamping`). */
  private velocityDamping: number;
  /** Stretch softness 0=hard … 1=floppy; derived from springConst / stretchCompliance. */
  private stretchCompliance = 0.12;
  private totalMass = 100;
  private maxSpeed: number;
  private friction: number;
  private enableSelfCollision: boolean;
  private interleavedHash: number;
  private particleDiameter: number;
  private seamRampElapsed = 0;
  private dragging = false;
  private prevT = 0;
  private debugStepCount = 0;
  private hashCounter = 0;

  // GPU buffers
  private positionsBuf!: GPUBuffer;
  private velocitiesBuf!: GPUBuffer;
  private predictedBuf!: GPUBuffer;
  private invMassBuf!: GPUBuffer;
  private radiiBuf!: GPUBuffer;
  private initialBuf!: GPUBuffer;
  private deltaXYZBuf!: GPUBuffer;
  private deltaCountsBuf!: GPUBuffer;
  private stretchIdxBuf!: GPUBuffer;
  private stretchRestBuf!: GPUBuffer;
  /** Pairwise sew constraints: indices (i,j), target rest, initial distance. */
  private seamIdxBuf!: GPUBuffer;
  private seamRestBuf!: GPUBuffer;
  private seamInitialBuf!: GPUBuffer;
  private indicesBuf!: GPUBuffer;
  private normalsAccumBuf!: GPUBuffer;
  private oneRingOffBuf!: GPUBuffer;
  private oneRingNbrBuf!: GPUBuffer;
  private obstaclesBuf!: GPUBuffer;
  private renderPosBuf!: GPUBuffer;
  private renderNrmBuf!: GPUBuffer;
  private colorBuffer!: GPUBuffer;
  private strainColorData!: Float32Array;
  private stretchEdges: StrainEdge[] = [];
  private strainMapEnabled = false;
  private indexBuffer!: GPUBuffer;
  private seamLinePosBuf: GPUBuffer | null = null;
  private seamLineNrmBuf: GPUBuffer | null = null;
  private seamLineVertexCount = 0;
  private stagingBuf!: GPUBuffer;
  private stagingBufB!: GPUBuffer;
  private stagingVelBuf!: GPUBuffer;
  private stagingVelBufB!: GPUBuffer;
  private stagingFlip = 0;
  private readPending = false;
  /** CPU contact resolved; upload pos/vel before the next GPU step. */
  private collisionFeedbackPending = false;
  /** Stretch constraints grouped by color for race-free parallel GS. */
  private stretchColorOffsets: Uint32Array = new Uint32Array([0]);
  private collideProxies: Particle[] = [];

  private nStretch = 0;
  private nAttach = 0;
  private nParticles = 0;
  private nTriangles = 0;

  private pipelines: Record<string, GPUComputePipeline> = {};
  /** Fresh UNIFORM buffers written this frame; destroyed next update (cannot rewrite mid-pass). */
  private transientUniforms: GPUBuffer[] = [];

  private sdfTexture: GPUTexture;
  private sdfView: GPUTextureView;
  private meshObstacles: ObstacleGpu[] = [];
  private dummySdf: { texture: GPUTexture; view: GPUTextureView };

  private cellStartBuf!: GPUBuffer;
  private cellCountBuf!: GPUBuffer;
  private particleIdsBuf!: GPUBuffer;
  private particleHashBuf!: GPUBuffer;
  private tableSize = 4096;
  private maxNeighbors = 64;

  constructor(
    mesh: MeshGeometry,
    params: SimParams,
    device: GPUDevice,
    avatar: AvatarBody,
    pattern?: PatternDocument
  ) {
    this.device = device;
    this.avatar = avatar;
    this.substeps = params.substeps ?? 8;
    this.iterations = params.constraintIterations ?? 4;
    this.gravity = params.gravity;
    this.damping = Math.min(0.5, params.dampingConst * 0.01);
    this.velocityDamping = params.velocityDamping ?? 0.998;
    this.totalMass = Math.max(1e-3, params.mass);
    this.stretchCompliance = stretchComplianceFromParams(params);
    this.maxSpeed = params.maxSpeed ?? 30;
    this.friction = params.contactFriction ?? 0.45;
    this.enableSelfCollision = params.enableSelfCollision ?? false;
    this.interleavedHash = params.interleavedHash ?? 3;

    this.topo = buildClothTopology(mesh, params.mass, pattern, {
      particleDiameterScalar: params.particleDiameterScalar ?? 1.5,
      longRangeStretchiness: params.longRangeStretchiness ?? 1.2,
    });
    this.nParticles = this.topo.numParticles;
    this.cpuPos = new Float32Array(this.topo.positions);
    this.cpuInitial = new Float32Array(this.topo.initialPositions);
    this.cpuVel = new Float32Array(this.nParticles * 3);
    this.invMasses = new Float32Array(this.topo.inverseMasses);
    this.radii = new Float32Array(this.topo.radii);
    this.indices = new Uint32Array(this.topo.indices);
    this.vertexPieceIds = [...this.topo.vertexPieceIds];
    this.seamPairs = this.topo.seamPairs.map((p) => [p[0], p[1]]);
    this.stretchEdges = this.topo.stretch.map((s) => ({ i: s.i, j: s.j, rest: s.rest }));
    this.nTriangles = this.indices.length / 3;
    this.particleDiameter = this.topo.avgEdgeLength * (params.particleDiameterScalar ?? 1.5);

    const up = vec3.fromValues(0, 1, 0);
    this.collideProxies = [];
    for (let i = 0; i < this.nParticles; i++) {
      const pos = vec3.fromValues(this.cpuPos[i * 3], this.cpuPos[i * 3 + 1], this.cpuPos[i * 3 + 2]);
      const p = new Particle(pos, vec3.clone(up), this.topo.particleMass, this.gravity, this.floorY);
      p.setContactFriction(this.friction);
      this.collideProxies.push(p);
    }

    const floorSize = Math.max(16, avatar.getFootprintRadius() * 2.5) * 3;
    this.floor = new Ground([-floorSize * 0.5, 0, -floorSize * 0.5], floorSize, device, {
      radialGradient: true,
    });

    this.dummySdf = createDummySdfTexture(device);
    this.sdfTexture = this.dummySdf.texture;
    this.sdfView = this.dummySdf.view;
    this.refreshSdfFromAvatar();

    this.createGpuBuffers();
    this.createPipelines();
    this.uploadAll();
    this.rebuildSeamLines();
    this.syncStrainColors(true);
    this.prevT = 0;

    this.device.addEventListener('uncapturederror', (ev) => {
      console.error('[XpbdGpuEngine] GPU error', (ev as GPUUncapturedErrorEvent).error);
    });
  }

  private refreshSdfFromAvatar(): void {
    const vol = this.avatar.getSdfVolume?.() ?? null;
    if (this.sdfTexture !== this.dummySdf.texture) {
      this.sdfTexture.destroy();
    }
    if (vol) {
      const uploaded = createSdfGpuTexture(this.device, vol);
      this.sdfTexture = uploaded.texture;
      this.sdfView = uploaded.view;
      this.meshObstacles = [uploaded.obstacle];
    } else {
      this.sdfTexture = this.dummySdf.texture;
      this.sdfView = this.dummySdf.view;
      this.meshObstacles = [];
    }
  }

  private createBuf(
    size: number,
    usage: GPUBufferUsageFlags,
    label: string
  ): GPUBuffer {
    return this.device.createBuffer({ size: Math.max(size, 4), usage, label });
  }

  private createGpuBuffers(): void {
    const n = this.nParticles;
    const usage =
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.positionsBuf = this.createBuf(n * 16, usage, 'xpbd-pos');
    this.velocitiesBuf = this.createBuf(n * 16, usage, 'xpbd-vel');
    this.predictedBuf = this.createBuf(n * 16, usage, 'xpbd-pred');
    this.invMassBuf = this.createBuf(n * 4, usage, 'xpbd-invmass');
    this.radiiBuf = this.createBuf(n * 4, usage, 'xpbd-radii');
    this.initialBuf = this.createBuf(n * 16, usage, 'xpbd-initial');
    this.deltaXYZBuf = this.createBuf(n * 3 * 4, usage, 'xpbd-delta');
    this.deltaCountsBuf = this.createBuf(n * 4, usage, 'xpbd-deltacount');
    this.normalsAccumBuf = this.createBuf(n * 16, usage, 'xpbd-nrm-accum');

    this.nStretch = this.topo.stretch.length;
    const coloring = colorStretchConstraints(this.topo.stretch, this.nParticles);
    this.stretchColorOffsets = coloring.offsets;
    const stretchIdx = new Uint32Array(Math.max(this.nStretch, 1) * 2);
    const stretchRest = new Float32Array(Math.max(this.nStretch, 1));
    for (let slot = 0; slot < this.nStretch; slot++) {
      const src = coloring.idx[slot]!;
      stretchIdx[slot * 2] = this.topo.stretch[src]!.i;
      stretchIdx[slot * 2 + 1] = this.topo.stretch[src]!.j;
      stretchRest[slot] = this.topo.stretch[src]!.rest;
    }
    this.stretchIdxBuf = this.createBuf(stretchIdx.byteLength, usage, 'xpbd-stretch-idx');
    this.stretchRestBuf = this.createBuf(stretchRest.byteLength, usage, 'xpbd-stretch-rest');
    this.writeBuf(this.stretchIdxBuf, stretchIdx);
    this.writeBuf(this.stretchRestBuf, stretchRest);

    const seams = this.topo.seamConstraints ?? [];
    this.nAttach = seams.length;
    const seamIdx = new Uint32Array(Math.max(this.nAttach, 1) * 2);
    const seamRest = new Float32Array(Math.max(this.nAttach, 1));
    const seamInit = new Float32Array(Math.max(this.nAttach, 1));
    for (let i = 0; i < this.nAttach; i++) {
      seamIdx[i * 2] = seams[i].i;
      seamIdx[i * 2 + 1] = seams[i].j;
      seamRest[i] = seams[i].rest;
      seamInit[i] = seams[i].initialDist;
    }
    this.seamIdxBuf = this.createBuf(seamIdx.byteLength, usage, 'xpbd-seam-idx');
    this.seamRestBuf = this.createBuf(seamRest.byteLength, usage, 'xpbd-seam-rest');
    this.seamInitialBuf = this.createBuf(seamInit.byteLength, usage, 'xpbd-seam-init');
    this.writeBuf(this.seamIdxBuf, seamIdx);
    this.writeBuf(this.seamRestBuf, seamRest);
    this.writeBuf(this.seamInitialBuf, seamInit);

    this.indicesBuf = this.createBuf(this.indices.byteLength || 4, usage, 'xpbd-indices');
    this.writeBuf(this.indicesBuf, this.indices);

    this.oneRingOffBuf = this.createBuf(
      this.topo.oneRingOffsets.byteLength,
      usage,
      'xpbd-1ring-off'
    );
    this.oneRingNbrBuf = this.createBuf(
      Math.max(this.topo.oneRingNeighbors.byteLength, 4),
      usage,
      'xpbd-1ring-nbr'
    );
    this.writeBuf(this.oneRingOffBuf, this.topo.oneRingOffsets);
    if (this.topo.oneRingNeighbors.byteLength > 0) {
      this.writeBuf(this.oneRingNbrBuf, this.topo.oneRingNeighbors);
    }

    this.obstaclesBuf = this.createBuf(28 * 4 * 4, usage, 'xpbd-obstacles');
    this.renderPosBuf = this.createBuf(
      n * 12,
      GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'xpbd-render-pos'
    );
    this.renderNrmBuf = this.createBuf(
      n * 12,
      GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'xpbd-render-nrm'
    );
    this.strainColorData = new Float32Array(n * 3);
    this.colorBuffer = this.createBuf(
      n * 12,
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      'xpbd-render-color'
    );
    this.indexBuffer = this.createBuf(
      this.indices.byteLength || 4,
      GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      'xpbd-index'
    );
    this.writeBuf(this.indexBuffer, this.indices);

    this.stagingBuf = this.createBuf(
      n * 16,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      'xpbd-staging-a'
    );
    this.stagingBufB = this.createBuf(
      n * 16,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      'xpbd-staging-b'
    );
    this.stagingVelBuf = this.createBuf(
      n * 16,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      'xpbd-staging-vel-a'
    );
    this.stagingVelBufB = this.createBuf(
      n * 16,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      'xpbd-staging-vel-b'
    );

    this.cellStartBuf = this.createBuf(this.tableSize * 4, usage, 'xpbd-cell-start');
    this.cellCountBuf = this.createBuf(this.tableSize * 4, usage, 'xpbd-cell-count');
    this.particleIdsBuf = this.createBuf(n * this.maxNeighbors * 4, usage, 'xpbd-part-ids');
    this.particleHashBuf = this.createBuf(n * 4, usage, 'xpbd-part-hash');
  }

  private createPipelines(): void {
    const mk = (code: string, entry = 'main') => {
      const module = this.device.createShaderModule({ code });
      return this.device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: entry },
      });
    };
    this.pipelines.predict = mk(predictWgsl);
    this.pipelines.stretch = mk(solveStretchWgsl);
    this.pipelines.attach = mk(solveAttachmentWgsl);
    this.pipelines.applyDeltas = mk(applyDeltasWgsl);
    this.pipelines.finalize = mk(finalizeWgsl);
    this.pipelines.collideSdf = mk(collideSdfWgsl);
    this.pipelines.collideParticles = mk(collideParticlesWgsl);
    this.pipelines.zeroNormals = mk(computeNormalsWgsl, 'zero_normals');
    this.pipelines.accumNormals = mk(computeNormalsWgsl, 'accumulate_tri_normals');
    this.pipelines.normCopy = mk(computeNormalsWgsl, 'normalize_and_copy');
  }

  /** Allocate a one-shot uniform buffer. Must not be rewritten while bound in an open pass. */
  private uniform(_label: string, data: Float32Array | Uint32Array | ArrayBuffer): GPUBuffer {
    const bytes =
      data instanceof ArrayBuffer ? Math.max(data.byteLength, 16) : Math.max(data.byteLength, 16);
    const buf = this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    if (data instanceof ArrayBuffer) {
      this.device.queue.writeBuffer(buf, 0, data);
    } else {
      this.device.queue.writeBuffer(buf, 0, gpuData(data));
    }
    this.transientUniforms.push(buf);
    return buf;
  }

  private flushTransientUniforms(): void {
    for (const b of this.transientUniforms) b.destroy();
    this.transientUniforms.length = 0;
  }

  private uploadVec4(buf: GPUBuffer, xyz: Float32Array): void {
    const n = xyz.length / 3;
    const v4 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      v4[i * 4] = xyz[i * 3];
      v4[i * 4 + 1] = xyz[i * 3 + 1];
      v4[i * 4 + 2] = xyz[i * 3 + 2];
    }
    this.device.queue.writeBuffer(buf, 0, gpuData(v4));
  }

  private writeBuf(buf: GPUBuffer, data: ArrayBufferView): void {
    this.device.queue.writeBuffer(buf, 0, gpuData(data));
  }

  private uploadAll(): void {
    this.uploadVec4(this.positionsBuf, this.cpuPos);
    this.uploadVec4(this.velocitiesBuf, this.cpuVel);
    this.uploadVec4(this.predictedBuf, this.cpuPos);
    this.uploadVec4(this.initialBuf, this.cpuInitial);
    this.writeBuf(this.invMassBuf, this.invMasses);
    this.writeBuf(this.radiiBuf, this.radii);
    this.writeRenderMeshes();
    this.writeObstacles();
    this.simStateDirty = false;
  }

  private writeObstacles(): void {
    const packed = packObstacles(this.meshObstacles);
    this.writeBuf(this.obstaclesBuf, packed);
  }

  private bg(pipeline: GPUComputePipeline, entries: GPUBindGroupEntry[]): GPUBindGroup {
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    });
  }

  private encodeStep(encoder: GPUCommandEncoder, h: number, seamProgress: number): void {
    const n = this.nParticles;
    const pass = encoder.beginComputePass();
    const wrapping = seamProgress < 0.999;
    const speedCap = wrapping ? Math.min(this.maxSpeed, WRAP_MAX_SPEED) : this.maxSpeed;

    for (let s = 0; s < this.substeps; s++) {
      {
        const uData = new ArrayBuffer(16);
        const f = new Float32Array(uData);
        const u32 = new Uint32Array(uData);
        f[0] = h;
        f[1] = this.gravity;
        f[2] = this.damping;
        u32[3] = n;
        const u = this.uniform('predict', uData);
        pass.setPipeline(this.pipelines.predict);
        pass.setBindGroup(
          0,
          this.bg(this.pipelines.predict, [
            { binding: 0, resource: { buffer: u } },
            { binding: 1, resource: { buffer: this.positionsBuf } },
            { binding: 2, resource: { buffer: this.velocitiesBuf } },
            { binding: 3, resource: { buffer: this.predictedBuf } },
            { binding: 4, resource: { buffer: this.invMassBuf } },
          ])
        );
        pass.dispatchWorkgroups(groups(n));
      }

      if (this.enableSelfCollision) {
        // Self-collision still uses the atomic delta path; skip until converted.
        // this.dispatchSelfCollision(pass);
        // this.dispatchApplyDeltas(pass);
      }

      for (let it = 0; it < this.iterations; it++) {
        this.dispatchStretch(pass);
        this.dispatchAttach(pass, seamProgress, h);
        // Extra stretch pass resists seam crumpling / self-intersection.
        if (wrapping) this.dispatchStretch(pass);
      }

      {
        const uData = new ArrayBuffer(16);
        const f = new Float32Array(uData);
        const u32 = new Uint32Array(uData);
        f[0] = 1 / h;
        f[1] = Math.pow(
          Math.min(1, Math.max(0.9, this.velocityDamping)),
          1 / Math.max(1, this.substeps)
        );
        f[2] = speedCap;
        u32[3] = n;
        const u = this.uniform('finalize', uData);
        pass.setPipeline(this.pipelines.finalize);
        pass.setBindGroup(
          0,
          this.bg(this.pipelines.finalize, [
            { binding: 0, resource: { buffer: u } },
            { binding: 1, resource: { buffer: this.positionsBuf } },
            { binding: 2, resource: { buffer: this.velocitiesBuf } },
            { binding: 3, resource: { buffer: this.predictedBuf } },
            { binding: 4, resource: { buffer: this.invMassBuf } },
          ])
        );
        pass.dispatchWorkgroups(groups(n));
      }

      // Body/floor contact after finalize so sew can't pull through the avatar.
      this.dispatchCollideSdf(pass, h);
    }

    pass.end();
  }

  private dispatchStretch(pass: GPUComputePassEncoder): void {
    if (this.nStretch === 0) return;
    const compliance = this.stretchCompliance;
    pass.setPipeline(this.pipelines.stretch);
    for (let c = 0; c < this.stretchColorOffsets.length - 1; c++) {
      const offset = this.stretchColorOffsets[c]!;
      const count = this.stretchColorOffsets[c + 1]! - offset;
      if (count <= 0) continue;
      const uData = new ArrayBuffer(16);
      const f = new Float32Array(uData);
      const u32 = new Uint32Array(uData);
      u32[0] = offset;
      u32[1] = count;
      f[2] = compliance;
      u32[3] = this.nParticles;
      const u = this.uniform(`stretch-${c}`, uData);
      pass.setBindGroup(
        0,
        this.bg(this.pipelines.stretch, [
          { binding: 0, resource: { buffer: u } },
          { binding: 1, resource: { buffer: this.predictedBuf } },
          { binding: 2, resource: { buffer: this.invMassBuf } },
          { binding: 3, resource: { buffer: this.stretchIdxBuf } },
          { binding: 4, resource: { buffer: this.stretchRestBuf } },
        ])
      );
      pass.dispatchWorkgroups(groups(count));
    }
  }

  private dispatchAttach(pass: GPUComputePassEncoder, seamProgress: number, h: number): void {
    if (this.nAttach === 0) return;
    // Softer while wrapping; a bit firmer once nearly closed.
    const t = Math.min(1, Math.max(0, seamProgress));
    const underRelax = 0.12 + 0.18 * t;
    // Limit how much gap one solve may close (≈ travel budget for this substep).
    const maxClose = Math.max(
      this.topo.avgEdgeLength * 0.08,
      Math.min(this.maxSpeed, WRAP_MAX_SPEED) * h / Math.max(1, this.iterations)
    );
    const uData = new ArrayBuffer(32);
    const f = new Float32Array(uData);
    const u32 = new Uint32Array(uData);
    u32[0] = this.nAttach;
    f[1] = seamProgress;
    u32[2] = this.nParticles;
    f[3] = underRelax;
    f[4] = maxClose;
    const u = this.uniform('attach', uData);
    pass.setPipeline(this.pipelines.attach);
    pass.setBindGroup(
      0,
      this.bg(this.pipelines.attach, [
        { binding: 0, resource: { buffer: u } },
        { binding: 1, resource: { buffer: this.predictedBuf } },
        { binding: 2, resource: { buffer: this.invMassBuf } },
        { binding: 3, resource: { buffer: this.seamIdxBuf } },
        { binding: 4, resource: { buffer: this.seamRestBuf } },
        { binding: 5, resource: { buffer: this.seamInitialBuf } },
      ])
    );
    pass.dispatchWorkgroups(groups(this.nAttach));
  }

  private dispatchCollideSdf(pass: GPUComputePassEncoder, h: number): void {
    if (this.meshObstacles.length === 0 && this.floorY === 0) {
      // Still resolve floor even without mesh SDF.
    }
    const margin = Math.max(0.05, this.topo.avgEdgeLength * 0.35);
    const maxPush = Math.min(margin * 2, Math.max(margin * 0.35, this.maxSpeed * h));
    const tangRetain = Math.max(0, 1 - Math.min(2, Math.max(0, this.friction)) * 0.95);
    const uData = new ArrayBuffer(32);
    const f = new Float32Array(uData);
    const u32 = new Uint32Array(uData);
    f[0] = tangRetain;
    f[1] = maxPush;
    u32[2] = this.nParticles;
    u32[3] = this.meshObstacles.length;
    f[4] = this.floorY;
    f[5] = margin;
    const u = this.uniform('sdf', uData);

    pass.setPipeline(this.pipelines.collideSdf);
    pass.setBindGroup(
      0,
      this.bg(this.pipelines.collideSdf, [
        { binding: 0, resource: { buffer: u } },
        { binding: 1, resource: { buffer: this.positionsBuf } },
        { binding: 2, resource: { buffer: this.velocitiesBuf } },
        { binding: 3, resource: { buffer: this.invMassBuf } },
        { binding: 4, resource: { buffer: this.obstaclesBuf } },
        { binding: 5, resource: this.sdfView },
      ])
    );
    pass.dispatchWorkgroups(groups(this.nParticles));
  }

  private dispatchApplyDeltas(pass: GPUComputePassEncoder): void {
    const uData = new ArrayBuffer(16);
    const f = new Float32Array(uData);
    const u32 = new Uint32Array(uData);
    u32[0] = this.nParticles;
    f[2] = 1.0;
    const u = this.uniform('apply', uData);
    pass.setPipeline(this.pipelines.applyDeltas);
    pass.setBindGroup(
      0,
      this.bg(this.pipelines.applyDeltas, [
        { binding: 0, resource: { buffer: u } },
        { binding: 1, resource: { buffer: this.predictedBuf } },
        { binding: 2, resource: { buffer: this.deltaXYZBuf } },
        { binding: 3, resource: { buffer: this.deltaCountsBuf } },
      ])
    );
    pass.dispatchWorkgroups(groups(this.nParticles));
  }

  private buildSpatialHashCpu(): void {
    const tableSize = this.tableSize;
    const invCell = 1 / Math.max(this.particleDiameter, 1e-4);
    const counts = new Uint32Array(tableSize);
    const hashes = new Uint32Array(this.nParticles);
    const hash = (x: number, y: number, z: number) => {
      const cx = Math.floor(x * invCell) | 0;
      const cy = Math.floor(y * invCell) | 0;
      const cz = Math.floor(z * invCell) | 0;
      return (
        (((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) >>> 0) %
          tableSize)
      );
    };
    for (let i = 0; i < this.nParticles; i++) {
      const h = hash(this.cpuPos[i * 3], this.cpuPos[i * 3 + 1], this.cpuPos[i * 3 + 2]);
      hashes[i] = h;
      counts[h]++;
    }
    const starts = new Uint32Array(tableSize);
    let total = 0;
    for (let i = 0; i < tableSize; i++) {
      starts[i] = total;
      total += counts[i];
      counts[i] = 0;
    }
    const ids = new Uint32Array(Math.max(total, 1));
    for (let i = 0; i < this.nParticles; i++) {
      const h = hashes[i];
      const slot = starts[h] + counts[h]++;
      ids[slot] = i;
    }
    this.writeBuf(this.cellStartBuf, starts);
    this.writeBuf(this.cellCountBuf, counts);
    this.writeBuf(this.particleIdsBuf, ids);
    this.writeBuf(this.particleHashBuf, hashes);
  }

  private dispatchSelfCollision(pass: GPUComputePassEncoder): void {
    const uData = new ArrayBuffer(32);
    const f = new Float32Array(uData);
    const u32 = new Uint32Array(uData);
    u32[0] = this.nParticles;
    u32[1] = this.tableSize;
    f[2] = 1 / Math.max(this.particleDiameter, 1e-4);
    f[3] = this.particleDiameter;
    f[4] = DELTA_SCALE;
    f[5] = this.friction;
    u32[6] = this.maxNeighbors;
    const u = this.uniform('selfcol', uData);
    pass.setPipeline(this.pipelines.collideParticles);
    pass.setBindGroup(
      0,
      this.bg(this.pipelines.collideParticles, [
        { binding: 0, resource: { buffer: u } },
        { binding: 1, resource: { buffer: this.predictedBuf } },
        { binding: 2, resource: { buffer: this.initialBuf } },
        { binding: 3, resource: { buffer: this.invMassBuf } },
        { binding: 4, resource: { buffer: this.oneRingOffBuf } },
        { binding: 5, resource: { buffer: this.oneRingNbrBuf } },
        { binding: 6, resource: { buffer: this.cellStartBuf } },
        { binding: 7, resource: { buffer: this.cellCountBuf } },
        { binding: 8, resource: { buffer: this.particleIdsBuf } },
        { binding: 9, resource: { buffer: this.deltaXYZBuf } },
        { binding: 10, resource: { buffer: this.deltaCountsBuf } },
      ])
    );
    pass.dispatchWorkgroups(groups(this.nParticles));
  }

  private async readbackPositions(): Promise<void> {
    await this.finishReadback();
  }

  private async finishReadback(): Promise<void> {
    if (this.readPending) return;
    this.readPending = true;
    const staging = this.stagingFlip === 0 ? this.stagingBuf : this.stagingBufB;
    const stagingVel = this.stagingFlip === 0 ? this.stagingVelBuf : this.stagingVelBufB;
    try {
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      await stagingVel.mapAsync(GPUMapMode.READ);
      const velData = new Float32Array(stagingVel.getMappedRange().slice(0));
      stagingVel.unmap();
      for (let i = 0; i < this.nParticles; i++) {
        this.cpuPos[i * 3] = data[i * 4]!;
        this.cpuPos[i * 3 + 1] = data[i * 4 + 1]!;
        this.cpuPos[i * 3 + 2] = data[i * 4 + 2]!;
        this.cpuVel[i * 3] = velData[i * 4]!;
        this.cpuVel[i * 3 + 1] = velData[i * 4 + 1]!;
        this.cpuVel[i * 3 + 2] = velData[i * 4 + 2]!;
      }
      this.applyCpuCollision();
      this.writeRenderMeshes();
      this.collisionFeedbackPending = true;
      if (typeof window !== 'undefined') {
        let y = 0;
        for (let i = 0; i < this.nParticles; i++) y += this.cpuPos[i * 3 + 1]!;
        (window as unknown as { __xpbdMeanY?: number; __xpbdMeanX?: number }).__xpbdMeanY =
          y / this.nParticles;
        let x = 0;
        for (let i = 0; i < this.nParticles; i++) x += this.cpuPos[i * 3]!;
        (window as unknown as { __xpbdMeanX?: number }).__xpbdMeanX = x / this.nParticles;
      }
      this.rebuildSeamLines();
      this.syncStrainColors();
    } catch {
      /* map may fail if buffer in use; next frame retries */
    } finally {
      this.readPending = false;
    }
  }

  /** Same contact model as CPU PatternCloth — stable on SDF / triangle avatar. */
  private applyCpuCollision(): void {
    const edge = this.topo.avgEdgeLength;
    for (let i = 0; i < this.nParticles; i++) {
      if (this.invMasses[i]! <= 0) continue;
      const proxy = this.collideProxies[i]!;
      const pos = proxy.position;
      const vel = proxy.getVelocity();
      const x0 = this.cpuPos[i * 3]!;
      const y0 = this.cpuPos[i * 3 + 1]!;
      const z0 = this.cpuPos[i * 3 + 2]!;
      pos[0] = x0;
      pos[1] = y0;
      pos[2] = z0;
      vel[0] = this.cpuVel[i * 3]!;
      vel[1] = this.cpuVel[i * 3 + 1]!;
      vel[2] = this.cpuVel[i * 3 + 2]!;
      proxy.setGroundPos(this.floorY);
      proxy.setContactFriction(this.friction);
      proxy.groundCollision();
      this.avatar.resolveParticle(proxy, edge);
      const dx = pos[0]! - x0;
      const dy = pos[1]! - y0;
      const dz = pos[2]! - z0;
      const movedSq = dx * dx + dy * dy + dz * dz;
      // Extra settle when contact actually projected — kills chatter against the body.
      if (movedSq > 1e-10) {
        vel[0]! *= 0.92;
        vel[1]! *= 0.92;
        vel[2]! *= 0.92;
      }
      const speedCap =
        this.seamRampElapsed < SEAM_RAMP_SECONDS
          ? Math.min(this.maxSpeed, WRAP_MAX_SPEED)
          : this.maxSpeed;
      const speed = Math.hypot(vel[0]!, vel[1]!, vel[2]!);
      if (speed > speedCap && speed > 1e-8) {
        const s = speedCap / speed;
        vel[0]! *= s;
        vel[1]! *= s;
        vel[2]! *= s;
      }
      this.cpuPos[i * 3] = pos[0]!;
      this.cpuPos[i * 3 + 1] = pos[1]!;
      this.cpuPos[i * 3 + 2] = pos[2]!;
      this.cpuVel[i * 3] = vel[0]!;
      this.cpuVel[i * 3 + 1] = vel[1]!;
      this.cpuVel[i * 3 + 2] = vel[2]!;
    }
  }

  /** Stable face-area weighted normals (no GPU race flicker). */
  private writeRenderMeshes(): void {
    const nrm = new Float32Array(this.nParticles * 3);
    const idx = this.indices;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const i0 = idx[t]!;
      const i1 = idx[t + 1]!;
      const i2 = idx[t + 2]!;
      const ax = this.cpuPos[i1 * 3]! - this.cpuPos[i0 * 3]!;
      const ay = this.cpuPos[i1 * 3 + 1]! - this.cpuPos[i0 * 3 + 1]!;
      const az = this.cpuPos[i1 * 3 + 2]! - this.cpuPos[i0 * 3 + 2]!;
      const bx = this.cpuPos[i2 * 3]! - this.cpuPos[i0 * 3]!;
      const by = this.cpuPos[i2 * 3 + 1]! - this.cpuPos[i0 * 3 + 1]!;
      const bz = this.cpuPos[i2 * 3 + 2]! - this.cpuPos[i0 * 3 + 2]!;
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      nrm[i0 * 3] += nx;
      nrm[i0 * 3 + 1] += ny;
      nrm[i0 * 3 + 2] += nz;
      nrm[i1 * 3] += nx;
      nrm[i1 * 3 + 1] += ny;
      nrm[i1 * 3 + 2] += nz;
      nrm[i2 * 3] += nx;
      nrm[i2 * 3 + 1] += ny;
      nrm[i2 * 3 + 2] += nz;
    }
    for (let i = 0; i < this.nParticles; i++) {
      const ox = i * 3;
      const len = Math.hypot(nrm[ox]!, nrm[ox + 1]!, nrm[ox + 2]!);
      if (len > 1e-8) {
        nrm[ox]! /= len;
        nrm[ox + 1]! /= len;
        nrm[ox + 2]! /= len;
      } else {
        nrm[ox + 1] = 1;
      }
    }
    this.writeBuf(this.renderPosBuf, this.cpuPos);
    this.writeBuf(this.renderNrmBuf, nrm);
  }

  private syncStrainColors(force = false): void {
    if (!this.colorBuffer || !this.strainColorData) return;
    if (!this.strainMapEnabled && !force) return;
    if (!this.strainMapEnabled) {
      this.strainColorData.fill(0);
      this.writeBuf(this.colorBuffer, this.strainColorData);
      return;
    }
    fillStrainColors(this.cpuPos, this.stretchEdges, this.strainColorData);
    this.writeBuf(this.colorBuffer, this.strainColorData);
  }

  setStrainMapEnabled(enabled: boolean): void {
    this.strainMapEnabled = enabled;
    this.syncStrainColors(true);
  }

  isStrainMapEnabled(): boolean {
    return this.strainMapEnabled;
  }

  getColorBuffer(): GPUBuffer | null {
    return this.colorBuffer;
  }

  private rebuildSeamLines(): void {
    this.seamLinePosBuf?.destroy();
    this.seamLineNrmBuf?.destroy();
    this.seamLinePosBuf = null;
    this.seamLineNrmBuf = null;
    this.seamLineVertexCount = 0;
    if (this.seamPairs.length === 0) return;
    const pos = new Float32Array(this.seamPairs.length * 2 * 3);
    const nrm = new Float32Array(this.seamPairs.length * 2 * 3);
    for (let i = 0; i < this.seamPairs.length; i++) {
      const [a, b] = this.seamPairs[i];
      const o = i * 6;
      pos[o] = this.cpuPos[a * 3];
      pos[o + 1] = this.cpuPos[a * 3 + 1];
      pos[o + 2] = this.cpuPos[a * 3 + 2];
      pos[o + 3] = this.cpuPos[b * 3];
      pos[o + 4] = this.cpuPos[b * 3 + 1];
      pos[o + 5] = this.cpuPos[b * 3 + 2];
      nrm[o + 1] = 1;
      nrm[o + 4] = 1;
    }
    this.seamLineVertexCount = this.seamPairs.length * 2;
    this.seamLinePosBuf = this.device.createBuffer({
      size: pos.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.seamLineNrmBuf = this.device.createBuffer({
      size: nrm.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.seamLinePosBuf, 0, pos);
    this.writeBuf(this.seamLineNrmBuf, nrm);
  }

  update(simulate = true): void {
    const now = performance.now();
    if (this.prevT === 0) {
      this.prevT = now;
      this.syncRenderFromCpu();
      return;
    }
    let dt = (now - this.prevT) / 1000;
    this.prevT = now;
    if (!simulate || this.dragging) {
      this.syncRenderFromCpu();
      return;
    }
    dt = Math.min(dt, 0.03);
    this.seamRampElapsed += dt;
    const seamProgress = Math.min(1, this.seamRampElapsed / SEAM_RAMP_SECONDS);
    const h = dt / this.substeps;

    // Keep pos/vel resident on the GPU across frames unless CPU contact feedback
    // or an explicit edit (drag/reset) dirtied the CPU mirror.
    if (this.simStateDirty || this.collisionFeedbackPending) {
      this.uploadVec4(this.positionsBuf, this.cpuPos);
      this.uploadVec4(this.velocitiesBuf, this.cpuVel);
      this.uploadVec4(this.predictedBuf, this.cpuPos);
      this.simStateDirty = false;
      this.collisionFeedbackPending = false;
    }
    this.writeObstacles();
    // Seam LRA targets + spatial hash must be written before the compute pass opens.
    if (this.enableSelfCollision) {
      this.hashCounter++;
      if (this.hashCounter % this.interleavedHash === 0) {
        this.buildSpatialHashCpu();
      }
    }

    this.flushTransientUniforms();
    const encoder = this.device.createCommandEncoder();
    try {
      this.encodeStep(encoder, h, seamProgress);
      // Only flip + copy when the previous readback finished. Flipping while
      // readPending left collision feedback reading a stale staging buffer and
      // fighting the live GPU state (high-frequency jitter).
      if (!this.readPending) {
        this.stagingFlip = 1 - this.stagingFlip;
        const staging = this.stagingFlip === 0 ? this.stagingBuf : this.stagingBufB;
        const stagingVel = this.stagingFlip === 0 ? this.stagingVelBuf : this.stagingVelBufB;
        encoder.copyBufferToBuffer(this.positionsBuf, 0, staging, 0, this.nParticles * 16);
        encoder.copyBufferToBuffer(this.velocitiesBuf, 0, stagingVel, 0, this.nParticles * 16);
      }
      this.device.queue.submit([encoder.finish()]);
      this.debugStepCount = (this.debugStepCount ?? 0) + 1;
      if (typeof window !== 'undefined') {
        (window as unknown as { __xpbdSteps?: number }).__xpbdSteps = this.debugStepCount;
      }
    } catch (err) {
      console.error('[XpbdGpuEngine] encode/submit failed', err);
      if (typeof window !== 'undefined') {
        (window as unknown as { __xpbdEncodeErr?: string }).__xpbdEncodeErr = String(err);
      }
      return;
    }

    if (!this.readPending) {
      void this.finishReadback();
    }
  }

  private syncRenderFromCpu(): void {
    this.writeRenderMeshes();
    this.uploadVec4(this.positionsBuf, this.cpuPos);
    this.uploadVec4(this.velocitiesBuf, this.cpuVel);
    this.simStateDirty = false;
    this.rebuildSeamLines();
    this.syncStrainColors();
  }

  applyParams(params: SimParams): void {
    this.substeps = params.substeps ?? this.substeps;
    this.iterations = params.constraintIterations ?? this.iterations;
    this.gravity = params.gravity;
    this.damping = Math.min(0.5, params.dampingConst * 0.01);
    this.velocityDamping = params.velocityDamping ?? this.velocityDamping;
    this.maxSpeed = params.maxSpeed ?? this.maxSpeed;
    this.friction = params.contactFriction ?? this.friction;
    this.enableSelfCollision = params.enableSelfCollision ?? this.enableSelfCollision;
    this.interleavedHash = params.interleavedHash ?? this.interleavedHash;
    this.stretchCompliance = stretchComplianceFromParams(params);

    const mass = Math.max(1e-3, params.mass);
    if (Math.abs(mass - this.totalMass) > 1e-6) {
      this.totalMass = mass;
      const particleMass = mass / Math.max(1, this.nParticles);
      const inv = particleMass > 0 ? 1 / particleMass : 0;
      this.invMasses.fill(inv);
      this.writeBuf(this.invMassBuf, this.invMasses);
    }
  }

  exportPose(): SimPose {
    const positions = Array.from(this.cpuPos);
    const velocities = Array.from(this.cpuVel);
    return { positions, velocities };
  }

  applyPose(pose: SimPose): void {
    for (let i = 0; i < this.nParticles; i++) {
      const o = i * 3;
      if (o + 2 >= pose.positions.length) break;
      this.cpuPos[o] = pose.positions[o];
      this.cpuPos[o + 1] = pose.positions[o + 1];
      this.cpuPos[o + 2] = pose.positions[o + 2];
      if (pose.velocities && o + 2 < pose.velocities.length) {
        this.cpuVel[o] = pose.velocities[o];
        this.cpuVel[o + 1] = pose.velocities[o + 1];
        this.cpuVel[o + 2] = pose.velocities[o + 2];
      }
    }
    this.seamRampElapsed = SEAM_RAMP_SECONDS;
    this.simStateDirty = true;
    this.uploadAll();
    this.rebuildSeamLines();
  }

  resetToInitialState(): void {
    this.cpuPos.set(this.cpuInitial);
    this.cpuVel.fill(0);
    this.seamRampElapsed = 0;
    this.dragging = false;
    this.prevT = 0;
    this.simStateDirty = true;
    this.uploadAll();
    this.rebuildSeamLines();
    if (typeof window !== 'undefined') {
      let y = 0;
      for (let i = 0; i < this.nParticles; i++) y += this.cpuPos[i * 3 + 1]!;
      (window as unknown as { __xpbdCpuY?: number; __xpbdN?: number }).__xpbdCpuY =
        y / this.nParticles;
      (window as unknown as { __xpbdN?: number }).__xpbdN = this.nParticles;
    }
  }

  setAvatar(avatar: ClothCollider): void {
    this.avatar = avatar as AvatarBody;
    this.refreshSdfFromAvatar();
    this.writeObstacles();
  }

  getGround(): ClothCollider {
    return this.avatar;
  }

  getFloor(): ClothFloor {
    return this.floor;
  }

  getSeamLineVertexCount(): number {
    return this.seamLineVertexCount;
  }

  getSeamLinePositionBuffer(): GPUBuffer | null {
    return this.seamLinePosBuf;
  }

  getSeamLineNormalBuffer(): GPUBuffer | null {
    return this.seamLineNrmBuf;
  }

  getVertexPieceIds(): readonly string[] {
    return this.vertexPieceIds;
  }

  raycast(origin: vec3, dir: vec3): { t: number; point: vec3; pieceId: string } | null {
    let bestT = Infinity;
    let best: vec3 | null = null;
    let bestPieceId = FALLBACK_PIECE_ID;
    const eps = 1e-6;
    for (let i = 0; i + 2 < this.indices.length; i += 3) {
      const i0 = this.indices[i];
      const i1 = this.indices[i + 1];
      const i2 = this.indices[i + 2];
      const v0 = vec3.fromValues(
        this.cpuPos[i0 * 3],
        this.cpuPos[i0 * 3 + 1],
        this.cpuPos[i0 * 3 + 2]
      );
      const v1 = vec3.fromValues(
        this.cpuPos[i1 * 3],
        this.cpuPos[i1 * 3 + 1],
        this.cpuPos[i1 * 3 + 2]
      );
      const v2 = vec3.fromValues(
        this.cpuPos[i2 * 3],
        this.cpuPos[i2 * 3 + 1],
        this.cpuPos[i2 * 3 + 2]
      );
      const hit = rayTriangle(origin, dir, v0, v1, v2, eps);
      if (hit !== null && hit > eps && hit < bestT) {
        bestT = hit;
        bestPieceId = this.vertexPieceIds[i0] ?? FALLBACK_PIECE_ID;
        best = vec3.create();
        vec3.scaleAndAdd(best, origin, dir, hit);
      }
    }
    return best ? { t: bestT, point: best, pieceId: bestPieceId } : null;
  }

  getCentroid(pieceId?: string): vec3 {
    const c = vec3.create();
    let count = 0;
    for (let i = 0; i < this.nParticles; i++) {
      if (pieceId && this.vertexPieceIds[i] !== pieceId) continue;
      c[0] += this.cpuPos[i * 3];
      c[1] += this.cpuPos[i * 3 + 1];
      c[2] += this.cpuPos[i * 3 + 2];
      count++;
    }
    if (count > 0) {
      c[0] /= count;
      c[1] /= count;
      c[2] /= count;
    }
    return c;
  }

  getPieceCentroidTuple(pieceId: string): [number, number, number] {
    const c = this.getCentroid(pieceId);
    return [c[0], c[1], c[2]];
  }

  setPieceCentroid(pieceId: string, target: [number, number, number]): void {
    const c = this.getCentroid(pieceId);
    this.translateBy(
      vec3.fromValues(target[0] - c[0], target[1] - c[1], target[2] - c[2]),
      pieceId
    );
  }

  applyPieceEulerDegrees(pieceId: string, eulerDeg: [number, number, number]): void {
    for (let i = 0; i < this.nParticles; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      this.cpuPos[i * 3] = this.cpuInitial[i * 3];
      this.cpuPos[i * 3 + 1] = this.cpuInitial[i * 3 + 1];
      this.cpuPos[i * 3 + 2] = this.cpuInitial[i * 3 + 2];
      this.cpuVel[i * 3] = 0;
      this.cpuVel[i * 3 + 1] = 0;
      this.cpuVel[i * 3 + 2] = 0;
    }
    const axes: Array<[number, number, number]> = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    for (let a = 0; a < 3; a++) {
      const rad = (eulerDeg[a] * Math.PI) / 180;
      if (Math.abs(rad) < 1e-8) continue;
      this.rotateBy(vec3.fromValues(...axes[a]), rad, pieceId);
    }
  }

  applyPieceQuat(pieceId: string, quatXyZw: [number, number, number, number]): void {
    for (let i = 0; i < this.nParticles; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      this.cpuPos[i * 3] = this.cpuInitial[i * 3];
      this.cpuPos[i * 3 + 1] = this.cpuInitial[i * 3 + 1];
      this.cpuPos[i * 3 + 2] = this.cpuInitial[i * 3 + 2];
      this.cpuVel[i * 3] = 0;
      this.cpuVel[i * 3 + 1] = 0;
      this.cpuVel[i * 3 + 2] = 0;
    }
    const rotation = quat.fromValues(quatXyZw[0], quatXyZw[1], quatXyZw[2], quatXyZw[3]);
    if (quat.squaredLength(rotation) < 1e-12) {
      this.simStateDirty = true;
      this.syncRenderFromCpu();
      return;
    }
    quat.normalize(rotation, rotation);
    const center = this.getCentroid(pieceId);
    const relative = vec3.create();
    for (let i = 0; i < this.nParticles; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      vec3.set(
        relative,
        this.cpuPos[i * 3] - center[0],
        this.cpuPos[i * 3 + 1] - center[1],
        this.cpuPos[i * 3 + 2] - center[2]
      );
      vec3.transformQuat(relative, relative, rotation);
      this.cpuPos[i * 3] = center[0] + relative[0];
      this.cpuPos[i * 3 + 1] = center[1] + relative[1];
      this.cpuPos[i * 3 + 2] = center[2] + relative[2];
    }
    this.simStateDirty = true;
    this.syncRenderFromCpu();
  }

  translateBy(delta: vec3, pieceId?: string): void {
    for (let i = 0; i < this.nParticles; i++) {
      if (pieceId && this.vertexPieceIds[i] !== pieceId) continue;
      this.cpuPos[i * 3] += delta[0];
      this.cpuPos[i * 3 + 1] += delta[1];
      this.cpuPos[i * 3 + 2] += delta[2];
      this.cpuVel[i * 3] = 0;
      this.cpuVel[i * 3 + 1] = 0;
      this.cpuVel[i * 3 + 2] = 0;
    }
    this.syncRenderFromCpu();
  }

  rotateBy(axis: vec3, radians: number, pieceId: string): void {
    if (!Number.isFinite(radians) || Math.abs(radians) < 1e-8) return;
    const normalizedAxis = vec3.clone(axis);
    if (vec3.squaredLength(normalizedAxis) < 1e-8) return;
    vec3.normalize(normalizedAxis, normalizedAxis);
    const rotation = quat.create();
    quat.setAxisAngle(rotation, normalizedAxis, radians);
    const center = this.getCentroid(pieceId);
    const relative = vec3.create();
    for (let i = 0; i < this.nParticles; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      vec3.set(
        relative,
        this.cpuPos[i * 3] - center[0],
        this.cpuPos[i * 3 + 1] - center[1],
        this.cpuPos[i * 3 + 2] - center[2]
      );
      vec3.transformQuat(relative, relative, rotation);
      this.cpuPos[i * 3] = center[0] + relative[0];
      this.cpuPos[i * 3 + 1] = center[1] + relative[1];
      this.cpuPos[i * 3 + 2] = center[2] + relative[2];
      this.cpuVel[i * 3] = 0;
      this.cpuVel[i * 3 + 1] = 0;
      this.cpuVel[i * 3 + 2] = 0;
    }
    this.syncRenderFromCpu();
  }

  setDragging(dragging: boolean): void {
    this.dragging = dragging;
    if (dragging) {
      this.cpuVel.fill(0);
      this.writeBuf(this.invMassBuf, this.invMasses);
      this.uploadVec4(this.velocitiesBuf, this.cpuVel);
    }
    // Resume simulate from the CPU pose (zeros velocity after a drag).
    this.simStateDirty = true;
  }

  getModelMatrix(): mat4 {
    return identity();
  }

  getPositionBuffer(): GPUBuffer {
    return this.renderPosBuf;
  }

  getNormalBuffer(): GPUBuffer {
    return this.renderNrmBuf;
  }

  getIndexBuffer(): GPUBuffer {
    return this.indexBuffer;
  }

  getIndexFormat(): GPUIndexFormat {
    return 'uint32';
  }

  getIndexCount(): number {
    return this.indices.length;
  }

  getWireframeBuffers(): null {
    return null;
  }

  destroy(): void {
    const bufs: Array<GPUBuffer | null | undefined> = [
      this.positionsBuf,
      this.velocitiesBuf,
      this.predictedBuf,
      this.invMassBuf,
      this.radiiBuf,
      this.initialBuf,
      this.deltaXYZBuf,
      this.deltaCountsBuf,
      this.stretchIdxBuf,
      this.stretchRestBuf,
      this.seamIdxBuf,
      this.seamRestBuf,
      this.seamInitialBuf,
      this.indicesBuf,
      this.normalsAccumBuf,
      this.oneRingOffBuf,
      this.oneRingNbrBuf,
      this.obstaclesBuf,
      this.renderPosBuf,
      this.renderNrmBuf,
      this.colorBuffer,
      this.indexBuffer,
      this.stagingBuf,
      this.stagingBufB,
      this.stagingVelBuf,
      this.stagingVelBufB,
      this.seamLinePosBuf,
      this.seamLineNrmBuf,
      this.cellStartBuf,
      this.cellCountBuf,
      this.particleIdsBuf,
      this.particleHashBuf,
    ];
    for (const b of bufs) b?.destroy();
    this.flushTransientUniforms();
    if (this.sdfTexture !== this.dummySdf.texture) this.sdfTexture.destroy();
    this.dummySdf.texture.destroy();
    this.floor.destroy?.();
  }
}
