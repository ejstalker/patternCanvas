// Quadrant snap grid overlay — flat, unlit, alpha-blended quads.

struct GridUniforms {
  viewProj: mat4x4<f32>,
  color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: GridUniforms;

@fragment
fn main() -> @location(0) vec4<f32> {
  return uniforms.color;
}
