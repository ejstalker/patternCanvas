import type {
  BezierPoint,
  PatternDocument,
  PatternPiece,
  SeamBinding,
  SeamEdgeRef,
  UnitDisplay,
  Vec2,
} from '../project/types';
import { formatLength } from '../project/types';
import { uid } from '../project/createDefault';
import {
  anchorsBounds,
  clonePatternPiece,
  dist,
  edgeHandles,
  edgeIndexForPointIds,
  findNearestEdge,
  insertDartOnPiece,
  isSeamEdgeValid,
  mirrorClonePatternPiece,
  pieceToPolyline,
  pointOnEdgeAtT,
  sampleEdgeByPointIds,
  segmentLengths,
} from './geometry';
import { DEFAULT_SEAM_GAP_CM } from '../mesh/triangulate';
import {
  AVATAR_OVERLAY_VIEWS,
  buildAvatarOverlayPath,
  ensureAvatarOverlaySource,
  type AvatarOverlayView,
} from './avatarPatternOverlay';

export type PatternEditorCallbacks = {
  onChange: () => void;
  /** Fired once before a gesture/mutation so the host can snapshot undo history. */
  onBeforeChange?: () => void;
};

/** Figma-aligned vector tools inside a pattern frame. */
export type PatternTool = 'move' | 'pen' | 'dart' | 'sew' | 'bend';

type HoverEdge = { pieceId: string; fromPointId: string; toPointId: string };

/** Corner = free/proportional 2-axis; edge = single-axis (n/s → Y, e/w → X). */
type ScaleHandle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 'e' | 's' | 'w';

type PointSnapshot = {
  pieceId: string;
  pointId: string;
  anchor: Vec2;
  handleIn: Vec2 | null;
  handleOut: Vec2 | null;
};

type DragKind =
  | { type: 'handle'; pieceId: string; pointId: string; which: 'in' | 'out'; mirror: boolean }
  | { type: 'penCurve'; pieceId: string; pointId: string }
  | { type: 'pan'; startClient: Vec2; startView: { x: number; y: number } }
  | { type: 'marquee'; start: Vec2; current: Vec2; additive: boolean }
  | { type: 'moveSelection'; start: Vec2; snapshots: PointSnapshot[] }
  | {
      type: 'scaleSelection';
      handle: ScaleHandle;
      /** 'both' = corner (Shift locks aspect); 'x'/'y' = edge handle. */
      axis: 'both' | 'x' | 'y';
      start: Vec2;
      fixed: Vec2;
      startSize: Vec2;
      snapshots: PointSnapshot[];
    };

type BBox = { minX: number; minY: number; maxX: number; maxY: number };

/** Figma-like soft-snap alignment guide while moving points. */
type SnapGuide =
  | {
      kind: 'axis';
      axis: 'x' | 'y';
      /** Shared x (vertical guide) or y (horizontal guide). */
      at: number;
      /** Extent along the other axis. */
      from: number;
      to: number;
    }
  | {
      kind: 'mid';
      at: Vec2;
      /** Parent points whose midpoint we snapped to (for guide stubs). */
      a: Vec2;
      b: Vec2;
    };

type SnapMidTarget = { at: Vec2; a: Vec2; b: Vec2 };

/**
 * SVG pattern editor with Move / Pen / Bend tools (Figma-like) and
 * canvas-matching zoom (⌘/Ctrl-wheel) + pan (Alt-drag).
 */
export class PatternEditor {
  private root: HTMLElement;
  private viewport: HTMLElement;
  private toolbar: HTMLElement;
  private snapBtn: HTMLButtonElement;
  private pointBar: HTMLElement;
  private parallelCheck: HTMLInputElement;
  private cornerCheck: HTMLInputElement;
  private svg: SVGSVGElement;
  /** Separate layer so avatar tris aren't rebuilt on every pattern redraw. */
  private avatarSvg: SVGSVGElement;
  private pattern: PatternDocument;
  private unit: UnitDisplay;
  private tool: PatternTool = 'move';
  /** Primary selected point (for point bar / single-point UI). */
  private selectedPointId: string | null = null;
  private selectedIds = new Set<string>();
  private selectedPieceId: string | null = null;
  private drag: DragKind | null = null;
  private viewBox = { x: -10, y: -10, w: 80, h: 90 };
  private cbs: PatternEditorCallbacks;
  /** Coalesce one undo checkpoint per gesture / discrete edit. */
  private historyArmed = false;
  /** True while pen is placing an open stroke (before close). */
  private penActive = false;
  /**
   * Figma "Snap to geometry": soft-align moving points to other anchors.
   * Hold Ctrl during drag to temporarily disable.
   */
  private softSnap = true;
  private snapGuides: SnapGuide[] = [];
  /** Orthographic avatar silhouette under the pattern (15% opacity). */
  private avatarOverlayOn = false;
  private avatarOverlayView: AvatarOverlayView = 'front';
  private avatarOverlayPath = '';
  private avatarOverlayLoading = false;
  private avatarOverlayError: string | null = null;
  /** Pattern-space cm offset applied after projection (hips stay at 0,0 before this). */
  private avatarOffsetX = 0;
  private avatarOffsetY = 0;
  private avatarBar: HTMLElement;
  private avatarToggleBtn: HTMLButtonElement;
  private avatarViewSelect: HTMLSelectElement;
  private avatarOffsetXInput: HTMLInputElement;
  private avatarOffsetYInput: HTMLInputElement;
  /** See avatar through pattern fills (adjustable opacity). */
  private xrayOn = false;
  /** Pattern fill opacity while x-ray is on (0–1). */
  private xrayOpacity = 0.35;
  private xrayBtn: HTMLButtonElement;
  private xrayBar: HTMLElement;
  private xrayOpacityInput: HTMLInputElement;
  private contextMenu: HTMLElement;
  /** Piece targeted by the open context menu. */
  private contextPieceId: string | null = null;
  /** Seam targeted by the open context menu (when right-clicking a seam). */
  private contextSeamId: string | null = null;
  /** First edge locked while sewing (MD segment sewing). */
  private pendingSeam: SeamEdgeRef | null = null;
  /** Edge under the cursor while the sew tool is active. */
  private hoverEdge: HoverEdge | null = null;

