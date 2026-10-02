// GPU spatial-hash build via counting sort.
//
// Entry points (dispatched in order, over the same storage buffers):
//   clear   — zero counts/cursors
//   count   — hash each particle, atomically count per cell
//   scan    — single-workgroup exclusive prefix sum → cellStart (+ cursor copy)
//   scatter — place particle ids into their cell range
//
// Requires tableSize ≤ 256 × SCAN_CHUNK (4096 with the defaults below).

struct Params {
  n: u32,
  tableSize: u32,
  invCell: f32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> positions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(3) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> cellCursor: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> particleIds: array<u32>;
@group(0) @binding(6) var<storage, read_write> particleHash: array<u32>;

fn hashCell(c: vec3<i32>) -> u32 {
  let x = u32(c.x) * 73856093u;
  let y = u32(c.y) * 19349663u;
  let z = u32(c.z) * 83492791u;
  return (x ^ y ^ z) % params.tableSize;
}

@compute @workgroup_size(256)
fn clear(@builtin(global_invocation_id) gid: vec3<u32>) {
  var i = gid.x;
  // cellStart has tableSize+1 entries (last is the total sentinel).
  loop {
    if (i > params.tableSize) { break; }
    cellStart[i] = 0u;
    if (i < params.tableSize) {
      atomicStore(&cellCount[i], 0u);
      atomicStore(&cellCursor[i], 0u);
    }
    i += 256u;
  }
}

@compute @workgroup_size(256)
fn count(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let p = positions[i].xyz;
  let cell = vec3<i32>(floor(p * params.invCell));
  let h = hashCell(cell);
  particleHash[i] = h;
  atomicAdd(&cellCount[h], 1u);
}

const SCAN_CHUNK: u32 = 16u;
var<workgroup> blockPrefix: array<u32, 256>;
var<workgroup> blockTotal: u32;

@compute @workgroup_size(256)
fn scan(@builtin(local_invocation_id) lid: vec3<u32>) {
  let t = lid.x;

  // Per-thread sequential exclusive scan over its chunk.
  var sum = 0u;
  for (var k = 0u; k < SCAN_CHUNK; k++) {
    let idx = t * SCAN_CHUNK + k;
    if (idx < params.tableSize) {
      let c = atomicLoad(&cellCount[idx]);
      cellStart[idx] = sum;
      sum += c;
    }
  }
  blockPrefix[t] = sum;
  workgroupBarrier();

  // Exclusive scan of the per-thread totals by thread 0; `acc` ends as the total.
  if (t == 0u) {
    var acc = 0u;
    for (var b = 0u; b < 256u; b++) {
      let v = blockPrefix[b];
      blockPrefix[b] = acc;
      acc += v;
    }
    blockTotal = acc;
  }
  workgroupBarrier();

  let base = blockPrefix[t];
  for (var k = 0u; k < SCAN_CHUNK; k++) {
    let idx = t * SCAN_CHUNK + k;
    if (idx < params.tableSize) {
      let start = cellStart[idx] + base;
      cellStart[idx] = start;
      atomicStore(&cellCursor[idx], start);
    }
  }

  // Sentinel so consumers can derive cell counts as start[h+1] − start[h].
  if (t == 0u) {
    cellStart[params.tableSize] = blockTotal;
  }
}

@compute @workgroup_size(256)
fn scatter(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let h = particleHash[i];
  let slot = atomicAdd(&cellCursor[h], 1u);
  particleIds[slot] = i;
}
