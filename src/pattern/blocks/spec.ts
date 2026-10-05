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

/**
 * A piece edge named by role and point key, before any ids are attached.
 *
 * `definitionId` names another block when the seam joins two of them — a bodice
 * front cannot be sewn to a back it does not know about. Left off, it means the
 * block the seam was declared on.
 */
export type BlockEdgeKey = {
  definitionId?: string;
  role: string;
  fromKey: string;
  toKey: string;
};

/** One seam a block wants made as soon as it can be. */
export type BlockSeamSpec = { a: BlockEdgeKey; b: BlockEdgeKey };

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
  /**
   * The seams this block wants, in point-key terms.
   *
   * A function of the variables rather than a fixed list, because how many
   * seams a skirt waist needs depends on how many darts it has: the waist is
   * sewn one edge per run *between* darts, since the notches are the darts
   * themselves and are sewn to each other, not to a band.
   */
  seams?(values: Record<string, number>): BlockSeamSpec[];
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

function specBounds(points: BlockPointSpec[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.anchor.x);
    minY = Math.min(minY, point.anchor.y);
    maxX = Math.max(maxX, point.anchor.x);
    maxY = Math.max(maxY, point.anchor.y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The opposite side of the same panel: a piece mirrored across a vertical axis
 * and set down clear of the original to its right.
 *
 * A block drafts *half* a body — the front is drawn from the centre front out to
 * the side seam, so on its own it is only ever half a garment. This is the other
 * half, and because it is produced by `build` rather than copied onto the canvas
 * it is regenerated with the variables like everything else, stays in step when
 * a measurement moves, and carries its own role so its ids never collide with
 * the piece it came from.
 *
 * The mirroring itself has to reverse the point order and swap each point's
 * handles. Reflecting the anchors alone still draws the right *shape*, but winds
 * it the other way round, which would leave every edge running backwards for
 * triangulation and for the sew tools.
 */
export function mirroredPiece(spec: BlockPieceSpec, role: string, gapCm: number): BlockPieceSpec {
  const box = specBounds(spec.points);
  const axis = (box.minX + box.maxX) / 2;
  const flip = (p: Vec2): Vec2 => ({ x: 2 * axis - p.x, y: p.y });

  const points: BlockPointSpec[] = spec.points
    .map((point) => ({
      ...point,
      anchor: flip(point.anchor),
      handleIn: point.handleIn ? flip(point.handleIn) : point.handleIn,
      handleOut: point.handleOut ? flip(point.handleOut) : point.handleOut,
    }))
    .reverse();
  for (const point of points) {
    const swap = point.handleIn;
    point.handleIn = point.handleOut;
    point.handleOut = swap;
  }

  // Butt it up against the original rather than leaving it on top of it.
  const mirrored = specBounds(points);
  const dx = box.maxX + gapCm - mirrored.minX;
  const shift = (p: Vec2): Vec2 => ({ x: p.x + dx, y: p.y });
  for (const point of points) {
    point.anchor = shift(point.anchor);
    if (point.handleIn) point.handleIn = shift(point.handleIn);
    if (point.handleOut) point.handleOut = shift(point.handleOut);
  }

  const grainline = spec.grainline
    ? { from: shift(flip(spec.grainline.from)), to: shift(flip(spec.grainline.to)) }
    : undefined;

  return { role, name: `${spec.name} (mirrored)`, points, grainline };
}
