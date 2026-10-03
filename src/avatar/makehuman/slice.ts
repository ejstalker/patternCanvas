/**
 * Horizontal plane slicing of the body mesh, used to derive tailor measurements
 * that have no hand-authored MakeHuman ruler polyline (arcs, widths, and girths
 * at arbitrary heights).
 *
 * All positions are in the base mesh's decimetres; outputs are returned in
 * centimetres where noted.
 */

export type SliceLoop = {
  /** Ordered, closed loop points (xyz triples, decimetres). */
  points: Float32Array;
  /** Loop circumference in centimetres. */
  perimeterCm: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cx: number;
  cz: number;
};

type Segment = [number, number];

const KEY_SCALE = 1000;

/**
 * Intersect the triangle mesh with the horizontal plane `y = planeY`.
 * Vertices exactly on the plane count as "above", which keeps the crossing
 * count per triangle even.
 */
export function sliceAtY(
  positions: Float32Array,
  indices: Uint32Array,
  planeY: number
): SliceLoop[] {
  const points: number[] = [];
  const indexByKey = new Map<string, number>();
  const segments: Segment[] = [];

  const addPoint = (x: number, z: number): number => {
    const key = `${Math.round(x * KEY_SCALE)}:${Math.round(z * KEY_SCALE)}`;
    const existing = indexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = points.length / 3;
    points.push(x, planeY, z);
    indexByKey.set(key, index);
    return index;
  };

  const at = (v: number): number => positions[v * 3 + 1]!;

  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]!;
    const ib = indices[t + 1]!;
    const ic = indices[t + 2]!;
    const ya = at(ia) - planeY;
    const yb = at(ib) - planeY;
    const yc = at(ic) - planeY;
    const sa = ya >= 0;
    const sb = yb >= 0;
    const sc = yc >= 0;
    if (sa === sb && sb === sc) continue;

    const crossing: number[] = [];
    const edge = (v0: number, v1: number, d0: number, d1: number): void => {
      if (d0 > 0 === d1 > 0) return;
      const denom = d0 - d1;
      if (Math.abs(denom) < 1e-12) return;
      const u = d0 / denom;
      const x = positions[v0 * 3]! + (positions[v1 * 3]! - positions[v0 * 3]!) * u;
      const z = positions[v0 * 3 + 2]! + (positions[v1 * 3 + 2]! - positions[v0 * 3 + 2]!) * u;
      crossing.push(addPoint(x, z));
    };
    edge(ia, ib, ya, yb);
    edge(ib, ic, yb, yc);
    edge(ic, ia, yc, ya);

    if (crossing.length === 2 && crossing[0] !== crossing[1]) {
      segments.push([crossing[0]!, crossing[1]!]);
    }
  }

  // Chain segments into closed loops.
  const adjacency = new Map<number, number[]>();
  segments.forEach((segment, index) => {
    for (const point of segment) {
      const list = adjacency.get(point);
      if (list) list.push(index);
      else adjacency.set(point, [index]);
    }
  });

  const used = new Uint8Array(segments.length);
  const loops: SliceLoop[] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    const chain: number[] = [];
    let current = start;
    const origin = segments[start]![0]!;
    let at0 = origin;
    for (;;) {
      used[current] = 1;
      const [a, b] = segments[current]!;
      chain.push(at0);
      const next = at0 === a ? b : a;
      at0 = next;
      if (at0 === origin) break;
      const candidates = adjacency.get(at0);
      const following = candidates?.find((s) => s !== current && !used[s]);
      if (following === undefined) break;
      current = following;
    }
    if (chain.length >= 3) loops.push(buildLoop(points, chain));
  }

  return loops;
}

function buildLoop(points: number[], chain: number[]): SliceLoop {
  const count = chain.length;
  const ordered = new Float32Array(count * 3);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < count; i++) {
    const p = chain[i]! * 3;
    const x = points[p]!;
    const y = points[p + 1]!;
    const z = points[p + 2]!;
    ordered[i * 3] = x;
    ordered[i * 3 + 1] = y;
    ordered[i * 3 + 2] = z;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    sx += x;
    sz += z;
  }
  let length = 0;
  for (let i = 0; i < count; i++) {
    const a = i * 3;
    const b = ((i + 1) % count) * 3;
    length += Math.hypot(ordered[a]! - ordered[b]!, ordered[a + 1]! - ordered[b + 1]!, ordered[a + 2]! - ordered[b + 2]!);
  }
  return { points: ordered, perimeterCm: length * 10, minX, maxX, minZ, maxZ, cx: sx / count, cz: sz / count };
}

/** The loop that belongs to the torso (closest centroid to the body's vertical axis). */
export function torsoLoop(loops: SliceLoop[]): SliceLoop | null {
  let best: SliceLoop | null = null;
  let bestDist = Infinity;
  for (const loop of loops) {
    const d = Math.abs(loop.cx);
    if (d < bestDist) {
      bestDist = d;
      best = loop;
    }
  }
  return best;
}

/** The loop whose centroid is nearest a point (e.g. an arm), optionally excluding one. */
export function loopNearest(loops: SliceLoop[], x: number, z: number, exclude?: SliceLoop | null): SliceLoop | null {
  let best: SliceLoop | null = null;
  let bestDist = Infinity;
  for (const loop of loops) {
    if (loop === exclude) continue;
    const d = Math.hypot(loop.cx - x, loop.cz - z);
    if (d < bestDist) {
      bestDist = d;
      best = loop;
    }
  }
  return best;
}

