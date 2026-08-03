struct FloorUniforms {
    viewProj: mat4x4<f32>,
    model: mat4x4<f32>,
    halfExtent: f32,
    _pad: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: FloorUniforms;

struct FragmentInput {
    @location(0) worldPos: vec3<f32>,
}

@fragment
fn main(input: FragmentInput) -> @location(0) vec4<f32> {
    let r = length(input.worldPos.xz) / uniforms.halfExtent;
    let t = smoothstep(0.0, 1.0, clamp(r, 0.0, 1.0));
    let gray = (1.0 - t) * 0.25;
    return vec4<f32>(gray, gray, gray, 1.0);
}
