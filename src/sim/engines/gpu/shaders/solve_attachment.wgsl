// Pairwise sew distance: |x_i − x_j| ≤ rest(t), with rest ramping from
// initialDist → targetRest as seamProgress goes 0→1.
// Caps how far a seam may close per pass so wrap can't slam through the body.

struct Params {
  nConstraints: u32,
  seamProgress: f32,
  nParticles: u32,
  underRelax: f32,
  maxClose: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> predicted: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> invMasses: array<f32>;
@group(0) @binding(3) var<storage, read> seamIndices: array<u32>;
@group(0) @binding(4) var<storage, read> seamRest: array<f32>;
@group(0) @binding(5) var<storage, read> seamInitial: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;
  if (id >= params.nConstraints) { return; }

  let idx1 = seamIndices[id * 2u];
  let idx2 = seamIndices[id * 2u + 1u];
  if (idx1 >= params.nParticles || idx2 >= params.nParticles || idx1 == idx2) { return; }

  let w1 = invMasses[idx1];
  let w2 = invMasses[idx2];
  let wSum = w1 + w2;
  if (wSum <= 0.0) { return; }

  let targetRest = max(seamRest[id], 1e-4);
  let initD = max(seamInitial[id], targetRest);
  let t = clamp(params.seamProgress, 0.0, 1.0);
  // Slower than smoothstep near the middle (when closure rate would peak).
  let eased = t * t * t * (t * (t * 6.0 - 15.0) + 10.0); // smootherstep
  let expected = initD + (targetRest - initD) * eased;

  let p1 = predicted[idx1].xyz;
  let p2 = predicted[idx2].xyz;
  let diff = p1 - p2;
  let distance = length(diff);
  if (distance < 1e-8) { return; }

  // Inequality: only pull when farther than the current sew gap.
  var C = distance - expected;
  if (C <= 0.0) { return; }
  C = min(C, max(params.maxClose, 1e-4));

  let nrm = diff / distance;
  let alpha = clamp(params.underRelax, 0.05, 0.5);
  let corr = nrm * ((C / wSum) * alpha);
  predicted[idx1] = vec4<f32>(p1 - corr * w1, 0.0);
  predicted[idx2] = vec4<f32>(p2 + corr * w2, 0.0);
}
