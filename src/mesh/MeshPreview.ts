import type { MeshDocument, MeshGeometry, PatternDocument, UnitDisplay, Vec2 } from '../project/types';
import { boundsOf } from '../pattern/geometry';
import { buildGridGroup, viewScaleFor, type GridBox } from '../pattern/grid';
import { buildPatternPointMarkers } from '../sim/patternPointMarkers';
import {
  drawMeshSeamBindings,
  drawMeshSeamConnectors,
  drawMeshSeamLines,
  seamRefsFromPattern,
} from './meshSeamDraw';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Zoom limits for the viewBox, in pattern units. */
const MIN_VIEW = 4;
const MAX_VIEW = 600;

/** Half the diameter of a pattern-point marker, matching the drape viewport. */
const MARKER_RADIUS_PX = 6.5;
const MARKER_STROKE_PX = 1.5;

/**
 * Top-down 2D preview of a triangulated fabric mesh. Pans and zooms like the 2D
 * pattern editor, and marks the mesh vertices that carry each pattern anchor.
 */
export class MeshPreview {
  private root: HTMLElement;
  private svg: SVGSVGElement;
  private mesh: MeshDocument;
  private pattern: PatternDocument | null;
  private unit: UnitDisplay;
  /** Visible region in mesh/pattern units — the SVG viewBox. */
  private view: GridBox = { x: 0, y: 0, w: 40, h: 40 };
  private pan:
    | { pointerId: number; clientX: number; clientY: number; viewX: number; viewY: number }
    | null = null;

