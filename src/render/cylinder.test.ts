import { describe, expect, it } from 'vitest';
import { cylinderGeometry } from './cylinder';

describe('cylinderGeometry', () => {
  it('builds a closed cylinder with its top at the given height', () => {
    const geometry = cylinderGeometry(2, 3, 8);
    expect(geometry.indices.length).toBe(8 * 3 * 2 + 8 * 3 * 2); // side quads + both caps
    for (const index of geometry.indices) {
      expect(index).toBeLessThan(geometry.positions.length / 3);
    }
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < geometry.positions.length; i += 3) {
      minY = Math.min(minY, geometry.positions[i]);
      maxY = Math.max(maxY, geometry.positions[i]);
    }
    expect(maxY).toBeCloseTo(0, 6);
    expect(minY).toBeCloseTo(-3, 6);
  });

  it('keeps every vertex on the radius', () => {
    const radius = 4.5;
    const geometry = cylinderGeometry(radius, 1, 16, 2);
    for (let i = 0; i < geometry.positions.length; i += 3) {
      const x = geometry.positions[i];
      const z = geometry.positions[i + 2];
      const planar = Math.hypot(x, z);
      expect(planar === 0 || Math.abs(planar - radius) < 1e-5).toBe(true);
    }
  });

  it('points the cap normals along Y and the wall normals outward', () => {
    const geometry = cylinderGeometry(1, 1, 12);
    for (let i = 0; i < geometry.normals.length; i += 3) {
      const [nx, ny, nz] = [geometry.normals[i], geometry.normals[i + 1], geometry.normals[i + 2]];
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
      if (ny !== 0) {
        expect(nx).toBe(0);
        expect(nz).toBe(0);
      } else {
        const x = geometry.positions[i];
        const z = geometry.positions[i + 2];
        // Outward: the normal matches the radial direction of the vertex.
        expect(nx * x + nz * z).toBeGreaterThan(0);
      }
    }
  });

  it('clamps silly segment counts to something renderable', () => {
    expect(cylinderGeometry(1, 1, 2).indices.length).toBeGreaterThan(0);
    expect(cylinderGeometry(1, 1, 0.4).indices.length).toBeGreaterThan(0);
  });
});
