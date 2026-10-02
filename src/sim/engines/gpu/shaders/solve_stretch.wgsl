struct Params {
  offset: u32,
  count: u32,
  compliance: f32,
  nParticles: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> predicted: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> invMasses: array<f32>;
@group(0) @binding(3) var<storage, read> stretchIndices: array<u32>;
@group(0) @binding(4) var<storage, read> stretchRest: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.count) { return; }
  let id = params.offset + gid.x;
  let idx1 = stretchIndices[id * 2u];
  let idx2 = stretchIndices[id * 2u + 1u];
  if (idx1 >= params.nParticles || idx2 >= params.nParticles || idx1 == idx2) { return; }

  let expected = stretchRest[id];
  if (!(expected > 1e-8)) { return; }

  let w1 = invMasses[idx1];
  let w2 = invMasses[idx2];
  let wSum = w1 + w2;
  if (wSum <= 0.0) { return; }

  let p1 = predicted[idx1].xyz;
  let p2 = predicted[idx2].xyz;
  let diff = p1 - p2;
  let distance = length(diff);
  if (distance < 1e-8) { return; }

  let C = distance - expected;
  if (abs(C) < 1e-8) { return; }

  // Color-class Gauss–Seidel: no shared vertices within a dispatch → safe stores.
  let nrm = diff / distance;
  let alpha = clamp(params.compliance, 0.0, 1.0);
  let corr = nrm * ((C / wSum) * (1.0 - alpha));
  predicted[idx1] = vec4<f32>(p1 - corr * w1, 0.0);
  predicted[idx2] = vec4<f32>(p2 + corr * w2, 0.0);
}
