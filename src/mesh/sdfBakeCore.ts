/**
 * CPU signed-distance-field baking core.
 *
 * Extracted from `sdfBake.worker.ts` so it can be unit-tested. Distances come
 * from a BVH-accelerated closest-point query; the sign comes from ray-parity
 * along a fixed direction, also BVH-accelerated.
 */

export type SdfBakeRequest = {
  positions: Float32Array;
  indices: Uint32Array;
  origin: [number, number, number];
  voxelSize: number;
  dim: [number, number, number];
};

export type BakeProgress = (value: number) => void;

const RAY_DIR: [number, number, number] = [1, 0.037, 0.017];
const LEAF_TRIANGLES = 8;

function closestPointOnTriangle(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: Float32Array
): void {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax;
    out[1] = ay;
    out[2] = az;
    return;
  }

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx;
    out[1] = by;
    out[2] = bz;
    return;
  }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + abx * v;
    out[1] = ay + aby * v;
    out[2] = az + abz * v;
    return;
  }

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx;
    out[1] = cy;
    out[2] = cz;
    return;
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + acx * w;
    out[1] = ay + acy * w;
    out[2] = az + acz * w;
    return;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const bcx = cx - bx;
    const bcy = cy - by;
    const bcz = cz - bz;
    out[0] = bx + bcx * w;
    out[1] = by + bcy * w;
    out[2] = bz + bcz * w;
    return;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}

function rayIntersectsTriangle(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number
): boolean {
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;

  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-8) return false;
  const invDet = 1 / det;

  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return false;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) return false;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t > 1e-5;
}

type Bvh = {
  mins: Float32Array;
  maxs: Float32Array;
  left: Int32Array;
  right: Int32Array;
  start: Int32Array;
  count: Int32Array;
  order: Uint32Array;
  nodeCount: number;
  maxNodes: number;
};

function buildBvh(positions: Float32Array, indices: Uint32Array): Bvh {
  const triCount = indices.length / 3;
  const order = new Uint32Array(triCount);
  const centroid = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    order[t] = t;
    const a = indices[t * 3]! * 3;
    const b = indices[t * 3 + 1]! * 3;
    const c = indices[t * 3 + 2]! * 3;
    centroid[t * 3] = (positions[a]! + positions[b]! + positions[c]!) / 3;
    centroid[t * 3 + 1] = (positions[a + 1]! + positions[b + 1]! + positions[c + 1]!) / 3;
    centroid[t * 3 + 2] = (positions[a + 2]! + positions[b + 2]! + positions[c + 2]!) / 3;
  }

  const maxNodes = Math.max(1, triCount * 2);
  const bvh: Bvh = {
    mins: new Float32Array(maxNodes * 3),
    maxs: new Float32Array(maxNodes * 3),
    left: new Int32Array(maxNodes).fill(-1),
    right: new Int32Array(maxNodes).fill(-1),
    start: new Int32Array(maxNodes),
    count: new Int32Array(maxNodes),
    order,
    nodeCount: 0,
    maxNodes,
  };

  const build = (start: number, count: number): number => {
    const node = bvh.nodeCount++;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let cMinX = Infinity;
    let cMinY = Infinity;
    let cMinZ = Infinity;
    let cMaxX = -Infinity;
    let cMaxY = -Infinity;
    let cMaxZ = -Infinity;
    for (let i = start; i < start + count; i++) {
      const tri = order[i]!;
      const a = indices[tri * 3]! * 3;
      const b = indices[tri * 3 + 1]! * 3;
      const c = indices[tri * 3 + 2]! * 3;
      minX = Math.min(minX, positions[a]!, positions[b]!, positions[c]!);
      minY = Math.min(minY, positions[a + 1]!, positions[b + 1]!, positions[c + 1]!);
      minZ = Math.min(minZ, positions[a + 2]!, positions[b + 2]!, positions[c + 2]!);
      maxX = Math.max(maxX, positions[a]!, positions[b]!, positions[c]!);
      maxY = Math.max(maxY, positions[a + 1]!, positions[b + 1]!, positions[c + 1]!);
      maxZ = Math.max(maxZ, positions[a + 2]!, positions[b + 2]!, positions[c + 2]!);
      const ci = tri * 3;
      cMinX = Math.min(cMinX, centroid[ci]!);
      cMinY = Math.min(cMinY, centroid[ci + 1]!);
      cMinZ = Math.min(cMinZ, centroid[ci + 2]!);
      cMaxX = Math.max(cMaxX, centroid[ci]!);
      cMaxY = Math.max(cMaxY, centroid[ci + 1]!);
      cMaxZ = Math.max(cMaxZ, centroid[ci + 2]!);
    }
    bvh.mins[node * 3] = minX;
    bvh.mins[node * 3 + 1] = minY;
    bvh.mins[node * 3 + 2] = minZ;
    bvh.maxs[node * 3] = maxX;
    bvh.maxs[node * 3 + 1] = maxY;
    bvh.maxs[node * 3 + 2] = maxZ;

    if (count <= LEAF_TRIANGLES) {
      bvh.start[node] = start;
      bvh.count[node] = count;
      return node;
    }

    const spanX = cMaxX - cMinX;
    const spanY = cMaxY - cMinY;
    const spanZ = cMaxZ - cMinZ;
    const axis = spanX >= spanY && spanX >= spanZ ? 0 : spanY >= spanZ ? 1 : 2;

    const slice = Array.from(order.subarray(start, start + count));
    slice.sort((p, q) => centroid[p * 3 + axis]! - centroid[q * 3 + axis]!);
    for (let i = 0; i < count; i++) order[start + i] = slice[i]!;

    const mid = count >> 1;
    const leftChild = build(start, mid);
    const rightChild = build(start + mid, count - mid);
    bvh.left[node] = leftChild;
    bvh.right[node] = rightChild;
    bvh.start[node] = -1;
    bvh.count[node] = 0;
    return node;
  };

  build(0, triCount);
  return bvh;
}

