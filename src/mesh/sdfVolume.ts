import { vec3 } from 'gl-matrix';
import type { Particle } from '../physics/Particle';

const BASE_COLLISION_MARGIN = 0.05;
export const SDF_MAGIC = 0x44494350; // 'PCSD' little-endian

export type SdfVolumeData = {
  origin: [number, number, number];
  voxelSize: number;
  dim: [number, number, number];
  distances: Float32Array;
};

/** Signed distance field for fast O(1) collision queries (positive = outside). */
export class SdfVolume {
  readonly origin: vec3;
  readonly voxelSize: number;
  readonly dim: [number, number, number];
  readonly distances: Float32Array;

  constructor(data: SdfVolumeData) {
    this.origin = vec3.fromValues(data.origin[0], data.origin[1], data.origin[2]);
    this.voxelSize = data.voxelSize;
    this.dim = data.dim;
    this.distances = data.distances;
  }

  static encode(data: SdfVolumeData): ArrayBuffer {
    const [nx, ny, nz] = data.dim;
    const headerBytes = 4 + 4 + 12 + 4 + 12;
    const buf = new ArrayBuffer(headerBytes + data.distances.byteLength);
    const view = new DataView(buf);
    view.setUint32(0, SDF_MAGIC, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, nx, true);
    view.setUint32(12, ny, true);
    view.setUint32(16, nz, true);
    view.setFloat32(20, data.origin[0], true);
    view.setFloat32(24, data.origin[1], true);
    view.setFloat32(28, data.origin[2], true);
    view.setFloat32(32, data.voxelSize, true);
    new Float32Array(buf, headerBytes).set(data.distances);
    return buf;
  }

  static decode(buffer: ArrayBuffer): SdfVolume {
    const view = new DataView(buffer);
    if (view.byteLength < 36) throw new Error('SDF file too small');
    if (view.getUint32(0, true) !== SDF_MAGIC) throw new Error('Invalid SDF magic');
    const version = view.getUint32(4, true);
    if (version !== 1) throw new Error(`Unsupported SDF version ${version}`);
    const nx = view.getUint32(8, true);
    const ny = view.getUint32(12, true);
    const nz = view.getUint32(16, true);
    const origin: [number, number, number] = [
      view.getFloat32(20, true),
      view.getFloat32(24, true),
      view.getFloat32(28, true),
    ];
    const voxelSize = view.getFloat32(32, true);
    const count = nx * ny * nz;
    const distances = new Float32Array(buffer, 36, count);
    if (distances.length !== count) throw new Error('SDF payload truncated');
    return new SdfVolume({ origin, voxelSize, dim: [nx, ny, nz], distances: new Float32Array(distances) });
  }

  private index(ix: number, iy: number, iz: number): number {
    const [nx, ny] = this.dim;
    return ix + iy * nx + iz * nx * ny;
  }

  private sampleRaw(ix: number, iy: number, iz: number): number {
    const [nx, ny, nz] = this.dim;
    ix = Math.max(0, Math.min(nx - 1, ix));
    iy = Math.max(0, Math.min(ny - 1, iy));
    iz = Math.max(0, Math.min(nz - 1, iz));
    return this.distances[this.index(ix, iy, iz)];
  }

  sampleAt(pos: vec3): number {
    const rel = vec3.create();
    vec3.sub(rel, pos, this.origin);
    const fx = rel[0] / this.voxelSize;
    const fy = rel[1] / this.voxelSize;
    const fz = rel[2] / this.voxelSize;
    const [nx, ny, nz] = this.dim;
    if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) {
      const cx = Math.max(0, Math.min(nx - 1, fx));
      const cy = Math.max(0, Math.min(ny - 1, fy));
      const cz = Math.max(0, Math.min(nz - 1, fz));
      return this.sampleRaw(Math.floor(cx), Math.floor(cy), Math.floor(cz));
    }
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const ty = fy - y0;
    const tz = fz - z0;
    const c000 = this.sampleRaw(x0, y0, z0);
    const c100 = this.sampleRaw(x0 + 1, y0, z0);
    const c010 = this.sampleRaw(x0, y0 + 1, z0);
    const c110 = this.sampleRaw(x0 + 1, y0 + 1, z0);
    const c001 = this.sampleRaw(x0, y0, z0 + 1);
    const c101 = this.sampleRaw(x0 + 1, y0, z0 + 1);
    const c011 = this.sampleRaw(x0, y0 + 1, z0 + 1);
    const c111 = this.sampleRaw(x0 + 1, y0 + 1, z0 + 1);
    const c00 = c000 * (1 - tx) + c100 * tx;
    const c01 = c001 * (1 - tx) + c101 * tx;
    const c10 = c010 * (1 - tx) + c110 * tx;
    const c11 = c011 * (1 - tx) + c111 * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    return c0 * (1 - tz) + c1 * tz;
  }

  gradientAt(pos: vec3, out: vec3): vec3 {
    const eps = this.voxelSize * 0.5;
    const gx = (this.sampleAt(vec3.fromValues(pos[0] + eps, pos[1], pos[2])) -
      this.sampleAt(vec3.fromValues(pos[0] - eps, pos[1], pos[2]))) /
      (2 * eps);
    const gy = (this.sampleAt(vec3.fromValues(pos[0], pos[1] + eps, pos[2])) -
      this.sampleAt(vec3.fromValues(pos[0], pos[1] - eps, pos[2]))) /
      (2 * eps);
    const gz = (this.sampleAt(vec3.fromValues(pos[0], pos[1], pos[2] + eps)) -
      this.sampleAt(vec3.fromValues(pos[0], pos[1], pos[2] - eps))) /
      (2 * eps);
    vec3.set(out, gx, gy, gz);
    if (vec3.squaredLength(out) < 1e-12) vec3.set(out, 0, 1, 0);
    else vec3.normalize(out, out);
    return out;
  }

  resolveParticle(p: Particle, edgeLength: number): boolean {
    const margin =
      edgeLength <= 0 ? BASE_COLLISION_MARGIN : Math.max(BASE_COLLISION_MARGIN, edgeLength * 0.35);
    const pos = p.getPosition();
    const dist = this.sampleAt(pos);
    if (dist >= margin) return false;

    const normal = this.gradientAt(pos, vec3.create());
    // Cap correction — deep/wrong SDF samples (common after loading a volume for GPU)
    // were slamming every particle onto the isosurface each substep: shrink, jitter,
    // and apparent loss of gravity.
    const maxPush = Math.max(margin * 2, edgeLength > 0 ? edgeLength * 1.5 : margin * 2);
    const push = Math.min(margin - dist, maxPush);
    vec3.scaleAndAdd(pos, pos, normal, push);

    const vel = p.getVelocity();
    const velDotNormal = vec3.dot(vel, normal);
    if (velDotNormal < 0) {
      const correction = vec3.create();
      vec3.scale(correction, normal, velDotNormal);
      vec3.sub(vel, vel, correction);
    }

    const vDotN = vec3.dot(vel, normal);
    const normalVel = vec3.create();
    vec3.scale(normalVel, normal, vDotN);
    const tangentVel = vec3.create();
    vec3.sub(tangentVel, vel, normalVel);
    vec3.scale(tangentVel, tangentVel, p.getContactFrictionRetain());
    vec3.add(vel, normalVel, tangentVel);
    return true;
  }
}

export function sdfCacheFileName(baseName: string, unitToWorld: number, resolution: number): string {
  const stem = baseName.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
  const scaleKey = unitToWorld.toFixed(4).replace('.', 'p');
  return `${stem}_u${scaleKey}_r${resolution}.sdf`;
}
