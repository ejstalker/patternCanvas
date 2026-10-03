import type { BlockInstance, PatternDocument, PatternPiece, Vec2 } from '../../project/types';
import type { MeasurementSet } from '../../project/measurements';
import { defaultBindings, resolveBlockValues } from './resolve';
import { materializePiece, type BlockDefinition } from './spec';

/**
 * Turning a definition plus an instance into real pattern pieces.
 *
 * These are ordinary `PatternPiece`s appended to `pattern.pieces`, so meshing,
 * seams, knife, drape and export need no special case for blocks at all. The
 * only thing that makes them "generated" is that a `BlockInstance` claims them
 * and can rebuild them.
 */

export type GeneratedPiece = { role: string; piece: PatternPiece };

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
