// Simple spatial-hash self-collision (Velvet-style particle–particle).
// Hash: cell = floor(p / cellSize); 27-neighbor lookup via flat table.

// Storage buffers are packed to stay within maxStorageBuffersPerShaderStage (8):
//   massEdge  = (inverse mass, mean incident edge length)
//   oneRing   = CSR offsets[0..n] followed by the neighbor list
//   delta     = (x, y, z, contactCount) per particle
//   cellStart = exclusive scan of cell counts with a sentinel at [tableSize]

struct Params {
  n: u32,
  tableSize: u32,
  invCell: f32,
  diameterScalar: f32,
  scale: f32,
  mu: f32,
  maxNeighbors: u32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> predicted: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> initialPositions: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> massEdge: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> oneRing: array<u32>;
@group(0) @binding(5) var<storage, read> cellStart: array<u32>;
@group(0) @binding(6) var<storage, read> particleIds: array<u32>;
@group(0) @binding(7) var<storage, read_write> delta: array<atomic<i32>>;

fn hashCell(c: vec3<i32>) -> u32 {
  let x = u32(c.x) * 73856093u;
  let y = u32(c.y) * 19349663u;
  let z = u32(c.z) * 83492791u;
  return (x ^ y ^ z) % params.tableSize;
}

fn isOneRing(i: u32, j: u32) -> bool {
  let a = oneRing[i];
  let b = oneRing[i + 1u];
  let base = params.n + 1u;
  for (var k = a; k < b; k++) {
    if (oneRing[base + k] == j) { return true; }
  }
  return false;
}

fn atomicAddVec(i: u32, d: vec3<f32>) {
  let o = i * 4u;
  atomicAdd(&delta[o], i32(d.x * params.scale));
  atomicAdd(&delta[o + 1u], i32(d.y * params.scale));
  atomicAdd(&delta[o + 2u], i32(d.z * params.scale));
  atomicAdd(&delta[o + 3u], 1);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let wi = massEdge[i].x;
  if (wi <= 0.0) { return; }
  let diSelf = massEdge[i].y * params.diameterScalar;
  let pi = predicted[i].xyz;
  let cell = vec3<i32>(floor(pi * params.invCell));

  for (var ox = -1; ox <= 1; ox++) {
    for (var oy = -1; oy <= 1; oy++) {
      for (var oz = -1; oz <= 1; oz++) {
        let h = hashCell(cell + vec3<i32>(ox, oy, oz));
        let start = cellStart[h];
        let count = min(cellStart[h + 1u] - start, params.maxNeighbors);
        for (var n = 0u; n < count; n++) {
          let j = particleIds[start + n];
          if (j <= i) { continue; }
          if (isOneRing(i, j)) { continue; }
          // Per-pair diameter (mean of the two particle diameters).
          let di = 0.5 * (diSelf + massEdge[j].y * params.diameterScalar);
          let p0 = initialPositions[i].xyz;
          let p1 = initialPositions[j].xyz;
          if (length(p0 - p1) < di) { continue; }
          let pj = predicted[j].xyz;
          let diff = pi - pj;
          let dist = length(diff);
          if (dist >= di || dist < 1e-8) { continue; }
          let wj = massEdge[j].x;
          if (wi + wj <= 0.0) { continue; }
          let nrm = diff / dist;
          let lambda = -(dist - di) / (wi + wj);
          let corr = nrm * lambda;
          atomicAddVec(i, wi * corr);
          atomicAddVec(j, -wj * corr);
        }
      }
    }
  }
}
