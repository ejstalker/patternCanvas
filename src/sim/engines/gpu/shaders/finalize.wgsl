struct Params {
  invH: f32,
  velRetain: f32,
  maxSpeed: f32,
  n: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> velocities: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> predicted: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> invMasses: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  if (invMasses[i] <= 0.0) {
    positions[i] = predicted[i];
    velocities[i] = vec4<f32>(0.0);
    return;
  }
  let p = positions[i].xyz;
  var q = predicted[i].xyz;
  var delta = q - p;
  let dlen = length(delta);
  // Clamp constraint-induced travel this substep so sew/stretch can't teleport
  // through the avatar or crumple into self-intersections.
  let maxDelta = max(params.maxSpeed * (1.0 / max(params.invH, 1e-4)), 1e-5);
  if (dlen > maxDelta && dlen > 1e-8) {
    delta = delta * (maxDelta / dlen);
    q = p + delta;
  }
  var v = delta * params.invH;
  v = v * params.velRetain;
  let speed = length(v);
  if (speed > params.maxSpeed && speed > 1e-8) {
    v = v * (params.maxSpeed / speed);
  }
  velocities[i] = vec4<f32>(v, 0.0);
  positions[i] = vec4<f32>(q, 0.0);
}
