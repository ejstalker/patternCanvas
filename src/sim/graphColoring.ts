/**
 * Greedy graph coloring for distance constraints (wasm-cloth-sim style).
 * Two constraints are adjacent iff they share a vertex. Within a color class,
 * no two constraints touch the same vertex — safe for parallel GS stores.
 */

export type Coloring = {
  /** Constraint indices reordered by color. */
  idx: Uint32Array;
  /** offsets[k]..offsets[k+1] = constraints of color k. */
  offsets: Uint32Array;
  numColors: number;
};

/**
 * @param endpoints endpoints[i] = vertex indices touched by constraint i
 * @param numVerts particle count
 */
export function colorConstraints(endpoints: ArrayLike<number>[], numVerts: number): Coloring {
  const nCon = endpoints.length;
  if (nCon === 0) {
    return { idx: new Uint32Array(0), offsets: new Uint32Array([0]), numColors: 0 };
  }

  // Colors needed by greedy coloring is bounded by max degree + 1, so size the
  // per-vertex bitmask dynamically. Capping at 64 (the old behaviour) silently
  // assigned two same-colored constraints to one vertex → a race → tearing.
  const degree = new Uint32Array(numVerts);
  for (let ci = 0; ci < nCon; ci++) {
    const eps = endpoints[ci];
    for (let k = 0; k < eps.length; k++) {
      const v = eps[k] as number;
      if (v >= 0 && v < numVerts) degree[v]++;
    }
  }
  let maxDegree = 0;
  for (let v = 0; v < numVerts; v++) {
    if (degree[v] > maxDegree) maxDegree = degree[v];
  }
  const words = Math.max(1, Math.ceil((maxDegree + 1) / 32));
  const vertMask = new Uint32Array(numVerts * words);
  const colorOf = new Uint32Array(nCon);
  let maxColor = 0;

  for (let ci = 0; ci < nCon; ci++) {
    const eps = endpoints[ci];
    let c = 0;
    // Lowest color whose bit is free on every endpoint of this constraint.
    for (;;) {
      const w = c >> 5;
      const bit = 1 << (c & 31);
      let used = false;
      for (let k = 0; k < eps.length; k++) {
        if (vertMask[(eps[k] as number) * words + w] & bit) {
          used = true;
          break;
        }
      }
      if (!used) break;
      c++;
    }
    colorOf[ci] = c;
    if (c > maxColor) maxColor = c;
    const w = c >> 5;
    const bit = 1 << (c & 31);
    for (let k = 0; k < eps.length; k++) {
      vertMask[(eps[k] as number) * words + w] |= bit;
    }
  }

  const numColors = maxColor + 1;
  const counts = new Uint32Array(numColors);
  for (let i = 0; i < nCon; i++) counts[colorOf[i]]++;

  const offsets = new Uint32Array(numColors + 1);
  for (let c = 0; c < numColors; c++) {
    offsets[c + 1] = offsets[c] + counts[c];
  }
  const idx = new Uint32Array(nCon);
  const cursor = offsets.slice();
  for (let i = 0; i < nCon; i++) {
    const c = colorOf[i];
    idx[cursor[c]++] = i;
  }

  return { idx, offsets, numColors };
}

/** Color stretch constraints given (i,j) pairs. */
export function colorStretchConstraints(
  stretch: Array<{ i: number; j: number }>,
  numVerts: number
): Coloring {
  return colorConstraints(
    stretch.map((s) => [s.i, s.j]),
    numVerts
  );
}
