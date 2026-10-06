import { describe, expect, it } from 'vitest';
import { analyzeCollisionMesh, clipAbovePlane } from './generateMesh';
import { floorLift, toBodySpace } from '../mesh/floorLift';

/** A closed tetrahedron: every edge is shared by exactly two triangles. */
const TETRA = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
};

/** A 2×2×2 box: six faces, each split into two triangles. */
const BOX = {
  positions: new Float32Array([
    -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1,
    -1, 2, -1, 1, 2, -1, 1, 2, 1, -1, 2, 1,
  ]),
  indices: new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom
    4, 5, 6, 4, 6, 7, // top
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]),
};

describe('analyzeCollisionMesh', () => {
  it('calls a closed surface watertight', () => {
    const a = analyzeCollisionMesh(TETRA.positions, TETRA.indices);
    expect(a.vertices).toBe(4);
    expect(a.triangles).toBe(4);
    expect(a.openEdges).toBe(0);
    expect(a.nonManifoldEdges).toBe(0);
    expect(a.watertight).toBe(true);
    expect(a.minY).toBe(0);
    expect(a.maxY).toBe(1);
  });

  it('counts the open edges of a surface with a hole', () => {
    // Drop one face: its three edges are left used by a single triangle.
    const open = analyzeCollisionMesh(TETRA.positions, TETRA.indices.slice(0, 9));
    expect(open.openEdges).toBe(3);
    expect(open.watertight).toBe(false);
  });

  it('counts edges shared by three triangles as non-manifold', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const indices = new Uint32Array([
      ...TETRA.indices,
      0, 1, 2, // duplicate of the first face's winding, sharing its edges
    ]);
    const a = analyzeCollisionMesh(positions, indices);
    expect(a.nonManifoldEdges).toBeGreaterThan(0);
    expect(a.watertight).toBe(false);
  });

  it('measures how far the flat top reaches from the axis', () => {
    // The box's top corners are 1 unit out on both x and z: the cut reaches √2.
    const a = analyzeCollisionMesh(BOX.positions, BOX.indices);
    expect(a.watertight).toBe(true);
    expect(a.cutReach).toBeCloseTo(Math.SQRT2, 6);
  });
});

describe('floorLift', () => {
  it('is the shift that rests the mesh on the floor', () => {
    const mesh = new Float32Array([0, -8.2, 0, 1, 6.8, 0, 0, 3, 0]);
    expect(floorLift(mesh)).toBeCloseTo(8.2, 6);
    const body = toBodySpace(mesh, 8.2);
    expect(body[1]).toBeCloseTo(0, 6); // feet
    expect(body[4]).toBeCloseTo(15, 6); // head, in body space
    // The original is left alone.
    expect(mesh[1]).toBeCloseTo(-8.2, 6);
  });

  it('is a no-op for a mesh already at the floor, and for an empty one', () => {
    expect(floorLift(new Float32Array([0, 0, 0, 1, 2, 0]))).toBe(0);
    expect(floorLift(new Float32Array(0))).toBe(0);
    const already = new Float32Array([0, 0, 0, 1, 2, 0]);
    expect([...toBodySpace(already, 0)]).toEqual([...already]);
  });
});

describe('clipAbovePlane', () => {
  it('drops the part above the plane and flattens what straddles it', () => {
    const clipped = clipAbovePlane(BOX.positions, BOX.indices, 0.5);
    // The two top-face triangles are entirely above the plane: gone.
    expect(clipped.indices.length).toBe(BOX.indices.length - 6);
    // Nothing survives above the cut...
    for (let i = 1; i < clipped.positions.length; i += 3) {
      expect(clipped.positions[i]!).toBeLessThanOrEqual(0.5 + 1e-6);
    }
    // ...and the straddling side triangles have been snapped onto it.
    const atPlane = [...clipped.positions].filter(
      (_, i) => i % 3 === 1 && Math.abs(clipped.positions[i]! - 0.5) < 1e-6
    );
    expect(atPlane.length).toBe(4);
  });

  it('keeps a mesh that is entirely below the plane', () => {
    const clipped = clipAbovePlane(BOX.positions, BOX.indices, 10);
    // Winding and vertex numbering may be renumbered, but nothing is dropped.
    expect(clipped.indices.length).toBe(BOX.indices.length);
    expect(clipped.positions.length).toBe(BOX.positions.length);
  });

  it('keeps the surface edge-closed in the topological sense only (known gap)', () => {
    // Snapping keeps no visible hole, but it does not produce a watertight
    // surface: the cut leaves one-sided edges. See the doc comment.
    const clipped = clipAbovePlane(BOX.positions, BOX.indices, 0.5);
    const a = analyzeCollisionMesh(clipped.positions, clipped.indices);
    expect(a.openEdges).toBeGreaterThan(0);
  });
});
