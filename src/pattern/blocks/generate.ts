import type { BlockInstance, PatternDocument, PatternPiece, SeamEdgeRef, Vec2 } from '../../project/types';
import type { MeasurementSet } from '../../project/measurements';
import { defaultBindings, resolveBlockValues } from './resolve';
import {
  materializePiece,
  blockPieceId,
  blockPointId,
  type BlockDefinition,
  type BlockEdgeKey,
} from './spec';

/**
 * Turning a definition plus an instance into real pattern pieces.
 *
 * These are ordinary `PatternPiece`s appended to `pattern.pieces`, so meshing,
 * seams, knife, drape and export need no special case for blocks at all. The
 * only thing that makes them "generated" is that a `BlockInstance` claims them
 * and can rebuild them.
 */

export type GeneratedPiece = { role: string; piece: PatternPiece };

/** One seam a block wants made, as real edge references. */
export type GeneratedSeam = { a: SeamEdgeRef; b: SeamEdgeRef };

/** A block placed on the canvas: its instance and the definition behind it. */
export type PlacedBlock = { instance: BlockInstance; definition: BlockDefinition };

/**
 * The seams a block wants, with ids attached — and only the ones it can
 * actually make.
 *
 * `partner` finds the placed block of another definition, and returning null
 * drops the seam. That is what lets a bodice front and back each declare the
 * seam between them: the one placed first finds nothing on the other side and
 * quietly does nothing, and the one placed second makes every seam across the
 * pair. Two blocks of the same definition are not told apart — the first placed
 * is taken as the partner.
 *
 * Each edge is written the way the piece itself winds it, which is the only form
 * the rest of the app can read: `edgeIndexForPointIds` and everything built on
 * it — validity, sampling, connectors, the mesh — match `fromPointId` followed
 * by `toPointId` around the outline and call a reference named the other way
 * round stale.
 *
 * The direction the seam was declared in is carried by `t0`/`t1` instead. That
 * is what pairs the ends up, and it matters for the mirrored halves: a mirror is
 * wound in reverse, so the same edge is named backwards on it, and both sides of
 * a seam read from `fromKey` to `toKey` only if the reversed one is given a
 * span running 1 → 0.
 */
export function generateBlockSeams(
  definition: BlockDefinition,
  instance: BlockInstance,
  set: MeasurementSet | null | undefined,
  partner: (definitionId: string) => PlacedBlock | null
): GeneratedSeam[] {
  if (!definition.seams) return [];

  // Point keys per role, so an edge can be recognised whichever way it is named.
  const winding = new Map<string, string[]>();
  const keysFor = (def: BlockDefinition, source: BlockInstance, role: string): string[] => {
    const key = `${source.id}:${role}`;
    const hit = winding.get(key);
    if (hit) return hit;
    const spec = def
      .build(resolveBlockValues(def, source, set), { x: 0, y: 0 })
      .find((piece) => piece.role === role);
    const keys = spec ? spec.points.map((point) => point.key) : [];
    winding.set(key, keys);
    return keys;
  };

  const resolve = (edge: BlockEdgeKey): SeamEdgeRef | null => {
    const foreign = edge.definitionId && edge.definitionId !== definition.id;
    const other = foreign ? partner(edge.definitionId!) : null;
    if (foreign && !other) return null;
    const def = other?.definition ?? definition;
    const source = other?.instance ?? instance;

    const keys = keysFor(def, source, edge.role);
    const n = keys.length;
    if (n < 2) return null;
    const from = keys.indexOf(edge.fromKey);
    const to = keys.indexOf(edge.toKey);
    if (from < 0 || to < 0) return null;
    const forward = (from + 1) % n === to;
    const backward = (to + 1) % n === from;
    if (!forward && !backward) return null;

    // Ids in winding order, direction in the span. `t0` is whichever of the two
    // the span starts at, so each side of a seam runs fromKey → toKey.
    const [woundFrom, woundTo] = forward
      ? [edge.fromKey, edge.toKey]
      : [edge.toKey, edge.fromKey];
    return {
      pieceId: blockPieceId(source.id, edge.role),
      fromPointId: blockPointId(source.id, edge.role, woundFrom),
      toPointId: blockPointId(source.id, edge.role, woundTo),
      t0: forward ? 0 : 1,
      t1: forward ? 1 : 0,
    };
  };

  const values = resolveBlockValues(definition, instance, set);
  const out: GeneratedSeam[] = [];
  for (const seam of definition.seams(values)) {
    const a = resolve(seam.a);
    const b = resolve(seam.b);
    if (a && b) out.push({ a, b });
  }
  return out;
}

