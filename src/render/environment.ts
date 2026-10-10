/**
 * Image-based lighting: the HDRI background and the light probe behind PBR
 * shading.
 *
 * A decoded equirectangular HDRI is turned into the four GPU resources a
 * physically based shader needs — a mip-mapped cubemap (background, and blurred
 * background by sampling a lower mip), a diffuse irradiance cubemap, a
 * roughness-prefiltered specular cubemap and a split-sum BRDF lookup table — all
 * once, then shared by every viewport, since they all render on one device.
 *
 * The passes follow the layout used by ~/Documents/Dev/pbr-webgpu.
 */
import { mat4, vec3 } from 'gl-matrix';
import { decodeExr, type ExrImage } from './exr';
import { clampToHalfRange, floatsToHalves } from './half';
import { perspective } from '../utils/math';
import { LATLONG_WGSL } from './latlong';
import { DEFAULT_TONEMAP, isTonemapMode, type TonemapMode } from './tonemapping';
import toneMappingWgsl from '../shaders/tonemapping.wgsl?raw';

/** Cubemap faces in the order WebGPU array layers expect: +X -X +Y -Y +Z -Z. */
export const FACE_TARGETS: ReadonlyArray<readonly [vec3, vec3]> = [
  [vec3.fromValues(1, 0, 0), vec3.fromValues(0, -1, 0)],
  [vec3.fromValues(-1, 0, 0), vec3.fromValues(0, -1, 0)],
  [vec3.fromValues(0, 1, 0), vec3.fromValues(0, 0, 1)],
  [vec3.fromValues(0, -1, 0), vec3.fromValues(0, 0, -1)],
  [vec3.fromValues(0, 0, 1), vec3.fromValues(0, -1, 0)],
  [vec3.fromValues(0, 0, -1), vec3.fromValues(0, -1, 0)],
];

/**
 * Cube sampling reads v downward from the top row, so every cube pass renders
 * through a vertically flipped projection. Without it each layer lands upside
 * down: the environment then comes back mirrored across the horizon, and the
 * +/-Y layers (whose v runs along Z) come back rotated as well.
 */
const CUBE_FLIP_Y = mat4.fromValues(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

const CUBEMAP_SIZE = 512;
const IRRADIANCE_SIZE = 32;
const PREFILTER_SIZE = 128;
const PREFILTER_LEVELS = 4;
const BRDF_SIZE = 256;
/** Roughness levels the prefilter chain covers, i.e. its last mip index. */
const MAX_REFLECTION_LOD = PREFILTER_LEVELS - 1;

export type ShadingMode = 'wireframe' | 'simple' | 'pbr';

/** Cycle order of the viewport shading toggle. */
export const SHADING_MODES: readonly ShadingMode[] = ['wireframe', 'simple', 'pbr'];

export function nextShadingMode(mode: ShadingMode): ShadingMode {
  const index = SHADING_MODES.indexOf(mode);
  return SHADING_MODES[(index + 1) % SHADING_MODES.length]!;
}

export function shadingModeLabel(mode: ShadingMode): string {
  if (mode === 'wireframe') return 'Wireframe';
  if (mode === 'pbr') return 'PBR';
  return 'Simple';
}

/**
 * Background blur, 0..1, as a *fractional* mip level of the latlong image.
 *
 * The mip chain already averages wider and wider neighbourhoods, and the
 * sampler interpolates between two levels (and within a level), so the skybox
 * reads a smooth, continuous defocus from a single texture fetch per pixel. No
 * per-frame taps, and no stepping as the slider moves.
 */
export function blurToMipLevel(blur: number, maxLevel: number): number {
  return Math.min(1, Math.max(0, blur)) * Math.max(0, maxLevel);
}

/**
 * The softest level worth sampling. Level 6 leaves a 2k latlong about 32 texels
 * wide — a heavy defocus that still has a shape; past it the image is a wash.
 */
const MAX_BLUR_MIP = 6;

/**
 * How many levels the latlong chain needs: one per halving, capped at the
 * softest level the background can ask for.
 */
export function equirectMipLevelCount(width: number): number {
  if (!Number.isFinite(width) || width < 2) return 1;
  return Math.min(Math.floor(Math.log2(width)) + 1, MAX_BLUR_MIP + 1);
}

export const MIN_EXPOSURE = 0.2;
export const MAX_EXPOSURE = 4;
const DEFAULT_EXPOSURE = 1;

export type EnvironmentSettings = {
  /** File name inside `hdri/`, or null for no environment. */
  hdri: string | null;
  /** Background blur, 0 (sharp) .. 1 (softest mip). */
  blur: number;
  /** Exposure applied to the background and to the PBR shading that uses it. */
  exposure: number;
  /** Which tone mapping operator the PBR pass and the background use. */
  tonemap: TonemapMode;
  /** Whether the HDRI is drawn behind the scene at all. */
  background: boolean;
  /**
   * The shading mode a new viewport opens in. Each viewport keeps its own mode
   * once it exists, so this is a remembered preference rather than live state.
   */
  shading: ShadingMode;
};

const SETTINGS_KEY = 'patternCanvas.environment';

/** The background a fresh install opens with. */
export const DEFAULT_HDRI = 'little_paris_eiffel_tower_1k.exr';

/**
 * The mode a 3D viewport opens in. PBR is the app's intended look — the plain
 * lit fabric is still there in the cycle for checking geometry without it.
 */
export const DEFAULT_SHADING_MODE: ShadingMode = 'pbr';

export const DEFAULT_ENVIRONMENT_SETTINGS: EnvironmentSettings = {
  hdri: DEFAULT_HDRI,
  blur: 0.5,
  exposure: DEFAULT_EXPOSURE,
  tonemap: DEFAULT_TONEMAP,
  background: true,
  shading: DEFAULT_SHADING_MODE,
};

export function loadEnvironmentSettings(): EnvironmentSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_ENVIRONMENT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<EnvironmentSettings>;
    return {
      hdri: typeof parsed.hdri === 'string' ? parsed.hdri : DEFAULT_HDRI,
      blur: clamp01(
        typeof parsed.blur === 'number' ? parsed.blur : DEFAULT_ENVIRONMENT_SETTINGS.blur
      ),
      exposure:
        typeof parsed.exposure === 'number'
          ? clampExposure(parsed.exposure)
          : DEFAULT_ENVIRONMENT_SETTINGS.exposure,
      tonemap: isTonemapMode(parsed.tonemap) ? parsed.tonemap : DEFAULT_TONEMAP,
      background: parsed.background !== false,
      shading: isShadingMode(parsed.shading) ? parsed.shading : DEFAULT_SHADING_MODE,
    };
  } catch {
    return { ...DEFAULT_ENVIRONMENT_SETTINGS };
  }
}

