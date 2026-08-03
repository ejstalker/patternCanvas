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

  const MAX_COLORS = 64;
  const vertMask = new BigUint64Array(numVerts);
  const colorOf = new Uint32Array(nCon);
  let maxColor = 0;

  for (let ci = 0; ci < nCon; ci++) {
    let used = 0n;
    const eps = endpoints[ci];
    for (let k = 0; k < eps.length; k++) {
      used |= vertMask[eps[k] as number];
    }
    // Lowest free color = trailing zeros of ~used
    let c = 0;
    let bit = 1n;
    while (c < MAX_COLORS && (used & bit) !== 0n) {
      c++;
      bit <<= 1n;
    }
    if (c >= MAX_COLORS) c = MAX_COLORS - 1;
    colorOf[ci] = c;
    if (c > maxColor) maxColor = c;
    const setBit = 1n << BigInt(c);
    for (let k = 0; k < eps.length; k++) {
      vertMask[eps[k] as number] |= setBit;
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
