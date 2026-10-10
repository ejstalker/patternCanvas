// Fragment shader for the physically based cloth pass.
//
// Cook-Torrance GGX with image-based lighting in the split-sum approximation:
// a diffuse irradiance cubemap, a roughness-prefiltered specular cubemap and a
// BRDF lookup table, then the selected tonemapper and gamma — the look of
// ~/Documents/Dev/pbr-webgpu, on the cloth instead of on a sphere.
//
// The tone mapping operators are prepended to this module at pipeline creation
// (src/shaders/tonemapping.wgsl) so the background and this pass share them.

struct LightingUniforms {
    ambientColor: vec3<f32>,
    lightDirection: vec3<f32>,
    lightColor: vec3<f32>,
    lightDirection2: vec3<f32>,
    lightColor2: vec3<f32>,
    diffuseColor: vec3<f32>,
    useVertexColor: f32,
    // PBR-only tail of the same buffer.
    cameraPosition: vec3<f32>,
    roughness: f32,
    exposure: f32,
    metallic: f32,
    /** Tone mapping operator, as a TONEMAP_MODES index. */
    tonemap: f32,
}

@group(0) @binding(1) var<uniform> lighting: LightingUniforms;

// The environment group. None of these is the HDRI: the file is a latlong
// texture_2d, and the environment pass bakes these three from it once at load
// (cube faces for the probe, a 2D LUT for the BRDF). Sampling the HDRI directly
// here would mean re-integrating the environment every pixel.
@group(1) @binding(0) var envSampler: sampler;
@group(1) @binding(1) var brdfLut: texture_2d<f32>;
@group(1) @binding(2) var irradianceMap: texture_cube<f32>;
@group(1) @binding(3) var prefilterMap: texture_cube<f32>;

const PI = 3.14159265359;
/** Last roughness level in the prefiltered chain — matches PREFILTER_MAX_LOD. */
const MAX_REFLECTION_LOD = 3.0;
/** Non-metals reflect about 4%; metals take their tint from the albedo. */
const DIELECTRIC_F0 = vec3<f32>(0.04);

fn distributionGGX(n: vec3<f32>, h: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let nDotH = max(dot(n, h), 0.0);
    let nDotH2 = nDotH * nDotH;
    let denom = nDotH2 * (a2 - 1.0) + 1.0;
    return a2 / max(PI * denom * denom, 1e-6);
}

/** Direct lighting remaps roughness with (r+1)^2/8; the IBL half uses it raw. */
fn geometrySchlickGGX(nDotV: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    return nDotV / (nDotV * (1.0 - k) + k);
}

fn geometrySmith(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32) -> f32 {
    let nDotV = max(dot(n, v), 0.0);
    let nDotL = max(dot(n, l), 0.0);
    return geometrySchlickGGX(nDotV, roughness) * geometrySchlickGGX(nDotL, roughness);
}

fn fresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
    return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelSchlickRoughness(cosTheta: f32, f0: vec3<f32>, roughness: f32) -> vec3<f32> {
    let roughnessTerm = max(1.0 - roughness, 0.0);
    let maxF = vec3<f32>(roughnessTerm, roughnessTerm, roughnessTerm);
    return f0 + (maxF - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

/** One Cook-Torrance direct light. `lightDir` is the direction *to* the light. */
fn directLight(
    n: vec3<f32>,
    v: vec3<f32>,
    lightDir: vec3<f32>,
    lightColor: vec3<f32>,
    albedo: vec3<f32>,
    f0: vec3<f32>,
    roughness: f32,
    metallic: f32,
) -> vec3<f32> {
    let l = normalize(lightDir);
    let nDotL = max(dot(n, l), 0.0);
    if (nDotL <= 0.0) {
        return vec3<f32>(0.0);
    }
    let h = normalize(v + l);
    let d = distributionGGX(n, h, roughness);
    let g = geometrySmith(n, v, l, roughness);
    let f = fresnelSchlick(max(dot(h, v), 0.0), f0);
    let specular = (d * g * f) / max(4.0 * max(dot(n, v), 0.0) * nDotL, 1e-4);
    // Metals have no diffuse lobe: their colour lives in the specular return.
    let kd = (vec3<f32>(1.0) - f) * (1.0 - metallic);
    return (kd * albedo / PI + specular) * lightColor * nDotL;
}

/**
 * The two direct lights are kept from the simple shader so the fabric still reads
 * when no HDRI is loaded; the IBL is what carries the PBR look.
 */
fn shade(normal: vec3<f32>, worldPos: vec3<f32>, albedo: vec3<f32>) -> vec3<f32> {
    let n = normalize(normal);
    let v = normalize(lighting.cameraPosition - worldPos);
    let r = reflect(-v, n);
    let roughness = clamp(lighting.roughness, 0.05, 1.0);
    let metallic = clamp(lighting.metallic, 0.0, 1.0);
    let f0 = mix(DIELECTRIC_F0, albedo, metallic);

    var direct = directLight(
        n, v, lighting.lightDirection, lighting.lightColor, albedo, f0, roughness, metallic,
    );
    direct += directLight(
        n, v, lighting.lightDirection2, lighting.lightColor2, albedo, f0, roughness, metallic,
    );
    // The simple shader's constant ambient becomes a floor under the IBL.
    direct += lighting.ambientColor * albedo;

    let f = fresnelSchlickRoughness(max(dot(n, v), 0.0), f0, roughness);
    let kd = (vec3<f32>(1.0) - f) * (1.0 - metallic);

    let irradiance = textureSample(irradianceMap, envSampler, n).rgb;
    let diffuse = irradiance * albedo;
    let prefiltered = textureSampleLevel(
        prefilterMap, envSampler, r, roughness * MAX_REFLECTION_LOD,
    ).rgb;
    let brdf = textureSample(
        brdfLut, envSampler, vec2<f32>(max(dot(n, v), 0.0), roughness),
    ).rg;
    let specularIbl = prefiltered * (f * brdf.x + brdf.y);

    let color = (kd * diffuse + specularIbl + direct) * lighting.exposure;
    return pow(toneMapping(color, u32(lighting.tonemap + 0.5)), vec3<f32>(1.0 / 2.2));
}

struct FragmentInput {
    @location(0) fragNormal: vec3<f32>,
    @location(1) fragWorldPos: vec3<f32>,
}

@fragment
fn main(input: FragmentInput) -> @location(0) vec4<f32> {
    return vec4<f32>(shade(input.fragNormal, input.fragWorldPos, lighting.diffuseColor), 1.0);
}

struct FragmentInputColor {
    @location(0) fragNormal: vec3<f32>,
    @location(1) fragWorldPos: vec3<f32>,
    @location(2) fragColor: vec3<f32>,
}

@fragment
fn mainColored(input: FragmentInputColor) -> @location(0) vec4<f32> {
    let albedo = mix(lighting.diffuseColor, input.fragColor, lighting.useVertexColor);
    return vec4<f32>(shade(input.fragNormal, input.fragWorldPos, albedo), 1.0);
}
