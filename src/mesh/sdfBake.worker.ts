type SdfBakeRequest = {
  positions: Float32Array;
  indices: Uint32Array;
  origin: [number, number, number];
  voxelSize: number;
  dim: [number, number, number];
};

type SdfBakeProgress = { type: 'progress'; value: number };
type SdfBakeResult = { type: 'done'; distances: Float32Array };
type SdfBakeError = { type: 'error'; message: string };

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

function bakeDistances(req: SdfBakeRequest): Float32Array {
  const { positions, indices, origin, voxelSize, dim } = req;
  const [nx, ny, nz] = dim;
  const count = nx * ny * nz;
  const distances = new Float32Array(count);
  const triCount = indices.length / 3;

  const closest = new Float32Array(3);
  const rayDir = [1, 0.037, 0.017];

  let vi = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const px = origin[0] + (ix + 0.5) * voxelSize;
        const py = origin[1] + (iy + 0.5) * voxelSize;
        const pz = origin[2] + (iz + 0.5) * voxelSize;

        let bestSq = Infinity;
        for (let ti = 0; ti < triCount; ti++) {
          const i0 = indices[ti * 3] * 3;
          const i1 = indices[ti * 3 + 1] * 3;
          const i2 = indices[ti * 3 + 2] * 3;
          closestPointOnTriangle(
            px,
            py,
            pz,
            positions[i0],
            positions[i1],
            positions[i2],
            positions[i1],
            positions[i1 + 1],
            positions[i1 + 2],
            positions[i2],
            positions[i2 + 1],
            positions[i2 + 2],
            closest
          );
          const dx = px - closest[0];
          const dy = py - closest[1];
          const dz = pz - closest[2];
          const dSq = dx * dx + dy * dy + dz * dz;
          if (dSq < bestSq) bestSq = dSq;
        }

        const unsigned = Math.sqrt(bestSq);
        let hits = 0;
        for (let ti = 0; ti < triCount; ti++) {
          const i0 = indices[ti * 3] * 3;
          const i1 = indices[ti * 3 + 1] * 3;
          const i2 = indices[ti * 3 + 2] * 3;
          if (
            rayIntersectsTriangle(
              px,
              py,
              pz,
              rayDir[0],
              rayDir[1],
              rayDir[2],
              positions[i0],
              positions[i1],
              positions[i2],
              positions[i1],
              positions[i1 + 1],
              positions[i1 + 2],
              positions[i2],
              positions[i2 + 1],
              positions[i2 + 2]
            )
          ) {
            hits++;
          }
        }

        const inside = hits % 2 === 1;
        distances[vi++] = inside ? -unsigned : unsigned;
      }
    }
    self.postMessage({ type: 'progress', value: (iz + 1) / nz } satisfies SdfBakeProgress);
  }

  return distances;
}

self.onmessage = (event: MessageEvent<SdfBakeRequest>) => {
  try {
    const req = event.data;
    const positions = new Float32Array(req.positions);
    const indices = new Uint32Array(req.indices);
    const distances = bakeDistances({ ...req, positions, indices });
    const payload: SdfBakeResult = { type: 'done', distances };
    self.postMessage(payload, { transfer: [distances.buffer] });
  } catch (err) {
    const payload: SdfBakeError = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(payload);
  }
};
