import type { MeshDocument, MeshGeometry, UnitDisplay } from '../project/types';
import { boundsOf } from '../pattern/geometry';

/**
 * Top-down 2D preview of a triangulated fabric mesh.
 */
export class MeshPreview {
  private root: HTMLElement;
  private svg: SVGSVGElement;
  private mesh: MeshDocument;
  private unit: UnitDisplay;

  constructor(host: HTMLElement, mesh: MeshDocument, unit: UnitDisplay) {
    this.mesh = mesh;
    this.unit = unit;
    this.root = host;
    this.root.classList.add('mesh-preview');
    this.root.innerHTML = '';

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'mesh-svg');
    this.root.appendChild(this.svg);
    this.redraw();
  }

  setUnit(unit: UnitDisplay): void {
    this.unit = unit;
    this.redraw();
  }

  setMesh(mesh: MeshDocument): void {
    this.mesh = mesh;
    this.redraw();
  }

  redraw(): void {
    const geom = this.mesh.geometry;
    this.svg.innerHTML = '';
    if (!geom || geom.vertices.length === 0) {
      this.svg.setAttribute('viewBox', '0 0 40 40');
      return;
    }

    const { min, max } = boundsOf(geom.vertices);
    const pad = 4;
    const w = Math.max(max.x - min.x, 1);
    const h = Math.max(max.y - min.y, 1);
    this.svg.setAttribute('viewBox', `${min.x - pad} ${min.y - pad} ${w + pad * 2} ${h + pad * 2}`);

    this.drawGeometry(geom);
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
}
