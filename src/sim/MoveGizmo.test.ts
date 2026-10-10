import { describe, expect, it } from 'vitest';
import { vec3, vec4 } from 'gl-matrix';
import { Camera } from '../Camera';
import { MoveGizmo, type MoveGizmoCallbacks } from './MoveGizmo';
import { pointAxisDirections } from './axisScreen';

const WIDTH = 900;
const HEIGHT = 600;

function cameraAt(azimuth: number, incline: number, orthographic = false): Camera {
  const camera = new Camera();
  camera.setAspect(WIDTH / HEIGHT);
  camera.setAzimuth(azimuth);
  camera.setIncline(incline);
  if (orthographic) camera.setOrthographic(true);
  camera.update();
  return camera;
}

function gizmo(): { host: HTMLElement; g: MoveGizmo; cbs: MoveGizmoCallbacks } {
  const host = document.createElement('div');
  const cbs: MoveGizmoCallbacks = { onDragStart: () => {}, onDrag: () => {}, onDragEnd: () => {} };
  return { host, g: new MoveGizmo(host, cbs), cbs };
}

function arrow(host: HTMLElement, axis: 'x' | 'y' | 'z'): { x: number; y: number; hidden: boolean } {
  const g = host.querySelector(`g[data-axis="${axis}"]`) as SVGGElement;
  const line = g.querySelector('line') as SVGLineElement;
  return {
    x: Number(line.getAttribute('x2')),
    y: Number(line.getAttribute('y2')),
    hidden: (g as SVGGElement).style.display === 'none',
  };
}

/** Screen position of a world point, straight from the camera's matrix. */
function project(camera: Camera, p: vec3): { x: number; y: number } {
  const clip = vec4.fromValues(p[0], p[1], p[2], 1);
  vec4.transformMat4(clip, clip, camera.getViewProjectMtx());
  return {
    x: (clip[0] / clip[3] / 2 + 0.5) * WIDTH,
    y: (-clip[1] / clip[3] / 2 + 0.5) * HEIGHT,
  };
}

describe('MoveGizmo axis layout', () => {
  it('draws each arrow along the world axis it projects from the gizmo', () => {
    const { host, g } = gizmo();
    for (const [az, inc] of [
      [0, 20],
      [35, 20],
      [-120, 35],
    ]) {
      const camera = cameraAt(az, inc);
      const origin = vec3.fromValues(0.5, 6, -1);
      g.updateAxisLayout({ camera, origin, width: WIDTH, height: HEIGHT });
      const o = project(camera, origin);
      for (const [axis, world] of [
        ['x', [1, 0, 0]],
        ['y', [0, 1, 0]],
        ['z', [0, 0, 1]],
      ] as const) {
        const drawn = arrow(host, axis);
        const end = project(camera, vec3.fromValues(origin[0] + world[0], origin[1] + world[1], origin[2] + world[2]));
        // Same line: the drawn arrow and the projected axis segment are parallel.
        const cross = drawn.x * (end.y - o.y) - drawn.y * (end.x - o.x);
        expect(Math.abs(cross)).toBeLessThan(1e-3 * Math.hypot(drawn.x, drawn.y) * Math.hypot(end.x - o.x, end.y - o.y));
        const expected = pointAxisDirections(camera.getViewProjectMtx(), origin, WIDTH, HEIGHT)[axis];
        expect(drawn.hidden).toBe(expected.foreshorten < 0.06);
        expect(Math.hypot(drawn.x, drawn.y)).toBeCloseTo(42 * expected.foreshorten, 3);
      }
    }
  });

  it('hides the axis the camera is looking along', () => {
    const { host, g } = gizmo();
    const camera = cameraAt(0, 0);
    g.updateAxisLayout({ camera, origin: vec3.fromValues(0, 0, 0), width: WIDTH, height: HEIGHT });
    expect(arrow(host, 'z').hidden).toBe(true);
    expect(arrow(host, 'x').hidden).toBe(false);
    expect(arrow(host, 'y').hidden).toBe(false);
    expect(arrow(host, 'x').x).toBeCloseTo(42, 3);
    expect(arrow(host, 'y').y).toBeCloseTo(-42, 3);
  });

  it('turns the arrows with the camera, in world terms', () => {
    const { host, g } = gizmo();
    const origin = vec3.fromValues(0, 3, 0);
    g.updateAxisLayout({ camera: cameraAt(0, 0), origin, width: WIDTH, height: HEIGHT });
    const before = arrow(host, 'x');
    g.updateAxisLayout({ camera: cameraAt(90, 0), origin, width: WIDTH, height: HEIGHT });
    const x = arrow(host, 'x');
    const z = arrow(host, 'z');
    // Front view: X runs to the right. Quarter turn to the -X side view: X comes
    // at the viewer and Z takes over the screen, still to the right.
    expect(before.x).toBeCloseTo(42, 3);
    expect(x.hidden).toBe(true);
    expect(z.x).toBeCloseTo(42, 3);
  });

  it('carries the tips and the rotate bubbles onto the same arrows', () => {
    const { host, g } = gizmo();
    const origin = vec3.fromValues(0, 4, 0);
    g.updateAxisLayout({ camera: cameraAt(35, 20), origin, width: WIDTH, height: HEIGHT });
    for (const axis of ['x', 'y', 'z'] as const) {
      const drawn = arrow(host, axis);
      const gEl = host.querySelector(`g[data-axis="${axis}"]`) as SVGGElement;
      const tip = (gEl.querySelector('polygon') as SVGPolygonElement).getAttribute('points')!.split(' ')[0];
      const [tx, ty] = tip.split(',').map(Number);
      expect(tx).toBeCloseTo(drawn.x, 2);
      expect(ty).toBeCloseTo(drawn.y, 2);
    }

    const rotate = gizmo();
    rotate.g.setMode('rotate');
    rotate.g.updateAxisLayout({ camera: cameraAt(35, 20), origin, width: WIDTH, height: HEIGHT });
    for (const axis of ['x', 'y', 'z'] as const) {
      const drawn = arrow(rotate.host, axis);
      const circle = rotate.host.querySelector(`g[data-axis="${axis}"] circle`) as SVGCircleElement;
      expect(Number(circle.getAttribute('cx'))).toBeCloseTo(drawn.x, 2);
      expect(Number(circle.getAttribute('cy'))).toBeCloseTo(drawn.y, 2);
    }
  });
});
