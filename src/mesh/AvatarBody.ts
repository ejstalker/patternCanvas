import { vec3, mat4 } from 'gl-matrix';
import { identity } from '../utils/math';
import { closestPointOnTriangle, triangleNormal } from './triangleCollision';
import type { ObjMesh } from './loadObj';
import type { Particle } from '../physics/Particle';
import type { SdfVolume } from './sdfVolume';

const BASE_COLLISION_MARGIN = 0.05;

type CollisionTri = {
  a: vec3;
  b: vec3;
  c: vec3;
  normal: vec3;
};

/** Renderable avatar mesh used as the drape collider. */
export class AvatarBody {
  private model: mat4 = identity();
  private positionBuffer: GPUBuffer | null = null;
  private normalBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private indexCount = 0;
  private boundsMin: vec3 = vec3.create();
  private boundsMax: vec3 = vec3.create();

  private collisionTris: CollisionTri[] = [];
  private grid = new Map<number, number[]>();
  private cellSize = 1.0;
  /**
   * Scratch for `queryCandidates`.
   *
   * Collision is resolved per particle per substep — tens of thousands of times
   * a frame — so the query runs on reused buffers: a stamp per triangle instead
   * of a `Set` of indices, and one shared output array instead of two fresh
   * allocations per call. It also means the result is only valid until the next
   * query, which is how the only caller uses it.
   */
  private triStamp = new Int32Array(0);
  private triStampGeneration = 0;
  private candidateScratch: number[] = [];
  private readonly closestScratch = vec3.create();
  private readonly toParticleScratch = vec3.create();
  private readonly normalVelScratch = vec3.create();
  private readonly bestPointScratch = vec3.create();
  private readonly bestNormalScratch = vec3.create();
  private sdfVolume: SdfVolume | null = null;

  private constructor() {}

  setSdfVolume(volume: SdfVolume | null): void {
    this.sdfVolume = volume;
  }

  usesSdfCollision(): boolean {
    return this.sdfVolume !== null;
  }

  getSdfVolume(): SdfVolume | null {
    return this.sdfVolume;
  }

  /** World-space triangle soup for SDF baking. */
  getCollisionBakeData(): {
    positions: Float32Array;
    indices: Uint32Array;
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
  } {
    const triCount = this.collisionTris.length;
    const positions = new Float32Array(triCount * 9);
    const indices = new Uint32Array(triCount * 3);
    for (let i = 0; i < triCount; i++) {
      const tri = this.collisionTris[i];
      const base = i * 9;
      positions[base] = tri.a[0];
      positions[base + 1] = tri.a[1];
      positions[base + 2] = tri.a[2];
      positions[base + 3] = tri.b[0];
      positions[base + 4] = tri.b[1];
      positions[base + 5] = tri.b[2];
      positions[base + 6] = tri.c[0];
      positions[base + 7] = tri.c[1];
      positions[base + 8] = tri.c[2];
      indices[i * 3] = i * 3;
      indices[i * 3 + 1] = i * 3 + 1;
      indices[i * 3 + 2] = i * 3 + 2;
    }
    return {
      positions,
      indices,
      boundsMin: [this.boundsMin[0], this.boundsMin[1], this.boundsMin[2]],
      boundsMax: [this.boundsMax[0], this.boundsMax[1], this.boundsMax[2]],
    };
  }

  static fromObjMesh(
    mesh: ObjMesh,
    cmToWorld: number,
    device: GPUDevice,
    options?: { skipSpatialGrid?: boolean }
  ): AvatarBody {
    const body = new AvatarBody();
    body.buildFromMesh(mesh, cmToWorld, options?.skipSpatialGrid ?? false);
    body.createBuffers(device);
    return body;
  }

