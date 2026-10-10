import { describe, expect, it } from 'vitest';
import { buildWireframeEdgeIndices } from './wireframeEdges';

describe('buildWireframeEdgeIndices', () => {
  it('extracts the three edges of a single triangle', () => {
    const edges = buildWireframeEdgeIndices([0, 1, 2]);
    expect(Array.from(edges)).toEqual([0, 1, 1, 2, 0, 2]);
  });

  it('deduplicates the shared edge of two triangles', () => {
    // Quad 0-1-2-3 as triangles (0,1,2) and (0,2,3): 5 unique edges.
    const edges = buildWireframeEdgeIndices([0, 1, 2, 0, 2, 3]);
    const pairs = new Set<string>();
    for (let i = 0; i < edges.length; i += 2) {
      pairs.add(`${edges[i]}-${edges[i + 1]}`);
    }
    expect(edges.length / 2).toBe(5);
    expect(pairs).toEqual(new Set(['0-1', '1-2', '0-2', '2-3', '0-3']));
  });

  it('always emits ordered index pairs so each edge appears once', () => {
    const edges = buildWireframeEdgeIndices([2, 0, 1]);
    for (let i = 0; i < edges.length; i += 2) {
      expect(edges[i]).toBeLessThan(edges[i + 1]);
    }
  });

  it('skips degenerate edges and tolerates trailing vertices', () => {
    const edges = buildWireframeEdgeIndices([0, 0, 1, 2]);
    expect(Array.from(edges)).toEqual([0, 1]);
  });

  it('returns an empty array for empty input', () => {
    expect(buildWireframeEdgeIndices([]).length).toBe(0);
  });
});
