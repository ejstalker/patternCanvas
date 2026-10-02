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
import { drawMeshSeamConnectors } from '../mesh/meshSeamDraw';
import { recordPieceSuccessors } from '../sim/pieceTransforms';
import { circlePiece, rectPiece, uid } from '../project/createDefault';
import {
  anchorsBounds,
  clonePatternPiece,
  dist,
  edgeHandles,
  edgeIndexForPointIds,
  findNearestEdge,
  insertDartOnPiece,
  isSeamEdgeValid,
  lerp,
  mirrorClonePatternPiece,
  pieceToPolyline,
  pointInPolygon,
  pointOnEdgeAtT,
  sameSeamBindingPair,
  sameSeamEdgeTopology,
  sampleEdgeByPointIds,
  sampleEdgeSpanByPointIds,
  segmentLengths,
} from './geometry';
import {
  findBoundaryHits,
  sampleCutterPath,
  slicePiece,
  snapAngleDegrees,
  type CutterPath,
} from './slice';
import { parseSvgToPieces, scalePieces, type SvgImportResult } from './importSvg';
import { buildManyToManySeams } from './multiSew';
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
export type PatternTool =
  | 'move'
  | 'pen'
  | 'rect'
  | 'circle'
  | 'knife'
  | 'dart'
  | 'sew'
  | 'bend';

