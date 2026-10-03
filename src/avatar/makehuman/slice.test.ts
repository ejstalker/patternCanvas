import { describe, expect, it } from 'vitest';
import {
  arcCm,
  indexByMaxAbsX,
  indexByMaxZ,
  halfWidthCm,
  sliceAtY,
  surfaceAreaDm2,
  torsoLoop,
  frontApexes,
} from './slice';

/** Axis-aligned box centred on the origin: width (x) x height (y) x depth (z). */
function box(w: number, h: number, d: number) {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  const positions = new Float32Array([
    -x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z,
    -x, -y, z, x, -y, z, x, y, z, -x, y, z,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, // back (-z)
    4, 6, 5, 4, 7, 6, // front (+z)
    0, 3, 7, 0, 7, 4, // left
    1, 5, 6, 1, 6, 2, // right
    3, 2, 6, 3, 6, 7, // top
    0, 4, 5, 0, 5, 1, // bottom
  ]);
  return { positions, indices };
}

describe('sliceAtY', () => {
  it('recovers a rectangular cross-section', () => {
    const { positions, indices } = box(2, 3, 4);
    const loops = sliceAtY(positions, indices, 0);
    expect(loops.length).toBe(1);
    const loop = loops[0]!;
    expect(loop.perimeterCm).toBeCloseTo(120, 3); // 2*(2+4) dm
    expect((loop.maxX - loop.minX) * 10).toBeCloseTo(20, 3);
    expect((loop.maxZ - loop.minZ) * 10).toBeCloseTo(40, 3);
  });

  it('picks the loop nearest the body axis and measures half widths', () => {
    const { positions, indices } = box(2, 3, 4);
    // Add a second, offset loop by translating a copy far in +x.
    const shifted = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      shifted[i] = positions[i]! + 10;
      shifted[i + 1] = positions[i + 1]!;
      shifted[i + 2] = positions[i + 2]!;
    }
    const combinedPositions = new Float32Array([...positions, ...shifted]);
    const combinedIndices = new Uint32Array([...indices, ...indices.map((v) => v + 8)]);
    const loops = sliceAtY(combinedPositions, combinedIndices, 0);
    expect(loops.length).toBe(2);
    const torso = torsoLoop(loops);
    expect(torso).not.toBeNull();
    expect(Math.abs(torso!.cx)).toBeLessThan(1);
    expect(halfWidthCm(torso!, true)).toBeCloseTo(20, 3);
    expect(halfWidthCm(torso!, false)).toBeCloseTo(20, 3);
  });

  it('computes arcs and apex span', () => {
    const { positions, indices } = box(2, 3, 4);
    const loop = sliceAtY(positions, indices, 0)[0]!;
    const cf = indexByMaxZ(loop);
    const side = indexByMaxAbsX(loop);
    // Either way round the loop is half the perimeter.
    const half = loop.perimeterCm / 2;
    expect(arcCm(loop, cf, side, true) + arcCm(loop, cf, side, false)).toBeCloseTo(loop.perimeterCm, 2);
    expect(arcCm(loop, cf, side, true)).toBeCloseTo(half, 2);
    const apexes = frontApexes(loop);
    expect(apexes).not.toBeNull();
    // On a box the front face has collinear points, so only assert the halves differ.
    expect(apexes![0][0]).toBeLessThanOrEqual(0);
    expect(apexes![1][0]).toBeGreaterThanOrEqual(0);
    expect(apexes![0][2]).toBeCloseTo(2, 3);
    expect(apexes![1][2]).toBeCloseTo(2, 3);
  });

  it('measures surface area', () => {
    const { positions, indices } = box(2, 3, 4);
    // 2*(2*3) + 2*(2*4) + 2*(3*4) = 12 + 16 + 24 = 52 dm²
    expect(surfaceAreaDm2(positions, indices)).toBeCloseTo(52, 3);
  });
});
