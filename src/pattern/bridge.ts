import type { BezierPoint, PatternPiece, SeamEdgeRef, Vec2 } from '../project/types';
import { pieceToPolyline, pointInPolygon } from './geometry';
import { joinRunOf, reverseWalk, ringWalk, type JoinRun } from './join';
import { isSimpleRing, joinRing, polygonArea, type RingDraft } from './ringDraft';

/**
 * Bridging two pattern pieces: the join tool's neighbour, for the case where
 * neither piece may move.
 *
 * A fuse drags one outline onto the other. A bridge leaves both outlines
 * exactly where the draftsperson put them and closes the gap between two picked
 * runs with a straight edge at each end of the runs, so the area in between
 * becomes part of one piece with them. Nothing is warped or scaled: every point
 * keeps its anchor and its handles, both pieces keep their shape, and the
 * picked edges become interior — the bridge is what the outline runs through.
 *
 * As with a fuse, the two runs meet end to end in only two ways, and which one
 * closes the outline cleanly depends on how the two pieces are wound. Both are
 * tried and the one whose outline does not cross itself wins.
 *
 * Both runs may also be on the *same* piece. Then the two runs leave two arcs of
 * its outline between them, and the one the bridge is not drawn across is what
 * the piece gains: the area between the runs becomes part of the piece, closed
 * off by a single straight edge, and the outline between them goes interior —
 * the way a bay or a notch in a panel is filled in.
 */

export type BridgeResult =
  | {
      ok: true;
      /** The bridged piece — it keeps the second piece's identity. */
      piece: PatternPiece;
      /**
       * The first piece, whose outline is now part of the bridged one, or null
       * when both runs were picked on one piece, which therefore just grew.
       */
      bridgedPieceId: string | null;
      /**
       * Point ids folded onto a neighbour where two joints met at the same spot
       * (the halves of a knife cut, say). A seam that named one of these still
       * describes a real edge, so it is worth following the alias.
       */
      idAliases: Record<string, string>;
    }
  | { ok: false; reason: string };

type Candidate = {
  ring: BezierPoint[];
  idAliases: Record<string, string>;
  area: number;
  simple: boolean;
};

/** A draft outline judged as a finished one: its area, and whether it crosses itself. */
function candidate(ring: RingDraft): Candidate {
  const poly = pieceToPolyline(ring.ring, true, 10);
  return {
    ring: ring.ring,
    idAliases: ring.idAliases,
    area: polygonArea(poly),
    simple: isSimpleRing(poly),
  };
}

function signedArea(points: readonly BezierPoint[]): number {
  return polygonArea(points.map((point) => point.anchor));
}

/**
 * Bridge `first` and `second` along the picked edges without moving either.
 * The result keeps the second piece's id and name; the first piece stops
 * existing as a piece of its own.
 */
export function bridgePieces(
  first: PatternPiece,
  firstRefs: readonly SeamEdgeRef[],
  second: PatternPiece,
  secondRefs: readonly SeamEdgeRef[]
): BridgeResult {
  if (first.id === second.id) return bridgeWithinPiece(first, firstRefs, secondRefs);

  const firstRun = joinRunOf(first, firstRefs);
  if (!firstRun.ok) return { ok: false, reason: `First piece: ${firstRun.reason}` };
  const secondRun = joinRunOf(second, secondRefs);
  if (!secondRun.ok) return { ok: false, reason: `Second piece: ${secondRun.reason}` };

  const firstKeep = keepOf(first, firstRun.run);
  const secondKeep = keepOf(second, secondRun.run);
  if (firstKeep.length < 2 || secondKeep.length < 2) {
    return { ok: false, reason: 'Leave each piece an edge to keep' };
  }

  const firstArea = polygonArea(first.points.map((point) => point.anchor));
  const secondArea = polygonArea(second.points.map((point) => point.anchor));
  const candidates = [
    candidate(joinRing([firstKeep, secondKeep])),
    candidate(joinRing([firstKeep, reverseWalk(secondKeep)])),
  ];

  const wanted = Math.max(Math.abs(firstArea), Math.abs(secondArea));
  const usable = candidates.filter(
    (option) =>
      option.simple &&
      Math.sign(option.area) === Math.sign(firstArea) &&
      Math.abs(option.area) >= wanted - 1e-6
  );
  if (usable.length === 0) {
    const crossed = candidates.some((option) => !option.simple);
    return {
      ok: false,
      reason: crossed
        ? 'That bridge would cross itself — pick runs that face each other'
        : 'That bridge would not close around both pieces',
    };
  }
  const pick = usable.reduce((best, option) =>
    Math.abs(option.area) > Math.abs(best.area) ? option : best
  );

  const piece: PatternPiece = {
    ...second,
    points: pick.ring,
    grainline: pickGrainline(pick.ring, second.grainline, first.grainline),
  };
  return { ok: true, piece, bridgedPieceId: first.id, idAliases: pick.idAliases };
}

