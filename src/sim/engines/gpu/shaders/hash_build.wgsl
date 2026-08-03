struct Params {
  n: u32,
  tableSize: u32,
  invCell: f32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> predicted: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> cellStart: array<u32>;
@group(0) @binding(4) var<storage, read_write> particleIds: array<u32>;
@group(0) @binding(5) var<storage, read_write> particleHash: array<u32>;

fn hashCell(c: vec3<i32>) -> u32 {
  let x = u32(c.x) * 73856093u;
  let y = u32(c.y) * 19349663u;
  let z = u32(c.z) * 83492791u;
  return (x ^ y ^ z) % params.tableSize;
}

@compute @workgroup_size(256)
fn clear_counts(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.tableSize) { return; }
  atomicStore(&cellCount[i], 0u);
  cellStart[i] = 0u;
}

@compute @workgroup_size(256)
fn count_particles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let p = predicted[i].xyz;
  let cell = vec3<i32>(floor(p * params.invCell));
  let h = hashCell(cell);
  particleHash[i] = h;
  atomicAdd(&cellCount[h], 1u);
}

// Prefix-sum cellStart on CPU for simplicity — this kernel only copies counts.
@compute @workgroup_size(256)
fn scatter_particles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let h = particleHash[i];
  let slot = atomicAdd(&cellCount[h], 0xffffffffu); // decrement after prefix — see CPU rebuild
  // Actually: CPU builds cellStart then we use atomicAdd on a copy of counts as insert cursor.
  particleIds[0] = i; // placeholder overwritten by CPU path
}
