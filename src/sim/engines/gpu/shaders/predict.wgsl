struct Params {
  h: f32,
  gravity: f32,
  damping: f32,
  n: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> velocities: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> predicted: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> invMasses: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let w = invMasses[i];
  if (w <= 0.0) {
    predicted[i] = positions[i];
    return;
  }
  var v = velocities[i].xyz;
  v.y = v.y - params.gravity * params.h;
  v = v * (1.0 - params.damping * params.h);
  velocities[i] = vec4<f32>(v, 0.0);
  let p = positions[i].xyz + v * params.h;
  predicted[i] = vec4<f32>(p, 0.0);
}
