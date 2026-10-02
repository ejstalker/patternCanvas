/**
 * Lightweight overlay marking each selected pattern piece in the transform view.
 *
 * Markers are plain DOM nodes positioned in the host's layout space (same space
 * as the move gizmo), so they scale with the board without touching the render
 * pipeline / shaders. A distinct pivot marker shows the group rotation centre
 * when more than one piece is selected.
 */
export type SelectionMarker = { id: string; x: number; y: number };

export class SelectionOverlay {
  private root: HTMLElement;
  private markers = new Map<string, HTMLElement>();
  private pivot: HTMLElement;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'selection-overlay';

    this.pivot = document.createElement('div');
    this.pivot.className = 'selection-overlay-pivot';
    this.pivot.style.display = 'none';
    this.root.appendChild(this.pivot);

    host.appendChild(this.root);
  }

  /** Sync marker positions. `pivot` is shown only when 2+ pieces are selected. */
  sync(markers: SelectionMarker[], pivot: { x: number; y: number } | null): void {
    const seen = new Set<string>();
    for (const m of markers) {
      seen.add(m.id);
      let el = this.markers.get(m.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'selection-marker';
        this.root.appendChild(el);
        this.markers.set(m.id, el);
      }
      el.style.left = `${m.x}px`;
      el.style.top = `${m.y}px`;
    }

    for (const [id, el] of this.markers) {
      if (seen.has(id)) continue;
      el.remove();
      this.markers.delete(id);
    }

    if (pivot && markers.length > 1) {
      this.pivot.style.display = 'block';
      this.pivot.style.left = `${pivot.x}px`;
      this.pivot.style.top = `${pivot.y}px`;
    } else {
      this.pivot.style.display = 'none';
    }
  }

  destroy(): void {
    this.root.remove();
    this.markers.clear();
  }
}