function isShadingMode(value: unknown): value is ShadingMode {
  return typeof value === 'string' && (SHADING_MODES as readonly string[]).includes(value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function clampExposure(value: number): number {
  return Math.min(MAX_EXPOSURE, Math.max(MIN_EXPOSURE, value));
}

function saveEnvironmentSettings(settings: EnvironmentSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: the setting just does not persist */
  }
}

/** The HDRI files the dev server publishes, newest listing each call. */
export async function listHdris(): Promise<string[]> {
  try {
    const res = await fetch('/hdri/index.json');
    if (!res.ok) return [];
    const json = (await res.json()) as { files?: unknown };
    if (!Array.isArray(json.files)) return [];
    return json.files.filter(
      (f): f is string => typeof f === 'string' && /\.(exr|hdr)$/i.test(f)
    );
  } catch {
    return [];
  }
}

/**
 * A neutral studio: sky-to-floor gradient with a soft warm key light and a
 * dimmer rim fill, so folds still read without a photographic HDRI.
 */
function NEUTRAL_EQUIRECT(): ExrImage {
  const width = 64;
  const height = 32;
  const data = new Float32Array(width * height * 4);
  const keyDir = [0.45, 0.62, 0.65];
  const rimDir = [-0.7, 0.35, -0.6];
  for (let y = 0; y < height; y++) {
    // Equirect rows run top (up) to bottom (down).
    const theta = ((y + 0.5) / height) * Math.PI;
    const up = Math.cos(theta);
    for (let x = 0; x < width; x++) {
      const phi = ((x + 0.5) / width) * Math.PI * 2;
      const dir = [Math.sin(theta) * Math.cos(phi), up, Math.sin(theta) * Math.sin(phi)];
      const sky = Math.max(0, up);
      const base = [0.16 + 0.5 * sky, 0.17 + 0.53 * sky, 0.19 + 0.58 * sky];
      const key = Math.pow(Math.max(0, dot3(dir, keyDir)), 24) * 6;
      const rim = Math.pow(Math.max(0, dot3(dir, rimDir)), 12) * 1.2;
      const i = (y * width + x) * 4;
      data[i] = base[0] + key * 1.0 + rim * 0.85;
      data[i + 1] = base[1] + key * 0.95 + rim * 0.9;
      data[i + 2] = base[2] + key * 0.85 + rim;
      data[i + 3] = 1;
    }
  }
  return { width, height, data };
}

function dot3(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

const CUBE_VERTEX_SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  /** Roughness for the prefilter pass; 0 elsewhere. */
  roughness: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  /** Untransformed cube position: the direction this pixel looks along. */
  @location(0) localPosition: vec3<f32>,
}

@vertex
fn main(@location(0) position: vec4<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = uniforms.viewProj * position;
  out.localPosition = position.xyz;
  return out;
}
`;

/**
 * The matrix one cube pass renders a face through: a 90 degree camera down the
 * face axis, times the vertical flip cube sampling needs. The flip is what lets
 * the capture use the plain latlong mapping — it is the projection, not the
 * mapping, that decides which direction lands in a given texel.
 */
export function cubeFaceViewProjection(face: number): mat4 {
  const [target, up] = FACE_TARGETS[face]!;
  const view = mat4.create();
  mat4.lookAt(view, vec3.create(), target, up);
  const viewProj = mat4.create();
  mat4.multiply(viewProj, perspective(90, 1, 0.1, 10), view);
  return mat4.multiply(viewProj, CUBE_FLIP_Y, viewProj);
}

/**
 * Bakes the light probe: each texel of each cube layer reads the latlong HDRI
 * along the direction that texel stands for, through the shared mapping. The
 * CUBE_FLIP_Y projection decides *which* direction lands in which texel, so the
 * mapping itself is the same one the background uses.
 */
const CAPTURE_FRAGMENT_SHADER = /* wgsl */ `
@group(0) @binding(1) var equirect: texture_2d<f32>;
@group(0) @binding(2) var equirectSampler: sampler;

${LATLONG_WGSL}

@fragment
fn main(@location(0) localPosition: vec3<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSample(equirect, equirectSampler, latlongUv(localPosition)).rgb, 1.0);
}
`;

/** WGSL shared by every environment pass that needs the PBR integrals. */
const PBR_HELPERS = /* wgsl */ `
const PI = 3.14159265359;

