/**
 * The HDRI is a latlong (`texture_2d`) image everywhere it is read, and every
 * reader unwraps it the same way.
 *
 * There are two readers — the capture that bakes the light-probe cubemap used by
 * the PBR shader, and the skybox that paints the background — and they render
 * through different paths: the background unprojects a pixel to a world
 * direction and samples the image directly, while the capture renders a cube and
 * relies on the hardware face selection to find those texels again. So this test
 * replays the whole chain in software: for a direction, find the cube texel the
 * GPU sampler picks, work out which direction the capture wrote into it, unwrap
 * that, and check it matches the background for the same direction.
 *
 * The two halves of that chain have to agree, because a sign error here lights
 * the cloth from the wrong hemisphere while the sky above it still looks right.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mat4, vec3, vec4 } from 'gl-matrix';
import { FACE_TARGETS, cubeFaceViewProjection } from './environment';
import { LATLONG_WGSL, latlongUv } from './latlong';

const FACE_SIZE = 64;

/** WebGPU cube face selection: direction -> layer, u, v (v = 0 is the top row). */
function selectFace(direction: readonly [number, number, number]) {
  const [rx, ry, rz] = direction;
  const ax = Math.abs(rx);
  const ay = Math.abs(ry);
  const az = Math.abs(rz);
  let face: number;
  let sc: number;
  let tc: number;
  if (ax >= ay && ax >= az) {
    face = rx >= 0 ? 0 : 1;
    sc = rx >= 0 ? -rz : rz;
    tc = -ry;
  } else if (ay >= ax && ay >= az) {
    face = ry >= 0 ? 2 : 3;
    sc = rx;
    tc = ry >= 0 ? rz : -rz;
  } else {
    face = rz >= 0 ? 4 : 5;
    sc = rz >= 0 ? rx : -rx;
    tc = -ry;
  }
  const ma = Math.max(ax, ay, az);
  return { face, u: 0.5 * (sc / ma + 1), v: 0.5 * (tc / ma + 1) };
}

/**
 * The direction the capture's fragment shader sees at texel (column, row).
 *
 * This unprojects through the very matrix the capture renders the face with, so
 * the camera, the projection and CUBE_FLIP_Y are the production ones rather than
 * a second copy of them. The fragment interpolates the cube vertex position, so
 * the direction is where the ray meets the face plane one unit out along the
 * face axis.
 */
function captureDirection(
  face: number,
  column: number,
  row: number
): [number, number, number] {
  const inverse = mat4.invert(mat4.create(), cubeFaceViewProjection(face))!;
  const ndcX = (2 * (column + 0.5)) / FACE_SIZE - 1;
  // Framebuffer row 0 is the top, i.e. clip y = +1.
  const ndcY = 1 - (2 * (row + 0.5)) / FACE_SIZE;
  const near = vec4.transformMat4(vec4.create(), vec4.fromValues(ndcX, ndcY, 0, 1), inverse);
  const far = vec4.transformMat4(vec4.create(), vec4.fromValues(ndcX, ndcY, 1, 1), inverse);
  const ray = vec3.create();
  for (let i = 0; i < 3; i++) ray[i] = far[i]! / far[3]! - near[i]! / near[3]!;
  vec3.normalize(ray, ray);

  const [target] = FACE_TARGETS[face]!;
  const hit = vec3.scale(vec3.create(), ray, 1 / Math.max(vec3.dot(ray, target), 1e-6));
  vec3.normalize(hit, hit);
  return [hit[0]!, hit[1]!, hit[2]!];
}

function unit(direction: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(...direction);
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

const DIRECTIONS: Array<[number, number, number]> = [];
for (let y = -8; y <= 8; y++) {
  for (let x = -8; x <= 8; x++) {
    for (const z of [-0.6, -0.25, 0.25, 0.6]) {
      DIRECTIONS.push(unit([x / 8, y / 8, z]));
    }
  }
}

describe('latlong unwrapping', () => {
  it('puts the zenith on the first row, matched to the HDRI files', () => {
    expect(latlongUv([0, 1, 0])[1]).toBeCloseTo(0, 6);
    expect(latlongUv([1, 0, 0])[1]).toBeCloseTo(0.5, 6);
    expect(latlongUv([0, -1, 0])[1]).toBeCloseTo(1, 6);
    // u wraps: +x is the middle of the image, -x lands on the seam at u = 1.
    expect(latlongUv([1, 0, 0])[0]).toBeCloseTo(0.5, 6);
    expect(latlongUv([-1, 0, 0])[0]).toBeCloseTo(1, 6);
    expect(latlongUv([0, 0, 1])[0]).toBeCloseTo(0.75, 6);
  });

  it('survives a zero direction', () => {
    const [u, v] = latlongUv([0, 0, 0]);
    expect(Number.isFinite(u)).toBe(true);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('lights the probe from the same hemisphere the skydome shows', () => {
    let checked = 0;
    const failures: string[] = [];
    for (const direction of DIRECTIONS) {
      const { face, u, v } = selectFace(direction);
      // Face seams and the poles are interpolation territory, not mapping.
      if (u < 0.05 || u > 0.95 || v < 0.05 || v > 0.95) continue;

      const column = Math.min(FACE_SIZE - 1, Math.floor(u * FACE_SIZE));
      const row = Math.min(FACE_SIZE - 1, Math.floor(v * FACE_SIZE));
      const [probeU, probeV] = latlongUv(captureDirection(face, column, row));
      const [skyU, skyV] = latlongUv(direction);
      checked++;

      const error = Math.max(Math.abs(probeU - skyU), Math.abs(probeV - skyV));
      // One texel of a 64x64 face is 1/64 of a uv unit; the ray and the
      // hardware texel it lands in can disagree by half of that.
      if (error > 1.5 / FACE_SIZE) {
        failures.push(
          `dir(${direction.map((c) => c.toFixed(2)).join(',')}) probe uv(${probeU.toFixed(3)},${probeV.toFixed(3)}) sky uv(${skyU.toFixed(3)},${skyV.toFixed(3)})`
        );
      }
    }

    expect(checked).toBeGreaterThan(800);
    expect(failures.slice(0, 6)).toEqual([]);
  });
});

describe('shader sources', () => {
  const root = resolve(process.cwd());

  function collect(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'dist') collect(path, out);
      } else if (/\.(ts|wgsl)$/.test(entry)) {
        out.push(path);
      }
    }
    return out;
  }

  const sources = collect(join(root, 'src')).filter(
    (path) => !path.endsWith('.test.ts') && !path.endsWith('latlong.ts')
  );

  it('defines the mapping in exactly one place', () => {
    for (const path of sources) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toMatch(/fn\s+(latlongUv|equirectUv)\s*\(/);
    }
    // ...and that place is latlong.ts, which interpolates its own block.
    expect(LATLONG_WGSL).toMatch(/fn latlongUv\(direction: vec3<f32>\)/);
    expect(LATLONG_WGSL).toMatch(/0\.5 - asin\(/);
  });

  it('has both HDRI readers use the shared block', () => {
    const environment = readFileSync(join(root, 'src/render/environment.ts'), 'utf8');
    const uses = environment.match(/\$\{LATLONG_WGSL\}/g) ?? [];
    // The capture pass and the skybox.
    expect(uses.length).toBe(2);
    expect(environment).not.toMatch(/texture_cube.*equirect|equirect.*texture_cube/);
  });
});
