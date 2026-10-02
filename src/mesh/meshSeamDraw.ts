import {
  buildEdgeArcTable,
  edgeArcLengthBetweenParams,
  isSeamEdgeValid,
  pointOnEdgeAtArcFractionInSpan,
  sampleEdgeByPointIds,
  sampleEdgeSpanByPointIds,
} from '../pattern/geometry';
import type {
  MeshGeometry,
  PatternDocument,
  PatternPiece,
  SeamBinding,
  SeamEdgeRef,
  SeamVertexTag,
  Vec2,
} from '../project/types';

function tagMatchesTopology(tag: SeamVertexTag, ref: SeamEdgeRef): boolean {
  return (
    tag.pieceId === ref.pieceId &&
    tag.fromPointId === ref.fromPointId &&
    tag.toPointId === ref.toPointId
  );
}

function edgeInAnySeamSpan(
  refs: SeamEdgeRef[],
  tagA: SeamVertexTag,
  tagB: SeamVertexTag
): boolean {
  for (const ref of refs) {
    if (!tagMatchesTopology(tagA, ref) || !tagMatchesTopology(tagB, ref)) continue;
    const lo = Math.min(ref.t0, ref.t1);
    const hi = Math.max(ref.t0, ref.t1);
    const tMin = Math.min(tagA.t, tagB.t);
    const tMax = Math.max(tagA.t, tagB.t);
    if (tMax >= lo - 1e-5 && tMin <= hi + 1e-5) return true;
  }
  return false;
}

function sampleSeamRefPoints(piece: PatternPiece, ref: SeamEdgeRef): Vec2[] | null {
  const isPartial =
    Math.abs(ref.t0 - ref.t1) > 1e-5 && !(ref.t0 === 0 && ref.t1 === 1);
  let samples: Vec2[] | null = null;
  if (isPartial) {
    samples = sampleEdgeSpanByPointIds(piece, ref.fromPointId, ref.toPointId, ref.t0, ref.t1, 20);
  }
  samples ??= sampleEdgeByPointIds(piece, ref.fromPointId, ref.toPointId, 20);
  if (!samples || samples.length < 2) return null;
  return ref.t0 > ref.t1 ? [...samples].reverse() : samples;
}

