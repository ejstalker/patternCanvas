import { vec3, quat, mat4 } from 'gl-matrix';
import { Particle } from '../physics/Particle';
import { SpringDamper } from '../physics/SpringDamper';
import { Triangle } from '../physics/Triangle';
import { Ground } from '../Ground';
import type { AvatarBody } from '../mesh/AvatarBody';
import { identity } from '../utils/math';
import type { MeshGeometry, PatternDocument, SimParams, SimPose } from '../project/types';
import { CM_TO_WORLD } from './units';
import { buildClothTopology, FALLBACK_PIECE_ID } from './meshTopology';
import { buildWireframeEdgeIndices } from './wireframeEdges';
import { fillStrainColors, type StrainEdge } from './strainMap';

/** @deprecated Import from `./units` instead. */
export { CM_TO_WORLD };

/** Seam spring stiffness as a fraction of cloth stretch k (keep below fabric). */
const SEAM_SPRING_MULT = 0.28;
/** Seconds over which seam rest lengths shrink to their final gap. */
const SEAM_RAMP_SECONDS = 3.5;

/** Möller–Trumbore; returns t or null. */
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
  const v = vec3.dot(dir, qvec) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = vec3.dot(edge2, qvec) * invDet;
  return t >= 0 ? t : null;
}

/**
 * Cloth particle system built from a 2D MeshGeometry (pattern cm → world).
 */
export class PatternCloth {
  private positions: vec3[] = [];
  private normals: vec3[] = [];
  private indices: number[] = [];
  private particles: Particle[] = [];
  /** Parallel to particles; supports selecting and transforming one mesh island. */
  private vertexPieceIds: string[] = [];
  /** Pieces pinned at their captured pose; their particles never integrate. */
  private frozenPieceIds = new Set<string>();
  private connections: SpringDamper[] = [];
  private bendSprings: SpringDamper[] = [];
  private seamSprings: SpringDamper[] = [];
  private seamRestLengths: Array<{ initial: number; target: number }> = [];
  /** Particle index pairs for seam visualization (a,b,a,b,...). */
  private seamPairIndices: Array<[number, number]> = [];
  private seamRampElapsed = 0;
  private seamSpringTarget = 0;
  private triangles: Triangle[] = [];

  private springConst: number;
  private dampingConst: number;
  private gravityAcce: number;
  private fluidDensity: number;
  private c_d: number;
  private windVelocity: vec3;
  private particleMass: number;
  /** Integration substeps per frame (Macklin small-steps). */
  private numOfOversamples = 24;
  /** Provot strain-limit iterations per substep. */
  private strainLimitIters = 6;
  /** Max edge length / rest (≤1 disables). */
  private maxStretch = 1.12;
  /** Bend spring k = springConst × scale (0 = off). */
  private bendSpringScale = 0.2;
  /** Per-substep velocity retain (slightly below 1 kills ringing). */
  private velocityDamping = 0.998;
  private maxSpeed = 30;
  private contactFriction = 0.45;

  private avatar: AvatarBody;
  /** Flat floor under the avatar so fabric can land if it slides off. */
  private floor: Ground;
  private floorY: number;
  private avgEdgeLength = 0.4;
  /** Per-particle mean incident edge length (world units) for collision margin. */
  private edgeLengths: Float32Array = new Float32Array(0);
  private initialPositions: vec3[] = [];
  private dragging = false;
  private prevT = 0;
  private fps = 0;
  private fpsCount = 0;
  private interval = 0;

  private positionBuffer: GPUBuffer | null = null;
  private normalBuffer: GPUBuffer | null = null;
  private colorBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private wireframeEdgeBuffer: GPUBuffer | null = null;
  private wireframeEdgeCount = 0;
  /** Flat (xyz interleaved) copy of the latest particle positions for CPU overlays. */
  private flatPositions = new Float32Array(0);
  private seamLinePositionBuffer: GPUBuffer | null = null;
  private seamLineNormalBuffer: GPUBuffer | null = null;
  private seamLineVertexCount = 0;
  private indexCount = 0;
  private indexFormat: GPUIndexFormat = 'uint32';
  private device: GPUDevice;
  private pattern: PatternDocument | undefined;
  /** Stretch edges for strain map (particle i,j + rest). */
  private stretchEdges: StrainEdge[] = [];
  private strainMapEnabled = false;
  private strainColorData: Float32Array | null = null;

