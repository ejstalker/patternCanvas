import { describe, expect, it } from 'vitest';
import { mat4, vec3, vec4 } from 'gl-matrix';
import { Camera } from '../Camera';
import { cameraBasis, pointAxisDirections, viewAxisDirections } from './axisScreen';
import { axisViewAngles, type AxisId } from './ViewportGnomon';

const VIEWS: Array<[azimuth: number, incline: number, ortho?: boolean]> = [
  [0, 0],
  [0, 20],
  [35, 20],
  [-60, 35],
  [120, -25],
  [35, 20, true],
];

function cameraAt(azimuth: number, incline: number, orthographic = false, aspect = 1.5): Camera {
  const camera = new Camera();
  camera.setAspect(aspect);
  camera.setAzimuth(azimuth);
  camera.setIncline(incline);
  if (orthographic) camera.setOrthographic(true);
  camera.update();
  return camera;
}

/** A world point from an NDC point — independent of the module under test. */
function unproject(camera: Camera, ndc: [number, number, number]): vec3 {
  const inv = mat4.create();
  mat4.invert(inv, camera.getViewProjectMtx());
  const p = vec4.fromValues(ndc[0], ndc[1], ndc[2], 1);
  vec4.transformMat4(p, p, inv);
  return vec3.fromValues(p[0] / p[3], p[1] / p[3], p[2] / p[3]);
}

/** Screen position of a world point in CSS px, straight from the matrix. */
function project(camera: Camera, p: vec3, width: number, height: number): { x: number; y: number } {
  const clip = vec4.fromValues(p[0], p[1], p[2], 1);
  vec4.transformMat4(clip, clip, camera.getViewProjectMtx());
  return {
    x: (clip[0] / clip[3] / 2 + 0.5) * width,
    y: (-clip[1] / clip[3] / 2 + 0.5) * height,
  };
}

function unit(v: vec3): vec3 {
  const out = vec3.create();
  vec3.normalize(out, v);
  return out;
}

function delta(a: vec3, b: vec3): vec3 {
  const out = vec3.create();
  vec3.sub(out, a, b);
  return out;
}

function angleBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const al = Math.hypot(a.x, a.y);
  const bl = Math.hypot(b.x, b.y);
  if (al < 1e-9 || bl < 1e-9) return 0;
  const dot = (a.x * b.x + a.y * b.y) / (al * bl);
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

