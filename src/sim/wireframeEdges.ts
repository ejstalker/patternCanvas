/**
 * Edge index extraction for wireframe shading.
 *
 * The drape simulators render triangles, so a wireframe view needs an explicit
 * line-list index buffer. Topology only changes when the mesh is rebuilt, so the
 * result is uploaded once per cloth rather than every frame.
 */
export function buildWireframeEdgeIndices(indices: ArrayLike<number>): Uint32Array {
  const seen = new Set<number>();
  const stride = indices.length;
  const edges: number[] = [];
  for (let i = 0; i + 2 < stride; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    pushEdge(edges, seen, a, b);
    pushEdge(edges, seen, b, c);
    pushEdge(edges, seen, c, a);
  }
  return Uint32Array.from(edges);
}

function pushEdge(edges: number[], seen: Set<number>, a: number, b: number): void {
  if (a === b) return;
  // Index pairs fit in a double for any realistic particle count, so a numeric
  // key avoids the cost of building strings per edge.
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const key = lo * 4294967296 + hi;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(lo, hi);
}