  constructor(
    host: HTMLElement,
    pattern: PatternDocument,
    unit: UnitDisplay,
    cbs: PatternEditorCallbacks
  ) {
    this.root = host;
    this.pattern = pattern;
    this.unit = unit;
    this.cbs = cbs;

    this.root.innerHTML = '';
    this.root.classList.add('pattern-editor');

    this.toolbar = document.createElement('div');
    this.toolbar.className = 'pattern-toolbar';
    this.toolbar.innerHTML = `
      <div class="pattern-toolbar-tools">
        <button type="button" data-tool="move" title="Move (V) — marquee select, drag to move · corner scale (Shift = proportional) · side handles = H/V only">↖</button>
        <button type="button" data-tool="pen" title="Pen (P) — click corners, click-drag curves, click first point to close">✎</button>
        <button type="button" data-tool="dart" title="Dart — click an edge to add a 4 cm inward dart (V-notch)">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" d="M2.5 3.5 L8 13.5 L13.5 3.5"/>
            <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="1.5 1.2" d="M8 13.5 L8 5"/>
          </svg>
        </button>
        <button type="button" data-tool="sew" title="Sew — click two edges to bind them as a seam (Marvelous Designer segment sewing)">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M3 12.5 L12.5 3"/>
            <path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" d="M11 3.5 L13 3 L12.5 5"/>
            <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="1.4 1.1" d="M4.5 5.5 L11.5 12.5"/>
          </svg>
        </button>
        <button type="button" data-tool="bend" title="Bend — add/edit Bézier handles">∿</button>
      </div>
      <div class="pattern-toolbar-spacer" aria-hidden="true"></div>
      <button type="button" data-opt="xray" class="pattern-xray-btn" title="X-ray — lower pattern opacity to see the avatar underneath">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-width="1.3" d="M2.5 8c1.8-3.2 4-4.8 5.5-4.8S11.7 4.8 13.5 8c-1.8 3.2-4 4.8-5.5 4.8S4.3 11.2 2.5 8z"/>
          <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
          <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="1.2 1" d="M3 11.5 L13 4.5"/>
        </svg>
      </button>
      <button type="button" data-opt="avatar" class="pattern-avatar-btn" title="Toggle avatar reference (15% opacity, true scale)">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="4.2" r="2.2" fill="currentColor"/>
          <path fill="currentColor" d="M3.2 13.5c.4-2.8 2.2-4.2 4.8-4.2s4.4 1.4 4.8 4.2H3.2z"/>
        </svg>
      </button>
      <button type="button" data-opt="snap" class="pattern-snap-btn active" title="Snap to geometry — align with points, edge midpoints, and midpoints between pairs (Ctrl holds to disable)">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path fill="currentColor" d="M3 2h4v1.5H4.5V6H3V2zm6 0h4v4h-1.5V3.5H9V2zM3 10h1.5v2.5H7V14H3v-4zm8.5 0H14v4h-4v-1.5h2.5V10z"/>
          <circle cx="8" cy="8" r="1.6" fill="currentColor"/>
        </svg>
      </button>
    `;
    this.root.appendChild(this.toolbar);
    this.snapBtn = this.toolbar.querySelector('button[data-opt="snap"]') as HTMLButtonElement;
    this.xrayBtn = this.toolbar.querySelector('button[data-opt="xray"]') as HTMLButtonElement;
    this.avatarToggleBtn = this.toolbar.querySelector('button[data-opt="avatar"]') as HTMLButtonElement;
    this.toolbar.addEventListener('click', (e) => {
      const xrayBtn = (e.target as HTMLElement).closest(
        'button[data-opt="xray"]'
      ) as HTMLButtonElement | null;
      if (xrayBtn) {
        this.setXrayEnabled(!this.xrayOn);
        return;
      }
      const avatarBtn = (e.target as HTMLElement).closest(
        'button[data-opt="avatar"]'
      ) as HTMLButtonElement | null;
      if (avatarBtn) {
        void this.setAvatarOverlayEnabled(!this.avatarOverlayOn);
        return;
      }
      const snap = (e.target as HTMLElement).closest('button[data-opt="snap"]') as HTMLButtonElement | null;
      if (snap) {
        this.softSnap = !this.softSnap;
        this.snapBtn.classList.toggle('active', this.softSnap);
        this.snapGuides = [];
        this.redraw();
        return;
      }
      const btn = (e.target as HTMLElement).closest('button[data-tool]') as HTMLButtonElement | null;
      if (!btn) return;
      this.setTool(btn.dataset.tool as PatternTool);
    });

    const main = document.createElement('div');
    main.className = 'pattern-editor-main';
    this.root.appendChild(main);

    this.pointBar = document.createElement('div');
    this.pointBar.className = 'pattern-point-bar';
    this.pointBar.innerHTML = `
      <label title="Keep handles opposite when dragging"><input type="checkbox" data-opt="parallel" /> Parallel handles</label>
      <label title="Zero-length handles — corner / straight segments"><input type="checkbox" data-opt="corner" /> Corner (zero handles)</label>
    `;
    main.appendChild(this.pointBar);
    this.parallelCheck = this.pointBar.querySelector('input[data-opt="parallel"]') as HTMLInputElement;
    this.cornerCheck = this.pointBar.querySelector('input[data-opt="corner"]') as HTMLInputElement;
    this.pointBar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.parallelCheck.addEventListener('change', () => this.onParallelToggle());
    this.cornerCheck.addEventListener('change', () => this.onCornerToggle());

    this.viewport = document.createElement('div');
    this.viewport.className = 'pattern-viewport';
    main.appendChild(this.viewport);

    this.xrayBar = document.createElement('div');
    this.xrayBar.className = 'pattern-xray-bar';
    this.xrayBar.hidden = true;
    this.xrayBar.innerHTML = `
      <span class="pattern-xray-bar-label">X-ray</span>
      <label class="pattern-xray-opacity" title="Pattern fill opacity">
        <span>Opacity</span>
        <input data-xray-opacity type="range" min="5" max="100" step="1" value="35" aria-label="Pattern opacity" />
        <span class="pattern-xray-opacity-val" data-xray-opacity-val>35%</span>
      </label>
    `;
    this.viewport.appendChild(this.xrayBar);
    this.xrayOpacityInput = this.xrayBar.querySelector(
      'input[data-xray-opacity]'
    ) as HTMLInputElement;
    this.xrayBar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.xrayOpacityInput.addEventListener('input', () => {
      const pct = Math.max(5, Math.min(100, parseFloat(this.xrayOpacityInput.value) || 35));
      this.xrayOpacity = pct / 100;
      this.applyXrayStyles();
    });

    this.avatarBar = document.createElement('div');
    this.avatarBar.className = 'pattern-avatar-bar';
    this.avatarBar.hidden = true;
    this.avatarBar.innerHTML = `
      <span class="pattern-avatar-bar-label">Avatar ref</span>
      <select data-avatar-view aria-label="Avatar view direction">
        ${AVATAR_OVERLAY_VIEWS.map(
          (v) => `<option value="${v.id}" ${v.id === 'front' ? 'selected' : ''}>${v.label}</option>`
        ).join('')}
      </select>
      <label class="pattern-avatar-offset" title="Horizontal offset in pattern cm">
        <span>X</span>
        <input data-avatar-ox type="number" step="0.5" value="0" aria-label="Avatar X offset (cm)" />
      </label>
      <label class="pattern-avatar-offset" title="Vertical offset in pattern cm (+ down)">
        <span>Y</span>
        <input data-avatar-oy type="number" step="0.5" value="0" aria-label="Avatar Y offset (cm)" />
      </label>
      <span class="pattern-avatar-bar-hint muted">15% · true scale (cm)</span>
    `;
    this.viewport.appendChild(this.avatarBar);
    this.avatarViewSelect = this.avatarBar.querySelector(
      'select[data-avatar-view]'
    ) as HTMLSelectElement;
    this.avatarOffsetXInput = this.avatarBar.querySelector(
      'input[data-avatar-ox]'
    ) as HTMLInputElement;
    this.avatarOffsetYInput = this.avatarBar.querySelector(
      'input[data-avatar-oy]'
    ) as HTMLInputElement;
    this.avatarBar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.avatarViewSelect.addEventListener('change', () => {
      this.avatarOverlayView = this.avatarViewSelect.value as AvatarOverlayView;
      void this.refreshAvatarOverlayPath();
    });
    const bindOffset = (input: HTMLInputElement, axis: 'x' | 'y') => {
      const apply = () => {
        const v = parseFloat(input.value);
        const n = Number.isFinite(v) ? v : 0;
        if (axis === 'x') this.avatarOffsetX = n;
        else this.avatarOffsetY = n;
        this.syncAvatarSvg();
      };
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
    };
    bindOffset(this.avatarOffsetXInput, 'x');
    bindOffset(this.avatarOffsetYInput, 'y');

    this.avatarSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.avatarSvg.setAttribute('class', 'pattern-avatar-svg');
    this.avatarSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.avatarSvg.setAttribute('aria-hidden', 'true');
    this.viewport.appendChild(this.avatarSvg);

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'pattern-svg');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.viewport.appendChild(this.svg);