/**
 * Bridge two runs of one piece's outline, filling the bay between them.
 *
 * Cutting the outline at both runs leaves two arcs. The bridge is drawn across
 * one of them — a single straight edge from that arc's end back to where it
 * started — and the other arc goes interior with the runs, so the piece grows to
 * hold whatever lay between the runs. Which arc that is depends on which of them
 * the runs face each other across, so both are tried and the one that leaves the
 * piece bigger than it was is the fill; the other is always a cut-off piece of
 * the outline itself, never a fill.
 */
function bridgeWithinPiece(
  piece: PatternPiece,
  firstRefs: readonly SeamEdgeRef[],
  secondRefs: readonly SeamEdgeRef[]
): BridgeResult {
  const firstRun = joinRunOf(piece, firstRefs);
  if (!firstRun.ok) return { ok: false, reason: `First run: ${firstRun.reason}` };
  const secondRun = joinRunOf(piece, secondRefs);
  if (!secondRun.ok) return { ok: false, reason: `Second run: ${secondRun.reason}` };

  const shared = edgesOf(piece, firstRun.run).filter((index) =>
    edgesOf(piece, secondRun.run).includes(index)
  );
  if (shared.length > 0) {
    return {
      ok: false,
      reason: 'Those runs share an edge — pick two runs with the bay between them',
    };
  }

  // Runs that meet at a vertex leave one arc empty, and that arc is the bridge
  // itself — there is nothing to draw it across, so only the other one counts.
  const arcs = [
    arcBetween(piece, firstRun.run, secondRun.run),
    arcBetween(piece, secondRun.run, firstRun.run),
  ].filter((arc) => arc.length >= 2);
  if (arcs.length === 0) {
    return { ok: false, reason: 'Leave the piece an edge to keep' };
  }

  const pieceArea = signedArea(piece.points);
  const candidates = arcs.map((arc) => candidate(joinRing([arc])));
  const usable = candidates.filter(
    (option) =>
      option.simple &&
      Math.sign(option.area) === Math.sign(pieceArea) &&
      Math.abs(option.area) > Math.abs(pieceArea) + 1e-6
  );
  if (usable.length === 0) {
    const crossed = candidates.some((option) => !option.simple);
    return {
      ok: false,
      reason: crossed
        ? 'That bridge would cross itself — pick runs that face each other across the bay'
        : 'There is no bay between those runs to fill',
    };
  }
  const pick = usable.reduce((best, option) =>
    Math.abs(option.area) > Math.abs(best.area) ? option : best
  );

  return {
    ok: true,
    piece: {
      ...piece,
      points: pick.ring,
      grainline: pickGrainline(pick.ring, piece.grainline, undefined),
    },
    bridgedPieceId: null,
    idAliases: pick.idAliases,
  };
}

/** The arc of the outline that runs from one run's end to the next run's start. */
function arcBetween(piece: PatternPiece, from: JoinRun, to: JoinRun): BezierPoint[] {
  return ringWalk(
    piece.points,
    from.vertexIndices[from.edgeCount],
    to.vertexIndices[0]
  );
}

/** Which edges of the piece a run covers, as winding indices. */
function edgesOf(piece: PatternPiece, run: JoinRun): number[] {
  const n = piece.points.length;
  return run.vertexIndices.slice(0, run.edgeCount).map((index) => index % n);
}

/** The part of a piece's outline a run leaves: walked the piece's way, both ends in. */
function keepOf(piece: PatternPiece, run: JoinRun): BezierPoint[] {
  return ringWalk(piece.points, run.vertexIndices[run.edgeCount], run.vertexIndices[0]);
}

/** The second piece's grainline if the bridge still covers it, else the first's. */
function pickGrainline(
  ring: BezierPoint[],
  preferred: PatternPiece['grainline'],
  fallback: PatternPiece['grainline']
): PatternPiece['grainline'] {
  const poly = pieceToPolyline(ring, true);
  const inside = (line: PatternPiece['grainline']): boolean =>
    !!line &&
    pointInPolygon({ x: (line.from.x + line.to.x) / 2, y: (line.from.y + line.to.y) / 2 }, poly);
  const asCopy = (line: PatternPiece['grainline']): PatternPiece['grainline'] =>
    line ? { from: { ...line.from }, to: { ...line.to } } : undefined;
  if (inside(preferred)) return asCopy(preferred);
  if (inside(fallback)) return asCopy(fallback);
  return undefined;
}