export function loopPointCount(loop: SliceLoop): number {
  return loop.points.length / 3;
}

function loopXYZ(loop: SliceLoop, i: number): [number, number, number] {
  const i3 = i * 3;
  return [loop.points[i3]!, loop.points[i3 + 1]!, loop.points[i3 + 2]!];
}

/** Index of the loop point with the greatest Z (front), least Z (back), or greatest |X| (side). */
export function indexByMaxZ(loop: SliceLoop): number {
  let best = 0;
  for (let i = 1; i < loopPointCount(loop); i++) {
    if (loop.points[i * 3 + 2]! > loop.points[best * 3 + 2]!) best = i;
  }
  return best;
}

export function indexByMinZ(loop: SliceLoop): number {
  let best = 0;
  for (let i = 1; i < loopPointCount(loop); i++) {
    if (loop.points[i * 3 + 2]! < loop.points[best * 3 + 2]!) best = i;
  }
  return best;
}

export function indexByMaxAbsX(loop: SliceLoop): number {
  let best = 0;
  for (let i = 1; i < loopPointCount(loop); i++) {
    if (Math.abs(loop.points[i * 3]!) > Math.abs(loop.points[best * 3]!)) best = i;
  }
  return best;
}

/**
 * Loop indices from `fromIndex` to `toIndex`, choosing the direction whose
 * midpoint lies on the front (z > 0) or back (z < 0).
 */
export function arcIndices(loop: SliceLoop, fromIndex: number, toIndex: number, front: boolean): number[] {
  const count = loopPointCount(loop);
  const forward: number[] = [];
  for (let i = fromIndex; ; i = (i + 1) % count) {
    forward.push(i);
    if (i === toIndex) break;
  }
  const forwardMidZ = loop.points[forward[Math.floor(forward.length / 2)]! * 3 + 2]!;
  if ((forwardMidZ > 0) === front) return forward;

  const backward: number[] = [];
  for (let i = fromIndex; ; i = (i - 1 + count) % count) {
    backward.push(i);
    if (i === toIndex) break;
  }
  return backward;
}

export function pointsFromIndices(loop: SliceLoop, indices: readonly number[]): Float32Array {
  const out = new Float32Array(indices.length * 3);
  indices.forEach((index, i) => {
    out[i * 3] = loop.points[index * 3]!;
    out[i * 3 + 1] = loop.points[index * 3 + 1]!;
    out[i * 3 + 2] = loop.points[index * 3 + 2]!;
  });
  return out;
}

export function lengthOfIndicesCm(loop: SliceLoop, indices: readonly number[]): number {
  let sum = 0;
  for (let i = 1; i < indices.length; i++) {
    const a = loopXYZ(loop, indices[i - 1]!);
    const b = loopXYZ(loop, indices[i]!);
    sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return sum * 10;
}

/** Arc length (cm) around the loop between two points, front or back. */
export function arcCm(loop: SliceLoop, fromIndex: number, toIndex: number, front: boolean): number {
  return lengthOfIndicesCm(loop, arcIndices(loop, fromIndex, toIndex, front));
}

/** The two front-most points on the left and right halves — an approximation of the bust apexes. */
export function frontApexes(loop: SliceLoop): [[number, number, number], [number, number, number]] | null {
  let left: [number, number, number] | null = null;
  let right: [number, number, number] | null = null;
  for (let i = 0; i < loopPointCount(loop); i++) {
    const p = loopXYZ(loop, i);
    if (p[0] >= 0) {
      if (!right || p[2] > right[2]) right = p;
    } else if (!left || p[2] > left[2]) {
      left = p;
    }
  }
  return left && right ? [left, right] : null;
}

/** Width (cm) of the loop's points that lie in front of (z > 0) or behind (z < 0) a side cut. */
export function halfWidthCm(loop: SliceLoop, front: boolean): number {
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < loopPointCount(loop); i++) {
    const z = loop.points[i * 3 + 2]!;
    if (front ? z <= 0 : z >= 0) continue;
    const x = loop.points[i * 3]!;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  if (!Number.isFinite(minX)) return 0;
  return (maxX - minX) * 10;
}

/** Distance between two points (decimetres) in centimetres. */
export function distanceCm(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 10;
}

export function vertexXYZ(positions: Float32Array, vertex: number): [number, number, number] {
  const i = vertex * 3;
  return [positions[i]!, positions[i + 1]!, positions[i + 2]!];
}

/** Total surface area of the given triangles, in square decimetres. */
export function surfaceAreaDm2(positions: Float32Array, indices: Uint32Array): number {
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const abx = positions[b]! - positions[a]!;
    const aby = positions[b + 1]! - positions[a + 1]!;
    const abz = positions[b + 2]! - positions[a + 2]!;
    const acx = positions[c]! - positions[a]!;
    const acy = positions[c + 1]! - positions[a + 1]!;
    const acz = positions[c + 2]! - positions[a + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    area += Math.hypot(nx, ny, nz) * 0.5;
  }
  return area;
}

/** Centroid Y (decimetres) of a named ruler polyline — used to locate slice heights. */
export function polylineCentroidY(positions: Float32Array, polyline: readonly number[]): number {
  let sum = 0;
  for (const vertex of polyline) sum += positions[vertex * 3 + 1]!;
  return sum / polyline.length;
}
