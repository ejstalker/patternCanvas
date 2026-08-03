struct Params {
  nConstraints: u32,
  compliance: f32,
  nParticles: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> predicted: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> invMasses: array<f32>;
@group(0) @binding(3) var<storage, read> stretchIndices: array<u32>;
@group(0) @binding(4) var<storage, read> stretchRest: array<f32>;
@group(0) @binding(5) var<storage, read_write> deltaXYZ: array<f32>;
@group(0) @binding(6) var<storage, read_write> deltaCounts: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;
  if (id >= params.nConstraints) { return; }
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

  // Soft under-relaxed distance constraint (racey Jacobi writes).
  let nrm = diff / distance;
  let alpha = max(params.compliance, 0.05);
  let corr = nrm * ((C / wSum) * alpha);
  predicted[idx1] = vec4<f32>(p1 - corr * w1, 0.0);
  predicted[idx2] = vec4<f32>(p2 + corr * w2, 0.0);

  let _keep = deltaXYZ[0] + deltaCounts[0];
  if (_keep > 1e30) { deltaCounts[0] = _keep; }
}
