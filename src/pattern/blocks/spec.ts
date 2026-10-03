import type { BlockVariableDecl, PatternPiece, Vec2 } from '../../project/types';

/**
 * A block definition is the "component": declared local variables plus a pure
 * builder that turns resolved centimetre values into piece outlines.
 *
 * Nothing here knows about the DOM, the document, or where the instance sits —
 * `build` receives an origin and returns geometry in pattern space. That keeps
 * the drafts testable against the book's own figures.
 */

/** A point in a generated outline. `key` names it for stable id generation. */
export type BlockPointSpec = {
  key: string;
  anchor: Vec2;
  handleIn?: Vec2 | null;
  handleOut?: Vec2 | null;
  handlesParallel?: boolean;
};

export type BlockPieceSpec = {
  /** Stable per-definition role, e.g. 'front', 'back', 'band'. */
  role: string;
  name: string;
  /** Blocks are always closed outlines. */
  points: BlockPointSpec[];
  grainline?: { from: Vec2; to: Vec2 };
};

export type BlockCategory = 'bodice' | 'skirt';

export type BlockDefinition = {
  id: string;
  name: string;
  category: BlockCategory;
  description: string;
  /** Where the construction comes from, for the inspector's footnote. */
  source?: string;
  /** Editable numbers, in the order the inspector should list them. */
  variables: BlockVariableDecl[];
  /** Roles in paint order — also the order pieces are added to the pattern. */
  roles: string[];
  /** Pure: resolved centimetre values plus a top-left origin → outlines. */
  build(values: Record<string, number>, origin: Vec2): BlockPieceSpec[];
};

/**
 * Deterministic ids. Regeneration must not renumber pieces or points, because
 * `SeamBinding` keys on `pieceId + fromPointId + toPointId` — fresh ids would
 * silently orphan every seam on the block.
 */
export function blockPieceId(instanceId: string, role: string): string {
  return `${instanceId}:${role}`;
}

export function blockPointId(instanceId: string, role: string, key: string): string {
  return `${instanceId}:${role}:${key}`;
}

/** Wrap a point spec into a pattern point with its durable id. */
export function materializePiece(
  spec: BlockPieceSpec,
  instanceId: string,
  fallbackName: string
): PatternPiece {
  return {
    id: blockPieceId(instanceId, spec.role),
    name: spec.name || fallbackName,
    closed: true,
    points: spec.points.map((p) => ({
      id: blockPointId(instanceId, spec.role, p.key),
      anchor: { ...p.anchor },
      handleIn: p.handleIn ? { ...p.handleIn } : null,
      handleOut: p.handleOut ? { ...p.handleOut } : null,
      handlesParallel: p.handlesParallel ?? false,
    })),
    grainline: spec.grainline
      ? { from: { ...spec.grainline.from }, to: { ...spec.grainline.to } }
      : undefined,
  };
}
