// Rigid SDF contact — plane + mesh texture (wasm-cloth-sim style).
// preStabilize != 0: project positions only (no friction), writes to `outPositions`.
// Otherwise projects predicted with friction vs positions reference.

struct Params {
  alpha: f32,
  mu: f32,
  n: u32,
  numObs: u32,
  preStabilize: u32,
  floorY: f32,
  _p0: u32,
  _p1: u32,
}

struct Obstacle {
  center: vec4<f32>,
  rot0: vec4<f32>,
  rot1: vec4<f32>,
  rot2: vec4<f32>,
  a: vec4<f32>,
  b: vec4<f32>,
  kind: u32,
  _p0: u32,
  _p1: u32,
  _p2: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> q: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> qRef: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> invMasses: array<f32>;
@group(0) @binding(4) var<storage, read> radii: array<f32>;
@group(0) @binding(5) var<storage, read> obstacles: array<Obstacle>;
@group(0) @binding(6) var meshSdf: texture_3d<f32>;

struct DN { d: f32, n: vec3<f32> }

fn rot_to_body(o: Obstacle, v: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    o.rot0.x * v.x + o.rot1.x * v.y + o.rot2.x * v.z,
    o.rot0.y * v.x + o.rot1.y * v.y + o.rot2.y * v.z,
    o.rot0.z * v.x + o.rot1.z * v.y + o.rot2.z * v.z,
  );
}

fn rot_to_world(o: Obstacle, v: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    o.rot0.x * v.x + o.rot0.y * v.y + o.rot0.z * v.z,
    o.rot1.x * v.x + o.rot1.y * v.y + o.rot1.z * v.z,
    o.rot2.x * v.x + o.rot2.y * v.y + o.rot2.z * v.z,
  );
}

fn fetch_sdf(uvw: vec3<f32>) -> f32 {
  let dims_u = textureDimensions(meshSdf);
  let dims = vec3<f32>(dims_u);
  let coord = clamp(uvw, vec3<f32>(0.0), vec3<f32>(1.0)) * (dims - vec3<f32>(1.0));
  let i0 = vec3<i32>(floor(coord));
  let i1 = i0 + vec3<i32>(1);
  let max_i = vec3<i32>(dims_u) - vec3<i32>(1);
  let i0c = clamp(i0, vec3<i32>(0), max_i);
  let i1c = clamp(i1, vec3<i32>(0), max_i);
  let f = coord - vec3<f32>(i0);
  let c000 = textureLoad(meshSdf, vec3<i32>(i0c.x, i0c.y, i0c.z), 0).r;
  let c100 = textureLoad(meshSdf, vec3<i32>(i1c.x, i0c.y, i0c.z), 0).r;
  let c010 = textureLoad(meshSdf, vec3<i32>(i0c.x, i1c.y, i0c.z), 0).r;
  let c110 = textureLoad(meshSdf, vec3<i32>(i1c.x, i1c.y, i0c.z), 0).r;
  let c001 = textureLoad(meshSdf, vec3<i32>(i0c.x, i0c.y, i1c.z), 0).r;
  let c101 = textureLoad(meshSdf, vec3<i32>(i1c.x, i0c.y, i1c.z), 0).r;
  let c011 = textureLoad(meshSdf, vec3<i32>(i0c.x, i1c.y, i1c.z), 0).r;
  let c111 = textureLoad(meshSdf, vec3<i32>(i1c.x, i1c.y, i1c.z), 0).r;
  let cx00 = mix(c000, c100, f.x);
  let cx10 = mix(c010, c110, f.x);
  let cx01 = mix(c001, c101, f.x);
  let cx11 = mix(c011, c111, f.x);
  let cxy0 = mix(cx00, cx10, f.y);
  let cxy1 = mix(cx01, cx11, f.y);
  return mix(cxy0, cxy1, f.z);
}