function angle3(a: vec3, b: vec3): number {
  const dot = vec3.dot(a, b) / (vec3.length(a) * vec3.length(b));
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

describe('cameraBasis', () => {
  it('reads the camera right/up/forward back out of the matrix', () => {
    for (const [az, inc, ortho] of VIEWS) {
      const camera = cameraAt(az, inc, ortho);
      const basis = cameraBasis(camera.getViewProjectMtx());
      // Ground truth: the near-plane ray directions at the view centre.
      const right = unit(delta(unproject(camera, [1, 0, 0.0001]), unproject(camera, [0, 0, 0.0001])));
      const up = unit(delta(unproject(camera, [0, 1, 0.0001]), unproject(camera, [0, 0, 0.0001])));
      const forward = unit(delta(unproject(camera, [0, 0, 1]), unproject(camera, [0, 0, 0])));
      expect(angle3(basis.right, right)).toBeLessThan(1);
      expect(angle3(basis.up, up)).toBeLessThan(1);
      expect(angle3(basis.forward, forward)).toBeLessThan(1);
    }
  });

  it('keeps the three axes orthonormal', () => {
    const basis = cameraBasis(cameraAt(35, 20).getViewProjectMtx());
    expect(vec3.length(basis.right)).toBeCloseTo(1, 6);
    expect(vec3.length(basis.up)).toBeCloseTo(1, 6);
    expect(vec3.length(basis.forward)).toBeCloseTo(1, 6);
    expect(Math.abs(vec3.dot(basis.right, basis.up))).toBeLessThan(1e-6);
    expect(Math.abs(vec3.dot(basis.right, basis.forward))).toBeLessThan(1e-6);
  });
});

describe('viewAxisDirections', () => {
  it('points each world axis along the camera basis', () => {
    for (const [az, inc, ortho] of VIEWS) {
      const camera = cameraAt(az, inc, ortho);
      const basis = cameraBasis(camera.getViewProjectMtx());
      const dirs = viewAxisDirections(camera.getViewProjectMtx());
      for (const [axis, world] of [
        ['x', [1, 0, 0]],
        ['y', [0, 1, 0]],
        ['z', [0, 0, 1]],
      ] as const) {
        const expected = {
          x: basis.right[0] * world[0] + basis.right[1] * world[1] + basis.right[2] * world[2],
          y: -(
            basis.up[0] * world[0] +
            basis.up[1] * world[1] +
            basis.up[2] * world[2]
          ),
        };
        const d = dirs[axis];
        if (Math.hypot(expected.x, expected.y) < 1e-6) {
          expect(d.foreshorten).toBeCloseTo(0, 6);
          continue;
        }
        expect(angleBetween({ x: d.x, y: d.y }, expected)).toBeLessThan(1e-6);
        expect(d.foreshorten).toBeCloseTo(Math.hypot(expected.x, expected.y), 6);
      }
    }
  });

  it('collapses the axis a snapped view looks along', () => {
    for (const id of ['x', '-x', 'y', '-y', 'z', '-z'] as AxisId[]) {
      const angles = axisViewAngles(id);
      const dirs = viewAxisDirections(cameraAt(angles.azimuth, angles.incline).getViewProjectMtx());
      const key = (id.startsWith('-') ? id.slice(1) : id) as 'x' | 'y' | 'z';
      const others = (['x', 'y', 'z'] as const).filter((k) => k !== key);
      expect(dirs[key].foreshorten).toBeLessThan(0.02);
      for (const other of others) expect(dirs[other].foreshorten).toBeGreaterThan(0.99);
    }
  });

  it('marks the near axis as the nearest', () => {
    const dirs = viewAxisDirections(cameraAt(0, 0).getViewProjectMtx());
    // Looking along -Z: +Z comes at the viewer, -Z goes away, X/Y lie across.
    expect(dirs.z.depth).toBeGreaterThan(dirs.x.depth);
    expect(dirs.z.depth).toBeGreaterThan(dirs.y.depth);
    expect(dirs.x.depth).toBeCloseTo(0, 6);
  });
});

describe('pointAxisDirections', () => {
  // Matches the camera's aspect: pixel directions are only comparable to the
  // projection's when the viewport is the one the camera was set up for.
  const width = 900;
  const height = 600;

  it('follows the axes as the matrix projects them from that point', () => {
    for (const [az, inc, ortho] of VIEWS) {
      const camera = cameraAt(az, inc, ortho);
      const vp = camera.getViewProjectMtx();
      for (const origin of [vec3.fromValues(0, 6, 0), vec3.fromValues(1.5, 3, -2), vec3.fromValues(-4, 12, 3)]) {
        const dirs = pointAxisDirections(vp, origin, width, height);
        const o = project(camera, origin, width, height);
        for (const [axis, world] of [
          ['x', [1, 0, 0]],
          ['y', [0, 1, 0]],
          ['z', [0, 0, 1]],
        ] as const) {
          const end = project(
            camera,
            vec3.fromValues(origin[0] + world[0], origin[1] + world[1], origin[2] + world[2]),
            width,
            height
          );
          const truth = { x: end.x - o.x, y: end.y - o.y };
          const d = dirs[axis];
          // An axis pointing at the camera has no direction worth reading: it
          // still sweeps the screen from an off-centre point, but along no
          // consistent line, so only the axes with a direction get compared.
          if (d.foreshorten > 0.05) {
            expect(angleBetween({ x: d.x, y: d.y }, truth)).toBeLessThan(1);
          }
          expect(d.foreshorten).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('shortens an axis the more it points at the camera', () => {
    // Front view: Z runs at the viewer and collapses, X stays full length.
    const front = pointAxisDirections(cameraAt(0, 0).getViewProjectMtx(), vec3.fromValues(0, 0, 0), width, height);
    expect(front.z.foreshorten).toBeLessThan(0.02);
    expect(front.x.foreshorten).toBeCloseTo(1, 5);
    expect(front.y.foreshorten).toBeCloseTo(1, 5);

    // Tilted down: Y leans away, so it draws shorter than X.
    const tilted = pointAxisDirections(cameraAt(0, 60).getViewProjectMtx(), vec3.fromValues(0, 0, 0), width, height);
    expect(tilted.y.foreshorten).toBeLessThan(tilted.x.foreshorten);
    expect(tilted.y.foreshorten).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 3);
  });

  it('agrees with the view-only reading at the view centre', () => {
    const camera = cameraAt(35, 20);
    const vp = camera.getViewProjectMtx();
    // The camera orbits the world origin, so that is the point the view
    // reading is drawn for.
    const scene = pointAxisDirections(vp, vec3.fromValues(0, 0, 0), width, height);
    const view = viewAxisDirections(vp);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(angleBetween(scene[axis], view[axis])).toBeLessThan(1);
      expect(scene[axis].foreshorten).toBeCloseTo(view[axis].foreshorten, 2);
    }
  });

  it('bends away from the view reading off centre, as the axes do', () => {
    const camera = cameraAt(35, 20);
    const vp = camera.getViewProjectMtx();
    const scene = pointAxisDirections(vp, vec3.fromValues(0, 6, 0), width, height);
    const view = viewAxisDirections(vp);
    const off = (['x', 'y', 'z'] as const).map((axis) => angleBetween(scene[axis], view[axis]));
    // Perspective convergence at an off-centre point is exactly what an
    // euler-only reading misses, so at least one axis has to move.
    expect(Math.max(...off)).toBeGreaterThan(5);
  });
});