/**
 * Ceiling for anything written into an rgba16float target (half max). The
 * irradiance pass multiplies by PI, so a texel that is already at the input
 * ceiling could still come out above this and be stored as Inf.
 */
const HALF_MAX = 65504.0;

/** GGX normal distribution — shared by the prefilter, the BRDF LUT and shading. */
fn distributionGGX(n: vec3<f32>, h: vec3<f32>, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let nDotH = max(dot(n, h), 0.0);
  let nDotH2 = nDotH * nDotH;
  let denom = nDotH2 * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 1e-6);
}

/** Smith visibility term with the IBL remap (k = a^2 / 2). */
fn geometrySchlickGGXIBL(nDotV: f32, roughness: f32) -> f32 {
  let k = (roughness * roughness) / 2.0;
  return nDotV / (nDotV * (1.0 - k) + k);
}

fn geometrySmithIBL(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32) -> f32 {
  let nDotV = max(dot(n, v), 0.0);
  let nDotL = max(dot(n, l), 0.0);
  return geometrySchlickGGXIBL(nDotV, roughness) * geometrySchlickGGXIBL(nDotL, roughness);
}

/**
 * Van der Corput radical inverse — the low-discrepancy half of the Hammersley
 * sequence.
 */
fn radicalInverseVdC(bits: u32) -> f32 {
  var result = bits;
  result = (result << 16u) | (result >> 16u);
  result = ((result & 0x55555555u) << 1u) | ((result & 0xAAAAAAAAu) >> 1u);
  result = ((result & 0x33333333u) << 2u) | ((result & 0xCCCCCCCCu) >> 2u);
  result = ((result & 0x0F0F0F0Fu) << 4u) | ((result & 0xF0F0F0F0u) >> 4u);
  result = ((result & 0x00FF00FFu) << 8u) | ((result & 0xFF00FF00u) >> 8u);
  return f32(result) * 2.3283064365386963e-10;
}

fn hammersley(i: u32, n: u32) -> vec2<f32> {
  return vec2<f32>(f32(i) / f32(n), radicalInverseVdC(i));
}

/** Tangent-space GGX half-vector, rotated into the frame around \`n\`. */
fn importanceSampleGGX(xi: vec2<f32>, n: vec3<f32>, roughness: f32) -> vec3<f32> {
  let a = roughness * roughness;
  let phi = 2.0 * PI * xi.x;
  let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  let h = vec3<f32>(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);

  let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(n.z) < 0.999);
  let tangent = normalize(cross(up, n));
  let bitangent = cross(n, tangent);
  return normalize(tangent * h.x + bitangent * h.y + n * h.z);
}
`;

const IRRADIANCE_FRAGMENT_SHADER = /* wgsl */ `
@group(0) @binding(1) var environment: texture_cube<f32>;
@group(0) @binding(2) var environmentSampler: sampler;

${PBR_HELPERS}

/**
 * Cosine-weighted convolution of the environment into the diffuse half of the
 * split-sum approximation.
 */