  constructor(
    host: HTMLElement,
    mesh: MeshDocument,
    unit: UnitDisplay,
    pattern: PatternDocument | null = null
  ) {
    this.mesh = mesh;
    this.pattern = pattern;
    this.unit = unit;
    this.root = host;
    this.root.classList.add('mesh-preview');
    this.root.innerHTML = '';

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'mesh-svg');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.root.appendChild(this.svg);
    this.bindInteraction();
    this.fitView();
    this.redraw();
  }

  setUnit(unit: UnitDisplay): void {
    this.unit = unit;
    this.redraw();
  }

  setMesh(mesh: MeshDocument, pattern?: PatternDocument | null): void {
    this.mesh = mesh;
    if (pattern !== undefined) this.pattern = pattern;
    // New geometry: reset to a fit rather than keeping a stale view.
    this.fitView();
    this.redraw();
  }

  setPattern(pattern: PatternDocument | null): void {
    this.pattern = pattern;
    this.redraw();
  }

  /** Frame the whole mesh. */
  fitView(): void {
    const geom = this.mesh.geometry;
    if (!geom || geom.vertices.length === 0) {
      this.view = { x: 0, y: 0, w: 40, h: 40 };
      return;
    }
    const { min, max } = boundsOf(geom.vertices);
    const pad = 4;
    this.view = {
      x: min.x - pad,
      y: min.y - pad,
      w: Math.max(max.x - min.x, 1) + pad * 2,
      h: Math.max(max.y - min.y, 1) + pad * 2,
    };
  }

  /** Layout CSS px per pattern unit. */
  private viewScale(): number {
    return viewScaleFor(this.view, {
      width: this.svg.clientWidth,
      height: this.svg.clientHeight,
    });
  }

  /** Screen px per pattern unit, including any CSS scale on the board. */
  private screenScale(): number {
    const rect = this.svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return 1;
    return Math.min(rect.width / this.view.w, rect.height / this.view.h);
  }

  /**
   * Map a client point into pattern space. The board applies a CSS scale, so
   * `getScreenCTM()` can't be trusted — map via the layout box + viewBox
   * (xMidYMid meet), same as the pattern editor.
   */
  private clientToPattern(clientX: number, clientY: number): Vec2 {
    const rect = this.svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return { x: this.view.x, y: this.view.y };
    const s = Math.min(rect.width / this.view.w, rect.height / this.view.h);
    const mappedW = this.view.w * s;
    const mappedH = this.view.h * s;
    const ox = rect.left + (rect.width - mappedW) / 2;
    const oy = rect.top + (rect.height - mappedH) / 2;
    return { x: this.view.x + (clientX - ox) / s, y: this.view.y + (clientY - oy) / s };
  }

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const before = this.clientToPattern(clientX, clientY);
    const nextW = Math.min(MAX_VIEW, Math.max(MIN_VIEW, this.view.w * factor));
    const nextH = Math.min(MAX_VIEW, Math.max(MIN_VIEW, this.view.h * factor));
    if (nextW === this.view.w && nextH === this.view.h) return;
    this.view.w = nextW;
    this.view.h = nextH;
    // Keep the point under the cursor pinned.
    const after = this.clientToPattern(clientX, clientY);
    this.view.x += before.x - after.x;
    this.view.y += before.y - after.y;
    this.redraw();
  }

  private bindInteraction(): void {
    this.svg.addEventListener('pointerdown', (e) => {
      // Left, middle, or Alt+left all pan — there is nothing else to click here.
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      this.pan = {
        pointerId: e.pointerId,
        clientX: e.clientX,
        clientY: e.clientY,
        viewX: this.view.x,
        viewY: this.view.y,
      };
      try {
        this.svg.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      this.root.classList.add('is-panning');
      this.svg.style.cursor = 'grabbing';
    });
    this.svg.addEventListener('pointermove', (e) => {
      const pan = this.pan;
      if (!pan || e.pointerId !== pan.pointerId) return;
      const s = this.screenScale();
      this.view.x = pan.viewX - (e.clientX - pan.clientX) / s;
      this.view.y = pan.viewY - (e.clientY - pan.clientY) / s;
      this.redraw();
    });
    const end = (e: PointerEvent): void => {
      if (!this.pan || e.pointerId !== this.pan.pointerId) return;
      this.pan = null;
      this.root.classList.remove('is-panning');
      this.svg.style.cursor = '';
      try {
        this.svg.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);
    this.svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.12 : 1 / 1.12);
      },
      { passive: false }
    );
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  redraw(): void {
    const geom = this.mesh.geometry;
    this.svg.innerHTML = '';
    if (!geom || geom.vertices.length === 0) {
      this.view = { x: 0, y: 0, w: 40, h: 40 };
      this.svg.setAttribute('viewBox', '0 0 40 40');
      return;
    }

    const { x, y, w, h } = this.view;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.svg.appendChild(
      buildGridGroup(this.view, this.unit, {
        width: this.svg.clientWidth,
        height: this.svg.clientHeight,
      })
    );

    this.drawGeometry(geom);
    this.drawSeams(geom);
    this.drawPatternPoints(geom);
  }

  /**
   * Mark the mesh vertex each pattern anchor lands on, styled like the drape
   * viewport's "Draw pattern points" tool.
   */
  private drawPatternPoints(geom: MeshGeometry): void {
    if (!this.pattern) return;
    const markers = buildPatternPointMarkers(geom, this.pattern);
    if (markers.length === 0) return;
    const scale = this.viewScale();
    if (!(scale > 0)) return;
    const layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute('class', 'mesh-points');
    for (const marker of markers) {
      const v = geom.vertices[marker.vertexIndex];
      if (!v) continue;
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String(v.x));
      dot.setAttribute('cy', String(v.y));
      dot.setAttribute('r', String(MARKER_RADIUS_PX / scale));
      dot.setAttribute('stroke-width', String(MARKER_STROKE_PX / scale));
      dot.setAttribute('class', 'mesh-point-marker');
      layer.appendChild(dot);
    }
    this.svg.appendChild(layer);
  }

  private drawGeometry(geom: MeshGeometry): void {
    for (let i = 0; i + 2 < geom.triangles.length; i += 3) {
      const a = geom.vertices[geom.triangles[i]];
      const b = geom.vertices[geom.triangles[i + 1]];
      const c = geom.vertices[geom.triangles[i + 2]];
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y}`);
      poly.setAttribute('class', 'mesh-tri');
      this.svg.appendChild(poly);
    }

    for (const [i, j] of geom.edges) {
      const a = geom.vertices[i];
      const b = geom.vertices[j];
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(a.x));
      line.setAttribute('y1', String(a.y));
      line.setAttribute('x2', String(b.x));
      line.setAttribute('y2', String(b.y));
      line.setAttribute('class', 'mesh-edge');
      this.svg.appendChild(line);
    }
  }

  private drawSeams(geom: MeshGeometry): void {
    if (!this.pattern || this.pattern.seams.length === 0) return;
    const seamRefs = seamRefsFromPattern(this.pattern);
    drawMeshSeamLines(this.svg, geom, seamRefs);
    drawMeshSeamConnectors(this.svg, this.pattern);
    drawMeshSeamBindings(this.svg, this.pattern);
  }
}