function boxDistanceSq(
  px: number,
  py: number,
  pz: number,
  minx: number,
  miny: number,
  minz: number,
  maxx: number,
  maxy: number,
  maxz: number
): number {
  const dx = px < minx ? minx - px : px > maxx ? px - maxx : 0;
  const dy = py < miny ? miny - py : py > maxy ? py - maxy : 0;
  const dz = pz < minz ? minz - pz : pz > maxz ? pz - maxz : 0;
  return dx * dx + dy * dy + dz * dz;
}

function rayBoxHit(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minx: number,
  miny: number,
  minz: number,
  maxx: number,
  maxy: number,
  maxz: number
): boolean {
  let tmin = -Infinity;
  let tmax = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const mn = [minx, miny, minz];
  const mx = [maxx, maxy, maxz];
  for (let axis = 0; axis < 3; axis++) {
    const dir = d[axis]!;
    if (Math.abs(dir) < 1e-9) {
      if (o[axis]! < mn[axis]! || o[axis]! > mx[axis]!) return false;
    } else {
      const inv = 1 / dir;
      let t1 = (mn[axis]! - o[axis]!) * inv;
      let t2 = (mx[axis]! - o[axis]!) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
  }
  return tmax >= 0;
}

function closestDistance(bvh: Bvh, positions: Float32Array, indices: Uint32Array, px: number, py: number, pz: number): number {
  const closest = new Float32Array(3);
  let best = Infinity;
  const stack = new Int32Array(64);
  let sp = 0;
  stack[sp++] = 0;

  while (sp > 0) {
    const node = stack[--sp]!;
    if (
      boxDistanceSq(
        px,
        py,
        pz,
        bvh.mins[node * 3]!,
        bvh.mins[node * 3 + 1]!,
        bvh.mins[node * 3 + 2]!,
        bvh.maxs[node * 3]!,
        bvh.maxs[node * 3 + 1]!,
        bvh.maxs[node * 3 + 2]!
      ) >= best
    ) {
      continue;
    }

    const count = bvh.count[node]!;
    if (count > 0) {
      const start = bvh.start[node]!;
      for (let i = start; i < start + count; i++) {
        const tri = bvh.order[i]!;
        const a = indices[tri * 3]! * 3;
        const b = indices[tri * 3 + 1]! * 3;
        const c = indices[tri * 3 + 2]! * 3;
        closestPointOnTriangle(
          px,
          py,
          pz,
          positions[a]!,
          positions[a + 1]!,
          positions[a + 2]!,
          positions[b]!,
          positions[b + 1]!,
          positions[b + 2]!,
          positions[c]!,
          positions[c + 1]!,
          positions[c + 2]!,
          closest
        );
        const dx = px - closest[0]!;
        const dy = py - closest[1]!;
        const dz = pz - closest[2]!;
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq < best) best = dSq;
      }
    } else {
      const l = bvh.left[node]!;
      const r = bvh.right[node]!;
      const dl = boxDistanceSq(
        px,
        py,
        pz,
        bvh.mins[l * 3]!,
        bvh.mins[l * 3 + 1]!,
        bvh.mins[l * 3 + 2]!,
        bvh.maxs[l * 3]!,
        bvh.maxs[l * 3 + 1]!,
        bvh.maxs[l * 3 + 2]!
      );
      const dr = boxDistanceSq(
        px,
        py,
        pz,
        bvh.mins[r * 3]!,
        bvh.mins[r * 3 + 1]!,
        bvh.mins[r * 3 + 2]!,
        bvh.maxs[r * 3]!,
        bvh.maxs[r * 3 + 1]!,
        bvh.maxs[r * 3 + 2]!
      );
      if (dl < dr) {
        if (dr < best) stack[sp++] = r;
        if (dl < best) stack[sp++] = l;
      } else {
        if (dl < best) stack[sp++] = l;
        if (dr < best) stack[sp++] = r;
      }
    }
  }

  return Math.sqrt(best);
}

