import type { PieceTransform3d } from '../project/types';
import type { ClothSimulator } from './ClothSimulator';
import { FALLBACK_PIECE_ID } from './meshTopology';

export function clonePieceTransform(t: PieceTransform3d): PieceTransform3d {
  return {
    position: [...t.position] as [number, number, number],
    rotationDeg: [...t.rotationDeg] as [number, number, number],
    rotationQuat: t.rotationQuat
      ? ([...t.rotationQuat] as [number, number, number, number])
      : undefined,
  };
}

/**
 * Retain per-piece placements across a remesh by matching the piece's durable
 * unique id (the pattern piece id baked into the mesh's `vertexPieceIds`).
 *
 * - Pieces that still exist keep their transform **exactly**.
 * - Pieces that were deleted simply drop out; every other piece is untouched.
 * - Pieces that were *replaced* by new ids (e.g. a knife cut) hand their
 *   orientation down to their successors via `successors`, so the arrangement
 *   isn't thrown away. Successors keep their own laid-out position.
 * - A whole *other* pattern (a duplicated node plugged into a different one):
 *   not one of the saved ids is on the cloth any more, so the arrangement is
 *   carried across piece for piece in the order the pieces are laid out — the
 *   first piece of the new pattern takes the first piece's placement, the second
 *   the second's, and so on — rather than being dropped for want of an id.
 * - Legacy `__cloth__` entries (meshes predating per-vertex piece ownership)
 *   are migrated/distributed as before.
 */
export function keepPieceTransforms(
  pieceTransforms: Record<string, PieceTransform3d>,
  liveIds: string[],
  cloth: ClothSimulator,
  successors?: Record<string, string[]>
): Record<string, PieceTransform3d> {
  const live = new Set(liveIds);
  const kept: Record<string, PieceTransform3d> = {};
  let matched = 0;

  for (const [pieceId, t] of Object.entries(pieceTransforms)) {
    if (pieceId === FALLBACK_PIECE_ID) continue;
    if (live.has(pieceId)) {
      kept[pieceId] = clonePieceTransform(t);
      matched++;
      continue;
    }
    const childIds = successors?.[pieceId];
    if (!childIds) continue;
    for (const childId of childIds) {
      if (!live.has(childId) || kept[childId]) continue;
      // Inherit the parent's orientation, but keep the successor at its own
      // laid-out position (two halves of a cut must not land on top of one another).
      kept[childId] = {
        position: cloth.getPieceCentroidTuple(childId),
        rotationDeg: [...t.rotationDeg] as [number, number, number],
        rotationQuat: t.rotationQuat
          ? ([...t.rotationQuat] as [number, number, number, number])
          : undefined,
      };
    }
  }

  // Nothing was recognised at all: this is another pattern rather than the same
  // one rebuilt, so pair the two orders up and carry the arrangement over. Left
  // alone when *any* id matched, so adding a piece to a pattern still leaves that
  // piece at its laid-out position instead of inheriting a deleted one's.
  if (matched === 0 && Object.keys(kept).length === 0) {
    const saved = Object.keys(pieceTransforms).filter((id) => id !== FALLBACK_PIECE_ID);
    // Only real pieces are paired: a cloth with no per-vertex ownership has
    // nothing to line an arrangement up against, and is left to the whole-cloth
    // handling below.
    const order = liveIds.filter((id) => id !== FALLBACK_PIECE_ID);
    const pairs = Math.min(saved.length, order.length);
    for (let i = 0; i < pairs; i++) {
      kept[order[i]] = clonePieceTransform(pieceTransforms[saved[i]]);
    }
    if (pairs > 0) return kept;
  }

  const fallback = pieceTransforms[FALLBACK_PIECE_ID];
  if (!fallback || live.has(FALLBACK_PIECE_ID)) return kept;
  if (Object.keys(kept).length > 0) return kept;

  if (liveIds.length === 1) {
    kept[liveIds[0]] = clonePieceTransform(fallback);
    return kept;
  }

  // Whole-cloth arrangement → distribute the same rotation and group translation
  // across pieces (rest layout is already the post-remesh flat pose).
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const id of liveIds) {
    const c = cloth.getPieceCentroidTuple(id);
    cx += c[0];
    cy += c[1];
    cz += c[2];
  }
  const n = Math.max(liveIds.length, 1);
  const dx = fallback.position[0] - cx / n;
  const dy = fallback.position[1] - cy / n;
  const dz = fallback.position[2] - cz / n;
  for (const id of liveIds) {
    const c = cloth.getPieceCentroidTuple(id);
    kept[id] = {
      position: [c[0] + dx, c[1] + dy, c[2] + dz],
      rotationDeg: [...fallback.rotationDeg] as [number, number, number],
      rotationQuat: fallback.rotationQuat
        ? ([...fallback.rotationQuat] as [number, number, number, number])
        : undefined,
    };
  }
  return kept;
}

/**
 * Does this saved arrangement belong to the pieces now on the cloth? True while
 * any saved piece id is still there, and true for a record with nothing saved per
 * piece (a legacy whole-cloth arrangement, which has no ids to go on).
 *
 * A stored *vertex pose* is only worth a look when this is true: vertex i of
 * another pattern is a different point on a different panel, so a pose with the
 * same vertex count and no piece in common is not a starting position, it is a
 * pastiche of one.
 */
export function arrangementBelongsTo(
  pieceTransforms: Record<string, PieceTransform3d>,
  liveIds: readonly string[]
): boolean {
  const live = new Set(liveIds);
  let savedPerPiece = 0;
  for (const id of Object.keys(pieceTransforms)) {
    if (id === FALLBACK_PIECE_ID) continue;
    savedPerPiece++;
    if (live.has(id)) return true;
  }
  return savedPerPiece === 0;
}

/**
 * Record that `parentId` was replaced by `childIds` (e.g. a cut). Used so the
 * arrangement follows the geometry through structural pattern edits. Returns a
 * new map — callers assign it back to the pattern document.
 */
export function recordPieceSuccessors(
  successors: Record<string, string[]> | undefined,
  parentId: string,
  childIds: string[]
): Record<string, string[]> {
  const next: Record<string, string[]> = { ...(successors ?? {}) };
  next[parentId] = [...new Set(childIds)].filter((id) => id !== parentId);
  return next;
}
