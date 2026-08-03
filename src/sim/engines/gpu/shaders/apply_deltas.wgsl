struct Params {
  n: u32,
  _pad0: u32,
  relaxation: f32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> predicted: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> deltaXYZ: array<f32>;
@group(0) @binding(3) var<storage, read_write> deltaCounts: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let count = deltaCounts[i];
  if (count > 0.0) {
    let dx = deltaXYZ[i * 3u];
    let dy = deltaXYZ[i * 3u + 1u];
    let dz = deltaXYZ[i * 3u + 2u];
    let avg = vec3<f32>(dx, dy, dz) / count * params.relaxation;
    let p = predicted[i].xyz + avg;
    predicted[i] = vec4<f32>(p, 0.0);
  }
  deltaXYZ[i * 3u] = 0.0;
  deltaXYZ[i * 3u + 1u] = 0.0;
  deltaXYZ[i * 3u + 2u] = 0.0;
  deltaCounts[i] = 0.0;
}
