import { describe, expect, it } from 'vitest';
import {
  buildIncidentTriangles,
  buildPatternPointMarkers,
  computeVertexNormal,
  markerFacesCamera,
} from './patternPointMarkers';
import { patternWindowFor } from './PatternPointOverlay';
import type { MeshGeometry, PatternDocument } from '../project/types';

function piece(id: string, points: Array<[number, number]>) {
  return {
    id,
    name: id,
    closed: true,
    points: points.map(([x, y], i) => ({
      id: `${id}-p${i}`,
      anchor: { x, y },
      handleIn: null,
      handleOut: null,
    })),
  };
}

function pattern(...pieces: ReturnType<typeof piece>[]): PatternDocument {
  return { id: 'pat', name: 'p', pieces, seams: [] };
}

/** Two unit squares side by side, each split into two triangles. */
function twoPieceMesh(): MeshGeometry {
  const vertices = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 10 },
    { x: 10, y: 10 },
  ];
  return {
    vertices,
    vertexPieceIds: ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B'],
    triangles: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
    edges: [],
  };
}

describe('buildPatternPointMarkers', () => {
  it('maps each anchor to the nearest vertex inside its own piece', () => {
    const mesh = twoPieceMesh();
    const doc = pattern(
      piece('A', [
        [0.2, 0.3],
        [9.8, 0.4],
        [10.5, 9.5],
        [0.4, 9.6],
      ]),
      piece('B', [
        [10.2, 0.1],
        [19.7, 0.2],
        [19.9, 9.9],
        [10.1, 9.8],
      ])
    );
    const markers = buildPatternPointMarkers(mesh, doc);
    expect(markers).toHaveLength(8);
    const byPoint = new Map(markers.map((m) => [m.pointId, m.vertexIndex]));
    // Piece A corners land on vertices 0..3, never on the adjacent piece B.
    expect(byPoint.get('A-p0')).toBe(0);
    expect(byPoint.get('A-p2')).toBe(2);
    expect(byPoint.get('B-p1')).toBe(5);
    expect(byPoint.get('B-p3')).toBe(7);
  });

  it('never reuses a vertex for two anchors', () => {
    const mesh = twoPieceMesh();
    const doc = pattern(
      piece('A', [
        [5, 5],
        [5.1, 5.1],
      ])
    );
    const markers = buildPatternPointMarkers(mesh, doc);
    expect(markers).toHaveLength(2);
    expect(markers[0].vertexIndex).not.toBe(markers[1].vertexIndex);
  });

  it('falls back to a global search when a piece owns no vertices', () => {
    const mesh = twoPieceMesh();
    const doc = pattern(piece('ZZ', [[19.5, 9.5]]));
    const markers = buildPatternPointMarkers(mesh, doc);
    expect(markers).toHaveLength(1);
    expect(markers[0].vertexIndex).toBe(6);
  });

  it('returns nothing without a mesh or pattern', () => {
    expect(buildPatternPointMarkers(null, pattern(piece('A', [[0, 0]])))).toEqual([]);
    expect(buildPatternPointMarkers(twoPieceMesh(), null)).toEqual([]);
    expect(buildPatternPointMarkers({ vertices: [], triangles: [], edges: [] }, pattern(piece('A', [[0, 0]])))).toEqual([]);
  });
});

describe('buildIncidentTriangles', () => {
  it('lists the triangles touching each vertex', () => {
    const indices = [0, 1, 2, 0, 2, 3];
    const inc = buildIncidentTriangles(indices, 4);
    const incident = (v: number) => Array.from(inc.tris.slice(inc.offsets[v], inc.offsets[v + 1]));
    expect(incident(0)).toEqual([0, 1]);
    expect(incident(1)).toEqual([0]);
    expect(incident(2)).toEqual([0, 1]);
    expect(incident(3)).toEqual([1]);
  });

  it('ignores out-of-range and malformed triangles', () => {
    const inc = buildIncidentTriangles([0, 1, 99, 0, 1], 2);
    expect(Array.from(inc.tris)).toEqual([]);
    expect(inc.offsets[2]).toBe(0);
  });
});

describe('vertex normals and culling', () => {
  // Flat quad on the XZ plane, wound so the normal is +Y.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1]);
  const indices = [0, 1, 2, 0, 2, 3];
  const incident = buildIncidentTriangles(indices, 4);
  const scratch = new Float32Array(3);

  it('computes an area-weighted normal', () => {
    expect(computeVertexNormal(positions, indices, incident, 0, scratch)).toBe(true);
    expect(scratch[0]).toBeCloseTo(0);
    expect(scratch[1]).toBeCloseTo(1);
    expect(scratch[2]).toBeCloseTo(0);
  });

  it('hides markers on the side facing away from the eye', () => {
    const above = [0.5, 5, -0.5];
    const below = [0.5, -5, -0.5];
    expect(markerFacesCamera(positions, indices, incident, 0, above, scratch)).toBe(true);
    expect(markerFacesCamera(positions, indices, incident, 0, below, scratch)).toBe(false);
  });

  it('keeps vertices with no usable normal visible', () => {
    const empty = buildIncidentTriangles(indices, 8);
    expect(markerFacesCamera(positions, indices, empty, 6, [0, 5, 0], scratch)).toBe(true);
  });
});

describe('patternWindowFor', () => {
  it('centres the window on the point and matches the panel aspect', () => {
    const w = patternWindowFor({ x: 12, y: 30 }, 34, 248 / 178);
    expect(w.width).toBeCloseTo(34);
    expect(w.height).toBeCloseTo((34 * 178) / 248);
    expect(w.x + w.width / 2).toBeCloseTo(12);
    expect(w.y + w.height / 2).toBeCloseTo(30);
  });

  it('clamps degenerate sizes', () => {
    const w = patternWindowFor({ x: 0, y: 0 }, 0, 0);
    expect(w.width).toBe(1);
    expect(Number.isFinite(w.height)).toBe(true);
  });
});
