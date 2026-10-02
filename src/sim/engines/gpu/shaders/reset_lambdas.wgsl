// Zero an XPBD Lagrange-multiplier array. Dispatched once per substep for the
// stretch and bend accumulators.

struct Params {
  count: u32,
  _p0: u32,
  _p1: u32,
  _p2: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> lambdas: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.count) { return; }
  lambdas[gid.x] = 0.0;
}