export type KnifeMode = 'linear' | 'circle' | 'curve';
export type SewMode = 'segment' | 'many';

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
  | {
      type: 'drawShape';
      shape: 'rect' | 'circle';
      start: Vec2;
      current: Vec2;
      /** Shift locks rectangle to square; ignored for circle (always circular). */
      lockAspect: boolean;
    }
  | { type: 'knifeLine'; start: Vec2; current: Vec2; shift: boolean }
  | { type: 'knifeCircle'; center: Vec2; radius: number; shift: boolean }
  | { type: 'knifeCurveHandles'; a: Vec2; b: Vec2; c0: Vec2; c1: Vec2 }
  | { type: 'moveSelection'; start: Vec2; snapshots: PointSnapshot[] }
  | {
      type: 'scaleSelection';
      handle: ScaleHandle;
      /** 'both' = corner (Shift locks aspect); 'x'/'y' = edge handle. */
      axis: 'both' | 'x' | 'y';
      start: Vec2;
      /** Default pivot: the opposite corner / edge of the selection box. */
      fixed: Vec2;
      /** Alt pivot: the centre of the selection box, so scaling is symmetric. */
      center: Vec2;
      /** Grabbed handle's offset from `fixed`. */
      startSize: Vec2;
      /** Grabbed handle's offset from `center`. */
      centerSize: Vec2;
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
 * middle-mouse pan + scroll-wheel zoom.
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
  private tipEl: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Last svg layout size used for chrome scaling (skip redundant redraws). */
  private lastChromeLayout = { w: 0, h: 0 };
  private pattern: PatternDocument;
  private unit: UnitDisplay;
  private tool: PatternTool = 'move';
  private knifeMode: KnifeMode = 'linear';
  /** Curve knife: endpoints before handle edit. */
  private knifeCurveA: Vec2 | null = null;
  private knifeCurveB: Vec2 | null = null;
  private knifeBtn: HTMLButtonElement;
  private knifeFlyout: HTMLElement;
  private knifeHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private knifeHoldOpened = false;
  private knifeDocPointerDown: ((e: PointerEvent) => void) | null = null;
  private sewMode: SewMode = 'segment';
  private sewBtn: HTMLButtonElement;
  private sewFlyout: HTMLElement;
  private sewHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private sewHoldOpened = false;
  private sewDocPointerDown: ((e: PointerEvent) => void) | null = null;
  private sewBar: HTMLElement;
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
  /** Show dashed links between paired seam edges. */
  private seamConnectorsOn = false;
  /** Pattern fill opacity while x-ray is on (0–1). */
  private xrayOpacity = 0.35;
  private xrayBtn: HTMLButtonElement;
  private seamLinksBtn: HTMLButtonElement;
  private xrayBar: HTMLElement;
  private xrayOpacityInput: HTMLInputElement;
  private contextMenu: HTMLElement;
  /** Piece targeted by the open context menu. */
  private contextPieceId: string | null = null;
  /** Seam targeted by the open context menu (when right-clicking a seam). */
  private contextSeamId: string | null = null;
  /** First edge locked while sewing (MD segment sewing). */
  private pendingSeam: SeamEdgeRef | null = null;
  /** Ordered edge groups for many-to-many sewing. */
  private multiSewPhase: 'source' | 'target' = 'source';
  private multiSewSource: SeamEdgeRef[] = [];
  private multiSewTarget: SeamEdgeRef[] = [];
  /** Edge under the cursor while the sew tool is active. */
  private hoverEdge: HoverEdge | null = null;
  private svgFileInput!: HTMLInputElement;
  private importDialog: HTMLElement | null = null;
  private pendingSvgImport: SvgImportResult | null = null;

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
        <button type="button" data-tool="move" data-tip="Move" aria-label="Move">↖</button>
        <button type="button" data-tool="pen" data-tip="Pen" aria-label="Pen">✎</button>
        <button type="button" data-tool="rect" data-tip="Rectangle" aria-label="Rectangle">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3" y="3.5" width="10" height="9" fill="none" stroke="currentColor" stroke-width="1.4" rx="0.5"/>
          </svg>
        </button>
        <button type="button" data-tool="circle" data-tip="Circle" aria-label="Circle">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.4"/>
          </svg>
        </button>
        <div class="pattern-tool-flyout" data-flyout="knife">
          <button type="button" data-tool="knife" data-tip="Knife · Linear" aria-label="Knife" aria-haspopup="true" aria-expanded="false">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M3 13 L13 3"/>
              <path fill="none" stroke="currentColor" stroke-width="1.2" d="M11.2 3.2 L13 3 L12.8 4.8"/>
              <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="1.5 1.2" d="M4 8.5 L8.5 4"/>
            </svg>
          </button>
          <div class="pattern-tool-flyout-menu" hidden role="menu">
            <button type="button" role="menuitem" data-knife-mode="linear" data-tip="Linear knife">Linear</button>
            <button type="button" role="menuitem" data-knife-mode="circle" data-tip="Circle knife">Circle</button>
            <button type="button" role="menuitem" data-knife-mode="curve" data-tip="Curve knife">Curve</button>
          </div>
        </div>
        <button type="button" data-tool="dart" data-tip="Dart" aria-label="Dart">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" d="M2.5 3.5 L8 13.5 L13.5 3.5"/>
            <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="1.5 1.2" d="M8 13.5 L8 5"/>
          </svg>
        </button>
        <div class="pattern-tool-flyout" data-flyout="sew">
          <button type="button" data-tool="sew" data-tip="Sew · Segment" aria-label="Sew" aria-haspopup="true" aria-expanded="false">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M3 12.5 L12.5 3"/>
              <path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" d="M11 3.5 L13 3 L12.5 5"/>
              <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="1.4 1.1" d="M4.5 5.5 L11.5 12.5"/>
            </svg>
          </button>
          <div class="pattern-tool-flyout-menu" hidden role="menu">
            <button type="button" role="menuitem" data-sew-mode="segment" data-tip="Segment sewing">Segment sewing</button>
            <button type="button" role="menuitem" data-sew-mode="many" data-tip="Many-to-many sewing">Many-to-many</button>
          </div>
        </div>
        <button type="button" data-tool="bend" data-tip="Bend" aria-label="Bend">∿</button>
        <button type="button" data-act="import-svg" data-tip="Import SVG" aria-label="Import SVG">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="1.3" d="M3.5 3.5h9v9h-9z"/>
            <path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M8 6.2v4.2M6.1 8.8 L8 11 L9.9 8.8"/>
          </svg>
        </button>
      </div>
      <div class="pattern-toolbar-spacer" aria-hidden="true"></div>
      <button type="button" data-opt="seam-links" class="pattern-seam-links-btn" data-tip="Seam links" aria-label="Seam links" aria-pressed="false">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="4.5" cy="5" r="1.4" fill="currentColor"/>
          <circle cx="11.5" cy="11" r="1.4" fill="currentColor"/>
          <path fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.5" stroke-linecap="round" d="M5.6 5.8 L10.4 10.2"/>
        </svg>
      </button>
      <button type="button" data-opt="xray" class="pattern-xray-btn" data-tip="X-ray" aria-label="X-ray">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-width="1.3" d="M2.5 8c1.8-3.2 4-4.8 5.5-4.8S11.7 4.8 13.5 8c-1.8 3.2-4 4.8-5.5 4.8S4.3 11.2 2.5 8z"/>
          <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>
          <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="1.2 1" d="M3 11.5 L13 4.5"/>
        </svg>
      </button>
      <button type="button" data-opt="avatar" class="pattern-avatar-btn" data-tip="Avatar" aria-label="Avatar">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="4.2" r="2.2" fill="currentColor"/>
          <path fill="currentColor" d="M3.2 13.5c.4-2.8 2.2-4.2 4.8-4.2s4.4 1.4 4.8 4.2H3.2z"/>
        </svg>
      </button>
      <button type="button" data-opt="snap" class="pattern-snap-btn active" data-tip="Snap" aria-label="Snap">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path fill="currentColor" d="M3 2h4v1.5H4.5V6H3V2zm6 0h4v4h-1.5V3.5H9V2zM3 10h1.5v2.5H7V14H3v-4zm8.5 0H14v4h-4v-1.5h2.5V10z"/>
          <circle cx="8" cy="8" r="1.6" fill="currentColor"/>
        </svg>
      </button>
    `;
    this.root.appendChild(this.toolbar);
    this.svgFileInput = document.createElement('input');
    this.svgFileInput.type = 'file';
    this.svgFileInput.accept = '.svg,image/svg+xml';
    this.svgFileInput.hidden = true;
    this.svgFileInput.addEventListener('change', () => {
      const file = this.svgFileInput.files?.[0];
      this.svgFileInput.value = '';
      if (file) void this.beginSvgImport(file);
    });
    this.root.appendChild(this.svgFileInput);
    this.bindToolbarTips();
    this.snapBtn = this.toolbar.querySelector('button[data-opt="snap"]') as HTMLButtonElement;
    this.seamLinksBtn = this.toolbar.querySelector('button[data-opt="seam-links"]') as HTMLButtonElement;
    this.xrayBtn = this.toolbar.querySelector('button[data-opt="xray"]') as HTMLButtonElement;
    this.avatarToggleBtn = this.toolbar.querySelector('button[data-opt="avatar"]') as HTMLButtonElement;
    this.knifeBtn = this.toolbar.querySelector('button[data-tool="knife"]') as HTMLButtonElement;
    this.knifeFlyout = this.toolbar.querySelector(
      '[data-flyout="knife"] .pattern-tool-flyout-menu'
    ) as HTMLElement;
    this.sewBtn = this.toolbar.querySelector('button[data-tool="sew"]') as HTMLButtonElement;
    this.sewFlyout = this.toolbar.querySelector(
      '[data-flyout="sew"] .pattern-tool-flyout-menu'
    ) as HTMLElement;
    this.bindKnifeFlyout();
    this.bindSewFlyout();
    this.toolbar.addEventListener('click', (e) => {
      const importBtn = (e.target as HTMLElement).closest(
        'button[data-act="import-svg"]'
      ) as HTMLButtonElement | null;
      if (importBtn) {
        e.preventDefault();
        this.svgFileInput.click();
        return;
      }
      const seamLinksBtn = (e.target as HTMLElement).closest(
        'button[data-opt="seam-links"]'
      ) as HTMLButtonElement | null;
      if (seamLinksBtn) {
        this.setSeamConnectorsEnabled(!this.seamConnectorsOn);
        return;
      }
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
      const knifeModeBtn = (e.target as HTMLElement).closest(
        'button[data-knife-mode]'
      ) as HTMLButtonElement | null;
      if (knifeModeBtn) {
        e.preventDefault();
        e.stopPropagation();
        this.setKnifeMode(knifeModeBtn.dataset.knifeMode as KnifeMode);
        this.setTool('knife');
        this.hideKnifeFlyout();
        return;
      }
      const sewModeBtn = (e.target as HTMLElement).closest(
        'button[data-sew-mode]'
      ) as HTMLButtonElement | null;
      if (sewModeBtn) {
        e.preventDefault();
        e.stopPropagation();
        this.setSewMode(sewModeBtn.dataset.sewMode as SewMode);
        this.setTool('sew');
        this.hideSewFlyout();
        return;
      }
      const btn = (e.target as HTMLElement).closest('button[data-tool]') as HTMLButtonElement | null;
      if (!btn) return;
      // Flyout main buttons are handled by press/click bindings.
      if (btn.dataset.tool === 'knife' || btn.dataset.tool === 'sew') return;
      this.hideKnifeFlyout();
      this.hideSewFlyout();
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

    this.sewBar = document.createElement('div');
    this.sewBar.className = 'pattern-sew-bar';
    this.sewBar.hidden = true;
    this.sewBar.innerHTML = `
      <span data-sew-instruction></span>
      <button type="button" data-sew-next></button>
      <button type="button" data-sew-cancel aria-label="Cancel many-to-many sewing">Cancel</button>
    `;
    this.viewport.appendChild(this.sewBar);
    this.sewBar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.sewBar.querySelector('[data-sew-next]')?.addEventListener('click', () => {
      this.advanceMultiSew();
    });
    this.sewBar.querySelector('[data-sew-cancel]')?.addEventListener('click', () => {
      this.clearMultiSew();
      this.redraw();
    });

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
    this.svg.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    this.root.addEventListener('pointerdown', this.onRootPointerDown, true);
    document.addEventListener('keydown', this.onDocKeyDown, true);
    this.viewport.addEventListener(
      'wheel',
      (e) => {
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
    this.bindViewportResize();
    // Constructor often runs before flex layout assigns svg size; redraw once laid out.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.relayoutChrome());
    });
  }

  /** Recompute screen-constant chrome after the viewport gets a real size. */
  relayoutChrome(): void {
    const w = this.svg.clientWidth;
    const h = this.svg.clientHeight;
    if (w < 2 || h < 2) return;
    if (w === this.lastChromeLayout.w && h === this.lastChromeLayout.h) return;
    this.lastChromeLayout = { w, h };
    this.redraw();
  }

  private bindViewportResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.relayoutChrome());
    this.resizeObserver.observe(this.viewport);
  }

  private onRootPointerDown = (e: PointerEvent): void => {
    if (this.contextMenu.hidden) return;
    if (this.contextMenu.contains(e.target as Node)) return;
    this.hideContextMenu();
  };

  private onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (this.importDialog) {
        this.closeSvgImportDialog();
        e.preventDefault();
        return;
      }
      if (this.pendingSeam) {
        this.pendingSeam = null;
        this.hoverEdge = null;
        this.redraw();
      }
      if (this.multiSewSource.length > 0 || this.multiSewTarget.length > 0) {
        this.clearMultiSew();
        this.hoverEdge = null;
        this.redraw();
      }
      if (this.tool === 'knife' && (this.knifeCurveA || this.knifeCurveB)) {
        this.clearKnifeDraft();
        this.syncKnifeToolbar();
        this.redraw();
      }
      this.hideContextMenu();
      return;
    }
    if (e.key === 'Enter' && this.tool === 'sew' && this.sewMode === 'many') {
      e.preventDefault();
      this.advanceMultiSew();
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
      this.clearMultiSew();
      this.hideSewFlyout();
    }
    if (tool !== 'knife') {
      this.clearKnifeDraft();
      this.hideKnifeFlyout();
    }
    this.syncKnifeToolbar();
    this.syncSewToolbar();
    for (const btn of Array.from(this.toolbar.querySelectorAll('button[data-tool]'))) {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tool === tool);
    }
    this.svg.style.cursor =
      tool === 'pen' ||
      tool === 'dart' ||
      tool === 'sew' ||
      tool === 'rect' ||
      tool === 'circle' ||
      tool === 'knife'
        ? 'crosshair'
        : tool === 'bend'
          ? 'pointer'
          : 'default';
    this.redraw();
  }

  private bindKnifeFlyout(): void {
    const HOLD_MS = 380;
    this.knifeBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.hideToolbarTip();
      this.knifeHoldOpened = false;
      this.knifeHoldTimer = setTimeout(() => {
        this.knifeHoldTimer = null;
        this.knifeHoldOpened = true;
        this.showKnifeFlyout();
      }, HOLD_MS);
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        if (this.knifeHoldTimer) {
          clearTimeout(this.knifeHoldTimer);
          this.knifeHoldTimer = null;
        }
        if (this.knifeHoldOpened) {
          // Menu is open — selection happens via menu click; don't force linear.
          return;
        }
        // Quick click → linear knife
        if ((ev.target as Node | null) && this.knifeBtn.contains(ev.target as Node)) {
          this.setKnifeMode('linear');
          this.setTool('knife');
        }
      };
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    });
  }

  private bindSewFlyout(): void {
    const HOLD_MS = 380;
    this.sewBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.hideToolbarTip();
      this.sewHoldOpened = false;
      this.sewHoldTimer = setTimeout(() => {
        this.sewHoldTimer = null;
        this.sewHoldOpened = true;
        this.showSewFlyout();
      }, HOLD_MS);
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        if (this.sewHoldTimer) {
          clearTimeout(this.sewHoldTimer);
          this.sewHoldTimer = null;
        }
        if (this.sewHoldOpened) return;
        if ((ev.target as Node | null) && this.sewBtn.contains(ev.target as Node)) {
          this.setSewMode('segment');
          this.setTool('sew');
        }
      };
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    });
  }

  private showSewFlyout(): void {
    this.sewFlyout.hidden = false;
    this.sewBtn.setAttribute('aria-expanded', 'true');
    this.syncSewToolbar();
    if (!this.sewDocPointerDown) {
      this.sewDocPointerDown = (e: PointerEvent) => {
        const target = e.target as Node;
        if (this.sewFlyout.contains(target) || this.sewBtn.contains(target)) return;
        this.hideSewFlyout();
      };
      document.addEventListener('pointerdown', this.sewDocPointerDown, true);
    }
  }

  private hideSewFlyout(): void {
    this.sewFlyout.hidden = true;
    this.sewBtn.setAttribute('aria-expanded', 'false');
    if (this.sewDocPointerDown) {
      document.removeEventListener('pointerdown', this.sewDocPointerDown, true);
      this.sewDocPointerDown = null;
    }
  }

  private setSewMode(mode: SewMode): void {
    if (this.sewMode !== mode) {
      this.pendingSeam = null;
      this.clearMultiSew();
    }
    this.sewMode = mode;
    this.syncSewToolbar();
    this.redraw();
  }

  private syncSewToolbar(): void {
    const tip = this.sewMode === 'many' ? 'Sew · Many-to-many' : 'Sew · Segment';
    this.sewBtn.dataset.tip = tip;
    this.sewBtn.setAttribute('aria-label', tip);
    for (const btn of Array.from(this.sewFlyout.querySelectorAll('button[data-sew-mode]'))) {
      const el = btn as HTMLButtonElement;
      el.classList.toggle('is-active', el.dataset.sewMode === this.sewMode);
    }
    this.syncSewBar();
  }

  private showKnifeFlyout(): void {
    this.knifeFlyout.hidden = false;
    this.knifeBtn.setAttribute('aria-expanded', 'true');
    this.syncKnifeToolbar();
    if (!this.knifeDocPointerDown) {
      this.knifeDocPointerDown = (e: PointerEvent) => {
        const t = e.target as Node;
        if (this.knifeFlyout.contains(t) || this.knifeBtn.contains(t)) return;
        this.hideKnifeFlyout();
      };
      document.addEventListener('pointerdown', this.knifeDocPointerDown, true);
    }
  }

  private hideKnifeFlyout(): void {
    this.knifeFlyout.hidden = true;
    this.knifeBtn.setAttribute('aria-expanded', 'false');
    if (this.knifeDocPointerDown) {
      document.removeEventListener('pointerdown', this.knifeDocPointerDown, true);
      this.knifeDocPointerDown = null;
    }
  }

  private setKnifeMode(mode: KnifeMode): void {
    this.knifeMode = mode;
    this.clearKnifeDraft();
    this.syncKnifeToolbar();
    this.redraw();
  }

  private clearKnifeDraft(): void {
    this.knifeCurveA = null;
    this.knifeCurveB = null;
  }

  private syncKnifeToolbar(): void {
    const tips: Record<KnifeMode, string> = {
      linear: 'Knife · Linear',
      circle: 'Knife · Circle',
      curve: 'Knife · Curve',
    };
    this.knifeBtn.dataset.tip = tips[this.knifeMode];
    this.knifeBtn.setAttribute('aria-label', tips[this.knifeMode]);
    for (const btn of Array.from(this.knifeFlyout.querySelectorAll('button[data-knife-mode]'))) {
      const el = btn as HTMLButtonElement;
      el.classList.toggle('is-active', el.dataset.knifeMode === this.knifeMode);
    }
  }

  private ensureTipEl(): HTMLDivElement {
    if (!this.tipEl) {
      const el = document.createElement('div');
      el.className = 'pattern-toolbar-tip';
      el.hidden = true;
      document.body.appendChild(el);
      this.tipEl = el;
    }
    return this.tipEl;
  }

  private hideToolbarTip(): void {
    if (this.tipEl) this.tipEl.hidden = true;
  }

  private showToolbarTip(anchor: HTMLElement): void {
    const text = anchor.dataset.tip ?? '';
    if (!text) return;
    const tip = this.ensureTipEl();
    tip.textContent = text;
    tip.hidden = false;
    tip.style.visibility = 'hidden';
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const r = anchor.getBoundingClientRect();
    const pad = 6;
    let left = r.right + pad;
    if (left + tw > window.innerWidth - pad) left = Math.max(pad, r.left - tw - pad);
    let top = r.top + r.height / 2 - th / 2;
    top = Math.max(pad, Math.min(top, window.innerHeight - th - pad));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = 'visible';
  }

  private bindToolbarTips(): void {
    this.toolbar.querySelectorAll('button[data-tip]').forEach((btn) => {
      const el = btn as HTMLElement;
      el.addEventListener('mouseenter', () => this.showToolbarTip(el));
      el.addEventListener('mouseleave', () => this.hideToolbarTip());
      el.addEventListener('focus', () => this.showToolbarTip(el));
      el.addEventListener('blur', () => this.hideToolbarTip());
    });
    this.toolbar.addEventListener('pointerdown', () => this.hideToolbarTip());
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
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let found = false;
    for (const piece of this.pattern.pieces) {
      if (piece.points.length === 0) continue;
      const poly = pieceToPolyline(piece.points, piece.closed);
      for (const p of poly) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
        found = true;
      }
    }
    if (!found) {
      this.viewBox = { x: -5, y: -5, w: 60, h: 70 };
      return;
    }
    const pad = 8;
    this.viewBox = {
      x: minX - pad,
      y: minY - pad,
      w: Math.max(maxX - minX + pad * 2, 20),
      h: Math.max(maxY - minY + pad * 2, 20),
    };
  }

  private async beginSvgImport(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch {
      this.showSvgImportDialog({
        pieces: [],
        widthCm: 0,
        heightCm: 0,
        cmPerUserUnit: 1,
        warnings: [],
        error: `Could not read “${file.name}”`,
      });
      return;
    }
    const result = parseSvgToPieces(text, { scale: 1 });
    this.showSvgImportDialog(result, file.name);
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private closeSvgImportDialog(): void {
    this.pendingSvgImport = null;
    if (this.importDialog) {
      this.importDialog.remove();
      this.importDialog = null;
    }
  }

  private showSvgImportDialog(result: SvgImportResult, fileName = 'SVG'): void {
    this.closeSvgImportDialog();
    this.pendingSvgImport = result;

    const dlg = document.createElement('div');
    dlg.className = 'pattern-import-dialog-root';
    const canImport = result.pieces.length > 0 && !result.error;
    const warnHtml =
      result.warnings.length > 0
        ? `<ul class="pattern-import-warnings">${result.warnings
            .map((w) => `<li>${this.escapeHtml(w)}</li>`)
            .join('')}</ul>`
        : '';
    const errHtml = result.error
      ? `<p class="pattern-import-error">${this.escapeHtml(result.error)}</p>`
      : '';
    const sizeLabel =
      result.widthCm > 0 && result.heightCm > 0
        ? `${formatLength(result.widthCm, this.unit)} × ${formatLength(result.heightCm, this.unit)}`
        : '—';

    dlg.innerHTML = `
      <div class="pattern-import-backdrop" data-import-dismiss>
        <div class="pattern-import-dialog" role="dialog" aria-labelledby="patternImportTitle">
          <div class="pattern-import-header">
            <h3 id="patternImportTitle">Import SVG</h3>
            <button type="button" class="pattern-import-close" data-import-close aria-label="Close">×</button>
          </div>
          <p class="muted pattern-import-file">${this.escapeHtml(fileName)}</p>
          ${errHtml}
          <div class="pattern-import-meta">
            <div><span class="muted">Pieces</span><strong>${result.pieces.length}</strong></div>
            <div><span class="muted">Detected size</span><strong data-import-size>${this.escapeHtml(sizeLabel)}</strong></div>
          </div>
          <label class="pattern-import-scale">
            <span>Scale %</span>
            <input type="number" data-import-scale min="1" max="10000" step="1" value="100" ${canImport ? '' : 'disabled'} />
          </label>
          <p class="muted pattern-import-scale-hint">100% keeps the physical SVG size (width/height units, or px @ 96 DPI).</p>
          ${warnHtml}
          <div class="pattern-import-actions">
            <button type="button" data-import-cancel>Cancel</button>
            <button type="button" class="primary" data-import-confirm ${canImport ? '' : 'disabled'}>Import</button>
          </div>
        </div>
      </div>
    `;
    this.root.appendChild(dlg);
    this.importDialog = dlg;

    const scaleInput = dlg.querySelector('[data-import-scale]') as HTMLInputElement | null;
    const sizeEl = dlg.querySelector('[data-import-size]') as HTMLElement | null;
    const updateSizePreview = () => {
      if (!sizeEl || !(result.widthCm > 0)) return;
      const pct = Math.max(1, Number(scaleInput?.value) || 100);
      const f = pct / 100;
      sizeEl.textContent = `${formatLength(result.widthCm * f, this.unit)} × ${formatLength(result.heightCm * f, this.unit)}`;
    };
    scaleInput?.addEventListener('input', updateSizePreview);

    const dismiss = () => this.closeSvgImportDialog();
    const confirm = () => {
      if (!canImport) return;
      const pct = Math.max(1, Number(scaleInput?.value) || 100);
      this.commitSvgImport(pct / 100);
    };
    dlg.querySelector('[data-import-dismiss]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) dismiss();
    });
    dlg.querySelector('[data-import-close]')?.addEventListener('click', dismiss);
    dlg.querySelector('[data-import-cancel]')?.addEventListener('click', dismiss);
    dlg.querySelector('[data-import-confirm]')?.addEventListener('click', confirm);
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && canImport) {
        e.preventDefault();
        confirm();
      }
    });
    scaleInput?.focus();
    scaleInput?.select();
  }

  private commitSvgImport(scaleFactor: number): void {
    const pending = this.pendingSvgImport;
    if (!pending || pending.pieces.length === 0) {
      this.closeSvgImportDialog();
      return;
    }
    const pieces =
      Math.abs(scaleFactor - 1) < 1e-9
        ? pending.pieces
        : scalePieces(pending.pieces, scaleFactor);
    this.closeSvgImportDialog();
    this.markBeforeChange();
    const ids: string[] = [];
    for (const piece of pieces) {
      this.pattern.pieces.push(piece);
      for (const pt of piece.points) ids.push(pt.id);
    }
    this.selectedPieceId = pieces[0]?.id ?? this.selectedPieceId;
    this.setSelection(ids);
    this.fitView();
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
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

  private setSeamConnectorsEnabled(on: boolean): void {
    this.seamConnectorsOn = on;
    this.seamLinksBtn.classList.toggle('active', on);
    this.seamLinksBtn.setAttribute('aria-pressed', String(on));
    this.redraw();
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
    const layoutW = this.svg.clientWidth;
    const layoutH = this.svg.clientHeight;
    if (layoutW >= 2 && layoutH >= 2) {
      this.lastChromeLayout = { w: layoutW, h: layoutH };
    }

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

    if (this.drag?.type === 'drawShape') {
      this.drawShapePreview(this.drag);
    }

    if (
      this.drag?.type === 'knifeLine' ||
      this.drag?.type === 'knifeCircle' ||
      this.drag?.type === 'knifeCurveHandles'
    ) {
      this.drawKnifePreview(this.drag);
    } else if (this.tool === 'knife' && this.knifeMode === 'curve') {
      this.drawKnifeCurveDraft();
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

  private shapeBoxFromDrag(
    start: Vec2,
    current: Vec2,
    lockAspect: boolean
  ): { x: number; y: number; w: number; h: number } {
    const sx = current.x >= start.x ? 1 : -1;
    const sy = current.y >= start.y ? 1 : -1;
    let w = Math.abs(current.x - start.x);
    let h = Math.abs(current.y - start.y);
    if (lockAspect) {
      const s = Math.max(w, h);
      w = s;
      h = s;
    }
    return {
      x: sx > 0 ? start.x : start.x - w,
      y: sy > 0 ? start.y : start.y - h,
      w,
      h,
    };
  }

  private drawShapePreview(drag: Extract<DragKind, { type: 'drawShape' }>): void {
    const lock = drag.shape === 'circle' || drag.lockAspect;
    const box = this.shapeBoxFromDrag(drag.start, drag.current, lock);
    if (box.w < 1e-6 && box.h < 1e-6) return;
    const sw = this.px(1.5);
    if (drag.shape === 'rect') {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(box.x));
      rect.setAttribute('y', String(box.y));
      rect.setAttribute('width', String(box.w));
      rect.setAttribute('height', String(box.h));
      rect.setAttribute('class', 'pattern-shape-preview');
      rect.setAttribute('stroke-width', String(sw));
      rect.setAttribute('pointer-events', 'none');
      this.svg.appendChild(rect);
    } else {
      const ell = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      ell.setAttribute('cx', String(box.x + box.w / 2));
      ell.setAttribute('cy', String(box.y + box.h / 2));
      ell.setAttribute('rx', String(box.w / 2));
      ell.setAttribute('ry', String(box.h / 2));
      ell.setAttribute('class', 'pattern-shape-preview');
      ell.setAttribute('stroke-width', String(sw));
      ell.setAttribute('pointer-events', 'none');
      this.svg.appendChild(ell);
    }
  }

  private finishDrawShape(drag: Extract<DragKind, { type: 'drawShape' }>): void {
    const lock = drag.shape === 'circle' || drag.lockAspect;
    const box = this.shapeBoxFromDrag(drag.start, drag.current, lock);
    const minSize = Math.max(0.5, this.hitRadius() * 0.5);
    if (box.w < minSize || box.h < minSize) {
      this.endHistoryGesture();
      return;
    }
    this.markBeforeChange();
    const n = this.pattern.pieces.length + 1;
    const piece =
      drag.shape === 'rect'
        ? rectPiece(`Rect ${n}`, box.w, box.h, { x: box.x, y: box.y })
        : circlePiece(`Circle ${n}`, box.x + box.w / 2, box.y + box.h / 2, box.w / 2);
    this.pattern.pieces.push(piece);
    this.selectEntirePiece(piece);
    this.cbs.onChange();
    this.endHistoryGesture();
  }

  private knifeCutterFromDrag(
    drag: Extract<
      DragKind,
      { type: 'knifeLine' | 'knifeCircle' | 'knifeCurveHandles' }
    >
  ): CutterPath | null {
    if (drag.type === 'knifeLine') {
      let b = drag.current;
      if (drag.shift) {
        const d = snapAngleDegrees(b.x - drag.start.x, b.y - drag.start.y, 30);
        b = { x: drag.start.x + d.x, y: drag.start.y + d.y };
      }
      if (dist(drag.start, b) < 0.2) return null;
      return { kind: 'line', a: drag.start, b };
    }
    if (drag.type === 'knifeCircle') {
      let r = drag.radius;
      if (drag.shift) r = Math.round(r * 2) / 2;
      if (r < 0.25) return null;
      return { kind: 'circle', center: drag.center, radius: r };
    }
    return {
      kind: 'cubic',
      a: drag.a,
      c0: drag.c0,
      c1: drag.c1,
      b: drag.b,
    };
  }

  private drawKnifePreview(
    drag: Extract<
      DragKind,
      { type: 'knifeLine' | 'knifeCircle' | 'knifeCurveHandles' }
    >
  ): void {
    const cutter = this.knifeCutterFromDrag(drag);
    if (!cutter) return;
    this.strokeCutter(cutter, true);
  }

  private drawKnifeCurveDraft(): void {
    if (this.knifeCurveA) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(this.knifeCurveA.x));
      c.setAttribute('cy', String(this.knifeCurveA.y));
      c.setAttribute('r', String(this.px(4)));
      c.setAttribute('class', 'pattern-knife-point');
      c.setAttribute('pointer-events', 'none');
      this.svg.appendChild(c);
    }
    if (this.knifeCurveA && this.knifeCurveB) {
      this.strokeCutter(
        {
          kind: 'line',
          a: this.knifeCurveA,
          b: this.knifeCurveB,
        },
        false
      );
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(this.knifeCurveB.x));
      c.setAttribute('cy', String(this.knifeCurveB.y));
      c.setAttribute('r', String(this.px(4)));
      c.setAttribute('class', 'pattern-knife-point');
      c.setAttribute('pointer-events', 'none');
      this.svg.appendChild(c);
    }
  }

  private strokeCutter(cutter: CutterPath, showHits: boolean): void {
    const piece = showHits ? this.pieceForKnife(cutter) : null;
    const hits = piece ? findBoundaryHits(piece, cutter) : [];

    // For linear cuts, draw through the hit span so opposite-side crossings are obvious.
    let pts = sampleCutterPath(cutter);
    if (cutter.kind === 'line' && hits.length >= 2) {
      const sorted = [...hits].sort((a, b) => a.along - b.along);
      const a = sorted[0]!.point;
      const b = sorted[sorted.length - 1]!.point;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const pad = Math.max(2, len * 0.08);
      pts = [
        { x: a.x - (dx / len) * pad, y: a.y - (dy / len) * pad },
        { x: b.x + (dx / len) * pad, y: b.y + (dy / len) * pad },
      ];
    }
    if (pts.length < 2) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i]!.x} ${pts[i]!.y}`;
    if (cutter.kind === 'circle') d += ' Z';
    path.setAttribute('d', d);
    path.setAttribute('class', 'pattern-knife-preview');
    path.setAttribute('fill', cutter.kind === 'circle' ? 'rgba(196,92,38,0.06)' : 'none');
    path.setAttribute('stroke-width', String(this.px(1.75)));
    path.setAttribute('pointer-events', 'none');
    this.svg.appendChild(path);

    if (!showHits || !piece) return;
    const validPair = this.knifeHasValidHitPair(piece, hits, cutter);
    for (const h of hits) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(h.point.x));
      c.setAttribute('cy', String(h.point.y));
      c.setAttribute('r', String(this.px(3.5)));
      c.setAttribute('class', validPair ? 'pattern-knife-hit-ok' : 'pattern-knife-hit');
      c.setAttribute('pointer-events', 'none');
      this.svg.appendChild(c);
    }
  }

  private knifeHasValidHitPair(
    piece: PatternPiece,
    hits: ReturnType<typeof findBoundaryHits>,
    cutter: CutterPath
  ): boolean {
    if (hits.length < 2) return false;
    const poly = pieceToPolyline(piece.points, true);
    const sorted = [...hits].sort((a, b) => a.along - b.along);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const mid = lerp(sorted[i]!.point, sorted[j]!.point, 0.5);
        if (cutter.kind !== 'line' || pointInPolygon(mid, poly)) return true;
      }
    }
    return false;
  }

  private pieceForKnife(cutter: CutterPath): PatternPiece | null {
    const closed = this.pattern.pieces.filter((p) => p.closed && p.points.length >= 3);

    // Prefer the piece the infinite cut actually crosses (works when drag
    // endpoints sit outside opposite sides).
    if (cutter.kind === 'line') {
      for (const piece of closed) {
        const hits = findBoundaryHits(piece, cutter);
        if (hits.length < 2) continue;
        const poly = pieceToPolyline(piece.points, true);
        const sorted = [...hits].sort((a, b) => a.along - b.along);
        for (let i = 0; i < sorted.length - 1; i++) {
          const mid = lerp(sorted[i]!.point, sorted[i + 1]!.point, 0.5);
          if (pointInPolygon(mid, poly)) return piece;
        }
      }
    }

    const probe =
      cutter.kind === 'circle'
        ? cutter.center
        : lerp(
            cutter.kind === 'line' ? cutter.a : cutter.a,
            cutter.kind === 'line' ? cutter.b : cutter.b,
            0.5
          );
    for (const piece of closed) {
      if (pointInPolygon(probe, pieceToPolyline(piece.points, true))) return piece;
    }
    return this.activePiece()?.closed ? this.activePiece() : closed[0] ?? null;
  }

  private commitKnife(cutter: CutterPath): void {
    const piece = this.pieceForKnife(cutter);
    if (!piece) return;
    this.markBeforeChange();
    const result = slicePiece(piece, cutter, () => uid('id'));
    if (!result.ok) {
      this.endHistoryGesture();
      return;
    }
    const [a, b] = result.pieces;
    const idx = this.pattern.pieces.findIndex((p) => p.id === piece.id);
    if (idx < 0) {
      this.endHistoryGesture();
      return;
    }
    // The two halves get fresh ids; record the lineage so downstream Transform 3D
    // nodes hand the original arrangement down instead of resetting to default.
    this.pattern.pieceSuccessors = recordPieceSuccessors(
      this.pattern.pieceSuccessors,
      piece.id,
      [a.id, b.id]
    );

    const children = [
      { piece: a, pointMap: result.pointIdMaps[0] },
      { piece: b, pointMap: result.pointIdMaps[1] },
    ] as const;
    const remapEdge = (ref: SeamEdgeRef): SeamEdgeRef | null => {
      if (ref.pieceId !== piece.id) return { ...ref };
      for (const child of children) {
        const fromPointId = child.pointMap.get(ref.fromPointId);
        const toPointId = child.pointMap.get(ref.toPointId);
        if (!fromPointId || !toPointId) continue;
        // An untouched outline edge remains adjacent on exactly one child.
        // A knife-crossed edge has a new cut point between its old endpoints,
        // so it intentionally fails this test and its seam is removed.
        if (edgeIndexForPointIds(child.piece, fromPointId, toPointId) === null) continue;
        return {
          ...ref,
          pieceId: child.piece.id,
          fromPointId,
          toPointId,
        };
      }
      return null;
    };
    const remappedSeams: SeamBinding[] = [];
    for (const seam of this.pattern.seams) {
      const seamA = remapEdge(seam.a);
      const seamB = remapEdge(seam.b);
      if (!seamA || !seamB) continue;
      remappedSeams.push({ ...seam, a: seamA, b: seamB });
    }

    this.pattern.pieces.splice(idx, 1, a, b);
    this.pattern.seams = remappedSeams;
    this.selectedPieceId = a.id;
    this.selectEntirePiece(a);
    this.clearKnifeDraft();
    this.syncKnifeToolbar();
    this.cbs.onChange();
    this.endHistoryGesture();
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
    return cssPixels / s;
  }

  /** Layout CSS px per pattern unit (xMidYMid meet). */
  private viewScale(): number {
    const w = this.svg.clientWidth;
    const h = this.svg.clientHeight;
    // Before flex layout settles, client size is 0 — assume a typical pattern
    // viewport so we don't bake 1px≈1cm chrome (huge labels/handles).
    if (w < 2 || h < 2) {
      const assumed = 360;
      return Math.min(assumed / this.viewBox.w, assumed / this.viewBox.h);
    }
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
    this.root.focus({ preventScroll: true });

    // Cancel pending sew pick instead of opening the piece menu
    if (this.pendingSeam) {
      e.stopPropagation();
      this.pendingSeam = null;
      this.hoverEdge = null;
      this.hideContextMenu();
      this.redraw();
      return;
    }

    const p = this.svgPointFromClient(e.clientX, e.clientY);
    const seamHit = this.findSeamNearClick(p);
    if (seamHit) {
      e.stopPropagation();
      this.contextSeamId = seamHit.id;
      this.contextPieceId = null;
      this.showContextMenu(e.clientX, e.clientY, 'seam');
      this.redraw();
      return;
    }

    const piece = this.resolveContextPiece(e);
    if (!piece || piece.points.length === 0) {
      // Nothing pattern-specific under the cursor: let the event carry on so
      // the node's own context menu (duplicate / delete) can take over.
      this.hideContextMenu();
      return;
    }
    e.stopPropagation();
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

    // Alt over a scale handle means "scale about the selection centre", so the
    // handle takes precedence over the Alt-pan gesture there.
    const hitEl = e.target as SVGElement;
    const onScaleHandle =
      this.tool === 'move' && hitEl.dataset?.kind === 'scale' && !!hitEl.dataset.handle;

    // Middle-mouse (or Alt-left) pans the pattern view
    if (e.button === 1 || (e.button === 0 && e.altKey && !onScaleHandle)) {
      this.drag = {
        type: 'pan',
        startClient: { x: e.clientX, y: e.clientY },
        startView: { x: this.viewBox.x, y: this.viewBox.y },
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.button !== 0) return;
    e.stopPropagation();

    const target = e.target as SVGElement;
    const kind = target.dataset?.kind;
    const pointId = target.dataset?.pointId;
    const pieceId = target.dataset?.pieceId;
    const p = this.svgPoint(e);

    if (this.tool === 'pen') {
      this.onPenDown(e, p);
      return;
    }

    if (this.tool === 'rect' || this.tool === 'circle') {
      this.drag = {
        type: 'drawShape',
        shape: this.tool,
        start: p,
        current: p,
        lockAspect: e.shiftKey,
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
      return;
    }

    if (this.tool === 'knife') {
      this.onKnifeDown(e, p);
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
      const center = {
        x: (box.minX + box.maxX) / 2,
        y: (box.minY + box.maxY) / 2,
      };
      const startHandle = this.scaleHandlePoint(box, handle);
      this.markBeforeChange();
      this.drag = {
        type: 'scaleSelection',
        handle,
        axis: this.scaleAxisForHandle(handle),
        start: p,
        fixed,
        center,
        startSize: {
          x: startHandle.x - fixed.x,
          y: startHandle.y - fixed.y,
        },
        centerSize: {
          x: startHandle.x - center.x,
          y: startHandle.y - center.y,
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
    return sameSeamEdgeTopology(a, b);
  }

  private edgeUsedInExistingSeam(edge: SeamEdgeRef): boolean {
    return this.pattern.seams.some((seam) => this.sameEdge(seam.a, edge) || this.sameEdge(seam.b, edge));
  }

  private edgeIn(edges: SeamEdgeRef[], edge: SeamEdgeRef): number {
    return edges.findIndex((candidate) => this.sameEdge(candidate, edge));
  }

  private clearMultiSew(): void {
    this.multiSewPhase = 'source';
    this.multiSewSource = [];
    this.multiSewTarget = [];
    this.syncSewBar();
  }

  private syncSewBar(): void {
    if (!this.sewBar) return;
    const active = this.tool === 'sew' && this.sewMode === 'many';
    this.sewBar.hidden = !active;
    if (!active) return;
    const instruction = this.sewBar.querySelector('[data-sew-instruction]') as HTMLElement;
    const next = this.sewBar.querySelector('[data-sew-next]') as HTMLButtonElement;
    if (this.multiSewPhase === 'source') {
      instruction.textContent = `Side A: select edges (${this.multiSewSource.length})`;
      next.textContent = 'Next side';
      next.disabled = this.multiSewSource.length === 0;
    } else {
      instruction.textContent = `Side B: select edges (${this.multiSewTarget.length})`;
      next.textContent = 'Create seams';
      next.disabled = this.multiSewTarget.length === 0;
    }
  }

  private advanceMultiSew(): void {
    if (this.tool !== 'sew' || this.sewMode !== 'many') return;
    if (this.multiSewPhase === 'source') {
      if (this.multiSewSource.length === 0) return;
      this.multiSewPhase = 'target';
      this.hoverEdge = null;
      this.syncSewBar();
      this.redraw();
      return;
    }
    if (this.multiSewTarget.length === 0) return;

    const candidates = buildManyToManySeams(
      this.multiSewSource,
      this.multiSewTarget,
      this.pattern.pieces
    );
    const additions = candidates.filter(
      (candidate) =>
        !this.pattern.seams.some((seam) =>
          sameSeamBindingPair(seam.a, seam.b, candidate.a, candidate.b)
        )
    );
    if (additions.length > 0) {
      this.markBeforeChange();
      this.pattern.seams.push(
        ...additions.map(({ a, b }) => ({
          id: uid('seam'),
          a,
          b,
          restGapCm: DEFAULT_SEAM_GAP_CM,
        }))
      );
      this.cbs.onChange();
      this.endHistoryGesture();
      this.clearMultiSew();
      this.hoverEdge = null;
      this.redraw();
      return;
    }

    const instruction = this.sewBar.querySelector('[data-sew-instruction]') as HTMLElement;
    instruction.textContent =
      candidates.length === 0
        ? 'Could not match selected edges'
        : 'All matched seams already exist';
    this.syncSewBar();
    this.redraw();
    return;
  }

  private onManySewDown(edge: SeamEdgeRef, pieceId: string): void {
    if (this.multiSewPhase === 'source') {
      const index = this.edgeIn(this.multiSewSource, edge);
      if (index >= 0) this.multiSewSource.splice(index, 1);
      else {
        if (this.edgeUsedInExistingSeam(edge)) return;
        this.multiSewSource.push(edge);
      }
    } else {
      // An edge cannot belong to both sides of one many-to-many operation.
      if (this.edgeIn(this.multiSewSource, edge) >= 0) return;
      const index = this.edgeIn(this.multiSewTarget, edge);
      if (index >= 0) this.multiSewTarget.splice(index, 1);
      else {
        if (this.edgeUsedInExistingSeam(edge)) return;
        this.multiSewTarget.push(edge);
      }
    }
    this.selectedPieceId = pieceId;
    this.syncSewBar();
    this.redraw();
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

    if (this.sewMode === 'many') {
      this.onManySewDown(edge, hit.piece.id);
      return;
    }

    if (!this.pendingSeam) {
      if (this.edgeUsedInExistingSeam(edge)) return;
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
    if (this.seamConnectorsOn) {
      drawMeshSeamConnectors(this.svg, this.pattern, {
        className: 'pattern-seam-connector',
        strokeWidth: this.px(1.2),
      });
    }

    // Hover / pending previews
    if (this.hoverEdge) {
      this.drawSeamEdgeStroke(this.hoverEdge, 'pattern-seam-hover', true);
    }
    if (this.pendingSeam) {
      this.drawSeamEdgeStroke(this.pendingSeam, 'pattern-seam-pending', true);
    }
    for (const edge of this.multiSewSource) {
      this.drawSeamEdgeStroke(edge, 'pattern-seam-pending pattern-seam-multi-source', true);
    }
    for (const edge of this.multiSewTarget) {
      this.drawSeamEdgeStroke(edge, 'pattern-seam-pending pattern-seam-multi-target', true);
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
    let samples: Vec2[] | null = null;
    if ('t0' in ref && 't1' in ref) {
      const span = ref as SeamEdgeRef;
      const isPartial =
        Math.abs(span.t0 - span.t1) > 1e-5 && !(span.t0 === 0 && span.t1 === 1);
      if (isPartial) {
        samples = sampleEdgeSpanByPointIds(
          piece,
          ref.fromPointId,
          ref.toPointId,
          span.t0,
          span.t1,
          20
        );
      }
    }
    samples ??= sampleEdgeByPointIds(piece, ref.fromPointId, ref.toPointId, 20);
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

    if (this.drag.type === 'drawShape') {
      this.drag.current = p;
      this.drag.lockAspect = e.shiftKey;
      this.redraw();
      return;
    }

    if (this.drag.type === 'knifeLine') {
      this.drag.current = p;
      this.drag.shift = e.shiftKey;
      this.redraw();
      return;
    }

    if (this.drag.type === 'knifeCircle') {
      if (e.shiftKey) {
        // Shift: edit radius from fixed center (snap to 0.5 cm).
        this.drag.radius = dist(this.drag.center, p);
        this.drag.shift = true;
      } else if (this.drag.radius < 0.25) {
        // Establish radius on the first free drag.
        this.drag.radius = dist(this.drag.center, p);
        this.drag.shift = false;
      } else {
        // Free drag repositions the circle (keeps radius).
        this.drag.center = p;
        this.drag.shift = false;
      }
      this.redraw();
      return;
    }

    if (this.drag.type === 'knifeCurveHandles') {
      const mid = lerp(this.drag.a, this.drag.b, 0.5);
      const ox = (p.x - mid.x) * 1.25;
      const oy = (p.y - mid.y) * 1.25;
      this.drag.c0 = {
        x: this.drag.a.x + (this.drag.b.x - this.drag.a.x) / 3 + ox,
        y: this.drag.a.y + (this.drag.b.y - this.drag.a.y) / 3 + oy,
      };
      this.drag.c1 = {
        x: this.drag.a.x + ((this.drag.b.x - this.drag.a.x) * 2) / 3 + ox,
        y: this.drag.a.y + ((this.drag.b.y - this.drag.a.y) * 2) / 3 + oy,
      };
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
      // Alt scales about the centre of the selection — symmetric growth —
      // instead of about the opposite corner / edge.
      const fromCenter = e.altKey;
      const pivot = fromCenter ? d.center : d.fixed;
      const size = fromCenter ? d.centerSize : d.startSize;
      let sx = size.x === 0 ? 1 : (p.x - pivot.x) / size.x;
      let sy = size.y === 0 ? 1 : (p.y - pivot.y) / size.y;
      if (d.axis === 'x') sy = 1;
      else if (d.axis === 'y') sx = 1;
      else if (e.shiftKey) {
        // Proportional: lock aspect — use the dominant axis scale for both.
        const s = Math.abs(sx) >= Math.abs(sy) ? sx : sy;
        sx = s;
        sy = s;
      }
      this.applySnapshotsScaled(d.snapshots, pivot, sx, sy);
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

    if (finished.type === 'drawShape') {
      this.finishDrawShape(finished);
      this.redraw();
      return;
    }

    if (
      finished.type === 'knifeLine' ||
      finished.type === 'knifeCircle' ||
      finished.type === 'knifeCurveHandles'
    ) {
      const cutter = this.knifeCutterFromDrag(finished);
      if (cutter) this.commitKnife(cutter);
      this.redraw();
      return;
    }

    this.endHistoryGesture();
    this.redraw();
  }

  private onKnifeDown(e: PointerEvent, p: Vec2): void {
    if (this.knifeMode === 'linear') {
      this.drag = {
        type: 'knifeLine',
        start: p,
        current: p,
        shift: e.shiftKey,
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
      return;
    }

    if (this.knifeMode === 'circle') {
      this.drag = {
        type: 'knifeCircle',
        center: p,
        radius: 0,
        shift: e.shiftKey,
      };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
      return;
    }

    // Curve: click A, click B, then drag handles
    if (!this.knifeCurveA) {
      this.knifeCurveA = { ...p };
      this.knifeCurveB = null;
      this.syncKnifeToolbar();
      this.redraw();
      return;
    }
    if (!this.knifeCurveB) {
      this.knifeCurveB = { ...p };
      this.syncKnifeToolbar();
      this.redraw();
      return;
    }
    const a = this.knifeCurveA;
    const b = this.knifeCurveB;
    this.drag = {
      type: 'knifeCurveHandles',
      a,
      b,
      c0: lerp(a, b, 1 / 3),
      c1: lerp(a, b, 2 / 3),
    };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
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
