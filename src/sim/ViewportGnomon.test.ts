import { describe, expect, it } from 'vitest';
import { Camera } from '../Camera';
import { ViewportGnomon, type GnomonCallbacks } from './ViewportGnomon';
import { cameraBasis } from './axisScreen';

/** Gnomon viewBox geometry, mirrored from the widget. */
const SIZE = 84;
const CX = SIZE / 2;
const CY = SIZE / 2 - 4;

function cameraAt(azimuth: number, incline: number, orthographic = false): Camera {
  const camera = new Camera();
  camera.setAspect(1.5);
  camera.setAzimuth(azimuth);
  camera.setIncline(incline);
  if (orthographic) camera.setOrthographic(true);
  camera.update();
  return camera;
}

function gnomon(): { host: HTMLElement; g: ViewportGnomon } {
  const host = document.createElement('div');
  const cbs: GnomonCallbacks = { onOrbit: () => {}, onAxisClick: () => {}, onToggleProjection: () => {} };
  return { host, g: new ViewportGnomon(host, cbs) };
}

/** Screen position of an axis arm, read back off the drawn line. */
function ball(host: HTMLElement, axis: string): { x: number; y: number } {
  const line = host.querySelector(`line[data-axis="${axis}"]`) as SVGLineElement;
  return { x: Number(line.getAttribute('x2')), y: Number(line.getAttribute('y2')) };
}

/** Arms in the order they were drawn: farthest first. */
function drawOrder(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('line')).map((l) => (l as SVGLineElement).dataset.axis ?? '');
}

describe('ViewportGnomon', () => {
  it('lays the X/Y/Z arms along the world axes the camera shows', () => {
    for (const [az, inc] of [
      [0, 0],
      [35, 20],
      [-60, 35],
      [120, -25],
    ]) {
      const { host, g } = gnomon();
      const camera = cameraAt(az, inc);
      g.syncFromCamera(camera);
      const basis = cameraBasis(camera.getViewProjectMtx());
      for (const [axis, world] of [
        ['x', [1, 0, 0]],
        ['y', [0, 1, 0]],
        ['z', [0, 0, 1]],
      ] as const) {
        const expected = {
          cx: basis.right[0] * world[0] + basis.right[1] * world[1] + basis.right[2] * world[2],
          cy: basis.up[0] * world[0] + basis.up[1] * world[1] + basis.up[2] * world[2],
        };
        const drawn = ball(host, axis);
        const reach = Math.hypot(expected.cx, expected.cy) * 28;
        if (reach < 0.5) {
          expect(Math.hypot(drawn.x - CX, drawn.y - CY)).toBeLessThan(0.5);
          continue;
        }
        expect(drawn.x - CX).toBeCloseTo((expected.cx / Math.hypot(expected.cx, expected.cy)) * reach, 3);
        expect(drawn.y - CY).toBeCloseTo((-expected.cy / Math.hypot(expected.cx, expected.cy)) * reach, 3);
      }
    }
  });

  it('reads the front view the way the world does: X right, Y up, Z at the viewer', () => {
    const { host, g } = gnomon();
    g.syncFromCamera(cameraAt(0, 0));
    expect(ball(host, 'x').x).toBeCloseTo(CX + 28, 3);
    expect(ball(host, 'y').y).toBeCloseTo(CY - 28, 3);
    expect(ball(host, 'z')).toEqual({ x: CX, y: CY });
  });

  it('draws the axis nearest the viewer last', () => {
    const { host, g } = gnomon();
    // Tilted down: +Z leans at the viewer, -Z away from it, and both are long
    // enough on screen to tell apart.
    g.syncFromCamera(cameraAt(0, 20));
    const order = drawOrder(host);
    expect(order.indexOf('z')).toBeGreaterThan(order.indexOf('-z'));
    expect(ball(host, 'z').y).toBeGreaterThan(CY);
    expect(ball(host, '-z').y).toBeLessThan(CY);
  });

  it('keeps the projection button and the axes in step with the camera', () => {
    const { host, g } = gnomon();
    g.syncFromCamera(cameraAt(0, 20, true));
    const btn = host.querySelector('.gnomon-proj-btn') as HTMLButtonElement;
    expect(btn.textContent).toBe('Ortho');
    // Orthographic axes still sit on the world axes.
    expect(ball(host, 'x').x).toBeGreaterThan(CX);
    expect(ball(host, 'y').y).toBeLessThan(CY);
  });
});
