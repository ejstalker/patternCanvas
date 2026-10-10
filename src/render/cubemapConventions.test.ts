/**
 * The latlong -> cubemap capture has to agree with the cube-map face selection
 * the GPU uses when the result is sampled again (WebGPU/D3D convention: the
 * first row of a face is the top, and +X face texels run toward -Z with v
 * increasing downward). Getting this wrong renders the environment upside down
 * or mirrored, which is easy to miss by eye, so it is checked numerically here:
 * the test replays the capture for every texel of every face and then asks the
 * hardware convention for the texel a given direction reads.
 */
import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { FACE_TARGETS } from './environment';
import { latlongUv } from './latlong';

const FACE_SIZE = 32;

/** A smooth stand-in for an HDRI: different in every direction. */
function environment(direction: readonly [number, number, number]): [number, number, number] {
  const [x, y, z] = direction;
  return [(x + 1) / 2, (y + 1) / 2, (z + 1) / 2];
}

/** What the capture writes into layer `face`, texel (column, row), row 0 on top. */
function captureTexel(face: number, column: number, row: number): [number, number, number] {
  const [target, up] = FACE_TARGETS[face]!;
  const view = mat4.create();
  mat4.lookAt(view, vec3.create(), target, up);
  // gl-matrix is column-major: the camera basis is read down the columns.
  const right = vec3.fromValues(view[0]!, view[4]!, view[8]!);
  const cameraUp = vec3.fromValues(view[1]!, view[5]!, view[9]!);
  const back = vec3.fromValues(view[2]!, view[6]!, view[10]!);

  // 90 degree vertical fov, 1:1 aspect, so tan(fov / 2) is 1. The capture
  // renders through CUBE_FLIP_Y, which turns the ray's vertical component
  // around: texel row 0 is the top of the layer and comes from clip y = -1.
  const ndcX = (2 * (column + 0.5)) / FACE_SIZE - 1;
  const ndcY = (2 * (row + 0.5)) / FACE_SIZE - 1;
  const ray = vec3.create();
  vec3.scaleAndAdd(ray, ray, right, ndcX);
  vec3.scaleAndAdd(ray, ray, cameraUp, ndcY);
  vec3.scaleAndAdd(ray, ray, back, -1);

  // The fragment shader interpolates the cube vertex position, i.e. where the
  // ray meets the face plane (the face sits one unit out along its axis).
  const denom = vec3.dot(ray, target);
  const distance = 1 / denom;
  const hit = vec3.scale(vec3.create(), ray, distance);
  vec3.normalize(hit, hit);
  return environment([hit[0]!, hit[1]!, hit[2]!]);
}

/** WebGPU cube-map face selection: direction -> layer, u, v (v = 0 is the top row). */
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

const DIRECTIONS: Array<[number, number, number]> = [];
for (let y = -8; y <= 8; y++) {
  for (let x = -8; x <= 8; x++) {
    for (const zSign of [-1, 1]) {
      // Keep directions off the face borders, where texel rounding is unfair.
      DIRECTIONS.push([x / 8, y / 8, zSign * 0.5]);
    }
  }
}

describe('cubemap capture conventions', () => {
  it('stores every direction where the GPU sampler expects to read it', () => {
    const faces: Array<Array<[number, number, number]>> = [];
    for (let face = 0; face < 6; face++) {
      const texels: Array<[number, number, number]> = [];
      for (let row = 0; row < FACE_SIZE; row++) {
        for (let column = 0; column < FACE_SIZE; column++) {
          texels.push(captureTexel(face, column, row));
        }
      }
      faces.push(texels);
    }

    let checked = 0;
    const failures: string[] = [];
    for (const direction of DIRECTIONS) {
      const length = Math.hypot(...direction);
      const unit: [number, number, number] = [
        direction[0] / length,
        direction[1] / length,
        direction[2] / length,
      ];
      // Skip directions that fall on a face seam: the hardware tie-break there
      // is not what this test is about.
      const { face, u, v } = selectFace(unit);
      if (u < 0.05 || u > 0.95 || v < 0.05 || v > 0.95) continue;

      const column = Math.min(FACE_SIZE - 1, Math.floor(u * FACE_SIZE));
      const row = Math.min(FACE_SIZE - 1, Math.floor(v * FACE_SIZE));
      const stored = faces[face]![row * FACE_SIZE + column]!;
      const expected = environment(unit);
      checked++;
      const error = Math.max(
        Math.abs(stored[0] - expected[0]),
        Math.abs(stored[1] - expected[1]),
        Math.abs(stored[2] - expected[2])
      );
      // One texel of a 32x32 face spans ~0.06 in this smooth environment.
      if (error > 0.09) {
        failures.push(
          `face ${face} uv(${u.toFixed(2)},${v.toFixed(2)}) dir(${unit.map((c) => c.toFixed(2)).join(',')}) got ${stored.map((c) => c.toFixed(2)).join(',')} want ${expected.map((c) => c.toFixed(2)).join(',')}`
        );
      }
    }

    expect(checked).toBeGreaterThan(400);
    expect(failures.slice(0, 6)).toEqual([]);
  });

  it('keeps the latlong mapping upright (zenith on the first row)', () => {
    const [, vUp] = latlongUv([0, 1, 0]);
    const [, vDown] = latlongUv([0, -1, 0]);
    const [, vHorizon] = latlongUv([1, 0, 0]);
    expect(vUp).toBeCloseTo(0, 6);
    expect(vHorizon).toBeCloseTo(0.5, 6);
    expect(vDown).toBeCloseTo(1, 6);
  });
});