  constructor(
    mesh: MeshGeometry,
    params: SimParams,
    device: GPUDevice,
    avatar: AvatarBody,
    pattern?: PatternDocument
  ) {
    this.device = device;
    this.pattern = pattern;
    this.springConst = params.springConst;
    this.dampingConst = params.dampingConst;
    this.gravityAcce = params.gravity;
    this.fluidDensity = params.fluidDensity;
    this.c_d = params.dragCoeff;
    this.windVelocity = vec3.fromValues(params.wind[0], params.wind[1], params.wind[2]);
    this.avatar = avatar;
    this.floorY = 0;
    const floorSize = Math.max(16, avatar.getFootprintRadius() * 2.5) * 3;
    this.floor = new Ground(
      [-floorSize * 0.5, 0, -floorSize * 0.5],
      floorSize,
      device,
      { radialGradient: true }
    );
    this.particleMass = 1;
    this.seamSpringTarget = params.springConst * SEAM_SPRING_MULT;
    this.numOfOversamples = Math.max(1, Math.round(params.substeps ?? 24));
    this.strainLimitIters = Math.max(0, Math.round(params.constraintIterations ?? 6));
    this.maxStretch = params.maxStretch ?? 1.12;
    this.bendSpringScale = params.bendSpringScale ?? 0.2;
    this.velocityDamping = params.velocityDamping ?? 0.998;
    this.maxSpeed = params.maxSpeed ?? 30;
    this.contactFriction = params.contactFriction ?? 0.45;

    this.buildFromMesh(mesh, params.mass);
    this.createBuffers();
    this.prevT = 0;
  }

  setAvatar(avatar: AvatarBody): void {
    this.avatar = avatar;
  }

  private buildFromMesh(mesh: MeshGeometry, mass: number): void {
    const topo = buildClothTopology(mesh, mass, this.pattern, { layoutY: 4.0 });
    this.vertexPieceIds = [...topo.vertexPieceIds];
    this.avgEdgeLength = topo.avgEdgeLength;
    this.edgeLengths = new Float32Array(topo.edgeLengths);
    this.particleMass = topo.particleMass;
    const up = vec3.fromValues(0, 1, 0);

    for (let i = 0; i < topo.numParticles; i++) {
      const pos = vec3.fromValues(
        topo.positions[i * 3],
        topo.positions[i * 3 + 1],
        topo.positions[i * 3 + 2]
      );
      const p = new Particle(pos, vec3.clone(up), this.particleMass, this.gravityAcce, this.floorY);
      p.setEdgeLength(topo.edgeLengths[i] ?? this.avgEdgeLength);
      p.setFixed(false);
      this.particles.push(p);
      this.positions.push(vec3.clone(pos));
      this.initialPositions.push(vec3.clone(pos));
      this.normals.push(vec3.clone(up));
    }

    this.stretchEdges = topo.stretch.map((s) => ({ i: s.i, j: s.j, rest: s.rest }));
    for (const s of topo.stretch) {
      this.connections.push(
        new SpringDamper(
          this.particles[s.i],
          this.particles[s.j],
          this.springConst,
          this.dampingConst,
          s.rest
        )
      );
    }

    // Bend: springs across opposite verts of shared edges (cheap dihedral proxy).
    this.bendSprings = [];
    const bendK = this.springConst * Math.max(0, this.bendSpringScale);
    for (const b of topo.bend) {
      const rest = vec3.distance(this.particles[b.i0].position, this.particles[b.i3].position);
      if (rest < 1e-6) continue;
      this.bendSprings.push(
        new SpringDamper(
          this.particles[b.i0],
          this.particles[b.i3],
          bendK,
          this.dampingConst * 0.5,
          rest
        )
      );
    }

    for (const p of this.particles) {
      p.setContactFriction(this.contactFriction);
    }

    this.seamPairIndices = [];
    this.seamSprings = [];
    this.seamRestLengths = [];
    this.seamRampElapsed = 0;
    for (const sc of topo.seamConstraints) {
      const a = sc.i;
      const b = sc.j;
      this.seamSprings.push(
        new SpringDamper(
          this.particles[a],
          this.particles[b],
          this.seamSpringTarget * 0.35,
          this.dampingConst * 1.5,
          sc.initialDist
        )
      );
      this.seamRestLengths.push({ initial: sc.initialDist, target: sc.rest });
      this.seamPairIndices.push([a, b]);
    }

    this.indices = Array.from(topo.indices);
    this.indexCount = this.indices.length;
    for (let i = 0; i + 2 < this.indices.length; i += 3) {
      const i0 = this.indices[i];
      const i1 = this.indices[i + 1];
      const i2 = this.indices[i + 2];
      this.triangles.push(
        new Triangle(
          this.particles[i0],
          this.particles[i1],
          this.particles[i2],
          this.fluidDensity,
          this.c_d,
          this.windVelocity
        )
      );
    }
  }