/** Rebuild a block's outlines from its resolved variables. */
export function generateBlockPieces(
  definition: BlockDefinition,
  instance: BlockInstance,
  set: MeasurementSet | null | undefined
): GeneratedPiece[] {
  const values = resolveBlockValues(definition, instance, set);
  return definition
    .build(values, instance.origin)
    .map((spec) => ({ role: spec.role, piece: materializePiece(spec, instance.id, spec.role) }));
}

let seq = 0;
function blockId(): string {
  seq += 1;
  return `blk_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** A fresh instance, bindings defaulted for this person. */
export function createBlockInstance(
  definition: BlockDefinition,
  origin: Vec2,
  personId: string | null,
  personName: string,
  set: MeasurementSet | null | undefined
): BlockInstance {
  return {
    id: blockId(),
    definitionId: definition.id,
    personId,
    personName,
    origin: { ...origin },
    bindings: defaultBindings(definition, set),
    pieces: [],
  };
}

/**
 * Splice a block's freshly generated pieces back into a pattern's piece list.
 *
 * Matching by id keeps the array stable and — because ids are deterministic —
 * means any `SeamBinding` referencing a block piece survives every regeneration.
 * Anything the block used to own but no longer produces is dropped.
 */
export function spliceBlockPieces(
  pieces: PatternPiece[],
  instance: BlockInstance,
  generated: GeneratedPiece[]
): { pieces: PatternPiece[]; ownership: BlockInstance['pieces'] } {
  const previous = new Set(instance.pieces.map((entry) => entry.pieceId));
  const live = new Set(generated.map((entry) => entry.piece.id));

  const next = pieces.filter((piece) => !previous.has(piece.id) || live.has(piece.id));
  for (const { piece } of generated) {
    const at = next.findIndex((existing) => existing.id === piece.id);
    if (at >= 0) next[at] = piece;
    else next.push(piece);
  }

  return {
    pieces: next,
    ownership: generated.map((entry) => ({ role: entry.role, pieceId: entry.piece.id })),
  };
}

/** Where to drop a new block so it does not land on top of existing pieces. */
export function nextBlockOrigin(
  pieces: PatternPiece[],
  fallback: Vec2,
  gapCm = 12
): Vec2 {
  let maxX = -Infinity;
  let minY = Infinity;
  for (const piece of pieces) {
    for (const point of piece.points) {
      if (point.anchor.x > maxX) maxX = point.anchor.x;
      if (point.anchor.y < minY) minY = point.anchor.y;
    }
  }
  if (!Number.isFinite(maxX) || !Number.isFinite(minY)) return { ...fallback };
  return { x: maxX + gapCm, y: minY };
}

/**
 * Rebuild every block in a pattern from its variables.
 *
 * Block pieces are *derived* data — the bindings are the truth and the outlines
 * are a cache. Storing the outlines is what makes meshing and drape fast, but it
 * means anything that changes how a definition resolves (a clamped-out-of-range
 * value, a corrected drafting rule, a new variable) would leave an existing
 * document drawing yesterday's shape forever. Regenerating on load keeps the
 * canvas, the inspector readouts and the schema in agreement.
 *
 * Ids are deterministic, so seams on a block survive untouched. Detached blocks
 * are no longer in `blocks` and are left exactly as they are.
 */
export function normalizeBlocks(
  pattern: Pick<PatternDocument, 'pieces' | 'blocks'>,
  lookup: (id: string) => BlockDefinition | null,
  setFor: (personId: string | null) => MeasurementSet | null | undefined
): void {
  const instances = pattern.blocks;
  if (!instances || instances.length === 0) return;
  for (const instance of instances) {
    const definition = lookup(instance.definitionId);
    if (!definition) continue;
    const generated = generateBlockPieces(definition, instance, setFor(instance.personId));
    const { pieces, ownership } = spliceBlockPieces(pattern.pieces, instance, generated);
    pattern.pieces = pieces;
    instance.pieces = ownership;
  }
}
