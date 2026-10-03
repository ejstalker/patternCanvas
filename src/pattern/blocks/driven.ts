import type { BlockInstance, BlockVariableDecl, Vec2 } from '../../project/types';
import type { MeasurementSet } from '../../project/measurements';
import { generateBlockPieces, type GeneratedPiece } from './generate';
import { clampToDeclared, resolveBlockValues } from './resolve';
import type { BlockDefinition } from './spec';

/**
 * Which points a variable actually controls.
 *
 * Annotating every point of every draft with the variables that feed it is both
 * tedious and fragile — the annotation rots the moment a construction is
 * corrected, and the inspector would then highlight a lie. So we ask the builder
 * instead: resolve the block, resolve it again with this one variable moved, and
 * every point that moved is a point this number drives. Definitions nobody has
 * written yet get the behaviour for free.
 */

/** Below this nothing meaningfully moved — 0.2 mm, well under drafting noise. */
const MOVED_EPSILON_CM = 0.02;

/**
 * The values to try. Deliberately several, including both extremes.
 *
 * A single small nudge answers "what does the next click on the spinner move",
 * which is not the question. `lift = max(0, sideHipDepth - hipDepth)` is the
 * standing example: side hip depth below centre hip depth is clamped away, so a
 * nudge shows nothing at all even though the variable plainly controls the side
 * waist. Asking at the bounds as well answers the question that was actually
 * meant — *what can this number influence* — and errs toward showing more.
 */
function probeValues(variable: BlockVariableDecl, current: number): number[] {
  const candidates: number[] = [variable.minCm, variable.maxCm];
  if (variable.kind === 'count') {
    // Counts change how many darts a panel has, so only whole numbers mean
    // anything.
    candidates.push(Math.round(current) + 1, Math.round(current) - 1);
  } else if (variable.kind === 'factor') {
    // A 0–1 shaping control has its whole range inside the bounds above, so it
    // needs a wiggle in the middle rather than a bigger one.
    candidates.push(current + 0.2, current - 0.2);
  } else {
    const delta = Math.max(1, (variable.maxCm - variable.minCm) * 0.05);
    candidates.push(current + delta, current - delta);
  }

  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of candidates) {
    const value = clampToDeclared(variable, raw);
    if (Math.abs(value - current) < 1e-9) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Record every point the probe moved.
 *
 * Handles count, not just anchors: a curvature control leaves both endpoints
 * exactly where they were and only bends the curve between them, and an
 * inspector that answered "nothing moved" for the neckline curve would be
 * actively misleading.
 */
function collectMoved(
  anchors: Map<string, Pt>,
  probed: GeneratedPiece[],
  into: Set<string>
): void {
  for (const { piece } of probed) {
    for (const point of piece.points) {
      const was = anchors.get(point.id);
      if (
        !was ||
        moved(was.anchor, point.anchor) ||
        moved(was.handleIn, point.handleIn) ||
        moved(was.handleOut, point.handleOut)
      ) {
        into.add(point.id);
      }
    }
  }
}

function moved(a: Vec2 | null | undefined, b: Vec2 | null | undefined): boolean {
  if (!a || !b) return Boolean(a) !== Boolean(b);
  return Math.abs(a.x - b.x) > MOVED_EPSILON_CM || Math.abs(a.y - b.y) > MOVED_EPSILON_CM;
}

type Pt = { anchor: Vec2; handleIn?: Vec2 | null; handleOut?: Vec2 | null };

function indexAnchors(pieces: GeneratedPiece[]): Map<string, Pt> {
  const anchors = new Map<string, Pt>();
  for (const { piece } of pieces) {
    for (const point of piece.points) {
      anchors.set(point.id, {
        anchor: point.anchor,
        handleIn: point.handleIn,
        handleOut: point.handleOut,
      });
    }
  }
  return anchors;
}

/**
 * The ids of every point the variable moves, under any probe.
 *
 * `null` means the question could not be asked — an unknown variable, or one
 * pinned so hard that no legal value differs from the current one. Callers
 * should read that as "highlight nothing" rather than "highlight everything".
 * An empty set is different, and honest: the variable exists but currently has
 * no effect on the outline at all.
 */
export function drivenPointIds(
  definition: BlockDefinition,
  instance: BlockInstance,
  set: MeasurementSet | null | undefined,
  varId: string
): Set<string> | null {
  const variable = definition.variables.find((v) => v.id === varId);
  if (!variable) return null;

  const values = resolveBlockValues(definition, instance, set);
  const current = values[varId];
  if (current == null) return null;
  const probes = probeValues(variable, current);
  if (probes.length === 0) return null;

  const anchors = indexAnchors(generateBlockPieces(definition, instance, set));
  const driven = new Set<string>();
  for (const probe of probes) {
    collectMoved(
      anchors,
      generateBlockPieces(
        definition,
        { ...instance, bindings: { ...instance.bindings, [varId]: { mode: 'value', cm: probe } } },
        set
      ),
      driven
    );
  }

  // A count changes how many points a panel has, so a probe can name points the
  // block does not currently own. Those cannot be drawn, and naming them would
  // invite a caller to look up something that is not there.
  for (const id of [...driven]) {
    if (!anchors.has(id)) driven.delete(id);
  }
  return driven;
}
