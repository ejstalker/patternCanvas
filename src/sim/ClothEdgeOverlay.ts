/**
 * Screen-space highlight for the cloth edge under the pointer in a 3D viewport.
 *
 * A DOM/SVG layer, like the move gizmo and the selection markers: no render
 * pipeline or shader changes, and the app's own CSS decides how it looks.
 * Positions are in the host's layout space, the same space `worldToCanvasPx`
 * returns, so it lines up with the gizmo and the selection markers.
 *
 * Each line carries a dot on the end it is read from. Which end that is decides
 * which end of the edge meets which when the seam is sewn, so it has to be
 * visible — otherwise the reverse tool would appear to do nothing.
 */
export type ClothEdgePoint = { x: number; y: number };

const SVG_NS = 'http://www.w3.org/2000/svg';

type HighlightLine = { polyline: SVGPolylineElement; start: SVGCircleElement };

function makeLine(className: string): HighlightLine {
  const polyline = document.createElementNS(SVG_NS, 'polyline');
  polyline.setAttribute('class', className);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('pointer-events', 'none');
  polyline.style.display = 'none';

  const start = document.createElementNS(SVG_NS, 'circle');
  // Its own class family: the line rules set dashes, which a dot must not inherit.
  start.setAttribute('class', className.replace('cloth-edge-line', 'cloth-edge-start'));
  start.setAttribute('r', '4');
  start.setAttribute('pointer-events', 'none');
  start.style.display = 'none';

  return { polyline, start };
}

function setPoints(line: HighlightLine, points: ReadonlyArray<ClothEdgePoint> | null): void {
  if (!points || points.length < 2) {
    line.polyline.style.display = 'none';
    line.polyline.removeAttribute('points');
    line.start.style.display = 'none';
    return;
  }
  let d = '';
  for (const p of points) {
    if (d) d += ' ';
    d += `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  }
  line.polyline.setAttribute('points', d);
  line.polyline.style.display = 'block';
  line.start.setAttribute('cx', points[0].x.toFixed(2));
  line.start.setAttribute('cy', points[0].y.toFixed(2));
  line.start.style.display = 'block';
}

export class ClothEdgeOverlay {
  private root: HTMLDivElement;
  private hoverLine: HighlightLine;
  private sourceLine: HighlightLine;
  /** Dashed lines previewing the stitches a click would create. */
  private stitchLayer: SVGGElement;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'cloth-edge-overlay';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'cloth-edge-layer');
    this.stitchLayer = document.createElementNS(SVG_NS, 'g');
    this.stitchLayer.setAttribute('class', 'cloth-edge-stitch');
    this.sourceLine = makeLine('cloth-edge-line is-source');
    this.hoverLine = makeLine('cloth-edge-line is-hover');
    // Stitch preview under the outlines; source before hover so the edge being
    // sewn stays lit under the moving highlight.
    svg.append(
      this.stitchLayer,
      this.sourceLine.polyline,
      this.sourceLine.start,
      this.hoverLine.polyline,
      this.hoverLine.start
    );
    this.root.appendChild(svg);
    host.appendChild(this.root);
  }

  /** The edge the pointer is over, or null when it is over nothing. */
  setHover(points: ReadonlyArray<ClothEdgePoint> | null): void {
    setPoints(this.hoverLine, points);
  }

  /** The first edge of the seam being built, held lit until the seam is made. */
  setSource(points: ReadonlyArray<ClothEdgePoint> | null): void {
    setPoints(this.sourceLine, points);
  }

  /** Stitch lines a click would make, as screen-space point pairs. */
  setStitch(pairs: ReadonlyArray<readonly [ClothEdgePoint, ClothEdgePoint]> | null): void {
    this.stitchLayer.replaceChildren();
    if (!pairs) return;
    for (const [a, b] of pairs) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', a.x.toFixed(2));
      line.setAttribute('y1', a.y.toFixed(2));
      line.setAttribute('x2', b.x.toFixed(2));
      line.setAttribute('y2', b.y.toFixed(2));
      line.setAttribute('class', 'cloth-edge-stitch-line');
      this.stitchLayer.appendChild(line);
    }
  }

  destroy(): void {
    this.root.remove();
  }
}