  /** Build directly from a generated mesh (no OBJ parse). Same units as `fromObjMesh`. */
  static fromRawMesh(
    positions: Float32Array,
    indices: Uint32Array,
    unitToWorld: number,
    device: GPUDevice,
    options?: { skipSpatialGrid?: boolean }
  ): AvatarBody {
    const body = new AvatarBody();
    body.buildFromMesh({ positions, indices }, unitToWorld, options?.skipSpatialGrid ?? false);
    body.createBuffers(device);
    return body;
  }

  /** Build triangle spatial index when not using SDF collision. */
  buildCollisionGridIfNeeded(): void {
    if (this.sdfVolume || this.grid.size > 0 || this.collisionTris.length === 0) return;
    this.updateCellSizeFromBounds();
    this.buildSpatialGrid();
  }

  private buildFromMesh(mesh: ObjMesh, cmToWorld: number, skipSpatialGrid: boolean): void {
    const src = mesh.positions;
    const vertCount = src.length / 3;
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const normalAcc = new Float32Array(vertCount * 3);

    vec3.set(this.boundsMin, Infinity, Infinity, Infinity);
    vec3.set(this.boundsMax, -Infinity, -Infinity, -Infinity);

    for (let i = 0; i < vertCount; i++) {
      const x = src[i * 3] * cmToWorld;
      const y = src[i * 3 + 1] * cmToWorld;
      const z = src[i * 3 + 2] * cmToWorld;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      this.boundsMin[0] = Math.min(this.boundsMin[0], x);
      this.boundsMin[1] = Math.min(this.boundsMin[1], y);
      this.boundsMin[2] = Math.min(this.boundsMin[2], z);
      this.boundsMax[0] = Math.max(this.boundsMax[0], x);
      this.boundsMax[1] = Math.max(this.boundsMax[1], y);
      this.boundsMax[2] = Math.max(this.boundsMax[2], z);
    }

    // Rest the mesh on world y=0 (OBJ feet are usually near but not exactly at zero).
    const floorLift = -this.boundsMin[1];
    if (Math.abs(floorLift) > 1e-6) {
      for (let i = 0; i < vertCount; i++) {
        positions[i * 3 + 1] += floorLift;
      }
      this.boundsMax[1] += floorLift;
      this.boundsMin[1] = 0;
    }

    const getVert = (idx: number, out: vec3): vec3 =>
      vec3.set(out, positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);

    const va = vec3.create();
    const vb = vec3.create();
    const vc = vec3.create();
    const fn = vec3.create();

    for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
      const i0 = mesh.indices[i];
      const i1 = mesh.indices[i + 1];
      const i2 = mesh.indices[i + 2];
      getVert(i0, va);
      getVert(i1, vb);
      getVert(i2, vc);
      triangleNormal(va, vb, vc, fn);

      for (const vi of [i0, i1, i2]) {
        normalAcc[vi * 3] += fn[0];
        normalAcc[vi * 3 + 1] += fn[1];
        normalAcc[vi * 3 + 2] += fn[2];
      }

      this.collisionTris.push({
        a: vec3.clone(va),
        b: vec3.clone(vb),
        c: vec3.clone(vc),
        normal: vec3.clone(fn),
      });
    }

