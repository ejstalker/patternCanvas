import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { bakeDistances } from './sdfBakeCore';
import { SdfVolume } from './sdfVolume';

/** A 2×2×2 box centred on the origin: every face is at ±1. */
function boxMesh() {
  return {
    positions: new Float32Array([
      -1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1,
      -1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1,
    ]),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ]),
  };
}

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
          // Cell (ix, iy, iz) holds the distance at origin + i * voxelSize.
          const x = origin[0] + ix * voxelSize;
          const y = origin[1] + iy * voxelSize;
          const z = origin[2] + iz * voxelSize;
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

/**
 * The one thing a baked volume has to get right: where its surface is.
 *
 * `bakeDistances` writes a value per cell and `SdfVolume.sampleAt` reads them
 * back; the GPU sampler and the OpenVDB importer write the same layout. All of
 * them have to agree on which world position a cell holds, or every collision
 * surface sits half a voxel away from the geometry it was baked from — 1.8 cm at
 * 48³ on a body.
 */
describe('SDF grid convention', () => {
  const box = boxMesh();
  const dim: [number, number, number] = [32, 32, 32];
  const voxelSize = 4 / 32;
  const origin: [number, number, number] = [-2, -2, -2];

  const volume = () =>
    new SdfVolume({
      origin,
      voxelSize,
      dim,
      distances: bakeDistances({ positions: box.positions, indices: box.indices, origin, voxelSize, dim }),
    });

  /** The surface along a ray, by bisection on the sampled field. */
  const crossing = (v: SdfVolume, from: number, to: number): number => {
    let lo = from;
    let hi = to;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (v.sampleAt(vec3.fromValues(0, mid, 0)) < 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  it('puts the sampled surface where the geometry is', () => {
    const v = volume();
    // The box's top face is at y = 1, its bottom at y = -1.
    expect(crossing(v, 0.5, 1.5)).toBeCloseTo(1, 3);
    expect(crossing(v, -0.5, -1.5)).toBeCloseTo(-1, 3);
    // ...and the same in x, so the shift is not a y-only accident.
    expect(v.sampleAt(vec3.fromValues(0.5, 0, 0))).toBeLessThan(0);
    expect(v.sampleAt(vec3.fromValues(1.5, 0, 0))).toBeGreaterThan(0);
  });
});