  private createBuffers(): void {
    const posData = new Float32Array(this.positions.length * 3);
    const nrmData = new Float32Array(this.normals.length * 3);
    for (let i = 0; i < this.positions.length; i++) {
      posData[i * 3] = this.positions[i][0];
      posData[i * 3 + 1] = this.positions[i][1];
      posData[i * 3 + 2] = this.positions[i][2];
      nrmData[i * 3] = this.normals[i][0];
      nrmData[i * 3 + 1] = this.normals[i][1];
      nrmData[i * 3 + 2] = this.normals[i][2];
    }
    // Available immediately after construction (before the first `update()`).
    this.flatPositions = posData;
    this.positionBuffer = this.device.createBuffer({
      size: posData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.positionBuffer.getMappedRange()).set(posData);
    this.positionBuffer.unmap();

    this.normalBuffer = this.device.createBuffer({
      size: nrmData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.normalBuffer.getMappedRange()).set(nrmData);
    this.normalBuffer.unmap();

    this.strainColorData = new Float32Array(this.positions.length * 3);
    this.colorBuffer = this.device.createBuffer({
      size: this.strainColorData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.syncStrainColors(true);

    const idx = new Uint32Array(this.indices);
    this.indexBuffer = this.device.createBuffer({
      size: Math.max(idx.byteLength, 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.indexBuffer.getMappedRange()).set(idx);
    this.indexBuffer.unmap();

    const edgeIndices = buildWireframeEdgeIndices(this.indices);
    this.wireframeEdgeCount = edgeIndices.length;
    if (this.wireframeEdgeCount > 0) {
      this.wireframeEdgeBuffer = this.device.createBuffer({
        size: edgeIndices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
        label: 'cloth-wireframe-edges',
      });
      new Uint32Array(this.wireframeEdgeBuffer.getMappedRange()).set(edgeIndices);
      this.wireframeEdgeBuffer.unmap();
    }

    this.createSeamLineBuffers();
  }

  private createSeamLineBuffers(): void {
    this.seamLinePositionBuffer?.destroy();
    this.seamLineNormalBuffer?.destroy();
    this.seamLinePositionBuffer = null;
    this.seamLineNormalBuffer = null;
    this.seamLineVertexCount = this.seamPairIndices.length * 2;
    if (this.seamLineVertexCount === 0) return;

    const posData = new Float32Array(this.seamLineVertexCount * 3);
    const nrmData = new Float32Array(this.seamLineVertexCount * 3);
    // Up normals so the unlit overlay lighting path still works
    for (let i = 0; i < this.seamLineVertexCount; i++) {
      nrmData[i * 3 + 1] = 1;
    }
    this.fillSeamLinePositions(posData);

    this.seamLinePositionBuffer = this.device.createBuffer({
      size: posData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.seamLinePositionBuffer.getMappedRange()).set(posData);
    this.seamLinePositionBuffer.unmap();

    this.seamLineNormalBuffer = this.device.createBuffer({
      size: nrmData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.seamLineNormalBuffer.getMappedRange()).set(nrmData);
    this.seamLineNormalBuffer.unmap();
  }

  private fillSeamLinePositions(out: Float32Array): void {
    let o = 0;
    for (const [ia, ib] of this.seamPairIndices) {
      const pa = this.particles[ia].position;
      const pb = this.particles[ib].position;
      out[o++] = pa[0];
      out[o++] = pa[1];
      out[o++] = pa[2];
      out[o++] = pb[0];
      out[o++] = pb[1];
      out[o++] = pb[2];
    }
  }

  private syncBuffers(): void {
    for (let i = 0; i < this.particles.length; i++) {
      vec3.copy(this.positions[i], this.particles[i].position);
      vec3.copy(this.normals[i], this.particles[i].normal);
      const len = vec3.length(this.normals[i]);
      if (len > 1e-6) vec3.scale(this.normals[i], this.normals[i], 1 / len);
    }
    const posData = new Float32Array(this.positions.length * 3);
    const nrmData = new Float32Array(this.normals.length * 3);
    for (let i = 0; i < this.positions.length; i++) {
      posData.set(this.positions[i], i * 3);
      nrmData.set(this.normals[i], i * 3);
    }
    this.flatPositions = posData;
    this.device.queue.writeBuffer(this.positionBuffer!, 0, posData);
    this.device.queue.writeBuffer(this.normalBuffer!, 0, nrmData);
    this.syncStrainColors(false, posData);

    if (this.seamLinePositionBuffer && this.seamLineVertexCount > 0) {
      const seamPos = new Float32Array(this.seamLineVertexCount * 3);
      this.fillSeamLinePositions(seamPos);
      this.device.queue.writeBuffer(this.seamLinePositionBuffer, 0, seamPos);
    }
  }

  private syncStrainColors(force = false, positions?: Float32Array): void {
    if (!this.colorBuffer || !this.strainColorData) return;
    if (!this.strainMapEnabled && !force) return;
    if (!this.strainMapEnabled) {
      this.strainColorData.fill(0);
    } else {
      let posData = positions;
      if (!posData) {
        posData = new Float32Array(this.particles.length * 3);
        for (let i = 0; i < this.particles.length; i++) {
          const p = this.particles[i].position;
          posData[i * 3] = p[0];
          posData[i * 3 + 1] = p[1];
          posData[i * 3 + 2] = p[2];
        }
      }
      fillStrainColors(posData, this.stretchEdges, this.strainColorData);
    }
    // Fresh view so writeBuffer accepts ArrayBuffer (not SharedArrayBuffer typing).
    const upload = new Float32Array(this.strainColorData.length);
    upload.set(this.strainColorData);
    this.device.queue.writeBuffer(this.colorBuffer, 0, upload);
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

  setDragging(dragging: boolean): void {
    this.dragging = dragging;
    if (dragging) this.zeroVelocities();
  }

  isDragging(): boolean {
    return this.dragging;
  }

  getVertexPieceIds(): readonly string[] {
    return this.vertexPieceIds;
  }

  getCentroid(pieceId?: string): vec3 {
    const c = vec3.create();
    let count = 0;
    for (let i = 0; i < this.particles.length; i++) {
      if (pieceId && this.vertexPieceIds[i] !== pieceId) continue;
      vec3.add(c, c, this.particles[i].position);
      count++;
    }
    if (count > 0) vec3.scale(c, c, 1 / count);
    return c;
  }

  /**
   * Ray–triangle intersection against the cloth mesh.
   * Returns closest hit distance along the ray, or null.
   */
  raycast(origin: vec3, dir: vec3): { t: number; point: vec3; pieceId: string } | null {
    let bestT = Infinity;
    let best: vec3 | null = null;
    let bestPieceId = FALLBACK_PIECE_ID;
    const eps = 1e-6;
    for (let i = 0; i + 2 < this.indices.length; i += 3) {
      const p0 = this.particles[this.indices[i]].position;
      const p1 = this.particles[this.indices[i + 1]].position;
      const p2 = this.particles[this.indices[i + 2]].position;
      const hit = rayTriangle(origin, dir, p0, p1, p2, eps);
      if (hit !== null && hit > eps && hit < bestT) {
        bestT = hit;
        bestPieceId = this.vertexPieceIds[this.indices[i]] ?? FALLBACK_PIECE_ID;
        best = vec3.create();
        vec3.scaleAndAdd(best, origin, dir, hit);
      }
    }
    return best ? { t: bestT, point: best, pieceId: bestPieceId } : null;
  }

  /** Move one pattern piece (or the whole cloth when no id is supplied). */
  translateBy(delta: vec3, pieceId?: string): void {
    for (let i = 0; i < this.particles.length; i++) {
      if (pieceId && this.vertexPieceIds[i] !== pieceId) continue;
      const p = this.particles[i];
      vec3.add(p.position, p.position, delta);
      vec3.zero(p.getVelocity());
      p.resetForce();
    }
    this.syncBuffers();
  }

  resetPieceToInitial(pieceId: string): void {
    for (let i = 0; i < this.particles.length; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      vec3.copy(this.particles[i].position, this.initialPositions[i]);
      vec3.zero(this.particles[i].getVelocity());
      this.particles[i].resetForce();
    }
    this.syncBuffers();
  }

  getPieceCentroidTuple(pieceId: string): [number, number, number] {
    const c = this.getCentroid(pieceId);
    return [c[0], c[1], c[2]];
  }

  setPieceCentroid(pieceId: string, target: [number, number, number]): void {
    const c = this.getCentroid(pieceId);
    const delta = vec3.fromValues(target[0] - c[0], target[1] - c[1], target[2] - c[2]);
    this.translateBy(delta, pieceId);
  }

  applyPieceEulerDegrees(pieceId: string, eulerDeg: [number, number, number]): void {
    this.resetPieceToInitial(pieceId);
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
    this.resetPieceToInitial(pieceId);
    const rotation = quat.fromValues(quatXyZw[0], quatXyZw[1], quatXyZw[2], quatXyZw[3]);
    if (quat.squaredLength(rotation) < 1e-12) return;
    quat.normalize(rotation, rotation);
    const center = this.getCentroid(pieceId);
    const relative = vec3.create();
    for (let i = 0; i < this.particles.length; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      const p = this.particles[i];
      vec3.sub(relative, p.position, center);
      vec3.transformQuat(relative, relative, rotation);
      vec3.add(p.position, center, relative);
      vec3.zero(p.getVelocity());
      p.resetForce();
    }
    this.syncBuffers();
  }

  /** Rotate one pattern piece around its centroid and clear transform velocity. */
  rotateBy(axis: vec3, radians: number, pieceId: string): void {
    if (!Number.isFinite(radians) || Math.abs(radians) < 1e-8) return;
    const normalizedAxis = vec3.clone(axis);
    if (vec3.squaredLength(normalizedAxis) < 1e-8) return;
    vec3.normalize(normalizedAxis, normalizedAxis);
    const rotation = quat.create();
    quat.setAxisAngle(rotation, normalizedAxis, radians);
    const center = this.getCentroid(pieceId);
    const relative = vec3.create();
    for (let i = 0; i < this.particles.length; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      const p = this.particles[i];
      vec3.sub(relative, p.position, center);
      vec3.transformQuat(relative, relative, rotation);
      vec3.add(p.position, center, relative);
      vec3.zero(p.getVelocity());
      p.resetForce();
    }
    this.syncBuffers();
  }

  /**
   * Pin every particle of a piece so it stops integrating, or release it.
   * Freezing only touches integration velocity — fabric springs and seam
   * springs still push on the other end, so sewing stays live.
   */
  setPieceFrozen(pieceId: string, frozen: boolean): void {
    if (frozen) this.frozenPieceIds.add(pieceId);
    else this.frozenPieceIds.delete(pieceId);
    this.pinPieces();
    this.syncBuffers();
  }

  isPieceFrozen(pieceId: string): boolean {
    return this.frozenPieceIds.has(pieceId);
  }

  getFrozenPieceIds(): string[] {
    return [...this.frozenPieceIds];
  }

  captureFrozenState(): Record<string, number[]> {
    const state: Record<string, number[]> = {};
    for (const pieceId of this.frozenPieceIds) {
      const positions = this.capturePiecePositions(pieceId);
      if (positions) state[pieceId] = positions;
    }
    return state;
  }

  applyFrozenState(state: Record<string, number[]> | null | undefined): void {
    this.frozenPieceIds.clear();
    if (state) {
      for (const [pieceId, positions] of Object.entries(state)) {
        let count = 0;
        for (const id of this.vertexPieceIds) if (id === pieceId) count++;
        if (count === 0) continue;
        // Only place saved positions when the topology still matches; a remesh
        // renumbers vertices, so freezing at rest is safer than a scramble.
        if (positions.length === count * 3) {
          let k = 0;
          for (let i = 0; i < this.particles.length; i++) {
            if (this.vertexPieceIds[i] !== pieceId) continue;
            vec3.set(
              this.particles[i].position,
              positions[k * 3],
              positions[k * 3 + 1],
              positions[k * 3 + 2]
            );
            k++;
          }
        }
        this.frozenPieceIds.add(pieceId);
      }
    }
    this.pinPieces();
    this.syncBuffers();
  }

  /** Flat xyz of one piece's particles, or null when the piece is not here. */
  private capturePiecePositions(pieceId: string): number[] | null {
    const out: number[] = [];
    for (let i = 0; i < this.particles.length; i++) {
      if (this.vertexPieceIds[i] !== pieceId) continue;
      const p = this.particles[i].position;
      out.push(p[0], p[1], p[2]);
    }
    return out.length ? out : null;
  }

  /** Apply the fixed flag to match `frozenPieceIds` (and shed velocity). */
  private pinPieces(): void {
    for (let i = 0; i < this.particles.length; i++) {
      const frozen = this.frozenPieceIds.has(this.vertexPieceIds[i]);
      const p = this.particles[i];
      p.setFixed(frozen);
      if (frozen) {
        vec3.zero(p.getVelocity());
        p.resetForce();
      }
    }
  }

  resetToInitialState(): void {
    this.dragging = false;
    this.seamRampElapsed = 0;
    this.frozenPieceIds.clear();
    for (let i = 0; i < this.particles.length; i++) {
      vec3.copy(this.particles[i].position, this.initialPositions[i]);
      vec3.zero(this.particles[i].getVelocity());
      this.particles[i].resetForce();
      this.particles[i].setFixed(false);
    }
    this.setSeamProgress(0);
    this.prevT = 0;
    this.syncBuffers();
  }

  private zeroVelocities(): void {
    for (const p of this.particles) {
      vec3.zero(p.getVelocity());
      p.resetForce();
    }
  }

  update(simulate = true): void {
    const now = performance.now();
    if (this.prevT === 0) {
      this.prevT = now;
      this.syncBuffers();
      return;
    }
    let dt = (now - this.prevT) / 1000;
    this.prevT = now;
    this.interval += dt;
    this.fpsCount++;
    if (this.interval >= 1) {
      this.fps = this.fpsCount;
      this.fpsCount = 0;
      this.interval = 0;
    }
    // Hold physics while the user is dragging the piece into place.
    if (!simulate || this.dragging) {
      this.syncBuffers();
      return;
    }
    dt = Math.min(dt, 0.03);
    this.seamRampElapsed += dt;
    this.setSeamProgress(this.seamRampElapsed / SEAM_RAMP_SECONDS);

    const steps = Math.max(1, this.numOfOversamples);
    const sub = dt / steps;
    const velRetain = Math.min(1, Math.max(0.9, this.velocityDamping));
    const strainOn = this.maxStretch > 1 && this.strainLimitIters > 0;
    for (let s = 0; s < steps; s++) {
      for (const p of this.particles) p.resetForce();
      for (const c of this.connections) c.computeForce();
      if (this.bendSpringScale > 0) {
        for (const c of this.bendSprings) c.computeForce();
      }
      for (const c of this.seamSprings) c.computeForce();
      for (const t of this.triangles) t.computeAerodynamicForce();
      for (const p of this.particles) p.resetNormal();
      for (const t of this.triangles) t.computeNormal();
      for (const p of this.particles) p.integrate(sub);

      // Provot on fabric edges only — never on seam springs while their rest is
      // ramping down (that became a hard zipper fighting cloth stretch).
      if (strainOn) {
        for (let iter = 0; iter < this.strainLimitIters; iter++) {
          for (const c of this.connections) c.enforceMaxStretch(this.maxStretch);
        }
      }

      for (let pi = 0; pi < this.particles.length; pi++) {
        const p = this.particles[pi];
        if (velRetain < 1) p.scaleVelocity(velRetain);
        p.clampSpeed(this.maxSpeed);
        // A frozen piece must hold its exact pose, so contact projection is
        // skipped for it rather than nudging it onto the floor or body.
        if (p.isFixedParticle()) continue;
        p.groundCollision();
        this.avatar.resolveParticle(p, this.edgeLengths[pi] ?? this.avgEdgeLength);
      }
    }
    this.syncBuffers();
  }

  exportPose(): SimPose {
    const positions: number[] = [];
    const velocities: number[] = [];
    for (const p of this.particles) {
      positions.push(p.position[0], p.position[1], p.position[2]);
      const v = p.getVelocity();
      velocities.push(v[0], v[1], v[2]);
    }
    return { positions, velocities };
  }

  applyPose(pose: SimPose): void {
    const n = this.particles.length;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      if (o + 2 >= pose.positions.length) break;
      vec3.set(
        this.particles[i].position,
        pose.positions[o],
        pose.positions[o + 1],
        pose.positions[o + 2]
      );
      if (pose.velocities && o + 2 < pose.velocities.length) {
        const v = this.particles[i].getVelocity();
        vec3.set(v, pose.velocities[o], pose.velocities[o + 1], pose.velocities[o + 2]);
      }
    }
    // Re-pin any frozen pieces so a restored pose cannot thaw them.
    this.pinPieces();
    // A persisted drape is already sewn; do not replay the closure or briefly
    // push its joined edges apart using the original panel separation.
    this.seamRampElapsed = SEAM_RAMP_SECONDS;
    this.setSeamProgress(1);
    this.syncBuffers();
  }

  applyParams(params: SimParams): void {
    this.springConst = params.springConst;
    this.dampingConst = params.dampingConst;
    this.gravityAcce = params.gravity;
    this.fluidDensity = params.fluidDensity;
    this.c_d = params.dragCoeff;
    this.seamSpringTarget = params.springConst * SEAM_SPRING_MULT;
    this.numOfOversamples = Math.max(1, Math.round(params.substeps ?? this.numOfOversamples));
    this.strainLimitIters = Math.max(0, Math.round(params.constraintIterations ?? this.strainLimitIters));
    this.maxStretch = params.maxStretch ?? this.maxStretch;
    this.bendSpringScale = params.bendSpringScale ?? this.bendSpringScale;
    this.velocityDamping = params.velocityDamping ?? this.velocityDamping;
    this.maxSpeed = params.maxSpeed ?? this.maxSpeed;
    this.contactFriction = params.contactFriction ?? this.contactFriction;
    vec3.set(this.windVelocity, params.wind[0], params.wind[1], params.wind[2]);
    if (params.mass > 0 && this.particles.length > 0) {
      this.particleMass = params.mass / this.particles.length;
      for (const p of this.particles) p.setMass(this.particleMass);
    }
    for (const c of this.connections) {
      c.setSpringConst(this.springConst);
      c.setDampingConst(this.dampingConst);
    }
    const bendK = this.springConst * Math.max(0, this.bendSpringScale);
    for (const c of this.bendSprings) {
      c.setSpringConst(bendK);
      c.setDampingConst(this.dampingConst * 0.5);
    }
    for (const c of this.seamSprings) {
      c.setDampingConst(this.dampingConst * 1.5);
    }
    this.setSeamProgress(this.seamRampElapsed / SEAM_RAMP_SECONDS);
    for (const t of this.triangles) {
      t.setWindVelocity(this.windVelocity);
      t.setFluidDensity(this.fluidDensity);
      t.setDragConst(this.c_d);
    }
    for (const p of this.particles) {
      p.setGravityAcce(this.gravityAcce);
      p.setContactFriction(this.contactFriction);
    }
  }

  private setSeamProgress(progress: number): void {
    const p = Math.max(0, Math.min(1, progress));
    // Smoothstep starts and ends with zero closure velocity.
    const eased = p * p * (3 - 2 * p);
    const stiffness = this.seamSpringTarget * (0.2 + 0.8 * eased);
    for (let i = 0; i < this.seamSprings.length; i++) {
      const spring = this.seamSprings[i];
      const rest = this.seamRestLengths[i];
      spring.setSpringConst(stiffness);
      spring.setRestLength(rest.initial + (rest.target - rest.initial) * eased);
    }
  }

  getModelMatrix(): mat4 {
    return identity();
  }

  getPositionBuffer(): GPUBuffer {
    return this.positionBuffer!;
  }

  getPositionsSnapshot(): Float32Array | null {
    return this.flatPositions.length ? this.flatPositions : null;
  }

  getNormalBuffer(): GPUBuffer {
    return this.normalBuffer!;
  }

  getIndexBuffer(): GPUBuffer {
    return this.indexBuffer!;
  }

  getIndexCount(): number {
    return this.indexCount;
  }

  getIndexFormat(): GPUIndexFormat {
    return this.indexFormat;
  }

  getWireframeBuffers(): null {
    return null;
  }

  getWireframeEdges(): { indexBuffer: GPUBuffer; indexFormat: GPUIndexFormat; indexCount: number } | null {
    if (!this.wireframeEdgeBuffer || this.wireframeEdgeCount === 0) return null;
    return {
      indexBuffer: this.wireframeEdgeBuffer,
      indexFormat: 'uint32',
      indexCount: this.wireframeEdgeCount,
    };
  }

  getFPS(): number {
    return this.fps;
  }

  getGround(): AvatarBody {
    return this.avatar;
  }

  /** Optional flat floor drawn/collided under the avatar. */
  getFloor(): Ground {
    return this.floor;
  }

  getSeamLinePositionBuffer(): GPUBuffer | null {
    return this.seamLinePositionBuffer;
  }

  getSeamLineNormalBuffer(): GPUBuffer | null {
    return this.seamLineNormalBuffer;
  }

  getSeamLineVertexCount(): number {
    return this.seamLineVertexCount;
  }

  getParticleCount(): number {
    return this.particles.length;
  }

  destroy(): void {
    this.positionBuffer?.destroy();
    this.normalBuffer?.destroy();
    this.colorBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.wireframeEdgeBuffer?.destroy();
    this.wireframeEdgeBuffer = null;
    this.wireframeEdgeCount = 0;
    this.seamLinePositionBuffer?.destroy();
    this.seamLineNormalBuffer?.destroy();
    this.floor.destroy?.();
  }
}
