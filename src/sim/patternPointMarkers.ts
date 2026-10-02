import type { MeshGeometry, PatternDocument, Vec2 } from '../project/types';

/** A pattern bezier anchor paired with the cloth vertex that best represents it. */
export type PatternPointMarker = {
  /** Piece the anchor belongs to. */
  pieceId: string;
  /** `BezierPoint.id` of the anchor. */
  pointId: string;
  /** Index into `MeshGeometry.vertices` / the cloth particle array. */
  vertexIndex: number;
  /** Anchor position in pattern space (cm). */
  anchor: Vec2;
};

/** Compressed sparse row table of the triangles incident on each vertex. */
export type IncidentTriangles = {
  /** Length `vertexCount + 1`; vertex `v` owns triangles `tris[offsets[v]..offsets[v+1])`. */
  offsets: Uint32Array;
  /** Triangle indices (0-based, not element offsets). */
  tris: Uint32Array;
};

/**
 * For every pattern anchor, pick the mesh vertex nearest to it (restricted to the
 * piece it came from). Coincident anchors sharing a vertex keep only the first —
 * stacking identical markers would be unclickable.
 */
export function buildPatternPointMarkers(
  mesh: MeshGeometry | null | undefined,
  pattern: PatternDocument | null | undefined
): PatternPointMarker[] {
  const markers: PatternPointMarker[] = [];
  if (!mesh || !pattern) return markers;
  const verts = mesh.vertices;
  if (!verts || verts.length === 0) return markers;

  // Bucket vertices per piece so anchors only snap within their own piece.
  const byPiece = new Map<string, number[]>();
  const pieceIds = mesh.vertexPieceIds;
  for (let i = 0; i < verts.length; i++) {
    const pid = pieceIds?.[i] ?? '';
    let bucket = byPiece.get(pid);
    if (!bucket) {
      bucket = [];
      byPiece.set(pid, bucket);
    }
    bucket.push(i);
  }

  const used = new Set<number>();
  for (const piece of pattern.pieces) {
    const scoped = byPiece.get(piece.id);
    const candidates = scoped && scoped.length ? scoped : null;
    for (const point of piece.points) {
      const anchor = point.anchor;
      let best = -1;
      let bestD2 = Number.POSITIVE_INFINITY;
      if (candidates) {
        for (const vi of candidates) {
          if (used.has(vi)) continue;
          const v = verts[vi];
          const dx = v.x - anchor.x;
          const dy = v.y - anchor.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = vi;
          }
        }
      }
      if (best < 0) {
        // Piece has no tagged vertices (or they were all taken) — fall back to a
        // global search so the marker still lands somewhere sensible.
        for (let vi = 0; vi < verts.length; vi++) {
          if (used.has(vi)) continue;
          const v = verts[vi];
          const dx = v.x - anchor.x;
          const dy = v.y - anchor.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = vi;
          }
        }
      }
      if (best < 0) continue;
      used.add(best);
      markers.push({
        pieceId: piece.id,
        pointId: point.id,
        vertexIndex: best,
        anchor: { x: anchor.x, y: anchor.y },
      });
    }
  }
  return markers;
}

/** Build the vertex → incident-triangle table used for normal-based culling. */
export function buildIncidentTriangles(
  indices: ArrayLike<number> | null | undefined,
  vertexCount: number
): IncidentTriangles {
  const triCount = indices ? Math.floor(indices.length / 3) : 0;
  const counts = new Uint32Array(vertexCount + 1);
  const safeVertex = (v: number): number =>
    Number.isInteger(v) && v >= 0 && v < vertexCount ? v : -1;

  for (let t = 0; t < triCount; t++) {
    const i0 = safeVertex(indices![t * 3]);
    const i1 = safeVertex(indices![t * 3 + 1]);
    const i2 = safeVertex(indices![t * 3 + 2]);
    if (i0 < 0 || i1 < 0 || i2 < 0) continue;
    counts[i0]++;
    counts[i1]++;
    counts[i2]++;
  }

  const offsets = new Uint32Array(vertexCount + 1);
  let running = 0;
  for (let v = 0; v < vertexCount; v++) {
    offsets[v] = running;
    running += counts[v];
  }
  offsets[vertexCount] = running;

  const cursor = offsets.slice(0, vertexCount);
  const tris = new Uint32Array(running);
  for (let t = 0; t < triCount; t++) {
    const i0 = safeVertex(indices![t * 3]);
    const i1 = safeVertex(indices![t * 3 + 1]);
    const i2 = safeVertex(indices![t * 3 + 2]);
    if (i0 < 0 || i1 < 0 || i2 < 0) continue;
    tris[cursor[i0]++] = t;
    tris[cursor[i1]++] = t;
    tris[cursor[i2]++] = t;
  }

  return { offsets, tris };
}

/**
 * Area-weighted vertex normal from the current positions. Returns false when the
 * vertex has no usable incident triangle or the accumulated normal degenerates.
 */
export function computeVertexNormal(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  incident: IncidentTriangles,
  vertexIndex: number,
  out: Float32Array
): boolean {
  if (vertexIndex < 0 || vertexIndex + 1 >= incident.offsets.length) return false;
  const start = incident.offsets[vertexIndex];
  const end = incident.offsets[vertexIndex + 1];
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let k = start; k < end; k++) {
    const t = incident.tris[k];
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;
    const ax = positions[i1 * 3];
    const ay = positions[i1 * 3 + 1];
    const az = positions[i1 * 3 + 2];
    const bx = positions[i2 * 3];
    const by = positions[i2 * 3 + 1];
    const bz = positions[i2 * 3 + 2];
    const cx = positions[i0 * 3];
    const cy = positions[i0 * 3 + 1];
    const cz = positions[i0 * 3 + 2];
    if (
      ax === undefined || ay === undefined || az === undefined ||
      bx === undefined || by === undefined || bz === undefined ||
      cx === undefined || cy === undefined || cz === undefined
    ) {
      continue;
    }
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    nx += e1y * e2z - e1z * e2y;
    ny += e1z * e2x - e1x * e2z;
    nz += e1x * e2y - e1y * e2x;
  }
  const len = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(len) || len < 1e-12) return false;
  out[0] = nx / len;
  out[1] = ny / len;
  out[2] = nz / len;
  return true;
}

/**
 * Cheap visibility test: does the surface around this vertex face the camera?
 * Deliberately ignores occlusion by other parts of the cloth.
 */
export function markerFacesCamera(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  incident: IncidentTriangles,
  vertexIndex: number,
  eye: ArrayLike<number>,
  normalScratch: Float32Array,
  /** Global orientation fix-up (+1/-1) for meshes whose winding is inverted. */
  normalSign = 1
): boolean {
  if (!computeVertexNormal(positions, indices, incident, vertexIndex, normalScratch)) {
    // No usable normal (isolated/degenerate vertex) — keep it so it stays clickable.
    return true;
  }
  const px = positions[vertexIndex * 3];
  const py = positions[vertexIndex * 3 + 1];
  const pz = positions[vertexIndex * 3 + 2];
  if (px === undefined || py === undefined || pz === undefined) return false;
  return (
    normalSign *
      (normalScratch[0] * (eye[0] - px) +
        normalScratch[1] * (eye[1] - py) +
        normalScratch[2] * (eye[2] - pz)) >
    0
  );
}