@fragment
fn main(@location(0) localPosition: vec3<f32>) -> @location(0) vec4<f32> {
  let normal = normalize(localPosition);

  var up = vec3<f32>(0.0, 1.0, 0.0);
  let right = normalize(cross(up, normal));
  up = normalize(cross(normal, right));

  var irradiance = vec3<f32>(0.0);
  var samples = 0.0;
  let delta = 0.1;
  var phi = 0.0;
  loop {
    if (phi >= 2.0 * PI) { break; }
    var theta = 0.0;
    loop {
      if (theta >= 0.5 * PI) { break; }
      let tangentSample = vec3<f32>(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta));
      let sampleDir = tangentSample.x * right + tangentSample.y * up + tangentSample.z * normal;
      irradiance += textureSample(environment, environmentSampler, sampleDir).rgb * cos(theta) * sin(theta);
      samples += 1.0;
      theta += delta;
    }
    phi += delta;
  }

  let value = PI * irradiance / max(samples, 1.0);
  return vec4<f32>(min(value, vec3<f32>(HALF_MAX)), 1.0);
}
`;

const PREFILTER_FRAGMENT_SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  roughness: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var environment: texture_cube<f32>;
@group(0) @binding(2) var environmentSampler: sampler;

${PBR_HELPERS}

const SAMPLE_COUNT: u32 = 1024u;

/** Roughness levels in the prefiltered chain, fed in as the source resolution. */
const SOURCE_RESOLUTION: f32 = 512.0;

@fragment
fn main(@location(0) localPosition: vec3<f32>) -> @location(0) vec4<f32> {
  let n = normalize(localPosition);
  let r = n;
  let v = r;

  var prefiltered = vec3<f32>(0.0);
  var totalWeight = 0.0;

  for (var i: u32 = 0u; i < SAMPLE_COUNT; i++) {
    let xi = hammersley(i, SAMPLE_COUNT);
    let h = importanceSampleGGX(xi, n, uniforms.roughness);
    let l = normalize(2.0 * dot(v, h) * h - v);
    let nDotL = max(dot(n, l), 0.0);
    if (nDotL > 0.0) {
      // Sample a source mip that matches the sample's solid angle, so the
      // prefilter does not alias on rough levels.
      let d = distributionGGX(n, h, uniforms.roughness);
      let nDotH = max(dot(n, h), 0.0);
      let hDotV = max(dot(h, v), 0.0);
      let pdf = d * nDotH / (4.0 * hDotV) + 0.0001;
      let saTexel = 4.0 * PI / (6.0 * SOURCE_RESOLUTION * SOURCE_RESOLUTION);
      let saSample = 1.0 / (f32(SAMPLE_COUNT) * pdf + 0.0001);
      let mipLevel = select(0.5 * log2(saSample / saTexel), 0.0, uniforms.roughness == 0.0);

      prefiltered += textureSampleLevel(environment, environmentSampler, l, mipLevel).rgb * nDotL;
      totalWeight += nDotL;
    }
  }

  let value = prefiltered / max(totalWeight, 1e-4);
  return vec4<f32>(min(value, vec3<f32>(HALF_MAX)), 1.0);
}
`;

const QUAD_VERTEX_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn main(@location(0) position: vec3<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>(position, 1.0);
  out.uv = uv;
  return out;
}
`;

const BRDF_FRAGMENT_SHADER = /* wgsl */ `
${PBR_HELPERS}

const SAMPLE_COUNT: u32 = 512u;

fn integrateBRDF(nDotV: f32, roughness: f32) -> vec2<f32> {
  var v = vec3<f32>(sqrt(max(0.0, 1.0 - nDotV * nDotV)), 0.0, nDotV);
  let n = vec3<f32>(0.0, 0.0, 1.0);

  var a = 0.0;
  var b = 0.0;
  for (var i: u32 = 0u; i < SAMPLE_COUNT; i++) {
    let xi = hammersley(i, SAMPLE_COUNT);
    let h = importanceSampleGGX(xi, n, roughness);
    let l = normalize(2.0 * dot(v, h) * h - v);
    let nDotL = max(l.z, 0.0);
    let nDotH = max(h.z, 0.0);
    let vDotH = max(dot(v, h), 0.0);
    if (nDotL > 0.0) {
      let g = geometrySmithIBL(n, v, l, roughness);
      let gVis = (g * vDotH) / max(nDotH * nDotV, 1e-4);
      let fc = pow(1.0 - vDotH, 5.0);
      a += (1.0 - fc) * gVis;
      b += fc * gVis;
    }
  }
  return vec2<f32>(a, b) / f32(SAMPLE_COUNT);
}

@fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec2<f32> {
  return integrateBRDF(uv.x, 1.0 - uv.y);
}
`;

/**
 * Skybox: unwraps the latlong HDRI around the camera, read from the defocused
 * level of its mip chain. The uniform block is shared with the fragment
 * shader, so the two structs must stay identical.
 */
const BACKGROUND_VERTEX_SHADER = /* wgsl */ `
struct Uniforms {
  inverseViewProj: mat4x4<f32>,
  eye: vec3<f32>,
  /** Fractional mip level of the latlong image. */
  blurLevel: f32,
  exposure: f32,
  /** Tone mapping operator, as a TONEMAP_MODES index. */
  tonemap: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) direction: vec3<f32>,
}

/**
 * A single oversized triangle in clip space, unprojected back into a world
 * direction — cheaper than a cube and it never clips against the far plane.
 */