function rayHitCount(bvh: Bvh, positions: Float32Array, indices: Uint32Array, ox: number, oy: number, oz: number): number {
  let hits = 0;
  const stack = new Int32Array(64);
  let sp = 0;
  stack[sp++] = 0;

  while (sp > 0) {
    const node = stack[--sp]!;
    if (
      !rayBoxHit(
        ox,
        oy,
        oz,
        RAY_DIR[0],
        RAY_DIR[1],
        RAY_DIR[2],
        bvh.mins[node * 3]!,
        bvh.mins[node * 3 + 1]!,
        bvh.mins[node * 3 + 2]!,
        bvh.maxs[node * 3]!,
        bvh.maxs[node * 3 + 1]!,
        bvh.maxs[node * 3 + 2]!
      )
    ) {
      continue;
    }
    const count = bvh.count[node]!;
    if (count > 0) {
      const start = bvh.start[node]!;
      for (let i = start; i < start + count; i++) {
        const tri = bvh.order[i]!;
        const a = indices[tri * 3]! * 3;
        const b = indices[tri * 3 + 1]! * 3;
        const c = indices[tri * 3 + 2]! * 3;
        if (
          rayIntersectsTriangle(
            ox,
            oy,
            oz,
            RAY_DIR[0],
            RAY_DIR[1],
            RAY_DIR[2],
            positions[a]!,
            positions[a + 1]!,
            positions[a + 2]!,
            positions[b]!,
            positions[b + 1]!,
            positions[b + 2]!,
            positions[c]!,
            positions[c + 1]!,
            positions[c + 2]!
          )
        ) {
          hits++;
        }
      }
    } else {
      stack[sp++] = bvh.left[node]!;
      stack[sp++] = bvh.right[node]!;
    }
  }

  return hits;
}

/** Bake a signed distance field. Negative inside, positive outside. */
export function bakeDistances(req: SdfBakeRequest, onProgress?: BakeProgress): Float32Array {
  const { positions, indices, origin, voxelSize, dim } = req;
  const [nx, ny, nz] = dim;
  const distances = new Float32Array(nx * ny * nz);
  const bvh = buildBvh(positions, indices);

  let vi = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const px = origin[0] + (ix + 0.5) * voxelSize;
        const py = origin[1] + (iy + 0.5) * voxelSize;
        const pz = origin[2] + (iz + 0.5) * voxelSize;

        const distance = closestDistance(bvh, positions, indices, px, py, pz);
        const inside = rayHitCount(bvh, positions, indices, px, py, pz) % 2 === 1;
        distances[vi++] = inside ? -distance : distance;
      }
    }
    onProgress?.((iz + 1) / nz);
  }

  return distances;
}
