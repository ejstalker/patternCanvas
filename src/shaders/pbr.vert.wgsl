// Vertex shader for the physically based cloth pass.
//
// Mirrors cloth.vert.wgsl, but carries the world position the PBR fragment
// shader needs for its view vector, and lets the normal transform as a normal
// (w = 0) rather than as a point.

struct Uniforms {
    viewProj: mat4x4<f32>,
    model: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) fragNormal: vec3<f32>,
    @location(1) fragWorldPos: vec3<f32>,
}

@vertex
fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let world = uniforms.model * vec4<f32>(input.position, 1.0);
    output.position = uniforms.viewProj * world;
    output.fragWorldPos = world.xyz;
    output.fragNormal = (uniforms.model * vec4<f32>(input.normal, 0.0)).xyz;
    return output;
}

struct VertexInputColor {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec3<f32>,
}

struct VertexOutputColor {
    @builtin(position) position: vec4<f32>,
    @location(0) fragNormal: vec3<f32>,
    @location(1) fragWorldPos: vec3<f32>,
    @location(2) fragColor: vec3<f32>,
}

@vertex
fn mainColored(input: VertexInputColor) -> VertexOutputColor {
    var output: VertexOutputColor;
    let world = uniforms.model * vec4<f32>(input.position, 1.0);
    output.position = uniforms.viewProj * world;
    output.fragWorldPos = world.xyz;
    output.fragNormal = (uniforms.model * vec4<f32>(input.normal, 0.0)).xyz;
    output.fragColor = input.color;
    return output;
}