@vertex
fn main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  let clip = corners[index];

  var out: VertexOutput;
  out.position = vec4<f32>(clip, 1.0, 1.0);
  let world = uniforms.inverseViewProj * vec4<f32>(clip, 1.0, 1.0);
  out.direction = world.xyz / world.w;
  return out;
}
`;

const BACKGROUND_FRAGMENT_SHADER = /* wgsl */ `
struct Uniforms {
  inverseViewProj: mat4x4<f32>,
  eye: vec3<f32>,
  /**
   * Fractional mip level of the latlong image. The sampler interpolates
   * between levels, so this is a soft defocus rather than a resample.
   */
  blurLevel: f32,
  exposure: f32,
  /** Tone mapping operator, as a TONEMAP_MODES index. */
  tonemap: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var hdri: texture_2d<f32>;
@group(0) @binding(2) var hdriSampler: sampler;

${PBR_HELPERS}

${LATLONG_WGSL}

${toneMappingWgsl}

@fragment
fn main(@location(0) farPoint: vec3<f32>) -> @location(0) vec4<f32> {
  let direction = normalize(farPoint - uniforms.eye);
  // One fetch: the mip chain holds the averages, the sampler blends between the
  // levels either side of the blur level and bilinearly within each.
  let sampled = textureSampleLevel(
    hdri, hdriSampler, latlongUv(direction), uniforms.blurLevel,
  ).rgb;
  let mapped = toneMapping(sampled * uniforms.exposure, u32(uniforms.tonemap + 0.5));
  return vec4<f32>(pow(mapped, vec3<f32>(1.0 / 2.2)), 1.0);
}
`;

/** Downsamples one mip of the latlong image: a five-tap cross, weights to 1. */
const EQUIRECT_MIP_FRAGMENT_SHADER = /* wgsl */ `
struct Params {
  /** Texel size of the level being read. */
  texelSize: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

@fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let t = params.texelSize;
  var color = textureSampleLevel(source, sourceSampler, uv, 0.0).rgb * 0.4;
  color += textureSampleLevel(source, sourceSampler, uv + vec2<f32>(t, 0.0), 0.0).rgb * 0.15;
  color += textureSampleLevel(source, sourceSampler, uv - vec2<f32>(t, 0.0), 0.0).rgb * 0.15;
  color += textureSampleLevel(source, sourceSampler, uv + vec2<f32>(0.0, t), 0.0).rgb * 0.15;
  color += textureSampleLevel(source, sourceSampler, uv - vec2<f32>(0.0, t), 0.0).rgb * 0.15;
  return vec4<f32>(color, 1.0);
}
`;

type RenderTargets = {
  /** The latlong image itself — the background unwraps this directly. */
  equirect: GPUTexture;
  /** Its width, which decides how soft the background blur can go. */
  equirectWidth: number;
  cubemap: GPUTexture;
  irradiance: GPUTexture;
  prefilter: GPUTexture;
  brdf: GPUTexture;
  equirectView: GPUTextureView;
  irradianceView: GPUTextureView;
  prefilterView: GPUTextureView;
  brdfView: GPUTextureView;
};

/**
 * One environment per device, shared by every viewport that renders on it.
 *
 * Views hold a reference and are notified when the maps are rebuilt, because a
 * rebuild invalidates every bind group that referenced the old textures.
 */
export class Environment {
  readonly device: GPUDevice;
  private settings: EnvironmentSettings = loadEnvironmentSettings();
  private targets: RenderTargets | null = null;
  /** Set while a load is in flight, so overlapping requests do not race. */
  private loading: Promise<void> | null = null;
  private loadToken = 0;
  private listeners = new Set<() => void>();

  private sampler: GPUSampler;
  private cubeSampler: GPUSampler;
  /** Latlong sampling wraps around the horizon, so the seam is invisible. */
  private backgroundSampler: GPUSampler;
  private cubeVertices: GPUBuffer;
  private quadVertices: GPUBuffer;
  private prefilterUniform: GPUBuffer;

  private capturePipeline: GPURenderPipeline;
  private irradiancePipeline: GPURenderPipeline;
  private prefilterPipeline: GPURenderPipeline;
  private brdfPipeline: GPURenderPipeline;
  private equirectMipPipeline: GPURenderPipeline;
  readonly backgroundPipeline: GPURenderPipeline;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    // The CUBE filters itself; a plain linear sampler is all it needs.
    this.cubeSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
    this.backgroundSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      // Trilinear: the blur slider moves through fractional levels, and the
      // sampler is what turns that into a smooth defocus.
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
    });

    this.cubeVertices = device.createBuffer({
      size: CUBE_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.cubeVertices, 0, CUBE_VERTICES);

    this.quadVertices = device.createBuffer({
      size: QUAD_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.quadVertices, 0, QUAD_VERTICES);

    this.prefilterUniform = device.createBuffer({
      // mat4x4 (64 bytes) + roughness (+ 12 bytes padding for the 16-byte rule).
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.capturePipeline = device.createRenderPipeline({
      label: 'hdri to cubemap',
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({ code: CUBE_VERTEX_SHADER }),
        entryPoint: 'main',
        buffers: [
          { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] },
        ],
      },
      fragment: {
        module: device.createShaderModule({ code: CAPTURE_FRAGMENT_SHADER }),
        entryPoint: 'main',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    this.irradiancePipeline = device.createRenderPipeline({
      label: 'irradiance map',
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({ code: CUBE_VERTEX_SHADER }),
        entryPoint: 'main',
        buffers: [
          { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] },
        ],
      },
      fragment: {
        module: device.createShaderModule({ code: IRRADIANCE_FRAGMENT_SHADER }),
        entryPoint: 'main',
        targets: [{ format: 'rgba16float' }],
      },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    this.prefilterPipeline = device.createRenderPipeline({
      label: 'prefilter map',
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({ code: CUBE_VERTEX_SHADER }),
        entryPoint: 'main',
        buffers: [
          { arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] },
        ],
      },
      fragment: {
        module: device.createShaderModule({ code: PREFILTER_FRAGMENT_SHADER }),
        entryPoint: 'main',
        targets: [{ format: 'rgba16float' }],
      },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    this.equirectMipPipeline = device.createRenderPipeline({
      label: 'equirect mip chain',
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({ code: QUAD_VERTEX_SHADER }),
        entryPoint: 'main',
        buffers: [
          { arrayStride: 20, attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x2' },
          ] },
        ],
      },
      fragment: {
        module: device.createShaderModule({ code: EQUIRECT_MIP_FRAGMENT_SHADER }),
        entryPoint: 'main',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.brdfPipeline = device.createRenderPipeline({
      label: 'brdf lut',
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({ code: QUAD_VERTEX_SHADER }),
        entryPoint: 'main',
        buffers: [
          { arrayStride: 20, attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x2' },
          ] },
        ],
      },
      fragment: {
        module: device.createShaderModule({ code: BRDF_FRAGMENT_SHADER }),
        entryPoint: 'main',
        targets: [{ format: 'rg16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.backgroundPipeline = device.createRenderPipeline({
      label: 'hdri background',
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({ code: BACKGROUND_VERTEX_SHADER }),
        entryPoint: 'main',
      },
      fragment: {
        module: device.createShaderModule({ code: BACKGROUND_FRAGMENT_SHADER }),
        entryPoint: 'main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
    });

    // Kick off the first environment build so PBR has a probe from the start:
    // the saved HDRI if there is one, the neutral studio otherwise.
    void this.setHdri(this.settings.hdri).catch((error) => {
      console.warn('Environment build failed', error);
    });
  }

  /** Everything a PBR shader needs, as bind group 1. */
  textureBindGroup(layout: GPUBindGroupLayout): GPUBindGroup | null {
    const targets = this.targets;
    if (!targets) return null;
    return this.device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: targets.brdfView },
        { binding: 2, resource: targets.irradianceView },
        { binding: 3, resource: targets.prefilterView },
      ],
    });
  }

  /**
   * The background's full bind group: `uniformBuffer` is the view's own
   * inverse-view-projection buffer, the rest comes from the environment.
   */
  backgroundBindGroup(
    layout: GPUBindGroupLayout,
    uniformBuffer: GPUBuffer
  ): GPUBindGroup | null {
    const targets = this.targets;
    if (!targets) return null;
    return this.device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: targets.equirectView },
        { binding: 2, resource: this.backgroundSampler },
      ],
    });
  }

  /** True once an HDRI has finished building, so a background can be drawn. */
  get ready(): boolean {
    return this.targets !== null;
  }

  get drawBackground(): boolean {
    return this.settings.background && this.ready;
  }

  get currentSettings(): EnvironmentSettings {
    return { ...this.settings };
  }

  /** Fractional mip level the background samples for the current blur. */
  get backgroundBlurLevel(): number {
    return blurToMipLevel(this.settings.blur, this.maxBlurLevel);
  }

  /** The softest level this image's chain can offer for a background blur. */
  private get maxBlurLevel(): number {
    return equirectMipLevelCount(this.targets?.equirectWidth ?? 0) - 1;
  }

  /** Exposure shared by the background and the PBR shading. */
  get exposure(): number {
    return this.settings.exposure;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  setBlur(blur: number): void {
    const next = clamp01(blur);
    if (next === this.settings.blur) return;
    this.settings = { ...this.settings, blur: next };
    saveEnvironmentSettings(this.settings);
    // The blur and the exposure are read when the background is drawn, so
    // nothing has to be rebuilt — the views just need to redraw.
    this.notify();
  }

  /** Tone mapping operator for the background and the PBR pass. */
  get tonemap(): TonemapMode {
    return this.settings.tonemap;
  }

  setTonemap(mode: TonemapMode): void {
    if (mode === this.settings.tonemap) return;
    this.settings = { ...this.settings, tonemap: mode };
    saveEnvironmentSettings(this.settings);
    // The operators are all compiled into the shaders and picked by a uniform,
    // so nothing is rebuilt — the views only have to redraw.
    this.notify();
  }

  setExposure(exposure: number): void {
    const next = clampExposure(exposure);
    if (next === this.settings.exposure) return;
    this.settings = { ...this.settings, exposure: next };
    saveEnvironmentSettings(this.settings);
    this.notify();
  }

  /**
   * Remember the mode for viewports opened later. Deliberately does not notify:
   * this is not a change to the environment's textures, and waking every
   * renderer to rebuild bind groups for it would be waste.
   */
  rememberShadingMode(mode: ShadingMode): void {
    if (this.settings.shading === mode) return;
    this.settings = { ...this.settings, shading: mode };
    saveEnvironmentSettings(this.settings);
  }

  setBackgroundVisible(visible: boolean): void {
    if (visible === this.settings.background) return;
    this.settings = { ...this.settings, background: visible };
    saveEnvironmentSettings(this.settings);
    this.notify();
  }

  /** Load an HDRI from `hdri/`, or clear the environment with null. */
  async setHdri(file: string | null): Promise<void> {
    if (file === this.settings.hdri && this.targets) return;
    this.settings = { ...this.settings, hdri: file };
    saveEnvironmentSettings(this.settings);
    const token = ++this.loadToken;
    const run = (async () => {
      let targets: RenderTargets;
      try {
        targets = file ? await this.build(`/hdri/${encodeURIComponent(file)}`) : this.buildNeutral();
      } catch (error) {
        // Never leave PBR without a probe: a broken file falls back to the
        // neutral studio, and the caller still gets the error to report.
        this.applyTargets(token, this.buildNeutral());
        throw error;
      }
      this.applyTargets(token, targets);
    })().finally(() => {
      if (token === this.loadToken) this.loading = null;
    });
    this.loading = run;
    await run;
  }

  /** Adopt a freshly built set of maps unless a newer request has superseded it. */
  private applyTargets(token: number, targets: RenderTargets): void {
    if (token !== this.loadToken) {
      this.disposeTargets(targets);
      return;
    }
    const previous = this.targets;
    this.targets = targets;
    this.notify();
    this.disposeTargets(previous);
  }

  /** Resolves when any in-flight HDRI build has finished. */
  whenIdle(): Promise<void> {
    return this.loading ?? Promise.resolve();
  }

  private async build(url: string): Promise<RenderTargets> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
    return this.buildFromEquirect(decodeExr(await res.arrayBuffer()));
  }

  /**
   * No HDRI picked: a procedural studio gradient. PBR still needs a light
   * probe, so the mode never silently degrades to simple shading.
   */
  private buildNeutral(): RenderTargets {
    return this.buildFromEquirect(NEUTRAL_EQUIRECT());
  }

  /** Every pass after the equirect exists, so both sources share one path. */
  private buildFromEquirect(decoded: ExrImage): RenderTargets {
    const device = this.device;
    // A 1k night HDRI can hold a lamp at 4e5, which half float rounds to Inf and
    // then poisons the whole probe with NaN. Sanitise once, here.
    clampToHalfRange(decoded.data);
    const halves = floatsToHalves(
      decoded.data,
      new Uint16Array(decoded.width * decoded.height * 4)
    );
    // The background's blur *is* this mip chain, so build the whole thing.
    const mipLevelCount = equirectMipLevelCount(decoded.width);
    const equirect = device.createTexture({
      label: 'hdri equirect',
      size: { width: decoded.width, height: decoded.height },
      mipLevelCount,
      format: 'rgba16float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: equirect },
      // A plain ArrayBuffer view: `ArrayBufferLike` may be shared, which
      // writeTexture does not accept.
      new Uint8Array(halves.buffer as ArrayBuffer),
      { bytesPerRow: decoded.width * 8, rowsPerImage: decoded.height },
      { width: decoded.width, height: decoded.height }
    );
    this.buildEquirectMips(equirect, mipLevelCount, decoded.width, decoded.height);

    const cubemap = device.createTexture({
      label: 'hdri cubemap',
      size: { width: CUBEMAP_SIZE, height: CUBEMAP_SIZE, depthOrArrayLayers: 6 },
      format: 'rgba16float',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_DST,
    });
    const irradiance = device.createTexture({
      label: 'hdri irradiance',
      size: { width: IRRADIANCE_SIZE, height: IRRADIANCE_SIZE, depthOrArrayLayers: 6 },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const prefilter = device.createTexture({
      label: 'hdri prefilter',
      size: { width: PREFILTER_SIZE, height: PREFILTER_SIZE, depthOrArrayLayers: 6 },
      mipLevelCount: PREFILTER_LEVELS,
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const brdf = device.createTexture({
      label: 'brdf lut',
      size: { width: BRDF_SIZE, height: BRDF_SIZE },
      format: 'rg16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.drawFaces(cubemap, {
      pipeline: this.capturePipeline,
      size: CUBEMAP_SIZE,
      mipLevel: 0,
      bindGroup: (layout) =>
        device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: this.prefilterUniform } },
            { binding: 1, resource: equirect.createView() },
            { binding: 2, resource: this.sampler },
          ],
        }),
      useCubeGeometry: true,
    });

    const sourceView = () => cubemap.createView({ dimension: 'cube' });
    this.drawFaces(irradiance, {
      pipeline: this.irradiancePipeline,
      size: IRRADIANCE_SIZE,
      mipLevel: 0,
      bindGroup: (layout) =>
        device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: this.prefilterUniform } },
            { binding: 1, resource: sourceView() },
            { binding: 2, resource: this.cubeSampler },
          ],
        }),
      useCubeGeometry: true,
    });

    for (let level = 0; level < PREFILTER_LEVELS; level++) {
      const size = Math.max(1, PREFILTER_SIZE >> level);
      const roughness = level / MAX_REFLECTION_LOD;
      this.drawFaces(prefilter, {
        pipeline: this.prefilterPipeline,
        size,
        mipLevel: level,
        roughness,
        bindGroup: (layout) =>
          device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { buffer: this.prefilterUniform } },
              { binding: 1, resource: sourceView() },
              { binding: 2, resource: this.cubeSampler },
            ],
          }),
        useCubeGeometry: true,
      });
    }

    this.drawQuad(brdf, this.brdfPipeline, (layout) =>
      device.createBindGroup({ layout, entries: [] })
    );

    return {
      equirect,
      equirectWidth: decoded.width,
      cubemap,
      irradiance,
      prefilter,
      brdf,
      equirectView: equirect.createView(),
      irradianceView: irradiance.createView({ dimension: 'cube' }),
      prefilterView: prefilter.createView({ dimension: 'cube', mipLevelCount: PREFILTER_LEVELS }),
      brdfView: brdf.createView(),
    };
  }

  /**
   * Downsample the latlong image one level at a time. Cheap and one-off: the
   * result is what the background's blur control reads, so no frame pays for it.
   */
  private buildEquirectMips(
    equirect: GPUTexture,
    mipLevelCount: number,
    width: number,
    height: number
  ): void {
    if (mipLevelCount <= 1) return;
    const params = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    for (let level = 1; level < mipLevelCount; level++) {
      const sourceWidth = Math.max(1, width >> (level - 1));
      this.device.queue.writeBuffer(params, 0, new Float32Array([1 / sourceWidth]));
      this.drawQuad(
        equirect,
        this.equirectMipPipeline,
        (layout) =>
          this.device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { buffer: params } },
              {
                binding: 1,
                resource: equirect.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
              },
              { binding: 2, resource: this.backgroundSampler },
            ],
          }),
        level
      );
    }
    params.destroy();
  }

  /** Render the six cube faces into `target`, one pass per face. */
  private drawFaces(
    target: GPUTexture,
    opts: {
      pipeline: GPURenderPipeline;
      size: number;
      mipLevel: number;
      roughness?: number;
      bindGroup: (layout: GPUBindGroupLayout) => GPUBindGroup;
      useCubeGeometry: boolean;
    }
  ): void {
    const device = this.device;
    const depth = device.createTexture({
      size: { width: opts.size, height: opts.size },
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const depthView = depth.createView();
    const layout = opts.pipeline.getBindGroupLayout(0);
    const bindGroup = opts.bindGroup(layout);
    const uniforms = new Float32Array(20);

    const encoder = device.createCommandEncoder();
    for (let face = 0; face < 6; face++) {
      uniforms.set(cubeFaceViewProjection(face) as unknown as ArrayLike<number>, 0);
      uniforms[16] = opts.roughness ?? 0;
      device.queue.writeBuffer(this.prefilterUniform, 0, uniforms);

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target.createView({
              baseArrayLayer: face,
              arrayLayerCount: 1,
              baseMipLevel: opts.mipLevel,
              mipLevelCount: 1,
            }),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(opts.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, this.cubeVertices);
      pass.draw(CUBE_VERTEX_COUNT);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
    depth.destroy();
  }

  /** Render the BRDF LUT: one full-screen quad, no inputs. */
  private drawQuad(
    target: GPUTexture,
    pipeline: GPURenderPipeline,
    bindGroupFor: (layout: GPUBindGroupLayout) => GPUBindGroup,
    mipLevel = 0
  ): void {
    const device = this.device;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView({ baseMipLevel: mipLevel, mipLevelCount: 1 }),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroupFor(pipeline.getBindGroupLayout(0)));
    pass.setVertexBuffer(0, this.quadVertices);
    pass.draw(6);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.disposeTargets(this.targets);
    this.targets = null;
    this.cubeVertices.destroy();
    this.quadVertices.destroy();
    this.prefilterUniform.destroy();
    this.listeners.clear();
  }

  private disposeTargets(targets: RenderTargets | null): void {
    if (!targets) return;
    targets.equirect.destroy();
    targets.cubemap.destroy();
    targets.irradiance.destroy();
    targets.prefilter.destroy();
    targets.brdf.destroy();
  }
}

/** The largest roughness level a PBR shader may ask the prefilter map for. */
export const PREFILTER_MAX_LOD = MAX_REFLECTION_LOD;

/**
 * Cube corners for the six capture faces, in the order WebGPU lays out cube
 * array layers (+X -X +Y -Y +Z -Z). Six vertices per face, no index buffer —
 * 36 vec4 positions, drawn with a single `draw(36)`.
 */
function cubeFaceVertices(axis: 0 | 1 | 2, sign: 1 | -1): number[] {
  // The two axes spanning the face, in an order that keeps the winding outward.
  const other: number[] = [0, 1, 2].filter((a) => a !== axis);
  const [u, v] = other as [number, number];
  const corner = (su: number, sv: number): number[] => {
    const p = [0, 0, 0, 1];
    p[axis] = sign;
    p[u] = su;
    p[v] = sv;
    return p;
  };
  return [
    ...corner(-1, -1), ...corner(1, -1), ...corner(1, 1),
    ...corner(-1, -1), ...corner(1, 1), ...corner(-1, 1),
  ];
}

const CUBE_VERTICES = new Float32Array([
  ...cubeFaceVertices(0, 1),
  ...cubeFaceVertices(0, -1),
  ...cubeFaceVertices(1, 1),
  ...cubeFaceVertices(1, -1),
  ...cubeFaceVertices(2, 1),
  ...cubeFaceVertices(2, -1),
]);
const CUBE_VERTEX_COUNT = CUBE_VERTICES.length / 4;

const QUAD_VERTICES = new Float32Array([
  -1, -1, 0, 0, 0,
  1, -1, 0, 1, 0,
  1, 1, 0, 1, 1,
  -1, -1, 0, 0, 0,
  1, 1, 0, 1, 1,
  -1, 1, 0, 0, 1,
]);
