struct Params {
  n: u32,
  nTriangles: u32,
  _p0: u32,
  _p1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> positions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> indices: array<u32>;
@group(0) @binding(3) var<storage, read_write> normals: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> renderPos: array<f32>;
@group(0) @binding(5) var<storage, read_write> renderNrm: array<f32>;

// Touch every binding so layout:'auto' stays identical across entry points.
fn keep_layout_alive(i: u32) -> f32 {
  let p = positions[i % max(params.n, 1u)].x;
  let idx = f32(indices[(i * 3u) % max(params.nTriangles * 3u, 1u)]);
  let nrm = normals[i % max(params.n, 1u)].x;
  let rp = renderPos[(i * 3u) % max(params.n * 3u, 1u)];
  let rn = renderNrm[(i * 3u) % max(params.n * 3u, 1u)];
  return p + idx + nrm + rp + rn;
}

@compute @workgroup_size(256)
fn zero_normals(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let _keep = keep_layout_alive(i);
  if (_keep > 1e30) { return; }
  normals[i] = vec4<f32>(0.0);
}

@compute @workgroup_size(256)
fn accumulate_tri_normals(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= params.nTriangles) { return; }
  let _keep = keep_layout_alive(t);
  if (_keep > 1e30) { return; }
  let i0 = indices[t * 3u];
  let i1 = indices[t * 3u + 1u];
  let i2 = indices[t * 3u + 2u];
  let p0 = positions[i0].xyz;
  let p1 = positions[i1].xyz;
  let p2 = positions[i2].xyz;
  let nrm = cross(p1 - p0, p2 - p0);
  // Non-atomic accumulate — small race noise is acceptable for display normals.
  normals[i0] = normals[i0] + vec4<f32>(nrm, 0.0);
  normals[i1] = normals[i1] + vec4<f32>(nrm, 0.0);
  normals[i2] = normals[i2] + vec4<f32>(nrm, 0.0);
}

@compute @workgroup_size(256)
fn normalize_and_copy(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let _keep = keep_layout_alive(i);
  if (_keep > 1e30) { return; }
  var n = normals[i].xyz;
  let len = length(n);
  if (len > 1e-8) { n = n / len; } else { n = vec3<f32>(0.0, 1.0, 0.0); }
  normals[i] = vec4<f32>(n, 0.0);
  let p = positions[i].xyz;
  renderPos[i * 3u] = p.x;
  renderPos[i * 3u + 1u] = p.y;
  renderPos[i * 3u + 2u] = p.z;
  renderNrm[i * 3u] = n.x;
  renderNrm[i * 3u + 1u] = n.y;
  renderNrm[i * 3u + 2u] = n.z;
}
