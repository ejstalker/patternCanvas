// Tone mapping operators, ported from ~/Documents/Dev/pbr-webgpu so the viewport
// can match that look exactly. Each takes linear light and returns a value in
// display range.
//
// The operators are selected by an index carried in a uniform, so switching one
// is a buffer write rather than a pipeline rebuild. The branch is uniform across
// a draw call.

fn tonemapReinhard(color: vec3<f32>) -> vec3<f32> {
  return color / (color + vec3<f32>(1.0));
}

fn tonemapUncharted2Helper(x: vec3<f32>) -> vec3<f32> {
  let a = 0.15;
  let b = 0.50;
  let c = 0.10;
  let d = 0.20;
  let e = 0.02;
  let f = 0.30;
  return (x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f) - e / f;
}

fn tonemapUncharted2(color: vec3<f32>) -> vec3<f32> {
  let w = 11.2;
  let exposureBias = 2.0;
  let current = tonemapUncharted2Helper(exposureBias * color);
  let whiteScale = 1.0 / tonemapUncharted2Helper(vec3<f32>(w));
  return current * whiteScale;
}

fn tonemapAces(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return (color * (a * color + b)) / (color * (c * color + d) + e);
}

fn tonemapLottes(color: vec3<f32>) -> vec3<f32> {
  let a = vec3<f32>(1.6);
  let d = vec3<f32>(0.977);
  let hdrMax = vec3<f32>(8.0);
  let midIn = vec3<f32>(0.18);
  let midOut = vec3<f32>(0.267);
  let b = (-pow(midIn, a) + pow(hdrMax, a) * midOut) /
    ((pow(hdrMax, a * d) - pow(midIn, a * d)) * midOut);
  let c = (pow(hdrMax, a * d) * pow(midIn, a) - pow(hdrMax, a) * pow(midIn, a * d) * midOut) /
    ((pow(hdrMax, a * d) - pow(midIn, a * d)) * midOut);
  return pow(color, a) / (pow(color, a * d) * b + c);
}

/**
 * `mode` is a TONEMAP_MODES index. ACES is the fallback, so a shader that never
 * hears about the control (or hears a stale value) keeps the original look.
 */
fn toneMapping(color: vec3<f32>, mode: u32) -> vec3<f32> {
  var mapped: vec3<f32>;
  switch mode {
    case 0u: {
      mapped = tonemapReinhard(color);
    }
    case 1u: {
      mapped = tonemapUncharted2(color);
    }
    case 3u: {
      mapped = tonemapLottes(color);
    }
    default: {
      mapped = tonemapAces(color);
    }
  }
  return clamp(mapped, vec3<f32>(0.0), vec3<f32>(1.0));
}