function appendPolylinePath(
  svg: SVGSVGElement,
  points: Vec2[],
  className: string,
  strokeWidth: number,
  dash?: string
): void {
  if (points.length < 2) return;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`;
  path.setAttribute('d', d);
  path.setAttribute('class', className);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-width', String(strokeWidth));
  path.setAttribute('pointer-events', 'none');
  if (dash) path.setAttribute('stroke-dasharray', dash);
  svg.appendChild(path);
}

function appendSeamNotch(svg: SVGSVGElement, points: Vec2[]): void {
  if (points.length < 2) return;
  const midIdx = Math.floor(points.length / 2);
  const a = points[Math.max(0, midIdx - 1)];
  const b = points[Math.min(points.length - 1, midIdx + 1)];
  const tx = b.x - a.x;
  const ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  const ux = tx / len;
  const uy = ty / len;
  const nx = -uy;
  const ny = ux;
  const mid = points[midIdx];
  const notchLen = 0.9;
  const notchSw = 0.22;

  const notch = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  notch.setAttribute('x1', String(mid.x));
  notch.setAttribute('y1', String(mid.y));
  notch.setAttribute('x2', String(mid.x + nx * notchLen));
  notch.setAttribute('y2', String(mid.y + ny * notchLen));
  notch.setAttribute('class', 'mesh-seam-notch');
  notch.setAttribute('stroke-width', String(notchSw));
  notch.setAttribute('pointer-events', 'none');
  svg.appendChild(notch);

  const ah = 0.55;
  const tipPt = { x: mid.x + ux * ah, y: mid.y + uy * ah };
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  arrow.setAttribute(
    'points',
    `${mid.x - ux * ah * 0.3 + nx * ah * 0.45},${mid.y - uy * ah * 0.3 + ny * ah * 0.45} ${tipPt.x},${tipPt.y} ${mid.x - ux * ah * 0.3 - nx * ah * 0.45},${mid.y - uy * ah * 0.3 - ny * ah * 0.45}`
  );
  arrow.setAttribute('class', 'mesh-seam-notch');
  arrow.setAttribute('fill', 'none');
  arrow.setAttribute('stroke-width', String(notchSw));
  arrow.setAttribute('pointer-events', 'none');
  svg.appendChild(arrow);
}

function appendConnectorLine(
  svg: SVGSVGElement,
  a: Vec2,
  b: Vec2,
  className: string,
  strokeWidth: number,
  opacity = 0.6
): void {
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-3) return;
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', String(a.x));
  line.setAttribute('y1', String(a.y));
  line.setAttribute('x2', String(b.x));
  line.setAttribute('y2', String(b.y));
  line.setAttribute('class', className);
  line.setAttribute('stroke-width', String(strokeWidth));
  line.setAttribute('opacity', String(opacity));
  line.setAttribute('pointer-events', 'none');
  svg.appendChild(line);
}

function connectorLineCount(
  pieceA: PatternPiece,
  refA: SeamEdgeRef,
  pieceB: PatternPiece,
  refB: SeamEdgeRef,
  override?: number
): number {
  if (override != null && override >= 2) return Math.min(16, Math.floor(override));
  const lenA = edgeArcLengthBetweenParams(
    pieceA,
    refA.fromPointId,
    refA.toPointId,
    refA.t0,
    refA.t1
  );
  const lenB = edgeArcLengthBetweenParams(
    pieceB,
    refB.fromPointId,
    refB.toPointId,
    refB.t0,
    refB.t1
  );
  const span = Math.min(lenA, lenB);
  if (span <= 1e-6) return 2;
  return Math.max(3, Math.min(12, Math.round(span / 2) + 1));
}

/** Arc-length matched points along a seam binding (for direction visualization). */
export function buildSeamConnectorPointPairs(
  pieceA: PatternPiece,
  refA: SeamEdgeRef,
  pieceB: PatternPiece,
  refB: SeamEdgeRef,
  lineCount?: number
): Array<[Vec2, Vec2]> {
  const count = connectorLineCount(pieceA, refA, pieceB, refB, lineCount);
  const tableA = buildEdgeArcTable(pieceA, refA.fromPointId, refA.toPointId);
  const tableB = buildEdgeArcTable(pieceB, refB.fromPointId, refB.toPointId);
  if (!tableA || !tableB) return [];

  const pairs: Array<[Vec2, Vec2]> = [];
  for (let i = 0; i < count; i++) {
    const s = count === 1 ? 0.5 : i / (count - 1);
    const hitA = pointOnEdgeAtArcFractionInSpan(
      pieceA,
      refA.fromPointId,
      refA.toPointId,
      refA.t0,
      refA.t1,
      s,
      tableA
    );
    const hitB = pointOnEdgeAtArcFractionInSpan(
      pieceB,
      refB.fromPointId,
      refB.toPointId,
      refB.t0,
      refB.t1,
      s,
      tableB
    );
    if (!hitA || !hitB) continue;
    pairs.push([hitA.pos, hitB.pos]);
  }
  return pairs;
}

export type SeamConnectorDrawOptions = {
  className?: string;
  strokeWidth?: number;
  /** Number of lines across the seam span; default scales with edge length. */
  lineCount?: number;
  opacity?: number;
};

/** Dashed lines linking paired seam edges at matched arc-length samples. */
export function drawMeshSeamConnectors(
  svg: SVGSVGElement,
  pattern: PatternDocument,
  opts: SeamConnectorDrawOptions = {}
): void {
  const className = opts.className ?? 'mesh-seam-connector';
  const strokeWidth = opts.strokeWidth ?? 0.28;
  const opacity = opts.opacity ?? 0.6;
  for (const seam of pattern.seams) {
    drawSeamBindingConnectors(svg, seam, pattern, { ...opts, className, strokeWidth, opacity });
  }
}

function drawSeamBindingConnectors(
  svg: SVGSVGElement,
  seam: SeamBinding,
  pattern: PatternDocument,
  opts: SeamConnectorDrawOptions
): void {
  const className = opts.className ?? 'mesh-seam-connector';
  const strokeWidth = opts.strokeWidth ?? 0.28;
  const opacity = opts.opacity ?? 0.6;
  const pieceA = pattern.pieces.find((p) => p.id === seam.a.pieceId);
  const pieceB = pattern.pieces.find((p) => p.id === seam.b.pieceId);
  if (!pieceA || !pieceB) return;
  if (!isSeamEdgeValid(pattern.pieces, seam.a) || !isSeamEdgeValid(pattern.pieces, seam.b)) {
    return;
  }
  const pairs = buildSeamConnectorPointPairs(
    pieceA,
    seam.a,
    pieceB,
    seam.b,
    opts.lineCount
  );
  for (const [a, b] of pairs) {
    appendConnectorLine(svg, a, b, className, strokeWidth, opacity);
  }
}

/** Discretized mesh boundary segments that lie on sewn edges. */
export function drawMeshSeamLines(
  svg: SVGSVGElement,
  geom: MeshGeometry,
  seamRefs: SeamEdgeRef[]
): void {
  if (!geom.boundary || seamRefs.length === 0) return;

  for (const [i, j] of geom.edges) {
    const tagA = geom.boundary[i];
    const tagB = geom.boundary[j];
    if (!tagA || !tagB) continue;
    if (!edgeInAnySeamSpan(seamRefs, tagA, tagB)) continue;
    appendPolylinePath(
      svg,
      [geom.vertices[i], geom.vertices[j]],
      'mesh-seam-line',
      0.38
    );
  }
}

/** Pattern seam bindings overlaid on the mesh (smooth edge spans + notches). */
export function drawMeshSeamBindings(
  svg: SVGSVGElement,
  pattern: PatternDocument
): void {
  for (const seam of pattern.seams) {
    for (const ref of [seam.a, seam.b]) {
      const piece = pattern.pieces.find((p) => p.id === ref.pieceId);
      if (!piece) continue;
      const valid = isSeamEdgeValid(pattern.pieces, ref);
      const cls = valid ? 'mesh-seam-binding' : 'mesh-seam-binding mesh-seam-stale';
      const points = valid ? sampleSeamRefPoints(piece, ref) : null;
      if (!points) continue;
      appendPolylinePath(
        svg,
        points,
        cls,
        valid ? 0.42 : 0.3,
        valid ? undefined : '1.2 0.8'
      );
      if (valid) appendSeamNotch(svg, points);
    }
  }
}

export function seamRefsFromPattern(pattern: PatternDocument | null | undefined): SeamEdgeRef[] {
  if (!pattern) return [];
  const refs: SeamEdgeRef[] = [];
  for (const seam of pattern.seams) {
    refs.push(seam.a, seam.b);
  }
  return refs;
}
