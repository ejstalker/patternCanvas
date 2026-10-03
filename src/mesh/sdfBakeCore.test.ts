import { describe, expect, it } from 'vitest';
import { bakeDistances } from './sdfBakeCore';

/** UV sphere as a triangle soup. */
function sphereMesh(radius: number, segments = 24, rings = 16) {
  const positions: number[] = [];
  const indices: number[] = [];

  const push = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };

  const grid: number[][] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    const row: number[] = [];
    for (let s = 0; s < segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      row.push(
        push(
          radius * Math.sin(phi) * Math.cos(theta),
          radius * Math.cos(phi),
          radius * Math.sin(phi) * Math.sin(theta)
        )
      );
    }
    grid.push(row);
  }

  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments;
      const a = grid[r]![s]!;
      const b = grid[r]![s2]!;
      const c = grid[r + 1]![s]!;
      const d = grid[r + 1]![s2]!;
      indices.push(a, c, b, b, c, d);
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}

describe('bakeDistances', () => {
  it('produces signed distances consistent with a sphere', () => {
    const radius = 2;
    const { positions, indices } = sphereMesh(radius);
    const resolution = 24;
    const pad = 0.5;
    const extent = radius + pad;
    const dim: [number, number, number] = [resolution, resolution, resolution];
    const voxelSize = (extent * 2) / resolution;
    const origin: [number, number, number] = [-extent, -extent, -extent];

    const distances = bakeDistances({ positions, indices, origin, voxelSize, dim });

    const sample = (ix: number, iy: number, iz: number): number =>
      distances[ix + iy * resolution + iz * resolution * resolution]!;

    const center = Math.floor(resolution / 2);
    const centerIndex = center + center * resolution + center * resolution * resolution;

    // Centre voxel is inside.
    expect(distances[centerIndex]!).toBeLessThan(0);
    // Just outside the sphere (index 1) is positive.
    expect(sample(1, center, center)).toBeGreaterThan(0);

    // Every sample distance magnitude is within ~voxelSize of the analytic value.
    // Sign errors are tolerated only in a tiny fraction (pole triangles are degenerate).
    let maxError = 0;
    let signErrors = 0;
    let samples = 0;
    for (let iz = 1; iz < resolution - 1; iz++) {
      for (let iy = 1; iy < resolution - 1; iy++) {
        for (let ix = 1; ix < resolution - 1; ix++) {
          const x = origin[0] + (ix + 0.5) * voxelSize;
          const y = origin[1] + (iy + 0.5) * voxelSize;
          const z = origin[2] + (iz + 0.5) * voxelSize;
          const analytic = Math.hypot(x, y, z) - radius;
          const value = sample(ix, iy, iz);
          maxError = Math.max(maxError, Math.abs(Math.abs(value) - Math.abs(analytic)));
          samples++;
          if (Math.abs(analytic) > voxelSize * 1.5) {
            const wrongSign = analytic < 0 ? value > 0 : value < 0;
            if (wrongSign) signErrors++;
          }
        }
      }
    }
    expect(maxError).toBeLessThan(voxelSize * 0.5);
    expect(signErrors / samples).toBeLessThan(0.02);
  });

  it('reports progress from 0 to 1', () => {
    const { positions, indices } = sphereMesh(1);
    const progress: number[] = [];
    bakeDistances(
      { positions, indices, origin: [-1.2, -1.2, -1.2], voxelSize: 0.2, dim: [12, 12, 12] },
      (v) => progress.push(v)
    );
    expect(progress.length).toBe(12);
    expect(progress[progress.length - 1]).toBeCloseTo(1);
  });
});
