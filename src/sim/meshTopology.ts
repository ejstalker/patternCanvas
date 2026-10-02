import { vec3 } from 'gl-matrix';
import { boundsOf } from '../pattern/geometry';
import { resolveSeamParticlePairs } from '../mesh/triangulate';
import type { MeshGeometry, PatternDocument } from '../project/types';
import { CM_TO_WORLD } from './units';

export const FALLBACK_PIECE_ID = '__cloth__';

export type StretchConstraint = { i: number; j: number; rest: number };
export type BendConstraint = { i0: number; i1: number; i2: number; i3: number; restAngle: number };
/** Long-range / attach: particle i capped to maxDist from slot position. */
export type LraConstraint = {
  particleId: number;
  slotId: number;
  maxDist: number;
  /** If set, maxDist ramps from initialDist → maxDist over time (seams). */
  initialDist?: number;
  isSeam?: boolean;
};

/** Pairwise sew distance: |x_i − x_j| ≤ rest, ramped from initialDist. */
export type SeamDistanceConstraint = {
  i: number;
  j: number;
  /** Target gap in world units after seam closure. */
  rest: number;
  /** Laid-out separation before sewing (world units). */
  initialDist: number;
};

export type ClothTopology = {
  positions: Float32Array;
  initialPositions: Float32Array;
  inverseMasses: Float32Array;
  radii: Float32Array;
  /** Mean incident edge length per particle (world units) — drives collision margin. */
  edgeLengths: Float32Array;
  indices: Uint32Array;
  vertexPieceIds: string[];
  stretch: StretchConstraint[];
  bend: BendConstraint[];
  /** Attach slot world positions (xyz). Non-seam LRA only. */
  attachSlots: Float32Array;
  lra: LraConstraint[];
  /** Sew distance constraints (preferred over mutual-slot LRA). */
  seamConstraints: SeamDistanceConstraint[];
  /** Seam particle pairs for overlay (a,b). */
  seamPairs: Array<[number, number]>;
  /** CSR one-ring: offsets[i]..offsets[i+1] → neighbors. */
  oneRingOffsets: Uint32Array;
  oneRingNeighbors: Uint32Array;
  avgEdgeLength: number;
  particleMass: number;
  numParticles: number;
};

function fallbackMesh(): {
  vertices: MeshGeometry['vertices'];
  triangles: number[];
  edges: Array<[number, number]>;
  vertexPieceIds: string[];
} {
  const vertices = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 50 },
    { x: 0, y: 50 },
  ];
  return {
    vertices,
    triangles: [0, 1, 2, 0, 2, 3],
    edges: [
      [0, 1],
      [1, 2],
      [2, 0],
      [0, 2],
      [2, 3],
      [3, 0],
    ],
    vertexPieceIds: vertices.map(() => FALLBACK_PIECE_ID),
  };
}

/** Build dihedral bend constraints from triangle adjacency (shared edge → opposite verts). */
export function buildBendConstraints(
  positions: Float32Array,
  triangles: number[]
): BendConstraint[] {
  const edgeMap = new Map<string, { a: number; b: number; opp: number }>();
  const bends: BendConstraint[] = [];

  const key = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);

  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const i0 = triangles[t];
    const i1 = triangles[t + 1];
    const i2 = triangles[t + 2];
    const faces: Array<[number, number, number]> = [
      [i0, i1, i2],
      [i1, i2, i0],
      [i2, i0, i1],
    ];
    for (const [a, b, opp] of faces) {
      const k = key(a, b);
      const existing = edgeMap.get(k);
      if (!existing) {
        edgeMap.set(k, { a, b, opp });
        continue;
      }
      // Shared edge existing.a–existing.b; opposite verts existing.opp and opp.
      const i0b = existing.opp;
      const i1b = a;
      const i2b = b;
      const i3b = opp;
      const restAngle = dihedralRestAngle(positions, i0b, i1b, i2b, i3b);
      bends.push({ i0: i0b, i1: i1b, i2: i2b, i3: i3b, restAngle });
      edgeMap.delete(k);
    }
  }
  return bends;
}