fn sample_mesh(o: Obstacle, p: vec3<f32>) -> DN {
  let bmin = o.a.xyz;
  let bmax = o.b.xyz;
  let extent = max(bmax - bmin, vec3<f32>(1e-6));
  let cp_bbox = clamp(p, bmin, bmax);
  let outside = p - cp_bbox;
  let outside_len = length(outside);
  let uvw = (cp_bbox - bmin) / extent;
  let dims = vec3<f32>(textureDimensions(meshSdf));
  let step_uvw = vec3<f32>(1.0) / dims;
  let d_tex = fetch_sdf(uvw);
  let d = d_tex + outside_len;
  let dx = fetch_sdf(uvw + vec3<f32>(step_uvw.x, 0.0, 0.0)) - fetch_sdf(uvw - vec3<f32>(step_uvw.x, 0.0, 0.0));
  let dy = fetch_sdf(uvw + vec3<f32>(0.0, step_uvw.y, 0.0)) - fetch_sdf(uvw - vec3<f32>(0.0, step_uvw.y, 0.0));
  let dz = fetch_sdf(uvw + vec3<f32>(0.0, 0.0, step_uvw.z)) - fetch_sdf(uvw - vec3<f32>(0.0, 0.0, step_uvw.z));
  let g_tex = vec3<f32>(dx / extent.x, dy / extent.y, dz / extent.z);
  var g: vec3<f32>;
  if (outside_len > 1e-6) { g = outside; } else { g = g_tex; }
  let glen = length(g);
  var nrm = vec3<f32>(0.0, 1.0, 0.0);
  if (glen > 1e-6) { nrm = g / glen; }
  return DN(d, nrm);
}

fn sdf_sample(o: Obstacle, p: vec3<f32>) -> DN {
  // kind 1 = plane (n = a.xyz, d = b.x in body frame ≈ world if identity)
  if (o.kind == 1u) {
    let nrm = normalize(o.a.xyz);
    return DN(dot(p, nrm) - o.b.x, nrm);
  }
  // kind 4 = mesh texture
  if (o.kind == 4u) {
    return sample_mesh(o, p);
  }
  return DN(1e6, vec3<f32>(0.0, 1.0, 0.0));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let wi = invMasses[i];
  if (wi <= 0.0) { return; }

  var p = q[i].xyz;
  let r = radii[i];
  let qpred = qRef[i].xyz;

  // Analytic floor at params.floorY (always).
  {
    let phi = (p.y - params.floorY) - r;
    if (phi < 0.0) {
      let nrm = vec3<f32>(0.0, 1.0, 0.0);
      let dlambda = -phi / (wi + params.alpha);
      p = p + wi * dlambda * nrm;
      if (params.preStabilize == 0u) {
        let dx = p - qpred;
        let vt = dx - nrm * dot(dx, nrm);
        let vtLen = length(vt);
        let maxVt = params.mu * abs(dlambda);
        if (vtLen > maxVt && vtLen > 1e-8) {
          p = p - vt * ((vtLen - maxVt) / vtLen);
        }
      }
    }
  }

  for (var oi = 0u; oi < params.numObs; oi++) {
    let o = obstacles[oi];
    let p_body = rot_to_body(o, p - o.center.xyz);
    let dn = sdf_sample(o, p_body);
    let n_world = rot_to_world(o, dn.n);
    let phi = dn.d - r;
    if (phi < 0.0) {
      let dlambda = -phi / (wi + params.alpha);
      p = p + wi * dlambda * n_world;
      if (params.preStabilize == 0u) {
        let dx = p - qpred;
        let vt = dx - n_world * dot(dx, n_world);
        let vtLen = length(vt);
        let maxVt = params.mu * abs(dlambda);
        if (vtLen > maxVt && vtLen > 1e-8) {
          p = p - vt * ((vtLen - maxVt) / vtLen);
        }
      }
    }
  }

  q[i] = vec4<f32>(p, 0.0);
}
