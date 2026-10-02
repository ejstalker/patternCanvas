import type { BezierPoint, PatternDocument, PatternPiece, Vec2 } from '../project/types';
import { pieceToPolyline } from '../pattern/geometry';

export type PatternPointOverlayCallbacks = {
  /** Fired whenever the working copy transitions between clean and dirty. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Fired with the edited working copy when the user presses Apply. */
  onApply: (pattern: PatternDocument) => void;
  onCancel?: () => void;
};

/** Axis-aligned pattern-space window shown by the overlay (pattern cm). */
export type PatternWindow = { x: number; y: number; width: number; height: number };

export const OVERLAY_PANEL_WIDTH = 248;
export const OVERLAY_PANEL_HEIGHT = 178;
export const OVERLAY_WINDOW_CM = 34;

/** Centre a window of `widthCm` (pattern cm) on `center`, matching `aspect`. */
export function patternWindowFor(center: Vec2, widthCm: number, aspect: number): PatternWindow {
  const width = Math.max(1, widthCm);
  const height = width / Math.max(0.1, aspect);
  return { x: center.x - width / 2, y: center.y - height / 2, width, height };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function clonePieces(pieces: PatternPiece[]): PatternPiece[] {
  // Point IDs must survive — seams and mesh boundary tags reference them.
  return pieces.map((piece) => ({
    id: piece.id,
    name: piece.name,
    closed: piece.closed,
    points: piece.points.map((pt) => ({
      id: pt.id,
      anchor: { x: pt.anchor.x, y: pt.anchor.y },
      handleIn: pt.handleIn ? { x: pt.handleIn.x, y: pt.handleIn.y } : null,
      handleOut: pt.handleOut ? { x: pt.handleOut.x, y: pt.handleOut.y } : null,
      handlesParallel: pt.handlesParallel,
    })),
    grainline: piece.grainline
      ? { from: { ...piece.grainline.from }, to: { ...piece.grainline.to } }
      : undefined,
  }));
}

type DragState = {
  pieceId: string;
  pointId: string;
  pointerId: number;
  startPointer: Vec2;
  startAnchor: Vec2;
  startHandleIn: Vec2 | null;
  startHandleOut: Vec2 | null;
};

/**
 * Compact point editor pinned to the bottom-left of the drape viewport. It shows
 * only the outline of the pattern pieces plus their anchors — the full editor
 * chrome stays in the pattern node. Edits work on a private copy and are handed
 * back through `onApply`.
 */
export class PatternPointOverlay {
  private readonly root: HTMLDivElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly applyBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly svg: SVGSVGElement;

  private callbacks: PatternPointOverlayCallbacks;
  private working: PatternDocument | null = null;
  private selected: { pieceId: string; pointId: string } | null = null;
  private center: Vec2 = { x: 0, y: 0 };
  private window: PatternWindow = { x: -17, y: -12, width: 34, height: 24 };
  private drag: DragState | null = null;
  private dirty = false;
  private openState = false;

  private readonly onPointerDown = (e: PointerEvent): void => this.handlePointerDown(e);
  private readonly onPointerMove = (e: PointerEvent): void => this.handlePointerMove(e);
  private readonly onPointerUp = (e: PointerEvent): void => this.handlePointerUp(e);

  constructor(host: HTMLElement, callbacks: PatternPointOverlayCallbacks) {
    this.callbacks = callbacks;

    this.root = document.createElement('div');
    this.root.className = 'pattern-point-overlay';
    this.root.style.width = `${OVERLAY_PANEL_WIDTH}px`;
    this.root.style.display = 'none';

    const actions = document.createElement('div');
    actions.className = 'pattern-point-actions';

    this.titleEl = document.createElement('span');
    this.titleEl.className = 'pattern-point-title';

    this.cancelBtn = document.createElement('button');
    this.cancelBtn.type = 'button';
    this.cancelBtn.className = 'pattern-point-btn';
    this.cancelBtn.textContent = 'Cancel';
    this.cancelBtn.addEventListener('click', () => this.cancel());

    this.applyBtn = document.createElement('button');
    this.applyBtn.type = 'button';
    this.applyBtn.className = 'pattern-point-btn primary';
    this.applyBtn.textContent = 'Apply';
    this.applyBtn.disabled = true;
    this.applyBtn.addEventListener('click', () => this.apply());

    actions.appendChild(this.titleEl);
    actions.appendChild(this.cancelBtn);
    actions.appendChild(this.applyBtn);

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'pattern-point-svg');
    this.svg.setAttribute('width', String(OVERLAY_PANEL_WIDTH));
    this.svg.setAttribute('height', String(OVERLAY_PANEL_HEIGHT));
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('pointercancel', this.onPointerUp);

    this.root.appendChild(actions);
    this.root.appendChild(this.svg);
    host.appendChild(this.root);
  }

  isOpen(): boolean {
    return this.openState;
  }

  /** Open the overlay centred on the anchor identified by `pointId`. */
  open(pattern: PatternDocument, pointId: string | null): void {
    this.working = { ...pattern, pieces: clonePieces(pattern.pieces) };
    const found = this.findAnchor(pointId);
    this.selected = found ? { pieceId: found.piece.id, pointId: found.point.id } : null;
    this.center = found ? { x: found.point.anchor.x, y: found.point.anchor.y } : this.piecesCenter();
    const aspect = OVERLAY_PANEL_WIDTH / OVERLAY_PANEL_HEIGHT;
    this.window = patternWindowFor(this.center, OVERLAY_WINDOW_CM, aspect);
    this.openState = true;
    this.root.style.display = 'block';
    this.setDirty(false);
    this.render();
  }

  close(): void {
    this.openState = false;
    this.drag = null;
    this.working = null;
    this.root.style.display = 'none';
    this.setDirty(false);
  }

  cancel(): void {
    this.close();
    this.callbacks.onCancel?.();
  }

  apply(): void {
    if (!this.working) return;
    const edited: PatternDocument = {
      ...this.working,
      pieces: clonePieces(this.working.pieces),
    };
    this.close();
    this.callbacks.onApply(edited);
  }

  destroy(): void {
    this.svg.removeEventListener('pointerdown', this.onPointerDown);
    this.svg.removeEventListener('pointermove', this.onPointerMove);
    this.svg.removeEventListener('pointerup', this.onPointerUp);
    this.svg.removeEventListener('pointercancel', this.onPointerUp);
    this.root.remove();
  }

  private setDirty(dirty: boolean): void {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    this.applyBtn.disabled = !dirty;
    this.callbacks.onDirtyChange?.(dirty);
  }

  private findAnchor(
    pointId: string | null
  ): { piece: PatternPiece; point: BezierPoint } | null {
    if (!pointId || !this.working) return null;
    for (const piece of this.working.pieces) {
      const hit = piece.points.find((p) => p.id === pointId);
      if (hit) return { piece, point: hit };
    }
    return null;
  }

  private piecesCenter(): Vec2 {
    const pieces = this.working?.pieces ?? [];
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const piece of pieces) {
      for (const pt of piece.points) {
        sx += pt.anchor.x;
        sy += pt.anchor.y;
        n++;
      }
    }
    if (!n) return { x: 0, y: 0 };
    return { x: sx / n, y: sy / n };
  }

  private clientToPattern(clientX: number, clientY: number): Vec2 {
    const rect = this.svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return { x: this.center.x, y: this.center.y };
    const vb = this.window;
    const scale = Math.min(rect.width / vb.width, rect.height / vb.height);
    const mappedW = vb.width * scale;
    const mappedH = vb.height * scale;
    const ox = rect.left + (rect.width - mappedW) / 2;
    const oy = rect.top + (rect.height - mappedH) / 2;
    return {
      x: vb.x + (clientX - ox) / scale,
      y: vb.y + (clientY - oy) / scale,
    };
  }

  private handlePointerDown(e: PointerEvent): void {
    if (!this.working || e.button !== 0) return;
    const target = e.target as Element | null;
    const pointId = target?.getAttribute?.('data-point-id') ?? null;
    const pieceId = target?.getAttribute?.('data-piece-id') ?? null;
    if (!pointId || !pieceId) return;
    const piece = this.working.pieces.find((p) => p.id === pieceId);
    const point = piece?.points.find((p) => p.id === pointId);
    if (!piece || !point) return;
    e.preventDefault();
    this.drag = {
      pieceId,
      pointId,
      pointerId: e.pointerId,
      startPointer: this.clientToPattern(e.clientX, e.clientY),
      startAnchor: { x: point.anchor.x, y: point.anchor.y },
      startHandleIn: point.handleIn ? { x: point.handleIn.x, y: point.handleIn.y } : null,
      startHandleOut: point.handleOut ? { x: point.handleOut.x, y: point.handleOut.y } : null,
    };
    try {
      this.svg.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort; dragging still works inside the panel */
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || !this.working || e.pointerId !== drag.pointerId) return;
    const now = this.clientToPattern(e.clientX, e.clientY);
    const dx = now.x - drag.startPointer.x;
    const dy = now.y - drag.startPointer.y;
    if (dx === 0 && dy === 0) return;
    const piece = this.working.pieces.find((p) => p.id === drag.pieceId);
    const point = piece?.points.find((p) => p.id === drag.pointId);
    if (!point) return;
    point.anchor = { x: drag.startAnchor.x + dx, y: drag.startAnchor.y + dy };
    // Handles ride along rigidly so the local curve shape is preserved.
    point.handleIn = drag.startHandleIn
      ? { x: drag.startHandleIn.x + dx, y: drag.startHandleIn.y + dy }
      : null;
    point.handleOut = drag.startHandleOut
      ? { x: drag.startHandleOut.x + dx, y: drag.startHandleOut.y + dy }
      : null;
    this.setDirty(true);
    this.render();
  }

  private handlePointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.drag = null;
    try {
      this.svg.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  private render(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    if (!this.working) return;
    const vb = this.window;
    this.svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);

    const cmPerPx = vb.width / OVERLAY_PANEL_WIDTH;
    const strokeCm = cmPerPx; // ~1px hairlines regardless of zoom
    const anchorR = cmPerPx * 4.4;
    const dotR = cmPerPx * 2.1;

    const selected = this.drag
      ? { pieceId: this.drag.pieceId, pointId: this.drag.pointId }
      : this.selected;

    for (const piece of this.working.pieces) {
      const poly = pieceToPolyline(piece.points, piece.closed, 14);
      if (poly.length >= 2) {
        const path = document.createElementNS(SVG_NS, 'path');
        let d = `M ${poly[0].x} ${poly[0].y}`;
        for (let i = 1; i < poly.length; i++) d += ` L ${poly[i].x} ${poly[i].y}`;
        if (piece.closed) d += ' Z';
        path.setAttribute('d', d);
        path.setAttribute('class', 'pattern-point-piece');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-width', String(strokeCm));
        this.svg.appendChild(path);
      }

      const isActivePiece = selected?.pieceId === piece.id;
      for (const pt of piece.points) {
        const isActive = isActivePiece && selected?.pointId === pt.id;
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('cx', String(pt.anchor.x));
        c.setAttribute('cy', String(pt.anchor.y));
        c.setAttribute('r', String(isActive ? anchorR * 1.45 : anchorR));
        c.setAttribute('class', isActive ? 'pattern-point-anchor active' : 'pattern-point-anchor');
        c.setAttribute('fill', isActive ? '#f59e0b' : '#ffe9b0');
        c.setAttribute('stroke', '#3f2d05');
        c.setAttribute('stroke-width', String(strokeCm * 1.6));
        c.setAttribute('data-piece-id', piece.id);
        c.setAttribute('data-point-id', pt.id);
        c.style.cursor = 'grab';
        this.svg.appendChild(c);
      }
    }

    // Cursor crosshair marks the anchor the overlay was opened on.
    const cross = document.createElementNS(SVG_NS, 'circle');
    cross.setAttribute('cx', String(vb.x + vb.width / 2));
    cross.setAttribute('cy', String(vb.y + vb.height / 2));
    cross.setAttribute('r', String(dotR * 0.6));
    cross.setAttribute('class', 'pattern-point-center');
    cross.setAttribute('fill', 'none');
    cross.setAttribute('stroke', 'rgba(148, 163, 184, 0.8)');
    cross.setAttribute('stroke-width', String(strokeCm * 1.2));
    this.svg.appendChild(cross);

    this.updateTitle(selected);
  }

  private updateTitle(selected: { pieceId: string; pointId: string } | null): void {
    if (!selected) {
      this.titleEl.textContent = 'Pattern point';
      return;
    }
    const piece = this.working?.pieces.find((p) => p.id === selected.pieceId);
    if (!piece) {
      this.titleEl.textContent = 'Pattern point';
      return;
    }
    const idx = piece.points.findIndex((p) => p.id === selected.pointId);
    this.titleEl.textContent = `${piece.name} · pt ${idx + 1}`;
  }
}