function dihedralRestAngle(
  positions: Float32Array,
  i0: number,
  i1: number,
  i2: number,
  i3: number
): number {
  const p0 = vec3.fromValues(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
  const p1 = vec3.fromValues(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
  const p2 = vec3.fromValues(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
  const p3 = vec3.fromValues(positions[i3 * 3], positions[i3 * 3 + 1], positions[i3 * 3 + 2]);
  const e1 = vec3.create();
  const e2 = vec3.create();
  const n1 = vec3.create();
  const n2 = vec3.create();
  vec3.sub(e1, p1, p0);
  vec3.sub(e2, p2, p0);
  vec3.cross(n1, e1, e2);
  vec3.sub(e1, p1, p3);
  vec3.sub(e2, p2, p3);
  vec3.cross(n2, e1, e2);
  if (vec3.squaredLength(n1) < 1e-12 || vec3.squaredLength(n2) < 1e-12) return Math.PI;
  vec3.normalize(n1, n1);
  vec3.normalize(n2, n2);
  const d = Math.max(-1, Math.min(1, vec3.dot(n1, n2)));
  return Math.acos(d);
}

function buildOneRing(numParticles: number, edges: Array<[number, number]>): {
  offsets: Uint32Array;
  neighbors: Uint32Array;
} {
  const lists: number[][] = Array.from({ length: numParticles }, () => []);
  for (const [a, b] of edges) {
    if (a === b) continue;
    lists[a].push(b);
    lists[b].push(a);
  }
  const offsets = new Uint32Array(numParticles + 1);
  let total = 0;
  for (let i = 0; i < numParticles; i++) {
    offsets[i] = total;
    // unique
    const uniq = [...new Set(lists[i])];
    lists[i] = uniq;
    total += uniq.length;
  }
  offsets[numParticles] = total;
  const neighbors = new Uint32Array(total);
  for (let i = 0; i < numParticles; i++) {
    neighbors.set(lists[i], offsets[i]);
  }
  return { offsets, neighbors };
}

/**
 * Shared mesh → particle/constraint topology for CPU and GPU engines.
 */
export function buildClothTopology(
  mesh: MeshGeometry,
  mass: number,
  pattern?: PatternDocument | null,
  opts?: {
    particleDiameterScalar?: number;
    longRangeStretchiness?: number;
    layoutY?: number;
  }
): ClothTopology {
  const diameterScalar = opts?.particleDiameterScalar ?? 1.5;
  const lraSlack = opts?.longRangeStretchiness ?? 1.2;
  const layoutY = opts?.layoutY ?? 4.0;

  let vertices = mesh.vertices;
  let triangles = mesh.triangles;
  let edges = mesh.edges;
  let vertexPieceIds = mesh.vertexPieceIds;

  if (vertices.length < 3 || triangles.length < 3) {
    const fb = fallbackMesh();
    vertices = fb.vertices;
    triangles = fb.triangles;
    edges = fb.edges;
    vertexPieceIds = fb.vertexPieceIds;
  }

  const pieceIds =
    vertexPieceIds?.length === vertices.length
      ? vertexPieceIds.map((id) => id ?? FALLBACK_PIECE_ID)
      : vertices.map(() => FALLBACK_PIECE_ID);

  const { min, max } = boundsOf(vertices);
  const width = Math.max(max.x - min.x, 1);
  const height = Math.max(max.y - min.y, 1);
  const worldW = width * CM_TO_WORLD;
  const worldH = height * CM_TO_WORLD;
  const originX = -worldW * 0.5;
  const originZ = worldH * 0.5;

  const n = vertices.length;
  const positions = new Float32Array(n * 3);
  const initialPositions = new Float32Array(n * 3);
  const inverseMasses = new Float32Array(n);
  const radii = new Float32Array(n);
  const edgeLengths = new Float32Array(n);
  const particleMass = mass / Math.max(n, 1);
  const invMass = particleMass > 0 ? 1 / particleMass : 0;

  let avgEdge = 0;
  for (const [a, b] of edges) {
    avgEdge +=
      Math.hypot(vertices[a].x - vertices[b].x, vertices[a].y - vertices[b].y) * CM_TO_WORLD;
  }
  const avgEdgeLength = edges.length > 0 ? avgEdge / edges.length : 0.4;

  for (let i = 0; i < n; i++) {
    const p = vertices[i];
    const u = (p.x - min.x) / width;
    const v = (p.y - min.y) / height;
    const x = originX + u * worldW;
    const y = layoutY;
    const z = originZ - v * worldH;
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    initialPositions[i * 3] = x;
    initialPositions[i * 3 + 1] = y;
    initialPositions[i * 3 + 2] = z;
    inverseMasses[i] = invMass;
  }

  // Per-particle local edge length. A global average is wrong for strips that
  // mix long along-axis edges with very short cross-width edges, and it makes
  // the collision margin float or sink the strip.
  {
    const localSum = new Float32Array(n);
    const localCount = new Float32Array(n);
    const dist3 = (a: number, b: number): number =>
      Math.hypot(
        positions[a * 3] - positions[b * 3],
        positions[a * 3 + 1] - positions[b * 3 + 1],
        positions[a * 3 + 2] - positions[b * 3 + 2]
      );
    for (const [a, b] of edges) {
      const len = dist3(a, b);
      localSum[a] += len;
      localCount[a] += 1;
      localSum[b] += len;
      localCount[b] += 1;
    }
    for (let i = 0; i < n; i++) {
      const localAvg = localCount[i] > 0 ? localSum[i] / localCount[i] : avgEdgeLength;
      edgeLengths[i] = localAvg;
      radii[i] = localAvg * diameterScalar * 0.5;
    }
  }

  const stretch: StretchConstraint[] = [];
  for (const [a, b] of edges) {
    const dx = positions[a * 3] - positions[b * 3];
    const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
    const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
    const rest = Math.hypot(dx, dy, dz);
    stretch.push({ i: a, j: b, rest });
  }

  const bend = buildBendConstraints(positions, triangles);

  // Seams as pairwise distance constraints (not mutual stale-slot LRAs).
  const seamPairsRaw = resolveSeamParticlePairs(pattern ?? undefined, {
    ...mesh,
    vertices,
    triangles,
    edges,
    vertexPieceIds: pieceIds,
  });
  const seamPairs: Array<[number, number]> = [];
  const seamConstraints: SeamDistanceConstraint[] = [];
  // Non-seam attach slots reserved for future pin/LRA use.
  const lra: LraConstraint[] = [];
  const slotList: number[] = [];

  for (const pair of seamPairsRaw) {
    if (pair.a < 0 || pair.b < 0 || pair.a >= n || pair.b >= n) continue;
    if (pair.a === pair.b) continue;
    const ax = positions[pair.a * 3];
    const ay = positions[pair.a * 3 + 1];
    const az = positions[pair.a * 3 + 2];
    const bx = positions[pair.b * 3];
    const by = positions[pair.b * 3 + 1];
    const bz = positions[pair.b * 3 + 2];
    const initialDist = Math.hypot(ax - bx, ay - by, az - bz);
    // Small positive gap; lraSlack slightly loosens the final sew allowance.
    const targetRest = Math.max(1e-4, pair.restCm * CM_TO_WORLD * Math.max(1, lraSlack * 0.5 + 0.5));
    seamConstraints.push({
      i: pair.a,
      j: pair.b,
      rest: targetRest,
      initialDist: Math.max(initialDist, targetRest),
    });
    seamPairs.push([pair.a, pair.b]);
  }

  const { offsets, neighbors } = buildOneRing(n, edges);

  return {
    positions,
    initialPositions,
    inverseMasses,
    radii,
    edgeLengths,
    indices: new Uint32Array(triangles),
    vertexPieceIds: pieceIds,
    stretch,
    bend,
    attachSlots: new Float32Array(slotList),
    lra,
    seamConstraints,
    seamPairs,
    oneRingOffsets: offsets,
    oneRingNeighbors: neighbors,
    avgEdgeLength,
    particleMass,
    numParticles: n,
  };
}