    this.contextMenu = document.createElement('div');
    this.contextMenu.className = 'pattern-context-menu';
    this.contextMenu.hidden = true;
    this.contextMenu.innerHTML = `
      <button type="button" data-act="duplicate">Duplicate</button>
      <button type="button" data-act="mirror-x">Mirror duplicate X</button>
      <button type="button" data-act="mirror-y">Mirror duplicate Y</button>
      <button type="button" data-act="delete-piece" class="danger">Delete piece</button>
      <button type="button" data-act="reverse-seam" hidden>Reverse seam</button>
      <button type="button" data-act="remove-seam" class="danger" hidden>Remove seam</button>
    `;
    this.viewport.appendChild(this.contextMenu);
    this.contextMenu.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.contextMenu.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'duplicate') this.duplicateContextPiece();
      else if (act === 'mirror-x') this.mirrorDuplicateContextPiece('x');
      else if (act === 'mirror-y') this.mirrorDuplicateContextPiece('y');
      else if (act === 'delete-piece') this.deleteContextPiece();
      else if (act === 'reverse-seam') this.reverseContextSeam();
      else if (act === 'remove-seam') this.removeContextSeam();
      this.hideContextMenu();
    });

    this.root.tabIndex = -1;
    this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.svg.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.svg.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.root.addEventListener('pointerdown', this.onRootPointerDown, true);
    document.addEventListener('keydown', this.onDocKeyDown, true);
    this.viewport.addEventListener(
      'wheel',
      (e) => {
        if (!(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        e.stopPropagation();
        this.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.12 : 0.89);
      },
      { passive: false }
    );

    this.selectedPieceId = pattern.pieces[0]?.id ?? null;
    this.fitView();
    this.setTool('move');
    this.redraw();
  }

  private onRootPointerDown = (e: PointerEvent): void => {
    if (this.contextMenu.hidden) return;
    if (this.contextMenu.contains(e.target as Node)) return;
    this.hideContextMenu();
  };

  private onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (this.pendingSeam) {
        this.pendingSeam = null;
        this.hoverEdge = null;
        this.redraw();
      }
      this.hideContextMenu();
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;

    const ae = document.activeElement as HTMLElement | null;
    if (
      ae &&
      (ae.tagName === 'INPUT' ||
        ae.tagName === 'TEXTAREA' ||
        ae.tagName === 'SELECT' ||
        ae.isContentEditable)
    ) {
      return;
    }
    // Only when this pattern editor recently received focus / contains focus
    if (!this.root.isConnected) return;
    if (ae && ae !== this.root && !this.root.contains(ae) && ae !== document.body) return;

    e.preventDefault();
    e.stopPropagation();
    this.hideContextMenu();
    this.handleDeleteKey();
  };

  setUnit(unit: UnitDisplay): void {
    this.unit = unit;
    this.redraw();
  }

  setPattern(pattern: PatternDocument): void {
    this.pattern = pattern;
    this.selectedPieceId = pattern.pieces[0]?.id ?? null;
    this.clearSelection();
    this.fitView();
    this.redraw();
  }

  /** Reload avatar silhouette after the studio avatar mesh/prefs change. */
  reloadAvatarOverlay(): void {
    if (!this.avatarOverlayOn) return;
    void this.refreshAvatarOverlayPath();
  }

  getPattern(): PatternDocument {
    return this.pattern;
  }

  setTool(tool: PatternTool): void {
    this.tool = tool;
    if (tool !== 'pen') this.penActive = false;
    if (tool !== 'sew') {
      this.pendingSeam = null;
      this.hoverEdge = null;
    }
    for (const btn of Array.from(this.toolbar.querySelectorAll('button[data-tool]'))) {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tool === tool);
    }
    this.svg.style.cursor =
      tool === 'pen' || tool === 'dart' || tool === 'sew'
        ? 'crosshair'
        : tool === 'bend'
          ? 'pointer'
          : 'default';
    this.redraw();
  }

  private clearSelection(): void {
    this.selectedIds.clear();
    this.selectedPointId = null;
  }

  private setSelection(ids: string[], primary?: string | null): void {
    this.selectedIds = new Set(ids);
    this.selectedPointId = primary ?? ids[ids.length - 1] ?? null;
  }

  private selectOnly(pointId: string, pieceId?: string): void {
    this.selectedIds = new Set([pointId]);
    this.selectedPointId = pointId;
    if (pieceId) this.selectedPieceId = pieceId;
  }

  private activePiece(): PatternPiece | null {
    return this.pattern.pieces.find((p) => p.id === this.selectedPieceId) ?? this.pattern.pieces[0] ?? null;
  }

  private fitView(): void {
    const piece = this.activePiece();
    if (!piece || piece.points.length === 0) {
      this.viewBox = { x: -5, y: -5, w: 60, h: 70 };
      return;
    }
    const poly = pieceToPolyline(piece.points, piece.closed);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const pad = 8;
    this.viewBox = {
      x: minX - pad,
      y: minY - pad,
      w: Math.max(maxX - minX + pad * 2, 20),
      h: Math.max(maxY - minY + pad * 2, 20),
    };
  }

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const before = this.svgPointFromClient(clientX, clientY);
    this.viewBox.w = Math.min(400, Math.max(8, this.viewBox.w * factor));
    this.viewBox.h = Math.min(400, Math.max(8, this.viewBox.h * factor));
    this.redraw();
    const after = this.svgPointFromClient(clientX, clientY);
    this.viewBox.x += before.x - after.x;
    this.viewBox.y += before.y - after.y;
    this.redraw();
  }

  private setXrayEnabled(on: boolean): void {
    this.xrayOn = on;
    this.xrayBtn.classList.toggle('active', on);
    this.xrayBar.hidden = !on;
    this.root.classList.toggle('is-xray', on);
    if (on) {
      this.xrayOpacityInput.value = String(Math.round(this.xrayOpacity * 100));
    }
    this.applyXrayStyles();
  }

  private applyXrayStyles(): void {
    const pct = Math.round(this.xrayOpacity * 100);
    const valEl = this.xrayBar.querySelector('[data-xray-opacity-val]');
    if (valEl) valEl.textContent = `${pct}%`;
    this.root.style.setProperty('--pattern-xray-opacity', this.xrayOn ? String(this.xrayOpacity) : '1');
  }

  private async setAvatarOverlayEnabled(on: boolean): Promise<void> {
    this.avatarOverlayOn = on;
    this.avatarToggleBtn.classList.toggle('active', on);
    this.avatarBar.hidden = !on;
    if (!on) {
      this.avatarOverlayPath = '';
      this.avatarOverlayError = null;
      this.syncAvatarSvg();
      return;
    }
    await this.refreshAvatarOverlayPath();
  }

  private async refreshAvatarOverlayPath(): Promise<void> {
    if (!this.avatarOverlayOn) return;
    this.avatarOverlayLoading = true;
    this.avatarOverlayError = null;
    this.syncAvatarBarHint();
    try {
      const source = await ensureAvatarOverlaySource();
      if (!this.avatarOverlayOn) return;
      this.avatarOverlayPath = buildAvatarOverlayPath(source, this.avatarOverlayView);
    } catch (err) {
      this.avatarOverlayPath = '';
      this.avatarOverlayError = err instanceof Error ? err.message : 'Failed to load avatar';
    } finally {
      this.avatarOverlayLoading = false;
      this.syncAvatarBarHint();
      this.syncAvatarSvg();
    }
  }

  private syncAvatarBarHint(): void {
    const hint = this.avatarBar.querySelector('.pattern-avatar-bar-hint');
    if (!hint) return;
    if (this.avatarOverlayLoading) hint.textContent = 'Loading…';
    else if (this.avatarOverlayError) hint.textContent = this.avatarOverlayError;
    else hint.textContent = '15% · true scale (cm)';
  }

  private syncAvatarSvg(): void {
    const { x, y, w, h } = this.viewBox;
    this.avatarSvg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.avatarSvg.innerHTML = '';
    if (!this.avatarOverlayOn || !this.avatarOverlayPath) return;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute(
      'transform',
      `translate(${this.avatarOffsetX} ${this.avatarOffsetY})`
    );
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', this.avatarOverlayPath);
    path.setAttribute('class', 'pattern-avatar-mesh');
    g.appendChild(path);
    this.avatarSvg.appendChild(g);
  }

  private redraw(): void {
    const { x, y, w, h } = this.viewBox;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.avatarSvg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.svg.innerHTML = '';

    const grid = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    grid.setAttribute('class', 'pattern-grid');
    const step = this.unit === 'in' ? 2.54 : 5;
    const x0 = Math.floor(x / step) * step;
    const y0 = Math.floor(y / step) * step;
    const gridSw = this.px(1);
    for (let gx = x0; gx < x + w; gx += step) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(gx));
      line.setAttribute('y1', String(y));
      line.setAttribute('x2', String(gx));
      line.setAttribute('y2', String(y + h));
      line.setAttribute('stroke-width', String(gridSw));
      grid.appendChild(line);
    }
    for (let gy = y0; gy < y + h; gy += step) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(x));
      line.setAttribute('y1', String(gy));
      line.setAttribute('x2', String(x + w));
      line.setAttribute('y2', String(gy));
      line.setAttribute('stroke-width', String(gridSw));
      grid.appendChild(line);
    }
    this.svg.appendChild(grid);

    for (const piece of this.pattern.pieces) {
      this.drawPiece(piece);
    }

    this.drawSeams();

    if (this.tool === 'move') {
      this.drawSelectionChrome();
    }

    if (this.snapGuides.length > 0) {
      this.drawSnapGuides();
    }

    if (this.drag?.type === 'marquee') {
      this.drawMarquee(this.drag.start, this.drag.current);
    }

    this.updatePointBar();
  }

  private selectedPoint(): BezierPoint | null {
    if (!this.selectedPointId || this.selectedIds.size !== 1) return null;
    for (const piece of this.pattern.pieces) {
      const pt = piece.points.find((p) => p.id === this.selectedPointId);
      if (pt) return pt;
    }
    return null;
  }

  private isCornerPoint(pt: BezierPoint): boolean {
    const inZero =
      !pt.handleIn || (pt.handleIn.x === pt.anchor.x && pt.handleIn.y === pt.anchor.y);
    const outZero =
      !pt.handleOut || (pt.handleOut.x === pt.anchor.x && pt.handleOut.y === pt.anchor.y);
    return inZero && outZero;
  }

  private updatePointBar(): void {
    const pt = this.selectedPoint();
    if (!pt) {
      this.pointBar.classList.remove('visible');
      return;
    }
    this.pointBar.classList.add('visible');
    const corner = this.isCornerPoint(pt);
    this.cornerCheck.checked = corner;
    this.parallelCheck.checked = !!pt.handlesParallel;
    this.parallelCheck.disabled = corner;
  }

  /** Snapshot host undo history once before the next mutation in this gesture. */
  private markBeforeChange(): void {
    if (this.historyArmed) return;
    this.historyArmed = true;
    this.cbs.onBeforeChange?.();
  }

  private endHistoryGesture(): void {
    this.historyArmed = false;
  }

  private onParallelToggle(): void {
    const pt = this.selectedPoint();
    if (!pt || this.isCornerPoint(pt)) {
      this.updatePointBar();
      return;
    }
    this.markBeforeChange();
    pt.handlesParallel = this.parallelCheck.checked;
    if (pt.handlesParallel) this.mirrorHandlesFromPrimary(pt);
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private onCornerToggle(): void {
    const piece = this.activePiece();
    const pt = this.selectedPoint();
    if (!piece || !pt) {
      this.updatePointBar();
      return;
    }
    this.markBeforeChange();
    if (this.cornerCheck.checked) {
      pt.handleIn = null;
      pt.handleOut = null;
    } else {
      this.createDefaultHandles(piece, pt);
      pt.handlesParallel = false;
    }
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /** Make handleIn opposite handleOut (or vice versa if only in exists). */
  private mirrorHandlesFromPrimary(pt: BezierPoint): void {
    if (pt.handleOut) {
      const dx = pt.handleOut.x - pt.anchor.x;
      const dy = pt.handleOut.y - pt.anchor.y;
      pt.handleIn = { x: pt.anchor.x - dx, y: pt.anchor.y - dy };
    } else if (pt.handleIn) {
      const dx = pt.handleIn.x - pt.anchor.x;
      const dy = pt.handleIn.y - pt.anchor.y;
      pt.handleOut = { x: pt.anchor.x - dx, y: pt.anchor.y - dy };
    }
  }

  private selectionBBox(): BBox | null {
    if (this.selectedIds.size === 0) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let found = false;
    for (const piece of this.pattern.pieces) {
      for (const pt of piece.points) {
        if (!this.selectedIds.has(pt.id)) continue;
        found = true;
        minX = Math.min(minX, pt.anchor.x);
        minY = Math.min(minY, pt.anchor.y);
        maxX = Math.max(maxX, pt.anchor.x);
        maxY = Math.max(maxY, pt.anchor.y);
      }
    }
    if (!found) return null;
    // Degenerate (single point / colinear): give a tiny box so scale handles still work
    if (maxX - minX < 1e-6) {
      const pad = this.px(4);
      minX -= pad;
      maxX += pad;
    }
    if (maxY - minY < 1e-6) {
      const pad = this.px(4);
      minY -= pad;
      maxY += pad;
    }
    return { minX, minY, maxX, maxY };
  }

  private drawMarquee(a: Vec2, b: Vec2): void {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute('class', 'pattern-marquee');
    rect.setAttribute('stroke-width', String(this.px(1.5)));
    rect.setAttribute(
      'stroke-dasharray',
      `${this.px(6)} ${this.px(4)}`
    );
    rect.setAttribute('pointer-events', 'none');
    this.svg.appendChild(rect);
  }

  private drawSnapGuides(): void {
    const sw = this.px(1.5);
    const dash = `${this.px(4)} ${this.px(3)}`;
    for (const g of this.snapGuides) {
      if (g.kind === 'mid') {
        const stubA = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        stubA.setAttribute('x1', String(g.a.x));
        stubA.setAttribute('y1', String(g.a.y));
        stubA.setAttribute('x2', String(g.at.x));
        stubA.setAttribute('y2', String(g.at.y));
        stubA.setAttribute('class', 'pattern-snap-guide pattern-snap-guide-mid');
        stubA.setAttribute('stroke-width', String(sw));
        stubA.setAttribute('stroke-dasharray', dash);
        stubA.setAttribute('pointer-events', 'none');
        this.svg.appendChild(stubA);

        const stubB = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        stubB.setAttribute('x1', String(g.b.x));
        stubB.setAttribute('y1', String(g.b.y));
        stubB.setAttribute('x2', String(g.at.x));
        stubB.setAttribute('y2', String(g.at.y));
        stubB.setAttribute('class', 'pattern-snap-guide pattern-snap-guide-mid');
        stubB.setAttribute('stroke-width', String(sw));
        stubB.setAttribute('stroke-dasharray', dash);
        stubB.setAttribute('pointer-events', 'none');
        this.svg.appendChild(stubB);

        const mark = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        mark.setAttribute('cx', String(g.at.x));
        mark.setAttribute('cy', String(g.at.y));
        mark.setAttribute('r', String(this.px(3.5)));
        mark.setAttribute('class', 'pattern-snap-mid-mark');
        mark.setAttribute('pointer-events', 'none');
        this.svg.appendChild(mark);
        continue;
      }

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      if (g.axis === 'x') {
        line.setAttribute('x1', String(g.at));
        line.setAttribute('x2', String(g.at));
        line.setAttribute('y1', String(Math.min(g.from, g.to)));
        line.setAttribute('y2', String(Math.max(g.from, g.to)));
      } else {
        line.setAttribute('y1', String(g.at));
        line.setAttribute('y2', String(g.at));
        line.setAttribute('x1', String(Math.min(g.from, g.to)));
        line.setAttribute('x2', String(Math.max(g.from, g.to)));
      }
      line.setAttribute('class', 'pattern-snap-guide');
      line.setAttribute('stroke-width', String(sw));
      line.setAttribute('pointer-events', 'none');
      this.svg.appendChild(line);
    }
  }

  /**
   * Midpoints of edges (t=0.5) and midpoints between every pair of
   * non-selected anchors — used as snap targets while dragging.
   */
  private collectSnapMidTargets(): SnapMidTarget[] {
    const mids: SnapMidTarget[] = [];
    const seen = new Set<string>();
    const pushMid = (a: Vec2, b: Vec2, at: Vec2) => {
      const key = `${at.x.toFixed(4)},${at.y.toFixed(4)}`;
      if (seen.has(key)) return;
      seen.add(key);
      mids.push({ at: { x: at.x, y: at.y }, a, b });
    };

    // Edge midpoints (parametric halfway — honors curves).
    for (const piece of this.pattern.pieces) {
      const pts = piece.points;
      const n = pts.length;
      if (n < 2) continue;
      const edgeCount = piece.closed ? n : n - 1;
      for (let i = 0; i < edgeCount; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        if (this.selectedIds.has(a.id) || this.selectedIds.has(b.id)) continue;
        const at = pointOnEdgeAtT(piece, a.id, b.id, 0.5);
        if (at) pushMid(a.anchor, b.anchor, at);
      }
    }

    // Chord midpoints between every pair of free anchors (incl. cross-piece).
    const free: Vec2[] = [];
    for (const piece of this.pattern.pieces) {
      for (const pt of piece.points) {
        if (!this.selectedIds.has(pt.id)) free.push(pt.anchor);
      }
    }
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i];
        const b = free[j];
        pushMid(a, b, { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 });
      }
    }

    return mids;
  }

  /**
   * Soft-snap a rigid selection translate toward other anchors' X/Y,
   * edge midpoints, and midpoints between point pairs.
   */
  private softSnapTranslate(
    snapshots: PointSnapshot[],
    rawDx: number,
    rawDy: number,
    enabled: boolean
  ): { dx: number; dy: number; guides: SnapGuide[] } {
    if (!enabled || snapshots.length === 0) {
      return { dx: rawDx, dy: rawDy, guides: [] };
    }

    const threshold = this.px(9);
    const midTargets = this.collectSnapMidTargets();

    const refs: Vec2[] = [];
    for (const piece of this.pattern.pieces) {
      for (const pt of piece.points) {
        if (this.selectedIds.has(pt.id)) continue;
        refs.push(pt.anchor);
      }
    }
    for (const m of midTargets) refs.push(m.at);

    if (refs.length === 0) {
      return { dx: rawDx, dy: rawDy, guides: [] };
    }

    // Prefer a full 2D snap onto a midpoint when close enough.
    let bestMidDist = threshold;
    let midAdjX = 0;
    let midAdjY = 0;
    let bestMid: SnapMidTarget | null = null;
    for (const s of snapshots) {
      const cx = s.anchor.x + rawDx;
      const cy = s.anchor.y + rawDy;
      for (const m of midTargets) {
        const d = Math.hypot(cx - m.at.x, cy - m.at.y);
        if (d < bestMidDist) {
          bestMidDist = d;
          midAdjX = m.at.x - cx;
          midAdjY = m.at.y - cy;
          bestMid = m;
        }
      }
    }

    if (bestMid) {
      const dx = rawDx + midAdjX;
      const dy = rawDy + midAdjY;
      return {
        dx,
        dy,
        guides: [{ kind: 'mid', at: bestMid.at, a: bestMid.a, b: bestMid.b }],
      };
    }

    let bestAbsDx = threshold;
    let snapAdjX = 0;
    let bestAbsDy = threshold;
    let snapAdjY = 0;

    for (const s of snapshots) {
      const cx = s.anchor.x + rawDx;
      const cy = s.anchor.y + rawDy;
      for (const ref of refs) {
        const adx = Math.abs(cx - ref.x);
        if (adx < bestAbsDx) {
          bestAbsDx = adx;
          snapAdjX = ref.x - cx;
        }
        const ady = Math.abs(cy - ref.y);
        if (ady < bestAbsDy) {
          bestAbsDy = ady;
          snapAdjY = ref.y - cy;
        }
      }
    }

    const dx = rawDx + (bestAbsDx < threshold ? snapAdjX : 0);
    const dy = rawDy + (bestAbsDy < threshold ? snapAdjY : 0);

    // Build guides for every alignment that holds after the snap
    const eps = Math.max(1e-4, threshold * 0.05);
    const guides: SnapGuide[] = [];
    const seenV = new Set<string>();
    const seenH = new Set<string>();

    for (const s of snapshots) {
      const mx = s.anchor.x + dx;
      const my = s.anchor.y + dy;
      for (const ref of refs) {
        if (Math.abs(mx - ref.x) <= eps) {
          const key = `v:${ref.x.toFixed(4)}:${Math.min(my, ref.y).toFixed(3)}:${Math.max(my, ref.y).toFixed(3)}`;
          if (!seenV.has(key)) {
            seenV.add(key);
            guides.push({ kind: 'axis', axis: 'x', at: ref.x, from: my, to: ref.y });
          }
        }
        if (Math.abs(my - ref.y) <= eps) {
          const key = `h:${ref.y.toFixed(4)}:${Math.min(mx, ref.x).toFixed(3)}:${Math.max(mx, ref.x).toFixed(3)}`;
          if (!seenH.has(key)) {
            seenH.add(key);
            guides.push({ kind: 'axis', axis: 'y', at: ref.y, from: mx, to: ref.x });
          }
        }
      }
    }

    return { dx, dy, guides };
  }

  /** Padded bbox used for selection chrome + scale handle math. */
  private selectionScaleBox(): BBox | null {
    const box = this.selectionBBox();
    if (!box) return null;
    const pad = this.px(6);
    return {
      minX: box.minX - pad,
      minY: box.minY - pad,
      maxX: box.maxX + pad,
      maxY: box.maxY + pad,
    };
  }

  private drawSelectionChrome(): void {
    if (this.selectedIds.size < 2) return;
    const box = this.selectionScaleBox();
    if (!box) return;
    const x = box.minX;
    const y = box.minY;
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute('class', 'pattern-selection-box');
    rect.setAttribute('stroke-width', String(this.px(1.75)));
    rect.setAttribute('stroke-dasharray', `${this.px(7)} ${this.px(4)}`);
    rect.dataset.kind = 'selectionBox';
    this.svg.appendChild(rect);

    const hs = this.px(8);
    const handleSw = this.px(1.5);
    const midX = x + w / 2;
    const midY = y + h / 2;
    const handles: Array<{ handle: ScaleHandle; cx: number; cy: number }> = [
      { handle: 'nw', cx: x, cy: y },
      { handle: 'ne', cx: x + w, cy: y },
      { handle: 'sw', cx: x, cy: y + h },
      { handle: 'se', cx: x + w, cy: y + h },
      { handle: 'n', cx: midX, cy: y },
      { handle: 's', cx: midX, cy: y + h },
      { handle: 'w', cx: x, cy: midY },
      { handle: 'e', cx: x + w, cy: midY },
    ];
    for (const c of handles) {
      const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      handle.setAttribute('x', String(c.cx - hs / 2));
      handle.setAttribute('y', String(c.cy - hs / 2));
      handle.setAttribute('width', String(hs));
      handle.setAttribute('height', String(hs));
      handle.setAttribute('class', 'pattern-scale-handle');
      handle.setAttribute('stroke-width', String(handleSw));
      handle.dataset.kind = 'scale';
      handle.dataset.handle = c.handle;
      // Keep legacy attr for any CSS that still keys off corner.
      if (c.handle.length === 2) handle.dataset.corner = c.handle;
      this.svg.appendChild(handle);
    }
  }

  private drawPiece(piece: PatternPiece): void {
    const n = piece.points.length;
    if (n > 0) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', this.piecePathD(piece));
      path.setAttribute('class', 'pattern-fill');
      path.setAttribute('stroke-width', String(this.px(2)));
      path.dataset.pieceId = piece.id;
      this.svg.appendChild(path);
    }

    const lengths = segmentLengths(piece.points, piece.closed);
    const edgeCount = piece.closed ? n : Math.max(0, n - 1);
    const fontSize = this.px(11);
    for (let i = 0; i < edgeCount; i++) {
      const a = piece.points[i].anchor;
      const b = piece.points[(i + 1) % n].anchor;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(mid.x));
      label.setAttribute('y', String(mid.y - this.px(10)));
      label.setAttribute('class', 'pattern-length');
      label.setAttribute('font-size', String(fontSize));
      label.setAttribute('pointer-events', 'none');
      label.style.userSelect = 'none';
      label.textContent = formatLength(lengths[i], this.unit, 1);
      this.svg.appendChild(label);
    }

    if (piece.grainline) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      g.setAttribute('x1', String(piece.grainline.from.x));
      g.setAttribute('y1', String(piece.grainline.from.y));
      g.setAttribute('x2', String(piece.grainline.to.x));
      g.setAttribute('y2', String(piece.grainline.to.y));
      g.setAttribute('class', 'pattern-grain');
      g.setAttribute('stroke-width', String(this.px(2)));
      g.setAttribute('stroke-dasharray', `${this.px(6)} ${this.px(4)}`);
      this.svg.appendChild(g);
    }

    const showHandles =
      this.tool === 'bend' ||
      this.tool === 'pen' ||
      (this.tool === 'move' && this.selectedIds.size === 1);

    const pointR = this.px(5);
    const pointSw = this.px(1.5);
    for (const pt of piece.points) {
      if (showHandles && (pt.handleIn || pt.handleOut || this.selectedIds.has(pt.id))) {
        this.drawHandles(piece, pt);
      }
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(pt.anchor.x));
      c.setAttribute('cy', String(pt.anchor.y));
      c.setAttribute('r', String(pointR));
      c.setAttribute('stroke-width', String(pointSw));
      c.setAttribute(
        'class',
        this.selectedIds.has(pt.id) ? 'pattern-point selected' : 'pattern-point'
      );
      c.dataset.pointId = pt.id;
      c.dataset.pieceId = piece.id;
      c.dataset.kind = 'anchor';
      this.svg.appendChild(c);
    }
  }

  private piecePathD(piece: PatternPiece): string {
    const pts = piece.points;
    if (pts.length === 0) return '';
    let d = `M ${pts[0].anchor.x} ${pts[0].anchor.y}`;
    const n = pts.length;
    const edgeCount = piece.closed ? n : Math.max(0, n - 1);
    for (let i = 0; i < edgeCount; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const { c0, c1 } = edgeHandles(a, b);
      const linear =
        (!a.handleOut || (a.handleOut.x === a.anchor.x && a.handleOut.y === a.anchor.y)) &&
        (!b.handleIn || (b.handleIn.x === b.anchor.x && b.handleIn.y === b.anchor.y));
      if (linear) d += ` L ${b.anchor.x} ${b.anchor.y}`;
      else d += ` C ${c0.x} ${c0.y}, ${c1.x} ${c1.y}, ${b.anchor.x} ${b.anchor.y}`;
    }
    if (piece.closed) d += ' Z';
    return d;
  }

  private drawHandles(piece: PatternPiece, pt: BezierPoint): void {
    const lineSw = this.px(1.25);
    const handleR = this.px(4);
    const handleSw = this.px(1.5);
    const drawOne = (h: Vec2, which: 'in' | 'out') => {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(pt.anchor.x));
      line.setAttribute('y1', String(pt.anchor.y));
      line.setAttribute('x2', String(h.x));
      line.setAttribute('y2', String(h.y));
      line.setAttribute('class', 'pattern-handle-line');
      line.setAttribute('stroke-width', String(lineSw));
      this.svg.appendChild(line);
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(h.x));
      c.setAttribute('cy', String(h.y));
      c.setAttribute('r', String(handleR));
      c.setAttribute('stroke-width', String(handleSw));
      c.setAttribute('class', 'pattern-handle');
      c.dataset.pointId = pt.id;
      c.dataset.pieceId = piece.id;
      c.dataset.kind = which === 'in' ? 'handleIn' : 'handleOut';
      this.svg.appendChild(c);
    };
    if (pt.handleIn) drawOne(pt.handleIn, 'in');
    if (pt.handleOut) drawOne(pt.handleOut, 'out');
  }

  private svgPointFromClient(clientX: number, clientY: number): Vec2 {
    // Board CSS scale breaks getScreenCTM(); map via getBoundingClientRect + viewBox (xMidYMid meet).
    const rect = this.svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return { x: 0, y: 0 };
    const vb = this.viewBox;
    const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
    const mappedW = vb.w * scale;
    const mappedH = vb.h * scale;
    const ox = rect.left + (rect.width - mappedW) / 2;
    const oy = rect.top + (rect.height - mappedH) / 2;
    return {
      x: vb.x + (clientX - ox) / scale,
      y: vb.y + (clientY - oy) / scale,
    };
  }

  private svgPoint(e: PointerEvent): Vec2 {
    return this.svgPointFromClient(e.clientX, e.clientY);
  }

  /**
   * Pattern-space length equal to `cssPixels` inside the SVG element.
   * Uses clientWidth/Height (not getBoundingClientRect) so parent board CSS
   * zoom doesn't skew the viewBox→layout mapping used for chrome sizing.
   */
  private px(cssPixels: number): number {
    const s = this.viewScale();
    return s > 1e-6 ? cssPixels / s : cssPixels;
  }

  /** Layout CSS px per pattern unit (xMidYMid meet). */
  private viewScale(): number {
    const w = this.svg.clientWidth;
    const h = this.svg.clientHeight;
    if (w < 1 || h < 1) return 1;
    return Math.min(w / this.viewBox.w, h / this.viewBox.h);
  }

  /** Screen px per pattern unit (includes board CSS zoom) — for pointer math. */
  private screenToPatternScale(): number {
    const rect = this.svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return 1;
    return Math.min(rect.width / this.viewBox.w, rect.height / this.viewBox.h);
  }

  private hitRadius(): number {
    return this.px(10);
  }

  private findPointNear(p: Vec2): { piece: PatternPiece; point: BezierPoint } | null {
    const r = this.hitRadius();
    for (const piece of this.pattern.pieces) {
      for (const pt of piece.points) {
        if (dist(p, pt.anchor) <= r) return { piece, point: pt };
      }
    }
    return null;
  }

  private snapshotSelection(): PointSnapshot[] {
    const out: PointSnapshot[] = [];
    for (const piece of this.pattern.pieces) {
      for (const pt of piece.points) {
        if (!this.selectedIds.has(pt.id)) continue;
        out.push({
          pieceId: piece.id,
          pointId: pt.id,
          anchor: { ...pt.anchor },
          handleIn: pt.handleIn ? { ...pt.handleIn } : null,
          handleOut: pt.handleOut ? { ...pt.handleOut } : null,
        });
      }
    }
    return out;
  }

  private applySnapshotsTranslated(snapshots: PointSnapshot[], dx: number, dy: number): void {
    for (const s of snapshots) {
      const piece = this.pattern.pieces.find((x) => x.id === s.pieceId);
      const pt = piece?.points.find((x) => x.id === s.pointId);
      if (!pt) continue;
      pt.anchor = { x: s.anchor.x + dx, y: s.anchor.y + dy };
      if (s.handleIn) pt.handleIn = { x: s.handleIn.x + dx, y: s.handleIn.y + dy };
      if (s.handleOut) pt.handleOut = { x: s.handleOut.x + dx, y: s.handleOut.y + dy };
    }
  }

  private applySnapshotsScaled(
    snapshots: PointSnapshot[],
    fixed: Vec2,
    sx: number,
    sy: number
  ): void {
    const safeSx = Number.isFinite(sx) && Math.abs(sx) > 1e-6 ? sx : Math.sign(sx) || 1e-6;
    const safeSy = Number.isFinite(sy) && Math.abs(sy) > 1e-6 ? sy : Math.sign(sy) || 1e-6;
    const map = (v: Vec2): Vec2 => ({
      x: fixed.x + (v.x - fixed.x) * safeSx,
      y: fixed.y + (v.y - fixed.y) * safeSy,
    });
    for (const s of snapshots) {
      const piece = this.pattern.pieces.find((x) => x.id === s.pieceId);
      const pt = piece?.points.find((x) => x.id === s.pointId);
      if (!pt) continue;
      pt.anchor = map(s.anchor);
      if (s.handleIn) pt.handleIn = map(s.handleIn);
      if (s.handleOut) pt.handleOut = map(s.handleOut);
    }
  }

  private pointsInRect(a: Vec2, b: Vec2): string[] {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    const ids: string[] = [];
    for (const piece of this.pattern.pieces) {
      for (const pt of piece.points) {
        if (
          pt.anchor.x >= minX &&
          pt.anchor.x <= maxX &&
          pt.anchor.y >= minY &&
          pt.anchor.y <= maxY
        ) {
          ids.push(pt.id);
          this.selectedPieceId = piece.id;
        }
      }
    }
    return ids;
  }

  private scaleFixedPoint(box: BBox, handle: ScaleHandle): Vec2 {
    const midX = (box.minX + box.maxX) / 2;
    const midY = (box.minY + box.maxY) / 2;
    switch (handle) {
      case 'nw':
        return { x: box.maxX, y: box.maxY };
      case 'ne':
        return { x: box.minX, y: box.maxY };
      case 'sw':
        return { x: box.maxX, y: box.minY };
      case 'se':
        return { x: box.minX, y: box.minY };
      case 'n':
        return { x: midX, y: box.maxY };
      case 's':
        return { x: midX, y: box.minY };
      case 'w':
        return { x: box.maxX, y: midY };
      case 'e':
        return { x: box.minX, y: midY };
    }
  }

  private scaleHandlePoint(box: BBox, handle: ScaleHandle): Vec2 {
    const midX = (box.minX + box.maxX) / 2;
    const midY = (box.minY + box.maxY) / 2;
    switch (handle) {
      case 'nw':
        return { x: box.minX, y: box.minY };
      case 'ne':
        return { x: box.maxX, y: box.minY };
      case 'sw':
        return { x: box.minX, y: box.maxY };
      case 'se':
        return { x: box.maxX, y: box.maxY };
      case 'n':
        return { x: midX, y: box.minY };
      case 's':
        return { x: midX, y: box.maxY };
      case 'w':
        return { x: box.minX, y: midY };
      case 'e':
        return { x: box.maxX, y: midY };
    }
  }

  private scaleAxisForHandle(handle: ScaleHandle): 'both' | 'x' | 'y' {
    if (handle === 'n' || handle === 's') return 'y';
    if (handle === 'e' || handle === 'w') return 'x';
    return 'both';
  }

  private selectEntirePiece(piece: PatternPiece): void {
    this.selectedPieceId = piece.id;
    this.setSelection(piece.points.map((pt) => pt.id));
  }

  private pieceFromPointId(pointId: string): PatternPiece | null {
    for (const piece of this.pattern.pieces) {
      if (piece.points.some((pt) => pt.id === pointId)) return piece;
    }
    return null;
  }

  private resolveContextPiece(e: MouseEvent): PatternPiece | null {
    const target = e.target as SVGElement;
    const pieceId = target.dataset?.pieceId;
    if (pieceId) {
      return this.pattern.pieces.find((p) => p.id === pieceId) ?? null;
    }
    const pointId = target.dataset?.pointId;
    if (pointId) {
      return this.pieceFromPointId(pointId);
    }
    // Selection box / scale handle → active selection's piece
    if (this.selectedIds.size > 0) {
      const first = this.selectedIds.values().next().value as string | undefined;
      if (first) {
        const fromSel = this.pieceFromPointId(first);
        if (fromSel) return fromSel;
      }
    }
    // Click near an edge of the active piece
    const p = this.svgPointFromClient(e.clientX, e.clientY);
    const piece = this.activePiece();
    if (piece && piece.points.length >= 2) {
      const hit = findNearestEdge(piece.points, piece.closed, p);
      if (hit && hit.dist <= this.hitRadius() * 2.5) return piece;
    }
    return null;
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.root.focus({ preventScroll: true });

    // Cancel pending sew pick instead of opening the piece menu
    if (this.pendingSeam) {
      this.pendingSeam = null;
      this.hoverEdge = null;
      this.hideContextMenu();
      this.redraw();
      return;
    }

    const p = this.svgPointFromClient(e.clientX, e.clientY);
    const seamHit = this.findSeamNearClick(p);
    if (seamHit) {
      this.contextSeamId = seamHit.id;
      this.contextPieceId = null;
      this.showContextMenu(e.clientX, e.clientY, 'seam');
      this.redraw();
      return;
    }

    const piece = this.resolveContextPiece(e);
    if (!piece || piece.points.length === 0) {
      this.hideContextMenu();
      return;
    }
    this.selectEntirePiece(piece);
    this.contextPieceId = piece.id;
    this.contextSeamId = null;
    this.showContextMenu(e.clientX, e.clientY, 'piece');
    this.redraw();
  }

  private showContextMenu(clientX: number, clientY: number, mode: 'piece' | 'seam' = 'piece'): void {
    const pieceActs = ['duplicate', 'mirror-x', 'mirror-y', 'delete-piece'];
    const seamActs = ['reverse-seam', 'remove-seam'];
    for (const btn of Array.from(this.contextMenu.querySelectorAll('button[data-act]'))) {
      const act = (btn as HTMLElement).dataset.act!;
      const show =
        mode === 'piece' ? pieceActs.includes(act) : seamActs.includes(act);
      (btn as HTMLButtonElement).hidden = !show;
    }

    const rect = this.viewport.getBoundingClientRect();
    this.contextMenu.hidden = false;
    // Measure after showing so we can clamp inside the viewport
    const mw = this.contextMenu.offsetWidth || 160;
    const mh = this.contextMenu.offsetHeight || 100;
    let left = clientX - rect.left;
    let top = clientY - rect.top;
    left = Math.max(4, Math.min(left, rect.width - mw - 4));
    top = Math.max(4, Math.min(top, rect.height - mh - 4));
    this.contextMenu.style.left = `${left}px`;
    this.contextMenu.style.top = `${top}px`;
  }

  private hideContextMenu(): void {
    this.contextMenu.hidden = true;
    this.contextPieceId = null;
    this.contextSeamId = null;
  }

  private makePieceId = (): string => uid('pt');

  private afterPieceDuplicated(copy: PatternPiece): void {
    this.markBeforeChange();
    this.pattern.pieces.push(copy);
    this.selectEntirePiece(copy);
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private duplicateContextPiece(): void {
    const piece =
      this.pattern.pieces.find((p) => p.id === this.contextPieceId) ?? this.activePiece();
    if (!piece) return;
    const box = anchorsBounds(piece.points);
    const gap = 2;
    const copy = clonePatternPiece(piece, this.makePieceId, {
      x: (box.maxX - box.minX || 10) + gap,
      y: 0,
    });
    copy.id = uid('piece');
    this.afterPieceDuplicated(copy);
  }

  private mirrorDuplicateContextPiece(axis: 'x' | 'y'): void {
    const piece =
      this.pattern.pieces.find((p) => p.id === this.contextPieceId) ?? this.activePiece();
    if (!piece) return;
    const copy = mirrorClonePatternPiece(piece, axis, this.makePieceId);
    copy.id = uid('piece');
    this.afterPieceDuplicated(copy);
  }

  private deleteContextPiece(): void {
    const id = this.contextPieceId ?? this.selectedPieceId;
    if (!id) return;
    this.deletePiece(id);
  }

  private deletePiece(pieceId: string): void {
    this.markBeforeChange();
    this.pattern.pieces = this.pattern.pieces.filter((p) => p.id !== pieceId);
    this.pattern.seams = this.pattern.seams.filter(
      (s) => s.a.pieceId !== pieceId && s.b.pieceId !== pieceId
    );
    this.clearSelection();
    this.selectedPieceId = this.pattern.pieces[0]?.id ?? null;
    this.contextPieceId = null;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /** True when every point of the piece is in the selection (whole shape selected). */
  private isEntirePieceSelected(piece: PatternPiece): boolean {
    return piece.points.length > 0 && piece.points.every((pt) => this.selectedIds.has(pt.id));
  }

  private deleteSelectedPoints(): void {
    const piece = this.activePiece();
    if (!piece || this.selectedIds.size === 0) return;
    this.markBeforeChange();

    const minPts = piece.closed ? 3 : 1;
    const remaining = piece.points.filter((pt) => !this.selectedIds.has(pt.id));
    if (remaining.length < minPts) {
      // Removing these points would invalidate the outline — delete the piece instead
      this.deletePiece(piece.id);
      return;
    }

    piece.points = remaining;
    this.clearSelection();
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private handleDeleteKey(): void {
    const piece = this.activePiece();
    if (!piece) return;

    if (this.selectedIds.size === 0) {
      // No points selected but piece is active after empty click — ignore
      return;
    }

    if (this.isEntirePieceSelected(piece)) {
      this.deletePiece(piece.id);
      return;
    }

    this.deleteSelectedPoints();
  }

  private onPointerDown(e: PointerEvent): void {
    this.root.focus({ preventScroll: true });
    if (e.button === 0) this.hideContextMenu();
    if (e.button !== 0) return;
    e.stopPropagation();

    // Alt-drag pans the pattern view (same idea as board Alt-drag)
    if (e.altKey) {
      this.drag = {
        type: 'pan',
        startClient: { x: e.clientX, y: e.clientY },
        startView: { x: this.viewBox.x, y: this.viewBox.y },
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    const target = e.target as SVGElement;
    const kind = target.dataset?.kind;
    const pointId = target.dataset?.pointId;
    const pieceId = target.dataset?.pieceId;
    const p = this.svgPoint(e);

    if (this.tool === 'pen') {
      this.onPenDown(e, p);
      return;
    }

    if (this.tool === 'dart') {
      this.onDartDown(p);
      return;
    }

    if (this.tool === 'sew') {
      this.onSewDown(p);
      return;
    }

    if (this.tool === 'move' && kind === 'scale') {
      const handle = (target.dataset.handle ?? target.dataset.corner) as ScaleHandle | undefined;
      const box = this.selectionScaleBox();
      if (!handle || !box || this.selectedIds.size < 2) return;
      const fixed = this.scaleFixedPoint(box, handle);
      const startHandle = this.scaleHandlePoint(box, handle);
      this.markBeforeChange();
      this.drag = {
        type: 'scaleSelection',
        handle,
        axis: this.scaleAxisForHandle(handle),
        start: p,
        fixed,
        startSize: {
          x: startHandle.x - fixed.x,
          y: startHandle.y - fixed.y,
        },
        snapshots: this.snapshotSelection(),
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (this.tool === 'move' && kind === 'selectionBox') {
      this.markBeforeChange();
      this.drag = {
        type: 'moveSelection',
        start: p,
        snapshots: this.snapshotSelection(),
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (kind === 'handleIn' || kind === 'handleOut') {
      if (!pointId || !pieceId) return;
      this.selectOnly(pointId, pieceId);
      const piece = this.pattern.pieces.find((x) => x.id === pieceId)!;
      const pt = piece.points.find((x) => x.id === pointId)!;
      this.markBeforeChange();
      this.drag = {
        type: 'handle',
        pieceId,
        pointId,
        which: kind === 'handleIn' ? 'in' : 'out',
        mirror: !!pt.handlesParallel && !e.altKey,
      };
      this.svg.setPointerCapture(e.pointerId);
      this.redraw();
      return;
    }

    if (kind === 'anchor' && pointId && pieceId) {
      if (this.tool === 'move') {
        if (e.shiftKey) {
          // Toggle in multi-selection
          if (this.selectedIds.has(pointId)) {
            this.selectedIds.delete(pointId);
            if (this.selectedPointId === pointId) {
              this.selectedPointId = this.selectedIds.values().next().value ?? null;
            }
          } else {
            this.selectedIds.add(pointId);
            this.selectedPointId = pointId;
            this.selectedPieceId = pieceId;
          }
          this.redraw();
          return;
        }

        if (!this.selectedIds.has(pointId)) {
          this.selectOnly(pointId, pieceId);
        } else {
          this.selectedPointId = pointId;
          this.selectedPieceId = pieceId;
        }

        this.markBeforeChange();
        this.drag = {
          type: 'moveSelection',
          start: p,
          snapshots: this.snapshotSelection(),
        };
        this.svg.setPointerCapture(e.pointerId);
        this.redraw();
        return;
      }

      // Bend / other: single-point select + drag
      this.selectOnly(pointId, pieceId);
      const piece = this.pattern.pieces.find((x) => x.id === pieceId)!;
      const pt = piece.points.find((x) => x.id === pointId)!;

      if (this.tool === 'bend') {
        if (!pt.handleIn && !pt.handleOut) {
          this.markBeforeChange();
          this.createDefaultHandles(piece, pt);
          pt.handlesParallel = false;
          this.cbs.onChange();
        }
      }

      this.markBeforeChange();
      this.drag = {
        type: 'moveSelection',
        start: p,
        snapshots: this.snapshotSelection(),
      };
      this.svg.setPointerCapture(e.pointerId);
      this.redraw();
      return;
    }

    // Bend: click empty path area near a segment midpoint → bend that edge
    if (this.tool === 'bend') {
      this.markBeforeChange();
      const bent = this.bendNearestSegment(p);
      if (bent) {
        this.cbs.onChange();
        this.endHistoryGesture();
        this.redraw();
      } else {
        this.endHistoryGesture();
      }
      return;
    }

    // Move tool: empty drag → marquee
    if (this.tool === 'move') {
      this.drag = {
        type: 'marquee',
        start: p,
        current: p,
        additive: e.shiftKey,
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
    }
  }

  private onDartDown(p: Vec2): void {
    const piece = this.activePiece();
    if (!piece) return;
    if (!piece.closed || piece.points.length < 3) return;
    this.markBeforeChange();
    const result = insertDartOnPiece(piece.points, piece.closed, p, () => uid('pt'));
    if (!result.ok) {
      this.endHistoryGesture();
      return;
    }
    this.selectOnly(result.apexId, piece.id);
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /** Nearest edge across all pieces within a screen-space threshold. */
  private findNearestEdgeAcrossPieces(
    p: Vec2
  ): { piece: PatternPiece; edgeIndex: number; fromPointId: string; toPointId: string; dist: number } | null {
    const threshold = Math.max(0.5, 12 / this.screenToPatternScale());
    let best: {
      piece: PatternPiece;
      edgeIndex: number;
      fromPointId: string;
      toPointId: string;
      dist: number;
    } | null = null;
    for (const piece of this.pattern.pieces) {
      if (piece.points.length < 2) continue;
      const hit = findNearestEdge(piece.points, piece.closed, p);
      if (!hit || hit.dist > threshold) continue;
      if (!best || hit.dist < best.dist) {
        const n = piece.points.length;
        const a = piece.points[hit.edgeIndex];
        const b = piece.points[(hit.edgeIndex + 1) % n];
        best = {
          piece,
          edgeIndex: hit.edgeIndex,
          fromPointId: a.id,
          toPointId: b.id,
          dist: hit.dist,
        };
      }
    }
    return best;
  }

  private sameEdge(a: HoverEdge | SeamEdgeRef, b: HoverEdge | SeamEdgeRef): boolean {
    return (
      a.pieceId === b.pieceId &&
      a.fromPointId === b.fromPointId &&
      a.toPointId === b.toPointId
    );
  }

  private onSewDown(p: Vec2): void {
    const hit = this.findNearestEdgeAcrossPieces(p);
    if (!hit) return;

    const edge: SeamEdgeRef = {
      pieceId: hit.piece.id,
      fromPointId: hit.fromPointId,
      toPointId: hit.toPointId,
      t0: 0,
      t1: 1,
    };

    if (!this.pendingSeam) {
      this.pendingSeam = edge;
      this.selectedPieceId = hit.piece.id;
      this.redraw();
      return;
    }

    if (this.sameEdge(this.pendingSeam, edge)) {
      // Clicking the same edge again cancels the first pick
      this.pendingSeam = null;
      this.redraw();
      return;
    }

    // Reject duplicate of the same undirected edge pair.
    const dup = this.pattern.seams.some(
      (s) =>
        (this.sameEdge(s.a, this.pendingSeam!) && this.sameEdge(s.b, edge)) ||
        (this.sameEdge(s.b, this.pendingSeam!) && this.sameEdge(s.a, edge))
    );
    if (dup) {
      this.pendingSeam = null;
      this.redraw();
      return;
    }

    const seam: SeamBinding = {
      id: uid('seam'),
      a: this.pendingSeam,
      b: edge,
      // Small positive gap — zero-rest welds destabilize the cloth solvers.
      restGapCm: DEFAULT_SEAM_GAP_CM,
    };
    this.markBeforeChange();
    this.pattern.seams.push(seam);
    this.pendingSeam = null;
    this.hoverEdge = null;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private findSeamNearClick(p: Vec2): SeamBinding | null {
    const threshold = Math.max(0.5, 12 / this.screenToPatternScale());
    let best: { seam: SeamBinding; dist: number } | null = null;
    for (const seam of this.pattern.seams) {
      for (const ref of [seam.a, seam.b]) {
        const piece = this.pattern.pieces.find((x) => x.id === ref.pieceId);
        if (!piece) continue;
        const idx = edgeIndexForPointIds(piece, ref.fromPointId, ref.toPointId);
        if (idx === null) continue;
        const hit = findNearestEdge(piece.points, piece.closed, p);
        // Only count if the nearest edge on this piece is exactly this seam edge
        if (!hit || hit.edgeIndex !== idx || hit.dist > threshold) continue;
        if (!best || hit.dist < best.dist) best = { seam, dist: hit.dist };
      }
    }
    return best?.seam ?? null;
  }

  private reverseContextSeam(): void {
    const seam = this.pattern.seams.find((s) => s.id === this.contextSeamId);
    if (!seam) return;
    this.markBeforeChange();
    // Swap t0/t1 on side B to reverse sewing direction (MD-style)
    const t0 = seam.b.t0;
    seam.b.t0 = seam.b.t1;
    seam.b.t1 = t0;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private removeContextSeam(): void {
    if (!this.contextSeamId) return;
    this.markBeforeChange();
    this.pattern.seams = this.pattern.seams.filter((s) => s.id !== this.contextSeamId);
    this.contextSeamId = null;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private drawSeams(): void {
    // Hover / pending previews
    if (this.hoverEdge) {
      this.drawSeamEdgeStroke(this.hoverEdge, 'pattern-seam-hover', true);
    }
    if (this.pendingSeam) {
      this.drawSeamEdgeStroke(this.pendingSeam, 'pattern-seam-pending', true);
    }

    for (const seam of this.pattern.seams) {
      const aValid = isSeamEdgeValid(this.pattern.pieces, seam.a);
      const bValid = isSeamEdgeValid(this.pattern.pieces, seam.b);
      const stale = !aValid || !bValid;
      const cls = stale ? 'pattern-seam-edge pattern-seam-stale' : 'pattern-seam-edge';
      if (aValid) this.drawSeamEdgeStroke(seam.a, cls, true);
      if (bValid) this.drawSeamEdgeStroke(seam.b, cls, true);
      if (stale) {
        // Midpoint warning on whichever side we can still resolve
        const ref = aValid ? seam.a : bValid ? seam.b : null;
        if (ref) {
          const piece = this.pattern.pieces.find((x) => x.id === ref.pieceId);
          const samples = piece
            ? sampleEdgeByPointIds(piece, ref.fromPointId, ref.toPointId)
            : null;
          if (samples && samples.length > 0) {
            const mid = samples[Math.floor(samples.length / 2)];
            const mark = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            mark.setAttribute('x', String(mid.x));
            mark.setAttribute('y', String(mid.y - this.px(12)));
            mark.setAttribute('class', 'pattern-seam-warning');
            mark.setAttribute('font-size', String(this.px(14)));
            mark.setAttribute('pointer-events', 'none');
            mark.textContent = '!';
            this.svg.appendChild(mark);
          }
        }
      }
    }
  }

  private drawSeamEdgeStroke(
    ref: HoverEdge | SeamEdgeRef,
    className: string,
    withNotch: boolean
  ): void {
    const piece = this.pattern.pieces.find((x) => x.id === ref.pieceId);
    if (!piece) return;
    const samples = sampleEdgeByPointIds(piece, ref.fromPointId, ref.toPointId, 20);
    if (!samples || samples.length < 2) return;

    // Direction from t0→t1 when present (SeamEdgeRef); default forward
    const reversed =
      't0' in ref && 't1' in ref && (ref as SeamEdgeRef).t0 > (ref as SeamEdgeRef).t1;
    const pts = reversed ? [...samples].reverse() : samples;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`;
    path.setAttribute('d', d);
    path.setAttribute('class', className);
    path.setAttribute('fill', 'none');
    path.setAttribute('pointer-events', 'none');
    const isHover = className.includes('hover');
    const isPending = className.includes('pending');
    const isStale = className.includes('stale');
    const sw = isPending ? 3.5 : isHover ? 3.25 : isStale ? 2.25 : 3;
    path.setAttribute('stroke-width', String(this.px(sw)));
    if (isStale) {
      path.setAttribute('stroke-dasharray', `${this.px(6)} ${this.px(4)}`);
    }
    this.svg.appendChild(path);

    if (withNotch) {
      // Directional notch ticks like MD sewing notches (perpendicular, mid-edge)
      const midIdx = Math.floor(pts.length / 2);
      const a = pts[Math.max(0, midIdx - 1)];
      const b = pts[Math.min(pts.length - 1, midIdx + 1)];
      const tx = b.x - a.x;
      const ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1;
      const ux = tx / len;
      const uy = ty / len;
      // Perpendicular (left of direction)
      const nx = -uy;
      const ny = ux;
      const mid = pts[midIdx];
      const notchLen = this.px(10);
      const notchSw = this.px(2);
      const notch = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      notch.setAttribute('x1', String(mid.x));
      notch.setAttribute('y1', String(mid.y));
      notch.setAttribute('x2', String(mid.x + nx * notchLen));
      notch.setAttribute('y2', String(mid.y + ny * notchLen));
      notch.setAttribute('class', 'pattern-seam-notch');
      notch.setAttribute('stroke-width', String(notchSw));
      notch.setAttribute('pointer-events', 'none');
      this.svg.appendChild(notch);

      // Small arrowhead along the edge direction
      const ah = this.px(6);
      const tipPt = {
        x: mid.x + ux * ah,
        y: mid.y + uy * ah,
      };
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      arrow.setAttribute(
        'points',
        `${mid.x - ux * ah * 0.3 + nx * ah * 0.45},${mid.y - uy * ah * 0.3 + ny * ah * 0.45} ${tipPt.x},${tipPt.y} ${mid.x - ux * ah * 0.3 - nx * ah * 0.45},${mid.y - uy * ah * 0.3 - ny * ah * 0.45}`
      );
      arrow.setAttribute('class', 'pattern-seam-notch');
      arrow.setAttribute('fill', 'none');
      arrow.setAttribute('stroke-width', String(notchSw));
      arrow.setAttribute('pointer-events', 'none');
      this.svg.appendChild(arrow);
    }
  }

  private onPenDown(e: PointerEvent, p: Vec2): void {
    let piece = this.activePiece();
    if (!piece) {
      this.markBeforeChange();
      piece = {
        id: uid('piece'),
        name: 'Piece',
        closed: false,
        points: [],
      };
      this.pattern.pieces.push(piece);
      this.selectedPieceId = piece.id;
    }

    // Alt-click deletes anchor (Figma pen)
    if (e.altKey) {
      const hit = this.findPointNear(p);
      if (hit && hit.piece.points.length > 2) {
        this.markBeforeChange();
        hit.piece.points = hit.piece.points.filter((pt) => pt.id !== hit.point.id);
        this.selectedIds.delete(hit.point.id);
        if (this.selectedPointId === hit.point.id) {
          this.selectedPointId = this.selectedIds.values().next().value ?? null;
        }
        this.cbs.onChange();
        this.endHistoryGesture();
        this.redraw();
      }
      return;
    }

    // Clicking an existing anchor selects it (don't add a duplicate)
    const nearAnchor = this.findPointNear(p);
    if (nearAnchor && nearAnchor.piece.id === piece.id) {
      // Close open path by clicking first point
      if (
        !piece.closed &&
        piece.points.length >= 3 &&
        nearAnchor.point.id === piece.points[0].id
      ) {
        this.markBeforeChange();
        piece.closed = true;
        this.penActive = false;
        this.selectOnly(nearAnchor.point.id, piece.id);
        this.cbs.onChange();
        this.endHistoryGesture();
        this.redraw();
        return;
      }
      this.selectOnly(nearAnchor.point.id, piece.id);
      this.redraw();
      return;
    }

    const threshold = this.hitRadius() * 2.5;

    // Figma: click on an existing segment → insert a point ON that segment
    if (piece.points.length >= 2) {
      const edgeHit = findNearestEdge(piece.points, piece.closed, p);
      if (edgeHit && edgeHit.dist <= threshold) {
        // Don't insert extremely close to an existing endpoint
        const a = piece.points[edgeHit.edgeIndex];
        const b = piece.points[(edgeHit.edgeIndex + 1) % piece.points.length];
        if (
          dist(edgeHit.point, a.anchor) < this.hitRadius() ||
          dist(edgeHit.point, b.anchor) < this.hitRadius()
        ) {
          return;
        }
        const pt: BezierPoint = {
          id: uid('pt'),
          anchor: { ...edgeHit.point },
          handleIn: null,
          handleOut: null,
          handlesParallel: false,
        };
        // Split the edge: clear handles that spanned this segment
        this.markBeforeChange();
        a.handleOut = null;
        b.handleIn = null;
        piece.points.splice(edgeHit.edgeIndex + 1, 0, pt);
        this.selectOnly(pt.id, piece.id);
        this.penActive = false;
        this.drag = { type: 'penCurve', pieceId: piece.id, pointId: pt.id };
        this.svg.setPointerCapture(e.pointerId);
        this.cbs.onChange();
        this.redraw();
        return;
      }
    }

    // Continue / start an open path: append only when not closed (or empty)
    if (piece.closed && piece.points.length >= 3) {
      // Closed shape + click off the path: do not append (that would reshape the ring)
      return;
    }

    this.markBeforeChange();
    const pt: BezierPoint = {
      id: uid('pt'),
      anchor: { ...p },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    };
    piece.points.push(pt);
    piece.closed = false;
    this.penActive = true;
    this.selectOnly(pt.id, piece.id);
    this.drag = { type: 'penCurve', pieceId: piece.id, pointId: pt.id };
    this.svg.setPointerCapture(e.pointerId);
    this.cbs.onChange();
    this.redraw();
  }

  private createDefaultHandles(piece: PatternPiece, pt: BezierPoint): void {
    const idx = piece.points.findIndex((p) => p.id === pt.id);
    if (idx < 0) return;
    const n = piece.points.length;
    const prev = piece.points[(idx - 1 + n) % n];
    const next = piece.points[(idx + 1) % n];
    const toPrev = { x: prev.anchor.x - pt.anchor.x, y: prev.anchor.y - pt.anchor.y };
    const toNext = { x: next.anchor.x - pt.anchor.x, y: next.anchor.y - pt.anchor.y };
    const lenPrev = Math.hypot(toPrev.x, toPrev.y) || 1;
    const lenNext = Math.hypot(toNext.x, toNext.y) || 1;
    const scale = 0.33;
    pt.handleIn = {
      x: pt.anchor.x + (toPrev.x / lenPrev) * lenPrev * scale,
      y: pt.anchor.y + (toPrev.y / lenPrev) * lenPrev * scale,
    };
    pt.handleOut = {
      x: pt.anchor.x + (toNext.x / lenNext) * lenNext * scale,
      y: pt.anchor.y + (toNext.y / lenNext) * lenNext * scale,
    };
  }

  private bendNearestSegment(p: Vec2): boolean {
    const piece = this.activePiece();
    if (!piece || piece.points.length < 2) return false;
    const n = piece.points.length;
    const edgeCount = piece.closed ? n : n - 1;
    let bestI = -1;
    let bestD = this.hitRadius() * 2;
    for (let i = 0; i < edgeCount; i++) {
      const a = piece.points[i].anchor;
      const b = piece.points[(i + 1) % n].anchor;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const d = dist(p, mid);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    if (bestI < 0) return false;
    const a = piece.points[bestI];
    const b = piece.points[(bestI + 1) % n];
    // Pull handles toward click (Figma bend on segment)
    a.handleOut = { x: (a.anchor.x + p.x) / 2, y: (a.anchor.y + p.y) / 2 };
    b.handleIn = { x: (b.anchor.x + p.x) / 2, y: (b.anchor.y + p.y) / 2 };
    this.selectOnly(a.id, piece.id);
    return true;
  }

  private onPointerMove(e: PointerEvent): void {
    // Sew tool: hover highlight edges even when not dragging
    if (this.tool === 'sew' && !this.drag) {
      const p = this.svgPoint(e);
      const hit = this.findNearestEdgeAcrossPieces(p);
      const next: HoverEdge | null = hit
        ? { pieceId: hit.piece.id, fromPointId: hit.fromPointId, toPointId: hit.toPointId }
        : null;
      const changed =
        (!!next !== !!this.hoverEdge) ||
        (next && this.hoverEdge && !this.sameEdge(next, this.hoverEdge));
      if (changed) {
        this.hoverEdge = next;
        this.redraw();
      }
      return;
    }

    if (!this.drag) return;
    const p = this.svgPoint(e);

    if (this.drag.type === 'pan') {
      const scale = this.screenToPatternScale();
      this.viewBox.x = this.drag.startView.x - (e.clientX - this.drag.startClient.x) / scale;
      this.viewBox.y = this.drag.startView.y - (e.clientY - this.drag.startClient.y) / scale;
      this.redraw();
      return;
    }

    if (this.drag.type === 'marquee') {
      this.drag.current = p;
      this.redraw();
      return;
    }

    if (this.drag.type === 'moveSelection') {
      const d = this.drag;
      const rawDx = p.x - d.start.x;
      const rawDy = p.y - d.start.y;
      // Figma: Ctrl temporarily disables Snap to geometry
      const snapOn = this.softSnap && !e.ctrlKey;
      const { dx, dy, guides } = this.softSnapTranslate(d.snapshots, rawDx, rawDy, snapOn);
      this.snapGuides = guides;
      this.applySnapshotsTranslated(d.snapshots, dx, dy);
      this.redraw();
      this.cbs.onChange();
      return;
    }

    if (this.drag.type === 'scaleSelection') {
      const d = this.drag;
      let sx = d.startSize.x === 0 ? 1 : (p.x - d.fixed.x) / d.startSize.x;
      let sy = d.startSize.y === 0 ? 1 : (p.y - d.fixed.y) / d.startSize.y;
      if (d.axis === 'x') sy = 1;
      else if (d.axis === 'y') sx = 1;
      else if (e.shiftKey) {
        // Proportional: lock aspect — use the dominant axis scale for both.
        const s = Math.abs(sx) >= Math.abs(sy) ? sx : sy;
        sx = s;
        sy = s;
      }
      this.applySnapshotsScaled(d.snapshots, d.fixed, sx, sy);
      this.redraw();
      this.cbs.onChange();
      return;
    }

    if (this.drag.type === 'handle') {
      const d = this.drag;
      const piece = this.pattern.pieces.find((x) => x.id === d.pieceId)!;
      const pt = piece.points.find((x) => x.id === d.pointId)!;
      if (d.which === 'out') {
        pt.handleOut = { ...p };
        if (d.mirror) {
          pt.handleIn = {
            x: pt.anchor.x - (p.x - pt.anchor.x),
            y: pt.anchor.y - (p.y - pt.anchor.y),
          };
        }
      } else {
        pt.handleIn = { ...p };
        if (d.mirror) {
          pt.handleOut = {
            x: pt.anchor.x - (p.x - pt.anchor.x),
            y: pt.anchor.y - (p.y - pt.anchor.y),
          };
        }
      }
      this.redraw();
      this.cbs.onChange();
      return;
    }

    if (this.drag.type === 'penCurve') {
      const d = this.drag;
      const piece = this.pattern.pieces.find((x) => x.id === d.pieceId)!;
      const pt = piece.points.find((x) => x.id === d.pointId)!;
      const dx = p.x - pt.anchor.x;
      const dy = p.y - pt.anchor.y;
      if (Math.hypot(dx, dy) > 0.3) {
        // Initial pen drag seeds opposite handles; they stay independently editable unless Parallel is on.
        pt.handleOut = { x: pt.anchor.x + dx, y: pt.anchor.y + dy };
        pt.handleIn = { x: pt.anchor.x - dx, y: pt.anchor.y - dy };
        pt.handlesParallel = false;
        this.redraw();
        this.cbs.onChange();
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drag) {
      this.endHistoryGesture();
      return;
    }
    const finished = this.drag;
    try {
      this.svg.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.drag = null;
    this.snapGuides = [];
    // Keep history armed through finish handlers; clear at end of up.
    if (finished.type === 'marquee') {
      const moved = dist(finished.start, finished.current);
      if (moved < this.hitRadius() * 0.35) {
        // Click empty → clear (unless Shift)
        if (!finished.additive) this.clearSelection();
      } else {
        const hit = this.pointsInRect(finished.start, finished.current);
        if (finished.additive) {
          const merged = new Set(this.selectedIds);
          for (const id of hit) merged.add(id);
          this.setSelection([...merged]);
        } else {
          this.setSelection(hit);
        }
      }
      this.endHistoryGesture();
      this.redraw();
      return;
    }

    this.endHistoryGesture();
    this.redraw();
  }

  addPointOnEdge(): void {
    const piece = this.activePiece();
    if (!piece || piece.points.length < 2) return;
    this.markBeforeChange();
    const n = piece.points.length;
    const a = piece.points[n - 1].anchor;
    const b = piece.points[0].anchor;
    piece.points.push({
      id: uid('pt'),
      anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      handleIn: null,
      handleOut: null,
      handlesParallel: false,
    });
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }
}