    for (let i = 0; i < vertCount; i++) {
      const nx = normalAcc[i * 3];
      const ny = normalAcc[i * 3 + 1];
      const nz = normalAcc[i * 3 + 2];
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-8) {
        normals[i * 3] = nx / len;
        normals[i * 3 + 1] = ny / len;
        normals[i * 3 + 2] = nz / len;
      } else {
        normals[i * 3 + 1] = 1;
      }
    }

    this.indexCount = mesh.indices.length;
    if (!skipSpatialGrid) {
      this.updateCellSizeFromBounds();
      this.buildSpatialGrid();
    }
    this._uploadMesh = { positions, normals, indices: mesh.indices };
  }

  /** Size grid cells from mesh bounds (~48 cells on the longest axis). */
  private updateCellSizeFromBounds(): void {
    const ex = this.boundsMax[0] - this.boundsMin[0];
    const ey = this.boundsMax[1] - this.boundsMin[1];
    const ez = this.boundsMax[2] - this.boundsMin[2];
    const maxExtent = Math.max(ex, ey, ez, 1e-3);
    this.cellSize = Math.max(0.15, maxExtent / 48);
  }

  private _uploadMesh: {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
  } | null = null;

  private createBuffers(device: GPUDevice): void {
    const mesh = this._uploadMesh!;
    this._uploadMesh = null;

    this.positionBuffer = device.createBuffer({
      size: mesh.positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.positionBuffer.getMappedRange()).set(mesh.positions);
    this.positionBuffer.unmap();

    this.normalBuffer = device.createBuffer({
      size: mesh.normals.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this.normalBuffer.getMappedRange()).set(mesh.normals);
    this.normalBuffer.unmap();

    this.indexBuffer = device.createBuffer({
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(this.indexBuffer.getMappedRange()).set(mesh.indices);
    this.indexBuffer.unmap();
  }

  /**
   * Exact integer key for a cell.
   *
   * Three 17-bit fields, so any cell index a body can produce (±65k) packs into
   * one number that fits a double exactly. A `Map` keyed by a number avoids the
   * template string this used to build — one per cell visited, and the query
   * visits up to `(2r+1)³` of them for every particle every substep.
   */
  private cellKey(ix: number, iy: number, iz: number): number {
    const BIAS = 1 << 16;
    const SPAN = 1 << 17;
    return ((ix + BIAS) * SPAN + (iy + BIAS)) * SPAN + (iz + BIAS);
  }

  private cellIndex(p: vec3): [number, number, number] {
    return [
      Math.floor(p[0] / this.cellSize),
      Math.floor(p[1] / this.cellSize),
      Math.floor(p[2] / this.cellSize),
    ];
  }

  private buildSpatialGrid(): void {
    this.grid.clear();
    const pad = 1;
    const maxSpan = 48;

    for (let ti = 0; ti < this.collisionTris.length; ti++) {
      const tri = this.collisionTris[ti];
      const tMin = vec3.create();
      const tMax = vec3.create();
      vec3.copy(tMin, tri.a);
      vec3.copy(tMax, tri.a);
      for (const p of [tri.b, tri.c]) {
        tMin[0] = Math.min(tMin[0], p[0]);
        tMin[1] = Math.min(tMin[1], p[1]);
        tMin[2] = Math.min(tMin[2], p[2]);
        tMax[0] = Math.max(tMax[0], p[0]);
        tMax[1] = Math.max(tMax[1], p[1]);
        tMax[2] = Math.max(tMax[2], p[2]);
      }

      const c0 = this.cellIndex(tMin);
      const c1 = this.cellIndex(tMax);
      let ix0 = c0[0] - pad;
      let iy0 = c0[1] - pad;
      let iz0 = c0[2] - pad;
      let ix1 = c1[0] + pad;
      let iy1 = c1[1] + pad;
      let iz1 = c1[2] + pad;

      if (ix1 - ix0 > maxSpan) {
        const mid = (ix0 + ix1) >> 1;
        ix0 = mid - (maxSpan >> 1);
        ix1 = ix0 + maxSpan;
      }
      if (iy1 - iy0 > maxSpan) {
        const mid = (iy0 + iy1) >> 1;
        iy0 = mid - (maxSpan >> 1);
        iy1 = iy0 + maxSpan;
      }
      if (iz1 - iz0 > maxSpan) {
        const mid = (iz0 + iz1) >> 1;
        iz0 = mid - (maxSpan >> 1);
        iz1 = iz0 + maxSpan;
      }

      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          for (let iz = iz0; iz <= iz1; iz++) {
            const key = this.cellKey(ix, iy, iz);
            let bucket = this.grid.get(key);
            if (!bucket) {
              bucket = [];
              this.grid.set(key, bucket);
            }
            bucket.push(ti);
          }
        }
      }
    }
  }

  private queryCandidates(p: vec3, radius: number): readonly number[] {
    const r = Math.ceil(radius / this.cellSize) + 1;
    const cx = Math.floor(p[0] / this.cellSize);
    const cy = Math.floor(p[1] / this.cellSize);
    const cz = Math.floor(p[2] / this.cellSize);
    const out = this.candidateScratch;
    out.length = 0;
    if (this.triStamp.length !== this.collisionTris.length) {
      this.triStamp = new Int32Array(this.collisionTris.length);
      this.triStampGeneration = 0;
    }
    const stamp = ++this.triStampGeneration;
    const stamps = this.triStamp;
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iy = cy - r; iy <= cy + r; iy++) {
        for (let iz = cz - r; iz <= cz + r; iz++) {
          const bucket = this.grid.get(this.cellKey(ix, iy, iz));
          if (!bucket) continue;
          for (const ti of bucket) {
            if (stamps[ti] === stamp) continue;
            stamps[ti] = stamp;
            out.push(ti);
          }
        }
      }
    }
    return out;
  }

  getFloorY(): number {
    return 0;
  }

  getFootprintRadius(): number {
    const hx = (this.boundsMax[0] - this.boundsMin[0]) * 0.5;
    const hz = (this.boundsMax[2] - this.boundsMin[2]) * 0.5;
    return Math.max(hx, hz, 4);
  }

  private collisionMargin(edgeLength: number): number {
    if (edgeLength <= 0) return BASE_COLLISION_MARGIN;
    return Math.max(BASE_COLLISION_MARGIN, edgeLength * 0.35);
  }

  /** Push a cloth particle to the exterior of the avatar mesh. */
  resolveParticle(p: Particle, edgeLength: number): void {
    if (this.sdfVolume) {
      this.sdfVolume.resolveParticle(p, edgeLength);
      return;
    }
    this.buildCollisionGridIfNeeded();
    const pos = p.getPosition();
    const margin = this.collisionMargin(edgeLength);
    const searchRadius = margin + 0.75;
    const candidates = this.queryCandidates(pos, searchRadius);

    // Reused, not allocated: this runs on every particle of every substep.
    const closest = this.closestScratch;
    const toParticle = this.toParticleScratch;
    const bestPoint = this.bestPointScratch;
    const bestNormal = this.bestNormalScratch;
    let found = false;
    let bestDistSq = searchRadius * searchRadius;

    for (const ti of candidates) {
      const tri = this.collisionTris[ti];
      closestPointOnTriangle(pos, tri.a, tri.b, tri.c, closest);
      const dSq = vec3.squaredDistance(pos, closest);
      if (dSq >= bestDistSq) continue;
      bestDistSq = dSq;
      found = true;
      vec3.copy(bestPoint, closest);
      vec3.copy(bestNormal, tri.normal);
      vec3.sub(toParticle, pos, closest);
      if (vec3.dot(bestNormal, toParticle) < 0) vec3.negate(bestNormal, bestNormal);
    }

    if (!found || bestDistSq >= margin * margin) return;

    vec3.scaleAndAdd(pos, bestPoint, bestNormal, margin);

    const vel = p.getVelocity();
    const velDotNormal = vec3.dot(vel, bestNormal);
    if (velDotNormal < 0) {
      // Remove the closing component of the velocity; then friction on the rest.
      vec3.scaleAndAdd(vel, vel, bestNormal, -velDotNormal);
    }

    const vDotN = vec3.dot(vel, bestNormal);
    const normalVel = this.normalVelScratch;
    vec3.scale(normalVel, bestNormal, vDotN);
    vec3.sub(vel, vel, normalVel);
    vec3.scale(vel, vel, p.getContactFrictionRetain());
    vec3.add(vel, vel, normalVel);
  }

  getModelMatrix(): mat4 {
    return this.model;
  }

  getPositionBuffer(): GPUBuffer {
    return this.positionBuffer!;
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

  destroy(): void {
    this.positionBuffer?.destroy();
    this.normalBuffer?.destroy();
    this.indexBuffer?.destroy();
  }
}
