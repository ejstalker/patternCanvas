// Apply accumulated self-collision deltas and clear them for the next pass.
// deltaXYZ/deltaCounts are written by collide_particles.wgsl as scaled atomics.

const INV_DELTA_SCALE: f32 = 1.0 / 1048576.0; // 2^20

struct Params {
  n: u32,
  _pad0: u32,
  relaxation: f32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> predicted: array<vec4<f32>>;
// (x, y, z, contactCount) per particle — written by collide_particles.wgsl.
@group(0) @binding(2) var<storage, read_write> delta: array<atomic<i32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let o = i * 4u;
  let count = atomicLoad(&delta[o + 3u]);
  if (count > 0) {
    let dx = f32(atomicLoad(&delta[o]));
    let dy = f32(atomicLoad(&delta[o + 1u]));
    let dz = f32(atomicLoad(&delta[o + 2u]));
    let avg = vec3<f32>(dx, dy, dz) * (INV_DELTA_SCALE / f32(count)) * params.relaxation;
    predicted[i] = vec4<f32>(predicted[i].xyz + avg, 0.0);
  }
  atomicStore(&delta[o], 0);
  atomicStore(&delta[o + 1u], 0);
  atomicStore(&delta[o + 2u], 0);
  atomicStore(&delta[o + 3u], 0);
}
