// Quadrant snap grid overlay — flat, unlit, alpha-blended quads.

struct GridUniforms {
  viewProj: mat4x4<f32>,
  color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: GridUniforms;

@vertex
fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return uniforms.viewProj * vec4<f32>(position, 1.0);
}
