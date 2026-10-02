// Rigid SDF / floor contact on committed positions + velocities (after finalize).
// Mirrors CPU SdfVolume.resolveParticle: project along ∇φ, kill inward speed.
// Must not run on predicted positions before finalize — push/Δt explodes cloth.

struct Params {
  tangRetain: f32,
  maxPush: f32,
  n: u32,
  numObs: u32,
  floorY: f32,
  margin: f32,
  _p0: f32,
  _p1: f32,
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
@group(0) @binding(1) var<storage, read_write> positions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> velocities: array<vec4<f32>>;
// x = inverse mass, y = mean incident edge length (per-particle contact margin).
@group(0) @binding(3) var<storage, read> massEdge: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> obstacles: array<Obstacle>;
@group(0) @binding(5) var meshSdf: texture_3d<f32>;

const BASE_COLLISION_MARGIN: f32 = 0.05;

struct DN { d: f32, n: vec3<f32> }
struct PV { p: vec3<f32>, v: vec3<f32> }

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

/** Trilinear fetch at continuous voxel coords (matches CPU SdfVolume.sampleAt). */
fn sample_at_voxel(fx: f32, fy: f32, fz: f32) -> f32 {
  let dims_u = textureDimensions(meshSdf);
  let max_i = vec3<i32>(dims_u) - vec3<i32>(1);
  let x0 = clamp(i32(floor(fx)), 0, max_i.x);
  let y0 = clamp(i32(floor(fy)), 0, max_i.y);
  let z0 = clamp(i32(floor(fz)), 0, max_i.z);
  let x1 = clamp(x0 + 1, 0, max_i.x);
  let y1 = clamp(y0 + 1, 0, max_i.y);
  let z1 = clamp(z0 + 1, 0, max_i.z);
  let tx = clamp(fx - f32(x0), 0.0, 1.0);
  let ty = clamp(fy - f32(y0), 0.0, 1.0);
  let tz = clamp(fz - f32(z0), 0.0, 1.0);
  let c000 = textureLoad(meshSdf, vec3<i32>(x0, y0, z0), 0).r;
  let c100 = textureLoad(meshSdf, vec3<i32>(x1, y0, z0), 0).r;
  let c010 = textureLoad(meshSdf, vec3<i32>(x0, y1, z0), 0).r;
  let c110 = textureLoad(meshSdf, vec3<i32>(x1, y1, z0), 0).r;
  let c001 = textureLoad(meshSdf, vec3<i32>(x0, y0, z1), 0).r;
  let c101 = textureLoad(meshSdf, vec3<i32>(x1, y0, z1), 0).r;
  let c011 = textureLoad(meshSdf, vec3<i32>(x0, y1, z1), 0).r;
  let c111 = textureLoad(meshSdf, vec3<i32>(x1, y1, z1), 0).r;
  let c00 = mix(c000, c100, tx);
  let c01 = mix(c001, c101, tx);
  let c10 = mix(c010, c110, tx);
  let c11 = mix(c011, c111, tx);
  let c0 = mix(c00, c10, ty);
  let c1 = mix(c01, c11, ty);
  return mix(c0, c1, tz);
}

fn sample_mesh(o: Obstacle, p: vec3<f32>) -> DN {
  let origin = o.a.xyz;
  let bmax = o.b.xyz;
  let dims = vec3<f32>(textureDimensions(meshSdf));
  let extent = max(bmax - origin, vec3<f32>(1e-6));
  let voxel_size = extent / dims;

  // Same continuous index as CPU: (p - origin) / voxelSize
  let f = (p - origin) / voxel_size;
  let max_f = dims - vec3<f32>(1.0);
  let inside =
    f.x >= 0.0 && f.y >= 0.0 && f.z >= 0.0 &&
    f.x <= max_f.x && f.y <= max_f.y && f.z <= max_f.z;

  var d: f32;
  var nrm: vec3<f32>;

  if (!inside) {
    let cp = clamp(p, origin, origin + max_f * voxel_size);
    let outside = p - cp;
    let outside_len = length(outside);
    let fc = clamp(f, vec3<f32>(0.0), max_f);
    d = sample_at_voxel(fc.x, fc.y, fc.z) + outside_len;
    if (outside_len > 1e-6) {
      nrm = outside / outside_len;
    } else {
      nrm = vec3<f32>(0.0, 1.0, 0.0);
    }
  } else {
    d = sample_at_voxel(f.x, f.y, f.z);
    let eps = 0.5;
    let dx = sample_at_voxel(f.x + eps, f.y, f.z) - sample_at_voxel(f.x - eps, f.y, f.z);
    let dy = sample_at_voxel(f.x, f.y + eps, f.z) - sample_at_voxel(f.x, f.y - eps, f.z);
    let dz = sample_at_voxel(f.x, f.y, f.z + eps) - sample_at_voxel(f.x, f.y, f.z - eps);
    var g = vec3<f32>(
      dx / (2.0 * eps * voxel_size.x),
      dy / (2.0 * eps * voxel_size.y),
      dz / (2.0 * eps * voxel_size.z)
    );
    let glen = length(g);
    if (glen > 1e-8) {
      nrm = g / glen;
    } else {
      nrm = vec3<f32>(0.0, 1.0, 0.0);
    }
  }
  return DN(d, nrm);
}

fn sdf_sample(o: Obstacle, p: vec3<f32>) -> DN {
  if (o.kind == 1u) {
    let nrm = normalize(o.a.xyz);
    return DN(dot(p, nrm) - o.b.x, nrm);
  }
  if (o.kind == 4u) {
    return sample_mesh(o, p);
  }
  return DN(1e6, vec3<f32>(0.0, 1.0, 0.0));
}

fn resolve_contact(
  p_in: vec3<f32>,
  v_in: vec3<f32>,
  d: f32,
  n_in: vec3<f32>,
  margin: f32,
  maxPush: f32
) -> PV {
  var p = p_in;
  var v = v_in;
  let depth = margin - d;
  if (depth <= 0.0) {
    return PV(p, v);
  }
  var nrm = n_in;
  let nlen = length(nrm);
  if (nlen < 1e-8) {
    nrm = vec3<f32>(0.0, 1.0, 0.0);
  } else {
    nrm = nrm / nlen;
  }
  p = p + nrm * min(depth, maxPush);

  let vn = dot(v, nrm);
  if (vn < 0.0) {
    v = v - nrm * vn;
  }
  let vn2 = dot(v, nrm);
  let n_comp = nrm * vn2;
  let t_comp = (v - n_comp) * params.tangRetain;
  v = n_comp + t_comp;
  return PV(p, v);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  if (massEdge[i].x <= 0.0) { return; }

  var p = positions[i].xyz;
  var v = velocities[i].xyz;

  // Per-particle margin (matches SdfVolume.resolveParticle) so thin strips whose
  // cross-width edges are short aren't floated off the body by a global average.
  let edge = massEdge[i].y;
  let margin = max(BASE_COLLISION_MARGIN, edge * 0.35);
  let maxPush = max(margin * 2.0, edge * 1.5);

  {
    let r = resolve_contact(p, v, p.y - params.floorY, vec3<f32>(0.0, 1.0, 0.0), margin, maxPush);
    p = r.p;
    v = r.v;
  }

  for (var oi = 0u; oi < params.numObs; oi++) {
    let o = obstacles[oi];
    let p_body = rot_to_body(o, p - o.center.xyz);
    let dn = sdf_sample(o, p_body);
    let n_world = rot_to_world(o, dn.n);
    let r = resolve_contact(p, v, dn.d, n_world, margin, maxPush);
    p = r.p;
    v = r.v;
  }

  positions[i] = vec4<f32>(p, 0.0);
  velocities[i] = vec4<f32>(v, 0.0);
}
