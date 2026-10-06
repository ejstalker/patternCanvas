import type {
  BezierPoint,
  BlockDivisor,
  BlockInstance,
  BlockVariableBinding,
  BlockVariableDecl,
  PatternDocument,
  PatternPiece,
  PatternRuler,
  SeamBinding,
  SeamEdgeRef,
  UnitDisplay,
  Vec2,
} from '../project/types';
import { formatLength, cmToDisplay, displayToCm } from '../project/types';
import type { MeasurementLibrary, MeasurementSet } from '../project/measurements';
import { MEASUREMENT_FIELDS } from '../project/measurements';
import {
  buildMeasurementMenu,
  distanceToSegment,
  filterMeasurementMenu,
  measurementField,
  measurementSearchTokens,
  measurementValueCm,
  nearestMeasurementField,
  normalizeRulers,
  rulerAngle,
  rulerEndpoints,
  rulerGraduations,
  rulerLabel,
  rulerTextFlipped,
  setRulerDrawnLength,
  type RulerHit,
} from './rulers';
import {
  buildSeamConnectorPointPairs,
  drawMeshSeamConnectors,
  drawSeamConnectorPairs,
} from '../mesh/meshSeamDraw';
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
  seamReadsFromSecondHalf,
  seamRefFromHalf,
  sampleEdgeByPointIds,
  sampleEdgeSpanByPointIds,
  segmentLengths,
} from './geometry';
import {
  findSeamNearPoint,
  reverseSeamsAcrossEdge,
  seamCoversEdge,
  type EdgeParamHit,
} from './seamHit';
import {
  findBoundaryHits,
  sampleCutterPath,
  slicePiece,
  snapAngleDegrees,
  type CutterPath,
} from './slice';
import { parseSvgToPieces, scalePieces, type SvgImportResult } from './importSvg';
import { buildGridGroup } from './grid';
import { buildManyToManySeams } from './multiSew';
import { drivenPointIds } from './blocks/driven';
import {
  createBlockInstance,
  generateBlockPieces,
  generateBlockSeams,
  nextBlockOrigin,
  normalizeBlocks,
  spliceBlockPieces,
} from './blocks/generate';
import { BLOCK_DEFINITIONS, getBlockDefinition } from './blocks/registry';
import { bindingValueCm, clampToDeclared, resolveBlockValues, sourceValueCm } from './blocks/resolve';
import type { BlockDefinition } from './blocks/spec';
import { DEFAULT_SEAM_GAP_CM } from '../mesh/triangulate';
import {
  AVATAR_OVERLAY_VIEWS,
  buildAvatarOverlayPath,
  ensureAvatarOverlaySource,
  type AvatarOverlayView,
} from './avatarPatternOverlay';
import {
  CORNER_HANDLES,
  angleAbout,
  handleCentre,
  rotatePoint,
  rotateZoneAt,
  snapAngle,
  type ScaleHandle,
} from './selectionHandles';

export type PatternEditorCallbacks = {
  onChange: () => void;
  /** Fired once before a gesture/mutation so the host can snapshot undo history. */
  onBeforeChange?: () => void;
  /**
   * Ruler edits are drafting references only — they never change geometry, so
   * they must not invalidate the mesh the way `onChange` does.
   */
  onRulerChange?: () => void;
  /** Body-measurement library (people + values) used to size and label rulers. */
  getMeasurementLibrary?: () => MeasurementLibrary | null;
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
  | 'bend'
  | 'ruler';

export type KnifeMode = 'linear' | 'circle' | 'curve';
export type SewMode = 'segment' | 'many';

/**
 * The edge under the pointer. Carries the direction a click here would sew
 * (read from the half the pointer is on), the same gesture the 3D sew tool uses,
 * so the hover stroke can preview it.
 */
type HoverEdge = { pieceId: string; fromPointId: string; toPointId: string; t0: number; t1: number };

/** Corner = free/proportional 2-axis; edge = single-axis (n/s → Y, e/w → X). */
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
  | { type: 'rulerCreate'; start: Vec2; current: Vec2; snap: boolean }
  | { type: 'rulerMove'; id: string; start: Vec2; origin: Vec2 }
  | { type: 'rulerTurn'; id: string; which: 'a' | 'b' }
  | { type: 'blockMove'; id: string; start: Vec2; origin: Vec2 }
  | { type: 'knifeLine'; start: Vec2; current: Vec2; shift: boolean }
  | { type: 'knifeCircle'; center: Vec2; radius: number; shift: boolean }
  | { type: 'knifeCurveHandles'; a: Vec2; b: Vec2; c0: Vec2; c1: Vec2 }
  | { type: 'moveSelection'; start: Vec2; snapshots: PointSnapshot[] }
  | {
      type: 'rotateSelection';
      /** Pivot: the centre of the selection box. */
      center: Vec2;
      /** Pointer angle about `center` when the drag began, radians. */
      startAngle: number;
      snapshots: PointSnapshot[];
    }
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

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Turn arrow for the rotate zone, inline because CSS has no rotate cursor and
 * the gesture — "grab beside the corner" — is exactly what the pointer has to
 * say. Hotspot at the centre of the arc, where the pivot sits.
 */
const ROTATE_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23f2ebe3' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M12 6.5a6 6 0 1 1-5.2 3'/%3E%3Cpath d='M12 2.6v5.2l-4.4-2.6z' fill='%23f2ebe3' stroke='none'/%3E%3C/svg%3E\") 12 12, grabbing";

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

function svgLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cls: string,
  strokeWidth: number
): SVGLineElement {
  const line = svgEl('line');
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  line.setAttribute('class', cls);
  line.setAttribute('stroke-width', String(strokeWidth));
  return line;
}

/**
 * Repair a pattern's derived data on the way in.
 *
 * Both of these are caches that a document can carry stale copies of: ruler
 * labels are resolved live, and block outlines are a rendering of the block's
 * variables. Nothing should ever draw before this has run — an older build, a
 * hand-edited archive or a clamped variable would otherwise keep showing a
 * shape the data no longer describes.
 */
function normalizePattern(
  pattern: PatternDocument,
  setFor: (personId: string | null) => MeasurementSet | null | undefined
): void {
  if (pattern.rulers) pattern.rulers = normalizeRulers(pattern.rulers);
  normalizeBlocks(pattern, getBlockDefinition, setFor);
}

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
  /**
   * Layout px per pattern unit, captured once per redraw.
   *
   * Every stroke width, dash pattern, handle radius and label size goes through
   * `px()`, and each of those used to read the element's `clientWidth`. Reading
   * layout after the DOM has been mutated forces a synchronous style flush, so a
   * redraw that wrote an element and then measured one was doing it hundreds of
   * times: dragging a piece spent most of its time in layout, not drawing.
   */
  private viewScaleCache: number | null = null;
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
  /** Where on its edge the seam menu was opened — which seam, and which part of a shared edge. */
  private contextSeamHit: EdgeParamHit | null = null;
  /** First edge locked while sewing (MD segment sewing). */
  private pendingSeam: SeamEdgeRef | null = null;
  /** Ordered edge groups for many-to-many sewing. */
  private multiSewPhase: 'source' | 'target' = 'source';
  private multiSewSource: SeamEdgeRef[] = [];
  private multiSewTarget: SeamEdgeRef[] = [];
  /** Edge under the cursor while the sew tool is active. */
  private hoverEdge: HoverEdge | null = null;
  /** Corner whose rotate zone the pointer is in, while a selection has handles. */
  private hoverRotate: ScaleHandle | null = null;
  private svgFileInput!: HTMLInputElement;
  private importDialog: HTMLElement | null = null;
  private pendingSvgImport: SvgImportResult | null = null;
  /** Ruler tool state — rulers are document data on `pattern.rulers`. */
  private selectedRulerId: string | null = null;
  private hoverRulerId: string | null = null;
  private rulerBtn!: HTMLButtonElement;
  private rulerMenu!: HTMLElement;
  private rulerSearchInput!: HTMLInputElement;
  private rulerTree!: HTMLElement;
  private rulerMenuHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private rulerMenuHoldOpened = false;
  private rulerMenuDocPointerDown: ((e: PointerEvent) => void) | null = null;
  /**
   * A measurement chosen from the hold-open menu, waiting for the next drag.
   * Lets you lay out several rulers of the same body dimension in a row.
   */
  private rulerArmed: {
    personId: string;
    personName: string;
    fieldId: string;
    lengthCm: number;
  } | null = null;
  private rulerBar!: HTMLElement;
  /** Block tool state — instances are document data on `pattern.blocks`. */
  private selectedBlockId: string | null = null;
  /**
   * Which block owns each generated piece. Rebuilt at the top of `redraw()` so
   * `drawPiece` can tint block geometry without a scan per piece.
   */
  private blockOwnership = new Map<string, BlockInstance>();
  /** The variable row under the pointer, and the points its value moves. */
  /**
   * Inspector sections the user has folded shut, by group name.
   *
   * Held here rather than read back off the DOM because the rows are rebuilt
   * whenever a binding changes shape — switching one variable to Measure
   * rewrites the whole panel, and a section that sprang open every time you did
   * that would be worse than no accordion at all.
   */
  private collapsedBlockGroups = new Set<string>();
  private hoverVarId: string | null = null;  private hoverDriven: Set<string> | null = null;
  private blockBtn!: HTMLButtonElement;
  private blockMenu!: HTMLElement;
  private blockMenuDocPointerDown: ((e: PointerEvent) => void) | null = null;
  private blockBar!: HTMLElement;
  private blockPersonSelect!: HTMLSelectElement;
  private blockSourceNote!: HTMLElement;
  private blockVarsHost!: HTMLElement;
  private rulerPersonSelect!: HTMLSelectElement;
  private rulerMeasureSelect!: HTMLSelectElement;
  private rulerScaleBtns: HTMLButtonElement[] = [];
  private rulerReadout!: HTMLElement;

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
    normalizePattern(pattern, (id) => this.measurementSet(id));

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
        <div class="pattern-tool-flyout pattern-tool-flyout-wide" data-flyout="ruler">
          <button type="button" data-tool="ruler" data-tip="Ruler · hold for measurements" aria-label="Ruler" aria-haspopup="true" aria-expanded="false">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <g transform="rotate(-45 8 8)">
                <rect x="1.2" y="5.4" width="13.6" height="5.2" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.3"/>
                <path fill="none" stroke="currentColor" stroke-width="1.1" d="M4 5.4v2M6.6 5.4v1.3M9.2 5.4v2M11.8 5.4v1.3"/>
              </g>
            </svg>
          </button>
          <div class="pattern-tool-flyout-menu pattern-ruler-menu" hidden role="menu">
            <div class="pattern-ruler-menu-search">
              <input type="search" data-ruler-search autocomplete="off" spellcheck="false"
                placeholder="Search people or measurements…" aria-label="Search people and measurements" />
            </div>
            <div class="pattern-ruler-menu-tree" data-ruler-tree role="tree"></div>
          </div>
        </div>
        <div class="pattern-tool-flyout pattern-tool-flyout-wide" data-flyout="block">
          <button type="button" data-act="add-block" data-tip="Block · add a pattern block" aria-label="Add block" aria-haspopup="true" aria-expanded="false">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M2.6 5.6 L8 2.9 L13.4 5.6 L13.4 10.6 L8 13.3 L2.6 10.6 Z"/>
              <circle cx="8" cy="8" r="1.5" fill="currentColor"/>
            </svg>
          </button>
          <div class="pattern-tool-flyout-menu pattern-block-menu" hidden role="menu" data-block-menu></div>
        </div>
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
    this.rulerBtn = this.toolbar.querySelector('button[data-tool="ruler"]') as HTMLButtonElement;
    this.rulerMenu = this.toolbar.querySelector(
      '[data-flyout="ruler"] .pattern-tool-flyout-menu'
    ) as HTMLElement;
    this.blockBtn = this.toolbar.querySelector('button[data-act="add-block"]') as HTMLButtonElement;
    this.blockMenu = this.toolbar.querySelector('[data-block-menu]') as HTMLElement;
    this.bindBlockMenu();
    this.rulerSearchInput = this.toolbar.querySelector(
      'input[data-ruler-search]'
    ) as HTMLInputElement;
    this.rulerTree = this.toolbar.querySelector('[data-ruler-tree]') as HTMLElement;
    this.bindKnifeFlyout();
    this.bindSewFlyout();
    this.bindRulerMenu();
    this.rulerSearchInput.addEventListener('input', () => this.renderRulerMenu());
    this.rulerTree.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest(
        'button[data-measure-id]'
      ) as HTMLButtonElement | null;
      if (!item || item.disabled) return;
      e.preventDefault();
      this.chooseRulerMeasurement(item.dataset.personId ?? '', item.dataset.measureId ?? '');
    });
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
      if (
        btn.dataset.tool === 'knife' ||
        btn.dataset.tool === 'sew' ||
        btn.dataset.tool === 'ruler'
      ) {
        return;
      }
      this.hideKnifeFlyout();
      this.hideSewFlyout();
      this.setTool(btn.dataset.tool as PatternTool);
    });

    const main = document.createElement('div');
    main.className = 'pattern-editor-main';
    this.root.appendChild(main);

    this.pointBar = document.createElement('div');
    this.pointBar.className = 'pattern-point-bar';
    this.pointBar.hidden = true;
    this.pointBar.innerHTML = `
      <label title="Keep handles opposite when dragging"><input type="checkbox" data-opt="parallel" /> Parallel handles</label>
      <label title="Zero-length handles — corner / straight segments"><input type="checkbox" data-opt="corner" /> Corner (zero handles)</label>
    `;
    this.parallelCheck = this.pointBar.querySelector('input[data-opt="parallel"]') as HTMLInputElement;
    this.cornerCheck = this.pointBar.querySelector('input[data-opt="corner"]') as HTMLInputElement;
    this.sealOverlay(this.pointBar);
    this.parallelCheck.addEventListener('change', () => this.onParallelToggle());
    this.cornerCheck.addEventListener('change', () => this.onCornerToggle());

    this.viewport = document.createElement('div');
    this.viewport.className = 'pattern-viewport';
    main.appendChild(this.viewport);
    // Floats over the canvas in the top-left slot — as a layout sibling above
    // the viewport it used to shove the whole canvas down whenever you clicked
    // a point.
    this.viewport.appendChild(this.pointBar);

    // Ruler inspector — appears only while a reference ruler is selected.
    this.rulerBar = document.createElement('div');
    this.rulerBar.className = 'pattern-ruler-bar';
    this.rulerBar.hidden = true;
    this.rulerBar.innerHTML = `
      <span class="pattern-ruler-bar-label">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <g transform="rotate(-45 8 8)">
            <rect x="1.2" y="5.4" width="13.6" height="5.2" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.3"/>
            <path fill="none" stroke="currentColor" stroke-width="1.1" d="M4 5.4v2M6.6 5.4v1.3M9.2 5.4v2M11.8 5.4v1.3"/>
          </g>
        </svg>
        Ruler
      </span>
      <label class="pattern-ruler-field">
        <span>Person</span>
        <select data-ruler-person aria-label="Measurement person"></select>
      </label>
      <label class="pattern-ruler-field">
        <span>Measurement</span>
        <select data-ruler-measure aria-label="Body measurement"></select>
      </label>
      <div class="pattern-ruler-scale" role="group" aria-label="Ruler width">
        <button type="button" data-ruler-half="0">Full</button>
        <button type="button" data-ruler-half="1" title="Half the measurement — the usual fold line">Half</button>
      </div>
      <span class="pattern-ruler-readout" data-ruler-readout></span>
      <button type="button" class="pattern-ruler-delete" data-ruler-delete aria-label="Delete ruler">Delete</button>
    `;
    this.viewport.appendChild(this.rulerBar);
    this.rulerPersonSelect = this.rulerBar.querySelector(
      'select[data-ruler-person]'
    ) as HTMLSelectElement;
    this.rulerMeasureSelect = this.rulerBar.querySelector(
      'select[data-ruler-measure]'
    ) as HTMLSelectElement;
    this.rulerReadout = this.rulerBar.querySelector('[data-ruler-readout]') as HTMLElement;
    this.rulerScaleBtns = Array.from(
      this.rulerBar.querySelectorAll('button[data-ruler-half]')
    ) as HTMLButtonElement[];
    this.sealOverlay(this.rulerBar);
    this.rulerBar.addEventListener('click', (e) => {
      const halfBtn = (e.target as HTMLElement).closest(
        'button[data-ruler-half]'
      ) as HTMLButtonElement | null;
      if (halfBtn) {
        this.setSelectedRulerHalf(halfBtn.dataset.rulerHalf === '1');
        return;
      }
      const del = (e.target as HTMLElement).closest(
        'button[data-ruler-delete]'
      ) as HTMLButtonElement | null;
      if (del) this.deleteSelectedRuler();
    });
    this.rulerPersonSelect.addEventListener('change', () =>
      this.onRulerPersonChange(this.rulerPersonSelect.value)
    );
    this.rulerMeasureSelect.addEventListener('change', () =>
      this.onRulerMeasurementChange(this.rulerMeasureSelect.value)
    );

    // Block inspector — takes the same top-left slot as the point and ruler
    // ribbons; the three are mutually exclusive by selection.
    this.blockBar = document.createElement('div');
    this.blockBar.className = 'pattern-block-bar';
    this.blockBar.hidden = true;
    this.blockBar.innerHTML = `
      <div class="pattern-block-head">
        <span class="pattern-block-name" data-block-name></span>
        <label class="pattern-block-field">
          <span>Person</span>
          <select data-block-person aria-label="Measurement person"></select>
        </label>
        <button type="button" class="pattern-block-sew" data-block-sew
          title="Sew the side seams, and the waistband onto the waist">Sew</button>
        <button type="button" class="pattern-block-detach" data-block-detach
          title="Keep the pieces but stop tracking them as a block">Detach</button>
        <button type="button" class="pattern-block-delete" data-block-delete
          aria-label="Delete block">Delete</button>
      </div>
      <div class="pattern-block-vars" data-block-vars></div>
      <div class="pattern-block-source muted" data-block-source></div>
    `;
    this.viewport.appendChild(this.blockBar);
    this.blockPersonSelect = this.blockBar.querySelector(
      'select[data-block-person]'
    ) as HTMLSelectElement;
    this.blockVarsHost = this.blockBar.querySelector('[data-block-vars]') as HTMLElement;
    this.blockSourceNote = this.blockBar.querySelector('[data-block-source]') as HTMLElement;
    this.sealOverlay(this.blockBar);
    this.blockPersonSelect.addEventListener('change', () =>
      this.onBlockPersonChange(this.blockPersonSelect.value)
    );
    this.blockBar.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('button[data-block-sew]')) {
        this.sewSelectedBlock();
        return;
      }
      if (target.closest('button[data-block-detach]')) {
        this.detachSelectedBlock();
        return;
      }
      if (target.closest('button[data-block-delete]')) {
        this.deleteSelectedBlock();
        return;
      }
      const groupHead = target.closest<HTMLButtonElement>('button[data-block-group-toggle]');
      if (groupHead) {
        const group = groupHead.closest<HTMLElement>('.pattern-block-group');
        if (group?.dataset.blockGroup) this.toggleBlockGroup(group.dataset.blockGroup, group);
        return;
      }
      const mode = target.closest('button[data-block-mode]') as HTMLButtonElement | null;
      const div = target.closest('button[data-block-div]') as HTMLButtonElement | null;
      const varEl = target.closest('[data-var-id]') as HTMLElement | null;
      if (!varEl) return;
      const varId = varEl.dataset.varId!;
      if (mode) {
        this.setBlockVariableMode(varId, mode.dataset.blockMode as 'value' | 'measurement');
        return;
      }
      if (div) {
        const divisor = Number(div.dataset.blockDiv) as BlockDivisor;
        this.setBlockVariableDivisor(varId, divisor);
      }
    });
    this.blockBar.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      const varEl = target.closest('[data-var-id]') as HTMLElement | null;
      if (!varEl) return;
      const varId = varEl.dataset.varId!;
      // Typing is not a structural edit: the rows stay put so the caret survives
      // and the whole typed entry collapses into one undo step.
      if (target.matches('[data-block-value]')) {
        const cm = this.blockFieldCm(varId, target);
        if (cm != null) this.setBlockVariableValue(varId, cm, false);
        return;
      }
      if (target.matches('[data-block-offset]')) {
        const raw = Number.parseFloat(target.value);
        if (Number.isFinite(raw)) this.setBlockVariableOffset(varId, this.blockCm(raw), false);
      }
    });
    this.blockBar.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      const varEl = target.closest('[data-var-id]') as HTMLElement | null;
      if (!varEl) return;
      const varId = varEl.dataset.varId!;
      if (target.matches('[data-block-field]')) {
        this.setBlockVariableField(varId, (target as HTMLSelectElement).value);
        return;
      }
      // Past the select, everything left in this bar is a number field.
      const field = target as HTMLInputElement;
      // A field left empty, half-typed or out of range snaps back to the value
      // the block is really using, so the box never lies about the draft.
      if (target.matches('[data-block-value]')) {
        const cm = this.blockFieldCm(varId, field);
        if (cm != null) this.setBlockVariableValue(varId, cm, false);
      } else if (target.matches('[data-block-offset]')) {
        const raw = Number.parseFloat(field.value);
        if (Number.isFinite(raw)) this.setBlockVariableOffset(varId, this.blockCm(raw), false);
      }
      this.syncBlockField(varId, field);
      this.endHistoryGesture();
    });
    // Belt and braces: `change` already fires on blur, but an interrupted edit
    // must never leave the undo gesture open for the next unrelated action.
    this.blockBar.addEventListener('focusout', () => this.endHistoryGesture());

    // Hovering a variable lights up the outline it controls, so you can see what
    // "dart space" or "hip depth, side" actually moves before you touch it.
    this.blockVarsHost.addEventListener('pointerover', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-var-id]');
      this.setHoveredVar(row?.dataset.varId ?? null);
    });
    this.blockVarsHost.addEventListener('pointerleave', () => this.setHoveredVar(null));

    this.sewBar = document.createElement('div');
    this.sewBar.className = 'pattern-sew-bar';
    this.sewBar.hidden = true;
    this.sewBar.innerHTML = `
      <span data-sew-instruction></span>
      <button type="button" data-sew-reverse title="Reverse the order of the edges selected for this side">Reverse order</button>
      <button type="button" data-sew-next></button>
      <button type="button" data-sew-cancel aria-label="Cancel many-to-many sewing">Cancel</button>
    `;
    this.viewport.appendChild(this.sewBar);
    this.sealOverlay(this.sewBar);
    this.sewBar.querySelector('[data-sew-next]')?.addEventListener('click', () => {
      this.advanceMultiSew();
    });
    this.sewBar.querySelector('[data-sew-reverse]')?.addEventListener('click', () => {
      this.reverseMultiSewSide();
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
    this.sealOverlay(this.xrayBar);
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
    this.sealOverlay(this.avatarBar);
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
      <button type="button" data-act="reverse-seam-order" hidden>Reverse seam order here</button>
      <button type="button" data-act="remove-seam" class="danger" hidden>Remove seam</button>
      <button type="button" data-act="ruler-toggle-half" hidden>Toggle full / half width</button>
      <button type="button" data-act="ruler-delete" class="danger" hidden>Delete ruler</button>
    `;
    this.viewport.appendChild(this.contextMenu);
    this.sealOverlay(this.contextMenu);
    this.contextMenu.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'duplicate') this.duplicateContextPiece();
      else if (act === 'mirror-x') this.mirrorDuplicateContextPiece('x');
      else if (act === 'mirror-y') this.mirrorDuplicateContextPiece('y');
      else if (act === 'delete-piece') this.deleteContextPiece();
      else if (act === 'reverse-seam') this.reverseContextSeam();
      else if (act === 'reverse-seam-order') this.reverseContextSeamOrder();
      else if (act === 'remove-seam') this.removeContextSeam();
      else if (act === 'ruler-toggle-half') this.setSelectedRulerHalf(!this.selectedRuler()?.half);
      else if (act === 'ruler-delete') this.deleteSelectedRuler();
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
    this.syncRulerToolbar();
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
      this.setRulerSelection(null);
      this.setSelectedBlock(null);
      this.hideRulerMenu();
      this.hideBlockMenu();
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
    // Block outlines are a cache of their variables, so rebuild them before
    // anything measures or draws: a document written by an older build, or one
    // whose variables were clamped on the way in, must not keep displaying the
    // shape it was saved with.
    normalizePattern(pattern, (id) => this.measurementSet(id));
    this.selectedRulerId = null;
    this.hoverRulerId = null;
    this.selectedBlockId = null;
    this.syncRulerBar();
    this.syncBlockBar();
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

  /**
   * Called when the body-measurement library changes: rulers read their person
   * and measurement live, so their lengths and labels need a repaint.
   */
  reloadRulers(): void {
    this.syncRulerBar();
    this.redraw();
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
    if (tool !== 'ruler') {
      this.hideRulerMenu();
      // A measurement armed for the ruler tool is meaningless elsewhere.
      this.rulerArmed = null;
      this.syncRulerToolbar();
    }
    // Rulers are only interactive under the ruler and move tools; drop the
    // inspector rather than leaving an invisible selection behind.
    if (tool !== 'ruler' && tool !== 'move') {
      this.selectedRulerId = null;
      this.hoverRulerId = null;
      this.syncRulerBar();
    }
    this.syncKnifeToolbar();
    this.syncSewToolbar();
    for (const btn of Array.from(this.toolbar.querySelectorAll('button[data-tool]'))) {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tool === tool);
    }
    this.applyCursor(null);
    this.redraw();
  }

  /** Cursor the active tool uses when nothing is under the pointer. */
  private baseCursor(): string {
    const tool = this.tool;
    if (
      tool === 'pen' ||
      tool === 'dart' ||
      tool === 'sew' ||
      tool === 'rect' ||
      tool === 'circle' ||
      tool === 'knife' ||
      tool === 'ruler'
    ) {
      return 'crosshair';
    }
    return tool === 'bend' ? 'pointer' : 'default';
  }

  /**
   * The one place the canvas cursor is decided, so hover feedback cannot fight
   * itself: a ruler in hand outranks the rotate zone, which outranks the tool's
   * own cursor.
   */
  private applyCursor(over: 'ruler' | 'rotate' | null): void {
    const next =
      over === 'rotate' ? ROTATE_CURSOR : over === 'ruler' ? 'move' : this.baseCursor();
    if (this.svg.style.cursor !== next) this.svg.style.cursor = next;
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
    this.releaseBlockSelection();
  }

  private setSelection(ids: string[], primary?: string | null): void {
    this.selectedIds = new Set(ids);
    this.selectedPointId = primary ?? ids[ids.length - 1] ?? null;
    this.releaseBlockSelection();
  }

  private selectOnly(pointId: string, pieceId?: string): void {
    this.selectedIds = new Set([pointId]);
    this.selectedPointId = pointId;
    if (pieceId) this.selectedPieceId = pieceId;
    this.releaseBlockSelection();
  }

  /**
   * Drop the block selection once the pieces it describes are no longer picked.
   *
   * The block controls edit a block, and they have nothing to say about a
   * selection that has moved on to something else — a ribbon left up over a
   * piece you deselected reads as though the two are still connected. Run after
   * every change to the picked points rather than at each call site, so no path
   * can forget it.
   */
  private releaseBlockSelection(): void {
    const instance = this.selectedBlock();
    if (!instance) return;
    const owned = new Set(instance.pieces.map((entry) => entry.pieceId));
    const stillPicked = this.pattern.pieces.some(
      (piece) => owned.has(piece.id) && piece.points.some((pt) => this.selectedIds.has(pt.id))
    );
    if (!stillPicked) this.setSelectedBlock(null);
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

  /**
   * Minor/major reference grid — see `buildGridGroup` for the letterbox overscan
   * and the zoom-out ladder.
   */
  private drawGrid(layoutW: number, layoutH: number): SVGGElement {
    return buildGridGroup(this.viewBox, this.unit, {
      width: layoutW,
      height: layoutH,
    });
  }

  private redraw(): void {
    const { x, y, w, h } = this.viewBox;
    // The single layout read for this redraw — see `viewScaleCache`. Taken before
    // anything is written so it cannot force a flush of its own.
    const layoutW = this.svg.clientWidth;
    const layoutH = this.svg.clientHeight;
    const sized = layoutW >= 2 && layoutH >= 2;
    this.viewScaleCache = sized ? Math.min(layoutW / w, layoutH / h) : null;
    if (sized) this.lastChromeLayout = { w: layoutW, h: layoutH };

    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.avatarSvg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    this.svg.innerHTML = '';

    const grid = this.drawGrid(layoutW, layoutH);
    this.svg.appendChild(grid);

    // Ownership has to be known before anything is drawn, and the group boxes go
    // down first so a piece stroke can never be painted over by one.
    this.blockOwnership = new Map();
    for (const instance of this.blocks()) {
      for (const entry of instance.pieces) this.blockOwnership.set(entry.pieceId, instance);
      this.drawBlockOutline(instance);
    }

    for (const piece of this.pattern.pieces) {
      this.drawPiece(piece);
    }

    // Above the pieces, below the seams and everything you can grab: the
    // highlight is an answer to "what does this number move?", not a handle.
    this.drawBlockHighlight();

    this.drawSeams();

    // Rulers are laid *over* the work like a real ruler on the table, so the
    // line you are measuring against is always visible and grabbable. The
    // readings come back separately so a later ruler's graduations can never
    // cover an earlier ruler's numbers.
    for (const reading of this.drawRulers()) this.svg.appendChild(reading);

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
    this.updateRulerReadout();
    this.updateBlockReadouts();
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
      this.pointBar.hidden = true;
      return;
    }
    this.pointBar.hidden = false;
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

  /** True when the picked points sit on generated (block-owned) geometry. */
  private selectionIsGenerated(): boolean {
    for (const piece of this.pattern.pieces) {
      if (!this.blockOwnership.has(piece.id)) continue;
      if (piece.points.some((pt) => this.selectedIds.has(pt.id))) return true;
    }
    return false;
  }

  private drawSelectionChrome(): void {
    if (this.selectedIds.size < 2) return;
    const box = this.selectionScaleBox();
    if (!box) return;
    // A selection over generated geometry is an indicator, not a set of handles.
    // A block moves as a unit and its points are rebuilt from its variables, so
    // scale grips on it would edit something that is about to be thrown away —
    // and a box that swallowed the click would rob the block of its own drag,
    // which is how it is meant to be moved.
    const generated = this.selectionIsGenerated();
    const x = box.minX;
    const y = box.minY;
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute(
      'class',
      `pattern-selection-box${generated ? ' is-indicator' : ''}`
    );
    rect.setAttribute('stroke-width', String(this.px(1.75)));
    rect.setAttribute('stroke-dasharray', `${this.px(7)} ${this.px(4)}`);
    rect.dataset.kind = 'selectionBox';
    this.svg.appendChild(rect);
    if (generated) return;

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

    // A dashed ring outside each corner: the rotate zone, drawn where it can be
    // seen. The grip is a small exact target, so the gesture “just outside it”
    // needs to be visible or nobody finds it. Pointer-events stay off — the hit
    // test is distance-based, in `rotateZoneHandle`.
    for (const c of handles) {
      if (!CORNER_HANDLES.includes(c.handle)) continue;
      const ring = svgEl('circle');
      const inner = this.rotateZoneInner();
      const outer = this.rotateZoneOuter();
      ring.setAttribute('cx', String(c.cx));
      ring.setAttribute('cy', String(c.cy));
      ring.setAttribute('r', String((inner + outer) / 2 - (outer - inner) / 4));
      ring.setAttribute('class', `pattern-rotate-ring${this.hoverRotate === c.handle ? ' is-hot' : ''}`);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke-width', String(this.px(1.25)));
      ring.setAttribute('stroke-dasharray', `${this.px(3)} ${this.px(3)}`);
      ring.setAttribute('pointer-events', 'none');
      this.svg.appendChild(ring);
    }

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
    // Generated geometry reads as one family: lavender lines and points say
    // "this is drafted from variables" at a glance, and marks the pieces that
    // will be rebuilt the moment a variable moves.
    const block = this.blockOwnership.get(piece.id);
    const blockCls = block ? ' is-block' : '';
    if (n > 0) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', this.piecePathD(piece));
      path.setAttribute('class', `pattern-fill${blockCls}`);
      path.setAttribute('stroke-width', String(this.px(2)));
      path.dataset.pieceId = piece.id;
      this.svg.appendChild(path);
    }

    // Drafted blocks are full of short edges — dart legs, the waistband notch,
    // ease offsets. Labelling every one of them piles unreadable text over the
    // outline, so lengths are placed greedily: an edge earns a label only when
    // the text fits along it *and* the resulting box is clear of every label
    // already placed. Longest edges are considered first, because those are the
    // ones you actually measure; short ones fill the gaps if there is room.
    const lengths = segmentLengths(piece.points, piece.closed);
    const edgeCount = piece.closed ? n : Math.max(0, n - 1);
    const labelPx = 11;
    const fontSize = this.px(labelPx);
    const scale = this.viewScale();
    type Candidate = { index: number; text: string; x: number; y: number; w: number; h: number };
    const candidates: Candidate[] = [];
    for (let i = 0; i < edgeCount; i++) {
      const text = formatLength(lengths[i], this.unit, 1);
      const w = text.length * labelPx * 0.62;
      if (lengths[i] * scale < w + 8) continue;
      const a = piece.points[i].anchor;
      const b = piece.points[(i + 1) % n].anchor;
      candidates.push({
        index: i,
        text,
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2 - this.px(10),
        w,
        h: labelPx * 1.1,
      });
    }
    candidates.sort((a, b) => lengths[b.index] - lengths[a.index]);
    const placed: Array<{ index: number; text: string; x: number; y: number }> = [];
    const boxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    for (const c of candidates) {
      const box = { x0: c.x - c.w / 2, y0: c.y - c.h / 2, x1: c.x + c.w / 2, y1: c.y + c.h / 2 };
      const clash = boxes.some(
        (b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0
      );
      if (clash) continue;
      boxes.push(box);
      placed.push({ index: c.index, text: c.text, x: c.x, y: c.y });
    }
    placed.sort((a, b) => a.index - b.index);
    for (const p of placed) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(p.x));
      label.setAttribute('y', String(p.y));
      label.setAttribute('class', 'pattern-length');
      label.setAttribute('font-size', String(fontSize));
      label.setAttribute('pointer-events', 'none');
      label.style.userSelect = 'none';
      label.textContent = p.text;
      this.svg.appendChild(label);
    }

    if (piece.grainline) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      g.setAttribute('x1', String(piece.grainline.from.x));
      g.setAttribute('y1', String(piece.grainline.from.y));
      g.setAttribute('x2', String(piece.grainline.to.x));
      g.setAttribute('y2', String(piece.grainline.to.y));
      g.setAttribute('class', `pattern-grain${blockCls}`);
      // Every mark belonging to a piece has to advertise it: the editor resolves
      // "which piece was clicked" from the event target, so artwork without the
      // id swallows the gesture and the piece looks dead under the cursor.
      g.dataset.pieceId = piece.id;
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
        `${this.selectedIds.has(pt.id) ? 'pattern-point selected' : 'pattern-point'}${blockCls}`
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
    if (this.viewScaleCache != null) return this.viewScaleCache;
    const w = this.svg.clientWidth;
    const h = this.svg.clientHeight;
    // Before flex layout settles, client size is 0 — assume a typical pattern
    // viewport so we don't bake 1px≈1cm chrome (huge labels/handles). Deliberately
    // not cached: it is a placeholder, and storing it would size the whole drawing
    // for a viewport that never existed.
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
    this.mapSnapshots(snapshots, map);
  }

  /** Rotate the selection about a pivot. Anchors *and* handles turn together. */
  private applySnapshotsRotated(
    snapshots: PointSnapshot[],
    pivot: Vec2,
    angle: number
  ): void {
    this.mapSnapshots(snapshots, (v) => rotatePoint(v, pivot, angle));
  }

  private mapSnapshots(snapshots: PointSnapshot[], map: (v: Vec2) => Vec2): void {
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

  /** Inner edge of the rotate zone: just clear of the drawn grip. */
  private rotateZoneInner(): number {
    return this.px(7);
  }

  /** Outer edge of the rotate zone: how far out a drag still reads as rotate. */
  private rotateZoneOuter(): number {
    return this.px(20);
  }

  /**
   * The corner whose rotate zone the pointer is in, or null.
   *
   * Trimmed to *outside* the selection box: a drag that starts inside the box
   * means “move”, and for a small selection the zone would otherwise cover the
   * whole thing.
   */
  private rotateCornerAt(p: Vec2, box: BBox): ScaleHandle | null {
    return rotateZoneAt(p, box, this.rotateZoneInner(), this.rotateZoneOuter());
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
    const rulerHit = this.findRulerHit(p);
    if (rulerHit) {
      e.stopPropagation();
      this.setRulerSelection(rulerHit.id);
      this.showContextMenu(e.clientX, e.clientY, 'ruler');
      this.redraw();
      return;
    }

    const seamHit = this.findSeamNearClick(p);
    if (seamHit) {
      e.stopPropagation();
      this.contextSeamId = seamHit.id;
      const near = this.findNearestEdgeAcrossPieces(p);
      this.contextSeamHit = near
        ? {
            pieceId: near.piece.id,
            fromPointId: near.fromPointId,
            toPointId: near.toPointId,
            t: near.t,
          }
        : null;
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

  private showContextMenu(
    clientX: number,
    clientY: number,
    mode: 'piece' | 'seam' | 'ruler' = 'piece'
  ): void {
    const pieceActs = ['duplicate', 'mirror-x', 'mirror-y', 'delete-piece'];
    const seamActs = ['reverse-seam', 'reverse-seam-order', 'remove-seam'];
    const rulerActs = ['ruler-toggle-half', 'ruler-delete'];
    // Reordering only means something where a run of seams shares one edge.
    const canReorder =
      !!this.contextSeamHit &&
      reverseSeamsAcrossEdge(this.pattern.seams, this.contextSeamHit) !== null;
    for (const btn of Array.from(this.contextMenu.querySelectorAll('button[data-act]'))) {
      const act = (btn as HTMLElement).dataset.act!;
      const show =
        mode === 'piece'
          ? pieceActs.includes(act)
          : mode === 'ruler'
            ? rulerActs.includes(act)
            : act === 'reverse-seam-order'
              ? canReorder
              : seamActs.includes(act);
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
    this.contextSeamHit = null;
  }

  /**
   * A floating ribbon is a UI island: gestures on it must never reach the canvas
   * underneath.
   *
   * The pointer guard stops a click on a ribbon from being read as a canvas
   * gesture. The wheel guard matters just as much — the viewport zooms on wheel
   * (see the constructor), so without it, Alt+scrolling an offset field would
   * nudge the value *and* zoom the pattern behind it.
   */
  private sealOverlay(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  // ── Rulers ───────────────────────────────────────────────────────────────
  //
  // A ruler is a physical reference line pinned over the pattern. It measures a
  // *person*: the length tracks a body measurement, so you can eyeball "this
  // panel is a half-bust wide" without re-reading the measurement chart.
  // Rulers are document data (`pattern.rulers`) so they round-trip with the
  // project, and they never touch geometry — hence `onRulerChange`, not
  // `onChange`, which would invalidate the mesh.

  private rulers(): PatternRuler[] {
    return this.pattern.rulers ?? [];
  }

  private ensureRulers(): PatternRuler[] {
    if (!this.pattern.rulers) this.pattern.rulers = [];
    return this.pattern.rulers;
  }

  private selectedRuler(): PatternRuler | null {
    if (!this.selectedRulerId) return null;
    return this.rulers().find((r) => r.id === this.selectedRulerId) ?? null;
  }

  /** The person a ruler points at; `null` asks for the active person. */
  private measurementSet(personId: string | null): MeasurementSet | null {
    const lib = this.cbs.getMeasurementLibrary?.() ?? null;
    if (!lib || lib.sets.length === 0) return null;
    if (!personId) {
      return lib.sets.find((s) => s.id === lib.activeId) ?? lib.sets[0] ?? null;
    }
    return lib.sets.find((s) => s.id === personId) ?? null;
  }

  private activeSet(): MeasurementSet | null {
    return this.measurementSet(null);
  }

  /**
   * Drawn length: a live measurement value when the person still has one, else
   * the number snapshotted on the ruler.
   */
  private rulerDrawnLength(ruler: PatternRuler): number {
    const live = measurementValueCm(this.measurementSet(ruler.personId), ruler.measurementId);
    const full = live ?? (Number.isFinite(ruler.lengthCm) ? Math.max(0, ruler.lengthCm) : 0);
    return ruler.half ? full / 2 : full;
  }

  private notifyRulerChange(): void {
    if (this.cbs.onRulerChange) this.cbs.onRulerChange();
    else this.cbs.onChange();
  }

  // ── Hold-to-open measurement picker ──────────────────────────────────────
  //
  // Holding the ruler button drops a tree of everybody in the measurement
  // library and their measurements, with a search box that matches a person and
  // a measurement together ("alex waist"). Picking one either rebinds the
  // selected ruler or arms the tool for the next one you drag out.

  private bindRulerMenu(): void {
    const HOLD_MS = 380;
    this.rulerBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.hideToolbarTip();
      this.rulerMenuHoldOpened = false;
      this.rulerMenuHoldTimer = setTimeout(() => {
        this.rulerMenuHoldTimer = null;
        this.rulerMenuHoldOpened = true;
        this.showRulerMenu();
      }, HOLD_MS);
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        if (this.rulerMenuHoldTimer) {
          clearTimeout(this.rulerMenuHoldTimer);
          this.rulerMenuHoldTimer = null;
        }
        if (this.rulerMenuHoldOpened) return;
        // Quick click → plain ruler tool.
        if (ev.target && this.rulerBtn.contains(ev.target as Node)) this.setTool('ruler');
      };
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    });
  }

  private showRulerMenu(): void {
    this.rulerMenu.hidden = false;
    this.rulerBtn.setAttribute('aria-expanded', 'true');
    this.renderRulerMenu();
    if (!this.rulerMenuDocPointerDown) {
      this.rulerMenuDocPointerDown = (e: PointerEvent) => {
        const t = e.target as Node;
        if (this.rulerMenu.contains(t) || this.rulerBtn.contains(t)) return;
        this.hideRulerMenu();
      };
      document.addEventListener('pointerdown', this.rulerMenuDocPointerDown, true);
    }
    // Focus so you can type straight away; selecting means a new query replaces
    // the old one instead of appending to it.
    this.rulerSearchInput.focus();
    this.rulerSearchInput.select();
  }

  private hideRulerMenu(): void {
    this.rulerMenu.hidden = true;
    this.rulerBtn.setAttribute('aria-expanded', 'false');
    if (this.rulerMenuDocPointerDown) {
      document.removeEventListener('pointerdown', this.rulerMenuDocPointerDown, true);
      this.rulerMenuDocPointerDown = null;
    }
  }

  /** Wrap every literal occurrence of the query tokens in `<mark>`. */
  private highlightText(text: string, tokens: string[]): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (tokens.length === 0) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    const lower = text.toLowerCase();
    const hits: Array<[number, number]> = [];
    for (const token of tokens) {
      let from = 0;
      for (;;) {
        const at = lower.indexOf(token, from);
        if (at < 0) break;
        hits.push([at, at + token.length]);
        from = at + token.length;
      }
    }
    if (hits.length === 0) {
      // Fuzzy (subsequence) match — nothing literal to underline.
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    hits.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const hit of hits) {
      const last = merged[merged.length - 1];
      if (last && hit[0] <= last[1]) last[1] = Math.max(last[1], hit[1]);
      else merged.push([hit[0], hit[1]]);
    }
    let cursor = 0;
    for (const [from, to] of merged) {
      if (from > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, from)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(from, to);
      frag.appendChild(mark);
      cursor = to;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    return frag;
  }

  private renderRulerMenu(): void {
    const query = this.rulerSearchInput.value;
    const sets = this.cbs.getMeasurementLibrary?.()?.sets ?? [];
    const tokens = measurementSearchTokens(query);
    const sections = filterMeasurementMenu(buildMeasurementMenu(sets), query);
    this.rulerTree.innerHTML = '';

    const hint = (text: string): void => {
      const el = document.createElement('div');
      el.className = 'pattern-ruler-menu-empty';
      el.textContent = text;
      this.rulerTree.appendChild(el);
    };

    if (sets.length === 0) {
      hint('No people yet — add one from Measurements in the toolbar.');
      return;
    }

    // The escape hatch back to a plain, free-length ruler.
    if (tokens.length === 0) {
      const free = document.createElement('button');
      free.type = 'button';
      free.className = 'pattern-ruler-item is-free';
      free.dataset.personId = '';
      free.dataset.measureId = '';
      const label = document.createElement('span');
      label.className = 'pattern-ruler-item-label';
      label.textContent = 'No measurement';
      const value = document.createElement('span');
      value.className = 'pattern-ruler-item-value';
      value.textContent = 'free length';
      free.append(label, value);
      this.rulerTree.appendChild(free);
      const rule = document.createElement('div');
      rule.className = 'pattern-ruler-menu-divider';
      this.rulerTree.appendChild(rule);
    }

    if (sections.length === 0) {
      hint(`Nothing matches “${query.trim()}”.`);
      return;
    }

    for (const section of sections) {
      const head = document.createElement('div');
      head.className = 'pattern-ruler-person';
      head.appendChild(this.highlightText(section.personName, tokens));
      const unit = document.createElement('span');
      unit.className = 'pattern-ruler-person-unit';
      unit.textContent = section.unit;
      head.appendChild(unit);
      this.rulerTree.appendChild(head);

      for (const row of section.rows) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'pattern-ruler-item';
        item.dataset.personId = section.personId;
        item.dataset.measureId = row.fieldId;
        item.dataset.measureLabel = row.label;
        // An unmeasured field has no length to draw, so it stays visible (you
        // can see the gap in someone's chart) but not selectable.
        item.disabled = row.valueCm == null;

        const label = document.createElement('span');
        label.className = 'pattern-ruler-item-label';
        label.appendChild(this.highlightText(row.label, tokens));

        const value = document.createElement('span');
        value.className = 'pattern-ruler-item-value';
        value.textContent = row.valueCm == null ? 'not set' : formatLength(row.valueCm, this.unit, 1);

        item.append(label, value);
        this.rulerTree.appendChild(item);
      }
    }
  }

  /** Apply a picked measurement to the selected ruler, or arm the tool with it. */
  private chooseRulerMeasurement(personId: string, fieldId: string): void {
    this.hideRulerMenu();
    this.setTool('ruler');

    const ruler = this.selectedRuler();
    if (!personId || !fieldId) {
      this.rulerArmed = null;
      if (ruler) {
        this.markBeforeChange();
        ruler.measurementId = null;
        ruler.personId = null;
        ruler.personName = '';
        this.notifyRulerChange();
        this.endHistoryGesture();
        this.syncRulerBar();
      } else {
        this.syncRulerToolbar();
      }
      this.redraw();
      return;
    }

    const set = this.measurementSet(personId);
    const value = measurementValueCm(set, fieldId);
    if (!set || value == null) return;

    if (ruler) {
      this.markBeforeChange();
      ruler.personId = set.id;
      ruler.personName = set.name;
      ruler.measurementId = fieldId;
      ruler.lengthCm = value;
      this.notifyRulerChange();
      this.endHistoryGesture();
      this.syncRulerBar();
    } else {
      this.rulerArmed = {
        personId: set.id,
        personName: set.name,
        fieldId,
        lengthCm: value,
      };
      this.syncRulerToolbar();
    }
    this.redraw();
  }

  /** Tooltip + armed marker on the ruler button. */
  private syncRulerToolbar(): void {
    const armed = this.rulerArmed;
    const field = armed ? measurementField(armed.fieldId) : null;
    const tip = armed
      ? `Ruler · ${armed.personName} ${field?.label ?? armed.fieldId} — drag to place`
      : 'Ruler · hold for measurements';
    this.rulerBtn.dataset.tip = tip;
    this.rulerBtn.setAttribute('aria-label', tip);
    this.rulerBtn.classList.toggle('is-armed', !!armed);
  }

  private setRulerSelection(id: string | null): void {
    if (this.selectedRulerId === id) return;
    this.selectedRulerId = id;
    this.syncRulerBar();
  }

  private findRulerHit(p: Vec2): RulerHit | null {
    const list = this.rulers();
    const grab = this.px(10);
    const along = this.px(7);
    // Reverse order so the most recently added ruler wins, matching paint order.
    for (let i = list.length - 1; i >= 0; i--) {
      const ruler = list[i]!;
      const { a, b } = rulerEndpoints(ruler, this.rulerDrawnLength(ruler));
      if (dist(p, a) <= grab) return { id: ruler.id, part: 'a' };
      if (dist(p, b) <= grab) return { id: ruler.id, part: 'b' };
      if (distanceToSegment(p, a, b) <= along) return { id: ruler.id, part: 'body' };
    }
    return null;
  }

  private onRulerDown(e: PointerEvent, p: Vec2, preset?: RulerHit | null): void {
    const hit = preset ?? this.findRulerHit(p);
    if (!hit) {
      // Empty canvas → draw a new ruler.
      this.setRulerSelection(null);
      this.clearSelection();
      this.drag = { type: 'rulerCreate', start: p, current: p, snap: e.shiftKey };
      this.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.redraw();
      return;
    }
    const ruler = this.rulers().find((r) => r.id === hit.id);
    if (!ruler) return;
    this.setRulerSelection(ruler.id);
    // A point selection gives way to the ruler — they share the same handles.
    this.clearSelection();
    this.markBeforeChange();
    this.drag =
      hit.part === 'body'
        ? { type: 'rulerMove', id: ruler.id, start: p, origin: { ...ruler.center } }
        : { type: 'rulerTurn', id: ruler.id, which: hit.part };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.redraw();
  }

  /** Turn a finished create-drag into a ruler, snapping to a real measurement. */
  private commitRulerCreate(drag: Extract<DragKind, { type: 'rulerCreate' }>): void {
    const dx = drag.current.x - drag.start.x;
    const dy = drag.current.y - drag.start.y;
    const length = Math.hypot(dx, dy);
    if (!(length > 1)) return;

    const deg = rulerAngle(drag.start, drag.current, drag.snap);
    const th = (deg * Math.PI) / 180;
    const set = this.activeSet();
    // A measurement picked from the hold-open menu wins over auto-matching, so
    // you can lay out several rulers of the same body dimension in a row.
    const armed = this.rulerArmed;
    const fieldId = armed ? armed.fieldId : nearestMeasurementField(set, length);
    const live = armed ? armed.lengthCm : measurementValueCm(set, fieldId);

    const ruler: PatternRuler = {
      id: uid('ruler'),
      center: {
        x: drag.start.x + (Math.cos(th) * length) / 2,
        y: drag.start.y + (Math.sin(th) * length) / 2,
      },
      angle: deg,
      // A near-enough measurement snaps the line to its exact value.
      lengthCm: live ?? length,
      measurementId: fieldId,
      personId: armed ? armed.personId : (set?.id ?? null),
      personName: armed ? armed.personName : (set?.name ?? ''),
      half: false,
    };
    this.markBeforeChange();
    this.ensureRulers().push(ruler);
    this.selectedRulerId = ruler.id;
    this.syncRulerBar();
    this.notifyRulerChange();
    this.endHistoryGesture();
  }

  private setSelectedRulerHalf(half: boolean): void {
    const ruler = this.selectedRuler();
    if (!ruler || ruler.half === half) return;
    this.markBeforeChange();
    ruler.half = half;
    this.notifyRulerChange();
    this.endHistoryGesture();
    this.syncRulerBar();
    this.redraw();
  }

  private onRulerPersonChange(setId: string): void {
    const ruler = this.selectedRuler();
    const set = this.measurementSet(setId);
    if (!ruler || !set) return;
    this.markBeforeChange();
    ruler.personId = set.id;
    ruler.personName = set.name;
    // Keep the stored fallback truthful for the new person.
    const live = measurementValueCm(set, ruler.measurementId);
    if (live != null) ruler.lengthCm = live;
    this.notifyRulerChange();
    this.endHistoryGesture();
    this.syncRulerBar();
    this.redraw();
  }

  private onRulerMeasurementChange(fieldId: string): void {
    const ruler = this.selectedRuler();
    if (!ruler) return;
    this.markBeforeChange();
    ruler.measurementId = fieldId || null;
    const live = measurementValueCm(this.measurementSet(ruler.personId), ruler.measurementId);
    if (live != null) ruler.lengthCm = live;
    // Binding a person is the point of the tool — do it when one is available.
    if (ruler.measurementId && !ruler.personId) {
      const set = this.activeSet();
      if (set) {
        ruler.personId = set.id;
        ruler.personName = set.name;
      }
    }
    this.notifyRulerChange();
    this.endHistoryGesture();
    this.syncRulerBar();
    this.redraw();
  }

  private deleteSelectedRuler(): void {
    const ruler = this.selectedRuler();
    if (!ruler) return;
    this.markBeforeChange();
    this.pattern.rulers = this.rulers().filter((r) => r.id !== ruler.id);
    this.selectedRulerId = null;
    this.hoverRulerId = null;
    this.notifyRulerChange();
    this.endHistoryGesture();
    this.syncRulerBar();
    this.redraw();
  }

  private fillOptions(
    select: HTMLSelectElement,
    entries: Array<{ value: string; label: string }>,
    selected: string
  ): void {
    select.innerHTML = '';
    for (const entry of entries) {
      const opt = document.createElement('option');
      opt.value = entry.value;
      opt.textContent = entry.label;
      select.appendChild(opt);
    }
    select.value = entries.some((e) => e.value === selected) ? selected : (entries[0]?.value ?? '');
  }

  /** Full rebuild — visibility, selects and readout. Not called per frame. */
  private syncRulerBar(): void {
    const ruler = this.selectedRuler();
    if (!ruler) {
      this.rulerBar.hidden = true;
      return;
    }
    this.rulerBar.hidden = false;

    const sets = this.cbs.getMeasurementLibrary?.()?.sets ?? [];
    this.fillOptions(
      this.rulerPersonSelect,
      sets.length > 0
        ? sets.map((s) => ({ value: s.id, label: s.name }))
        : [{ value: '', label: 'No people yet' }],
      ruler.personId ?? sets[0]?.id ?? ''
    );

    const set = this.measurementSet(ruler.personId) ?? sets[0] ?? null;
    const entries: Array<{ value: string; label: string }> = [
      { value: '', label: '— free length —' },
    ];
    if (set) {
      for (const field of MEASUREMENT_FIELDS) {
        const value = measurementValueCm(set, field.id);
        if (value == null) continue;
        entries.push({
          value: field.id,
          label: `${field.label} · ${formatLength(value, this.unit, 1)}`,
        });
      }
      // Never silently drop a reference the ruler already points at.
      if (ruler.measurementId && !entries.some((e) => e.value === ruler.measurementId)) {
        const field = measurementField(ruler.measurementId);
        entries.push({
          value: ruler.measurementId,
          label: `${field?.label ?? ruler.measurementId} · not measured`,
        });
      }
    }
    this.fillOptions(this.rulerMeasureSelect, entries, ruler.measurementId ?? '');
    this.updateRulerReadout();
  }

  /** Cheap per-frame refresh: the numbers change while a free ruler is sized. */
  private updateRulerReadout(): void {
    const ruler = this.selectedRuler();
    if (!ruler) return;
    for (const btn of this.rulerScaleBtns) {
      btn.classList.toggle('is-active', (btn.dataset.rulerHalf === '1') === ruler.half);
    }
    const length = this.rulerDrawnLength(ruler);
    const field = measurementField(ruler.measurementId);
    const parts = [formatLength(length, this.unit, 1)];
    if (ruler.half) parts.push('half width');
    if (!field) parts.push('free');
    this.rulerReadout.textContent = parts.join(' · ');
  }

  // ── Blocks ───────────────────────────────────────────────────────────────
  //
  // A block instance is a parametric component: it owns a set of generated
  // pieces and rebuilds them whenever one of its variables changes. Its pieces
  // are ordinary `PatternPiece`s, so nothing downstream needs to know blocks
  // exist — the only special case is that their points are read-only until you
  // Detach, because regeneration would otherwise silently discard your edits.

  private blocks(): BlockInstance[] {
    return this.pattern.blocks ?? [];
  }

  private blockDefinition(instance: BlockInstance): BlockDefinition | null {
    return getBlockDefinition(instance.definitionId);
  }

  /** The block that owns a piece, if any. */
  private blockForPiece(pieceId: string | undefined): BlockInstance | null {
    if (!pieceId) return null;
    return (
      this.blocks().find((instance) => instance.pieces.some((e) => e.pieceId === pieceId)) ?? null
    );
  }

  /**
   * A faint dotted box around every piece a block drafts.
   *
   * A component that produces several panels — back, front, waistband — is one
   * object on the canvas, and without a container you cannot tell at a glance
   * whether the panels sitting next to each other are parts of one block or
   * separate pieces you drew. A single-piece block gets no box: a rectangle
   * around one outline is just a second outline.
   */
  private drawBlockOutline(instance: BlockInstance): void {
    if (instance.pieces.length < 2) return;
    const owned = new Set(instance.pieces.map((entry) => entry.pieceId));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const piece of this.pattern.pieces) {
      if (!owned.has(piece.id)) continue;
      for (const pt of piece.points) {
        minX = Math.min(minX, pt.anchor.x);
        minY = Math.min(minY, pt.anchor.y);
        maxX = Math.max(maxX, pt.anchor.x);
        maxY = Math.max(maxY, pt.anchor.y);
      }
    }
    if (!Number.isFinite(minX)) return;

    // Stand the box off in pattern units so it hugs the draft at any zoom
    // instead of touching a seam allowance.
    const pad = 1.5;
    const rect = svgEl('rect');
    rect.setAttribute('x', String(minX - pad));
    rect.setAttribute('y', String(minY - pad));
    rect.setAttribute('width', String(maxX - minX + pad * 2));
    rect.setAttribute('height', String(maxY - minY + pad * 2));
    rect.setAttribute('class', `pattern-block-outline${instance.id === this.selectedBlockId ? ' is-selected' : ''}`);
    rect.setAttribute('rx', String(this.px(8)));
    rect.setAttribute('stroke-width', String(this.px(1.4)));
    rect.setAttribute('stroke-dasharray', `${this.px(3)} ${this.px(6)}`);
    this.svg.appendChild(rect);
  }

  private selectedBlock(): BlockInstance | null {
    if (!this.selectedBlockId) return null;
    return this.blocks().find((instance) => instance.id === this.selectedBlockId) ?? null;
  }

  private setSelectedBlock(id: string | null): void {
    if (id) {
      this.setRulerSelection(null);
      // Cleared inline rather than through clearSelection(), which would call
      // back into releaseBlockSelection() and unset the id being set here.
      this.selectedIds.clear();
      this.selectedPointId = null;
    }
    if (this.selectedBlockId === id) return;
    this.selectedBlockId = id;
    this.syncBlockBar();
  }

  // — Placement —

  private bindBlockMenu(): void {
    this.blockBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideToolbarTip();
      if (this.blockMenu.hidden) this.showBlockMenu();
      else this.hideBlockMenu();
    });
  }

  private showBlockMenu(): void {
    this.renderBlockMenu();
    this.blockMenu.hidden = false;
    this.blockBtn.setAttribute('aria-expanded', 'true');
    if (!this.blockMenuDocPointerDown) {
      this.blockMenuDocPointerDown = (e: PointerEvent) => {
        const t = e.target as Node;
        if (this.blockMenu.contains(t) || this.blockBtn.contains(t)) return;
        this.hideBlockMenu();
      };
      document.addEventListener('pointerdown', this.blockMenuDocPointerDown, true);
    }
  }

  private hideBlockMenu(): void {
    this.blockMenu.hidden = true;
    this.blockBtn.setAttribute('aria-expanded', 'false');
    if (this.blockMenuDocPointerDown) {
      document.removeEventListener('pointerdown', this.blockMenuDocPointerDown, true);
      this.blockMenuDocPointerDown = null;
    }
  }

  private renderBlockMenu(): void {
    const menu = this.blockMenu;
    menu.innerHTML = '';
    if (BLOCK_DEFINITIONS.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pattern-block-menu-empty';
      empty.textContent = 'No blocks in the library yet.';
      menu.appendChild(empty);
      return;
    }
    const sets = this.cbs.getMeasurementLibrary?.()?.sets ?? [];
    const person = this.activeSet();
    void sets;
    const hint = document.createElement('div');
    hint.className = 'pattern-block-menu-hint';
    hint.textContent = person
      ? `Will be drafted for ${person.name}.`
      : 'No measurements yet — blocks start from the book’s default figures.';
    menu.appendChild(hint);

    for (const definition of BLOCK_DEFINITIONS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.role = 'menuitem';
      item.dataset.blockId = definition.id;
      const name = document.createElement('span');
      name.className = 'pattern-block-menu-name';
      name.textContent = definition.name;
      const desc = document.createElement('span');
      desc.className = 'pattern-block-menu-desc';
      desc.textContent = definition.description;
      item.append(name, desc);
      item.addEventListener('click', () => {
        this.hideBlockMenu();
        this.addBlock(definition.id);
      });
      menu.appendChild(item);
    }
  }

  /** Drop a fresh block instance into this pattern. */
  addBlock(definitionId: string): boolean {
    const definition = getBlockDefinition(definitionId);
    if (!definition) return false;
    const set = this.activeSet();
    const fallback = {
      x: this.viewBox.x + this.viewBox.w * 0.25,
      y: this.viewBox.y + this.viewBox.h * 0.25,
    };
    const origin = nextBlockOrigin(this.pattern.pieces, fallback);
    const instance = createBlockInstance(
      definition,
      origin,
      set?.id ?? null,
      set?.name ?? '',
      set
    );
    this.markBeforeChange();
    if (!this.pattern.blocks) this.pattern.blocks = [];
    this.pattern.blocks.push(instance);
    const generated = generateBlockPieces(definition, instance, set);
    const { pieces, ownership } = spliceBlockPieces(this.pattern.pieces, instance, generated);
    this.pattern.pieces = pieces;
    instance.pieces = ownership;
    this.selectedBlockId = instance.id;
    // Inside the same edit as the pieces, so one undo takes the block and its
    // seams away together.
    this.sewBlock(instance);
    this.cbs.onChange();
    this.endHistoryGesture();
    this.syncBlockBar();
    this.fitView();
    this.redraw();
    return true;
  }

  /**
   * Add the seams a block wants, and drop the ones it claims but can no longer
   * make. Returns whether anything changed.
   *
   * Run when the block is placed, and from the ribbon for blocks that were
   * placed before it existed. Only seams with both pieces in the document can be
   * made, which is how a bodice front and back each declare the seam between
   * them: the one placed first has nothing to sew to yet and quietly does
   * nothing, and the one placed second makes the lot.
   */
  private sewBlock(instance: BlockInstance): boolean {
    const definition = this.blockDefinition(instance);
    if (!definition?.seams) return false;
    let changed = false;

    // Drop the block's own dead seams first. A reference that no longer resolves
    // on its own piece cannot be sewn and is drawn as a warning, so letting one
    // sit there only makes the next pass add a second copy of the same seam.
    const owned = new Set(instance.pieces.map((entry) => entry.pieceId));
    const kept = this.pattern.seams.filter((seam) => {
      const dead =
        !isSeamEdgeValid(this.pattern.pieces, seam.a) ||
        !isSeamEdgeValid(this.pattern.pieces, seam.b);
      if (dead && (owned.has(seam.a.pieceId) || owned.has(seam.b.pieceId))) {
        changed = true;
        return false;
      }
      return true;
    });
    if (changed) this.pattern.seams = kept;

    const wanted = generateBlockSeams(
      definition,
      instance,
      this.measurementSet(instance.personId),
      // First block of that definition wins; two bodices on one canvas are not
      // told apart.
      (definitionId) => {
        const partner = this.blocks().find((b) => b.definitionId === definitionId);
        const partnerDefinition = partner ? this.blockDefinition(partner) : null;
        return partner && partnerDefinition
          ? { instance: partner, definition: partnerDefinition }
          : null;
      }
    );
    const present = new Set(this.pattern.pieces.map((piece) => piece.id));
    const additions = wanted.filter(
      ({ a, b }) =>
        present.has(a.pieceId) &&
        present.has(b.pieceId) &&
        !this.pattern.seams.some((seam) => sameSeamBindingPair(seam.a, seam.b, a, b))
    );
    if (additions.length > 0) {
      this.pattern.seams.push(
        ...additions.map(({ a, b }) => ({
          id: uid('seam'),
          a,
          b,
          restGapCm: DEFAULT_SEAM_GAP_CM,
        }))
      );
      changed = true;
    }
    return changed;
  }

  /** The ribbon's Sew button: sew up a block placed before this existed. */
  private sewSelectedBlock(): void {
    const instance = this.selectedBlock();
    if (!instance) return;
    this.markBeforeChange();
    const changed = this.sewBlock(instance);
    if (!changed) {
      this.endHistoryGesture();
      return;
    }
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  /**
   * Light up the geometry the hovered variable controls.
   *
   * Drawn over the pieces, as a wide translucent stroke with rings on the
   * points, so it reads as a lamp held against the outline rather than as yet
   * another outline competing with the lavender block tint.
   */
  private drawBlockHighlight(): void {
    const driven = this.hoverDriven;
    if (!driven || driven.size === 0) return;
    for (const piece of this.pattern.pieces) {
      const n = piece.points.length;
      if (n < 2) continue;
      // An edge counts as driven when *either* end moves: change the hip depth
      // and the centre line from the waist down is exactly what you moved.
      const hit = piece.points.map((pt) => driven.has(pt.id));
      if (!hit.some(Boolean)) continue;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (!hit[i] && !hit[j]) continue;
        const a = piece.points[i]!;
        const b = piece.points[j]!;
        const { c0, c1 } = edgeHandles(a, b);
        const path = svgEl('path');
        path.setAttribute('class', 'pattern-block-driver');
        path.setAttribute(
          'd',
          `M ${a.anchor.x} ${a.anchor.y} C ${c0.x} ${c0.y}, ${c1.x} ${c1.y}, ${b.anchor.x} ${b.anchor.y}`
        );
        path.setAttribute('stroke-width', String(this.px(9)));
        this.svg.appendChild(path);
      }
      // Rings last, so no neighbouring edge can cover one.
      for (const pt of piece.points) {
        if (!driven.has(pt.id)) continue;
        const ring = svgEl('circle');
        ring.setAttribute('cx', String(pt.anchor.x));
        ring.setAttribute('cy', String(pt.anchor.y));
        ring.setAttribute('r', String(this.px(7)));
        ring.setAttribute('class', 'pattern-block-driver-point');
        ring.setAttribute('stroke-width', String(this.px(2)));
        this.svg.appendChild(ring);
      }
    }
  }

  /**
   * Fold an inspector section shut, or open again.
   *
   * Done by toggling a class rather than rebuilding the rows: a rebuild would
   * throw away any half-typed number in the section, and there is nothing to
   * recompute — the rows are all still there, just not painted.
   */
  private toggleBlockGroup(name: string, group: HTMLElement): void {
    const collapsed = !this.collapsedBlockGroups.has(name);
    if (collapsed) this.collapsedBlockGroups.add(name);
    else this.collapsedBlockGroups.delete(name);
    group.classList.toggle('is-collapsed', collapsed);
    group
      .querySelector<HTMLButtonElement>('[data-block-group-toggle]')
      ?.setAttribute('aria-expanded', String(!collapsed));
    // A row that is no longer on screen must not leave its outline lit on the
    // canvas — the pointer is still over the header, but nothing is hovered.
    if (collapsed && this.hoverVarId) {
      const row = group.querySelector<HTMLElement>(`[data-var-id="${this.hoverVarId}"]`);
      if (row) this.setHoveredVar(null);
    }
  }

  /** Hovered variable → the points it moves. Cheap enough to redo per row. */
  private setHoveredVar(varId: string | null): void {
    if (this.hoverVarId === varId) return;
    this.hoverVarId = varId;
    this.hoverDriven = null;
    if (varId) {
      const instance = this.selectedBlock();
      const definition = instance ? this.blockDefinition(instance) : null;
      if (instance && definition) {
        this.hoverDriven = drivenPointIds(
          definition,
          instance,
          this.measurementSet(instance.personId),
          varId
        );
      }
    }
    this.redraw();
  }

  /**
   * Rebuild a block's pieces from its current variables, in place.
   *
   * `structural` marks the edits that change the *shape of a row* — switching
   * Value/Measure, a divisor, a different measurement, a different person. Those
   * rebuild the inspector, which throws away the live input and closes the undo
   * gesture immediately. Typing is not structural: the rows are left alone so
   * the caret survives, and the gesture stays open so a whole typed entry
   * collapses into one undo step.
   */
  private commitBlockChange(instance: BlockInstance, structural = true): void {
    const definition = this.blockDefinition(instance);
    if (!definition) return;
    const generated = generateBlockPieces(
      definition,
      instance,
      this.measurementSet(instance.personId)
    );
    const { pieces, ownership } = spliceBlockPieces(this.pattern.pieces, instance, generated);
    this.pattern.pieces = pieces;
    instance.pieces = ownership;
    this.cbs.onChange();
    if (structural) {
      this.endHistoryGesture();
      this.syncBlockVars();
    }
    this.redraw();
  }

  // — Variable editing —

  private bindingFor(instance: BlockInstance, varId: string): BlockVariableBinding | undefined {
    return instance.bindings[varId];
  }

  private setBlockVariableValue(varId: string, cm: number, structural = true): void {
    const instance = this.selectedBlock();
    const variable = this.blockVariable(instance, varId);
    if (!instance || !variable) return;
    // A typo should not be able to throw the draft off the table.
    const clamped = clampToDeclared(variable, cm);
    const existing = instance.bindings[varId];
    if (existing?.mode === 'value' && existing.cm === clamped) return;
    this.markBeforeChange();
    instance.bindings[varId] = { mode: 'value', cm: clamped };
    this.commitBlockChange(instance, structural);
  }

  private setBlockVariableMode(varId: string, mode: 'value' | 'measurement'): void {
    const instance = this.selectedBlock();
    const definition = instance ? this.blockDefinition(instance) : null;
    if (!instance || !definition) return;
    const variable = definition.variables.find((v) => v.id === varId);
    if (!variable) return;
    const current = this.bindingFor(instance, varId);
    if (current?.mode === mode) return;
    const set = this.measurementSet(instance.personId);
    this.markBeforeChange();
    if (mode === 'value') {
      instance.bindings[varId] = {
        mode: 'value',
        cm: current ? bindingValueCm(current, set) : variable.defaultValueCm,
      };
    } else {
      // Start from the declaration's suggestion, else the first measurement this
      // person actually has, so the row is immediately meaningful.
      const suggested = variable.suggested ?? {
        fieldId: this.firstMeasuredField(set) ?? 'waist',
        divisor: 1 as const,
        offsetCm: 0,
      };
      const live = sourceValueCm(suggested, set);
      instance.bindings[varId] = {
        mode: 'measurement',
        ...suggested,
        fallbackCm: live ?? (current ? bindingValueCm(current, set) : variable.defaultValueCm),
      };
    }
    this.commitBlockChange(instance);
  }

  private firstMeasuredField(set: MeasurementSet | null): string | null {
    if (!set) return null;
    return MEASUREMENT_FIELDS.find((f) => measurementValueCm(set, f.id) != null)?.id ?? null;
  }

  private setBlockVariableDivisor(varId: string, divisor: BlockDivisor): void {
    const instance = this.selectedBlock();
    const binding = instance ? this.bindingFor(instance, varId) : null;
    if (!instance || binding?.mode !== 'measurement' || binding.divisor === divisor) return;
    this.markBeforeChange();
    binding.divisor = divisor;
    const live = sourceValueCm(binding, this.measurementSet(instance.personId));
    if (live != null) binding.fallbackCm = live;
    this.commitBlockChange(instance);
  }

  private setBlockVariableOffset(varId: string, offsetCm: number, structural = true): void {
    const instance = this.selectedBlock();
    const binding = instance ? this.bindingFor(instance, varId) : null;
    if (!instance || binding?.mode !== 'measurement' || binding.offsetCm === offsetCm) return;
    this.markBeforeChange();
    binding.offsetCm = offsetCm;
    const live = sourceValueCm(binding, this.measurementSet(instance.personId));
    if (live != null) binding.fallbackCm = live;
    this.commitBlockChange(instance, structural);
  }

  private setBlockVariableField(varId: string, fieldId: string): void {
    const instance = this.selectedBlock();
    const binding = instance ? this.bindingFor(instance, varId) : null;
    if (!instance || binding?.mode !== 'measurement') return;
    this.markBeforeChange();
    binding.fieldId = fieldId;
    const live = sourceValueCm(binding, this.measurementSet(instance.personId));
    if (live != null) binding.fallbackCm = live;
    this.commitBlockChange(instance);
  }

  private onBlockPersonChange(setId: string): void {
    const instance = this.selectedBlock();
    if (!instance) return;
    const set = this.measurementSet(setId);
    this.markBeforeChange();
    instance.personId = set?.id ?? null;
    instance.personName = set?.name ?? '';
    // Refresh every snapshot against the new person, so the block still draws
    // correctly if that person is later removed.
    for (const variable of this.blockDefinition(instance)?.variables ?? []) {
      const binding = instance.bindings[variable.id];
      if (binding?.mode !== 'measurement') continue;
      const live = sourceValueCm(binding, set);
      if (live != null) binding.fallbackCm = live;
    }
    this.cbs.onChange();
    this.endHistoryGesture();
    this.syncBlockBar();
    this.redraw();
  }

  private detachSelectedBlock(): void {
    const instance = this.selectedBlock();
    if (!instance) return;
    this.markBeforeChange();
    // The pieces stay exactly as they are — they just stop being generated.
    this.pattern.blocks = this.blocks().filter((b) => b.id !== instance.id);
    this.selectedBlockId = null;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.syncBlockBar();
    this.redraw();
  }

  private deleteSelectedBlock(): void {
    const instance = this.selectedBlock();
    if (!instance) return;
    this.markBeforeChange();
    const owned = new Set(instance.pieces.map((e) => e.pieceId));
    this.pattern.pieces = this.pattern.pieces.filter((piece) => !owned.has(piece.id));
    this.pattern.blocks = this.blocks().filter((b) => b.id !== instance.id);
    this.selectedBlockId = null;
    this.cbs.onChange();
    this.endHistoryGesture();
    this.syncBlockBar();
    this.redraw();
  }

  // — The inspector ribbon —

  private blockDisplay(cm: number): number {
    return Number(cmToDisplay(cm, this.unit).toFixed(3));
  }

  private blockCm(display: number): number {
    return displayToCm(display, this.unit);
  }

  /** Nudge size for a length field, in display units. Alt+wheel reads this too. */
  private blockStep(): number {
    return this.unit === 'in' ? 0.25 : 0.5;
  }

  private blockVariable(
    instance: BlockInstance | null,
    varId: string
  ): BlockVariableDecl | null {
    const definition = instance ? this.blockDefinition(instance) : null;
    return definition?.variables.find((v) => v.id === varId) ?? null;
  }

  /**
   * Read a numeric inspector field back into canonical units.
   *
   * The box holds *display* units, so an inches project would otherwise write
   * "30" straight in as 30 cm. Counts (dart counts) and factors (how square a
   * curve turns) are dimensionless and must never be converted — a factor of
   * 0.55 is 0.55 in either system.
   */
  private blockFieldCm(varId: string, input: HTMLInputElement): number | null {
    const variable = this.blockVariable(this.selectedBlock(), varId);
    if (!variable) return null;
    const raw = Number.parseFloat(input.value);
    if (!Number.isFinite(raw)) return null;
    if (variable.kind === 'count') return Math.round(raw);
    if (variable.kind === 'factor') return raw;
    return this.blockCm(raw);
  }

  /** Restore a field's text to the value the block is actually using. */
  private syncBlockField(varId: string, input: HTMLInputElement): void {
    const instance = this.selectedBlock();
    const variable = this.blockVariable(instance, varId);
    const binding = instance?.bindings[varId];
    if (!instance || !variable || !binding) return;
    const cm = clampToDeclared(
      variable,
      bindingValueCm(binding, this.measurementSet(instance.personId))
    );
    input.value = this.blockFieldText(variable, cm);
  }

  /** How one variable's number reads inside its input box. */
  private blockFieldText(variable: BlockVariableDecl, cm: number): string {
    if (variable.kind === 'count') return String(Math.round(cm));
    if (variable.kind === 'factor') return String(Number(cm.toFixed(2)));
    return String(this.blockDisplay(cm));
  }

  /** Nudge size for a factor, in its own 0–1 domain. */
  private blockFactorStep(): number {
    return 0.05;
  }

  private blockFieldLabel(fieldId: string): string {
    return MEASUREMENT_FIELDS.find((f) => f.id === fieldId)?.label ?? fieldId;
  }

  /** Full rebuild — visibility, person select and every variable row. */
  private syncBlockBar(): void {
    const instance = this.selectedBlock();
    const definition = instance ? this.blockDefinition(instance) : null;
    if (!instance || !definition) {
      this.blockBar.hidden = true;
      return;
    }
    this.blockBar.hidden = false;
    const nameEl = this.blockBar.querySelector('[data-block-name]') as HTMLElement;
    nameEl.textContent = definition.name;

    const sets = this.cbs.getMeasurementLibrary?.()?.sets ?? [];
    this.fillOptions(
      this.blockPersonSelect,
      sets.length > 0
        ? sets.map((s) => ({ value: s.id, label: s.name }))
        : [{ value: '', label: 'No people yet' }],
      instance.personId ?? sets[0]?.id ?? ''
    );

    this.blockSourceNote.textContent = definition.source ?? '';
    this.syncBlockVars();
  }

  /** Rebuild the variable rows. Cheap enough to redo on a mode change. */
  private syncBlockVars(): void {
    const instance = this.selectedBlock();
    const definition = instance ? this.blockDefinition(instance) : null;
    const host = this.blockVarsHost;
    host.innerHTML = '';
    // The rows that were hovered are gone, so the highlight has to go too.
    this.hoverVarId = null;
    this.hoverDriven = null;
    if (!instance || !definition) return;

    const set = this.measurementSet(instance.personId);
    let currentGroup = '';
    let groupBody: HTMLElement | null = null;
    for (const variable of definition.variables) {
      if (variable.group !== currentGroup) {
        currentGroup = variable.group;
        const collapsed = this.collapsedBlockGroups.has(currentGroup);
        const group = document.createElement('div');
        group.className = 'pattern-block-group';
        group.dataset.blockGroup = currentGroup;
        group.classList.toggle('is-collapsed', collapsed);

        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'pattern-block-group-head';
        head.dataset.blockGroupToggle = '';
        // A real disclosure button, so it is reachable by keyboard and reads
        // correctly to a screen reader rather than being a div that happens to
        // have a click handler on it.
        head.setAttribute('aria-expanded', String(!collapsed));
        const caret = document.createElement('span');
        caret.className = 'pattern-block-group-caret';
        caret.setAttribute('aria-hidden', 'true');
        const title = document.createElement('span');
        title.className = 'pattern-block-group-title';
        title.textContent = currentGroup;
        head.append(caret, title);

        groupBody = document.createElement('div');
        groupBody.className = 'pattern-block-group-body';
        group.append(head, groupBody);
        host.appendChild(group);
      }

      const binding = instance.bindings[variable.id];
      const isMeasurement = binding?.mode === 'measurement';
      const row = document.createElement('div');
      row.className = 'pattern-block-var';
      row.dataset.varId = variable.id;
      row.title = variable.note ?? '';

      const top = document.createElement('div');
      top.className = 'pattern-block-var-top';
      const label = document.createElement('span');
      label.className = 'pattern-block-var-label';
      label.textContent = variable.label;
      const readout = document.createElement('span');
      readout.className = 'pattern-block-var-readout';
      readout.dataset.blockReadout = variable.id;
      top.append(label, readout);
      row.appendChild(top);

      const controls = document.createElement('div');
      controls.className = 'pattern-block-var-controls';

      const mode = document.createElement('div');
      mode.className = 'pattern-block-mode';
      mode.setAttribute('role', 'group');
      for (const [id, text] of [
        ['value', 'Value'],
        ['measurement', 'Measure'],
      ] as const) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.blockMode = id;
        btn.textContent = text;
        btn.classList.toggle('is-active', (id === 'measurement') === isMeasurement);
        mode.appendChild(btn);
      }
      controls.appendChild(mode);

      if (!isMeasurement) {
        // Only lengths convert. A dart count and a curve factor are the same
        // number in any unit — converting a count through inches is how you end
        // up with a maximum of 1.181.
        const kind = variable.kind ?? 'length';
        const current = clampToDeclared(
          variable,
          bindingValueCm(
            binding ?? { mode: 'value', cm: variable.defaultValueCm },
            set
          )
        );
        const input = document.createElement('input');
        // Deliberately *not* type="number": Chromium gives it a spinbutton role
        // that cannot be selected or caret-edited (Ctrl+A is ignored entirely),
        // so retyping a value appends into the middle of the old one. A text
        // field with a numeric keyboard hint behaves, and the parse and clamp
        // are ours anyway.
        input.type = 'text';
        input.inputMode = kind === 'length' ? 'decimal' : 'numeric';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.className = 'pattern-block-input';
        input.dataset.blockValue = '';
        input.dataset.numberInput = '';
        input.step = String(
          kind === 'count' ? 1 : kind === 'factor' ? this.blockFactorStep() : this.blockStep()
        );
        input.min = String(kind === 'length' ? this.blockDisplay(variable.minCm) : variable.minCm);
        input.max = String(kind === 'length' ? this.blockDisplay(variable.maxCm) : variable.maxCm);
        input.value = this.blockFieldText(variable, current);
        input.setAttribute('aria-label', variable.label);
        controls.appendChild(input);
      } else {
        const select = document.createElement('select');
        select.className = 'pattern-block-select';
        select.dataset.blockField = '';
        select.setAttribute('aria-label', `${variable.label} measurement`);
        const entries = MEASUREMENT_FIELDS.map((field) => {
          const live = measurementValueCm(set, field.id);
          return {
            value: field.id,
            label:
              live == null
                ? `${field.label} · not measured`
                : `${field.label} · ${formatLength(live, this.unit, 1)}`,
          };
        });
        this.fillOptions(select, entries, binding.fieldId);
        controls.appendChild(select);

        const divisor = document.createElement('div');
        divisor.className = 'pattern-block-div';
        divisor.setAttribute('role', 'group');
        for (const [value, text] of [
          [0.5, '×2'],
          [1, '×1'],
          [2, '½'],
          [4, '¼'],
        ] as const) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.dataset.blockDiv = String(value);
          btn.textContent = text;
          btn.classList.toggle('is-active', binding.divisor === value);
          divisor.appendChild(btn);
        }
        controls.appendChild(divisor);

        const ease = document.createElement('label');
        ease.className = 'pattern-block-ease';
        ease.title = `Ease added after dividing, in ${this.unit === 'in' ? 'inches' : 'cm'}`;
        const sign = document.createElement('span');
        sign.textContent = '+';
        const offset = document.createElement('input');
        offset.type = 'text';
        offset.inputMode = 'decimal';
        offset.autocomplete = 'off';
        offset.spellcheck = false;
        offset.dataset.blockOffset = '';
        offset.dataset.numberInput = '';
        offset.step = String(this.blockStep());
        offset.value = String(this.blockDisplay(binding.offsetCm));
        offset.setAttribute('aria-label', `${variable.label} ease`);
        ease.append(sign, offset);
        controls.appendChild(ease);
      }

      row.appendChild(controls);
      groupBody!.appendChild(row);
    }
    this.updateBlockReadouts();
  }

  /** Cheap refresh — only the numbers change while typing. */
  private updateBlockReadouts(): void {
    const instance = this.selectedBlock();
    const definition = instance ? this.blockDefinition(instance) : null;
    if (!instance || !definition) return;
    const set = this.measurementSet(instance.personId);
    const values = resolveBlockValues(definition, instance, set);
    for (const variable of definition.variables) {
      const el = this.blockVarsHost.querySelector(
        `[data-block-readout="${variable.id}"]`
      ) as HTMLElement | null;
      if (!el) continue;
      const binding = instance.bindings[variable.id];
      const value = values[variable.id] ?? 0;
      if (variable.kind === 'count') {
        el.textContent = String(Math.round(value));
      } else if (variable.kind === 'factor') {
        // A shaping control reads as a percentage — "55%" says more about a
        // neckline than "0.55".
        el.textContent = `${Math.round(value * 100)}%`;
      } else {
        el.textContent = formatLength(value, this.unit, 1);
      }
      el.classList.toggle(
        'is-unmeasured',
        binding?.mode === 'measurement' && sourceValueCm(binding, set) == null
      );
    }
  }

  /** Clicking a generated piece selects its block rather than its points. */
  private onBlockPointerDown(
    e: PointerEvent,
    p: Vec2,
    instance: BlockInstance,
    pieceId: string | undefined
  ): void {
    this.setSelectedBlock(instance.id);
    // Pick the outline as well, so the piece reads as selected the way a
    // hand-drawn one does rather than only lighting up a panel on the far side
    // of the canvas. Its geometry is regenerated, so the selection is an
    // indicator here and carries no scale grips — see drawSelectionChrome.
    const piece = this.pattern.pieces.find((entry) => entry.id === pieceId);
    if (piece) this.selectEntirePiece(piece);
    this.drag = {
      type: 'blockMove',
      id: instance.id,
      start: p,
      origin: { ...instance.origin },
    };
    this.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.redraw();
  }

  /**
   * A small run of text that keeps its own upright orientation while its
   * position follows the (possibly upside-down) ruler.
   */
  private rulerText(text: string, x: number, y: number, cls: string, flip: boolean): SVGGElement {    const g = svgEl('g');
    g.setAttribute('transform', `translate(${x} ${y})${flip ? ' rotate(180)' : ''}`);
    const t = svgEl('text');
    t.setAttribute('class', cls);
    t.setAttribute('font-size', String(this.px(9)));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'middle');
    // Halo so the text stays legible over the grid and piece fills.
    t.setAttribute('stroke-width', String(this.px(3)));
    t.setAttribute('paint-order', 'stroke');
    t.textContent = text;
    g.appendChild(t);
    return g;
  }

  /**
   * Ruler scale marks. Returns the label / handle groups, which the caller
   * appends *after* the pattern so the readings stay legible on top of a piece
   * while the scale itself stays behind it.
   */
  private drawRulers(): SVGGElement[] {
    const list = this.rulers();
    const draft = this.drag?.type === 'rulerCreate' ? this.drag : null;
    const overlay: SVGGElement[] = [];
    if (list.length === 0) {
      if (draft) this.drawRulerDraft(draft);
      return overlay;
    }

    const grad = rulerGraduations(this.unit, this.viewScale());
    const majorEvery = Math.max(1, Math.round(grad.majorCm / grad.minorCm));
    // Whole numbers once the labelled step reaches a whole unit (1 cm / 1 in).
    const majorDisplay = this.unit === 'in' ? grad.majorCm / 2.54 : grad.majorCm;
    const tickDigits = majorDisplay >= 1 ? 0 : 1;

    for (const ruler of list) {
      const length = this.rulerDrawnLength(ruler);
      if (!(length > 0.05)) continue;
      const selected = this.selectedRulerId === ruler.id;
      const hovered = this.hoverRulerId === ruler.id;
      const flip = rulerTextFlipped(ruler.angle);
      const { a } = rulerEndpoints(ruler, length);

      const group = svgEl('g');
      group.setAttribute(
        'class',
        `pattern-ruler${selected ? ' is-selected' : ''}${hovered ? ' is-hovered' : ''}`
      );
      group.setAttribute('transform', `translate(${a.x} ${a.y}) rotate(${ruler.angle})`);
      // Hit-testing is analytic, so the artwork must never swallow pointer events.
      group.setAttribute('pointer-events', 'none');

      group.appendChild(svgLine(0, 0, length, 0, 'pattern-ruler-line', this.px(selected ? 2.2 : 1.6)));

      const cap = this.px(9);
      group.appendChild(svgLine(0, -cap / 2, 0, cap / 2, 'pattern-ruler-cap', this.px(1.4)));
      group.appendChild(svgLine(length, -cap / 2, length, cap / 2, 'pattern-ruler-cap', this.px(1.4)));

      // Graduations hang below the axis so the label above stays clear.
      const tickSw = this.px(selected ? 1.1 : 0.9);
      const ticks = Math.floor(length / grad.minorCm + 1e-6);
      for (let i = 0; i <= ticks; i++) {
        const v = i * grad.minorCm;
        const isMajor = i % majorEvery === 0;
        const h = isMajor ? this.px(7) : this.px(3.4);
        group.appendChild(
          svgLine(v, 0, v, h, isMajor ? 'pattern-ruler-tick-major' : 'pattern-ruler-tick', tickSw)
        );
        if (isMajor && selected) {
          // Only the selected ruler is worth numbering — otherwise it's noise.
          group.appendChild(
            this.rulerText(
              formatLength(v, this.unit, tickDigits),
              v,
              h + this.px(9),
              'pattern-ruler-number',
              flip
            )
          );
        }
      }
      this.svg.appendChild(group);

      // Readings and grab handles ride above the pattern.
      const top = svgEl('g');
      top.setAttribute(
        'class',
        `pattern-ruler-top${selected ? ' is-selected' : ''}${hovered ? ' is-hovered' : ''}`
      );
      top.setAttribute('transform', `translate(${a.x} ${a.y}) rotate(${ruler.angle})`);
      top.setAttribute('pointer-events', 'none');

      const label = rulerLabel(
        ruler,
        this.unit,
        length,
        this.measurementSet(ruler.personId)?.name ?? ruler.personName
      );
      const midX = length / 2;
      top.appendChild(this.rulerText(label.primary, midX, -this.px(21), 'pattern-ruler-name', flip));
      top.appendChild(
        this.rulerText(label.secondary, midX, -this.px(10), 'pattern-ruler-value', flip)
      );

      if (selected) {
        for (const x of [0, length]) {
          const handle = svgEl('circle');
          handle.setAttribute('cx', String(x));
          handle.setAttribute('cy', '0');
          handle.setAttribute('r', String(this.px(4)));
          handle.setAttribute('class', 'pattern-ruler-handle');
          handle.setAttribute('stroke-width', String(this.px(1.4)));
          top.appendChild(handle);
        }
      }
      overlay.push(top);
    }

    if (draft) this.drawRulerDraft(draft);
    return overlay;
  }

  private drawRulerDraft(drag: Extract<DragKind, { type: 'rulerCreate' }>): void {
    const dx = drag.current.x - drag.start.x;
    const dy = drag.current.y - drag.start.y;
    const length = Math.hypot(dx, dy);
    if (!(length > 0.2)) return;
    const deg = rulerAngle(drag.start, drag.current, drag.snap);
    const th = (deg * Math.PI) / 180;
    const end = { x: drag.start.x + Math.cos(th) * length, y: drag.start.y + Math.sin(th) * length };
    const line = svgLine(
      drag.start.x,
      drag.start.y,
      end.x,
      end.y,
      'pattern-ruler-draft',
      this.px(1.6)
    );
    line.setAttribute('stroke-dasharray', `${this.px(6)} ${this.px(4)}`);
    line.setAttribute('pointer-events', 'none');
    this.svg.appendChild(line);

    const mid = { x: (drag.start.x + end.x) / 2, y: (drag.start.y + end.y) / 2 };
    const text = this.rulerText(
      formatLength(length, this.unit, 1),
      mid.x,
      mid.y - this.px(12),
      'pattern-ruler-value',
      false
    );
    text.setAttribute('pointer-events', 'none');
    this.svg.appendChild(text);
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
    this.deletePieces([id]);
  }

  /**
   * Remove whole pieces, and everything that refers to them.
   *
   * A block's pieces are not separately deletable. They are regenerated from the
   * block's variables, so a piece removed on its own comes straight back — with
   * the block's other pieces renumbered around it — on the next load. Any piece
   * of a block therefore takes the whole block, which is the same unit the
   * block's own Delete button works in. Detach is the button that exists for
   * breaking one up.
   */
  private deletePieces(pieceIds: readonly string[]): void {
    if (pieceIds.length === 0) return;
    const doomed = new Set(pieceIds);
    const doomedBlocks = new Set<string>();
    for (const instance of this.blocks()) {
      if (instance.pieces.some((entry) => doomed.has(entry.pieceId))) {
        doomedBlocks.add(instance.id);
        for (const entry of instance.pieces) doomed.add(entry.pieceId);
      }
    }

    this.markBeforeChange();
    this.pattern.pieces = this.pattern.pieces.filter((p) => !doomed.has(p.id));
    this.pattern.seams = this.pattern.seams.filter(
      (s) => !doomed.has(s.a.pieceId) && !doomed.has(s.b.pieceId)
    );
    if (doomedBlocks.size > 0) {
      this.pattern.blocks = this.blocks().filter((b) => !doomedBlocks.has(b.id));
      if (this.selectedBlockId && doomedBlocks.has(this.selectedBlockId)) {
        this.selectedBlockId = null;
      }
    }
    this.clearSelection();
    this.selectedPieceId = this.pattern.pieces[0]?.id ?? null;
    this.contextPieceId = null;
    this.cbs.onChange();
    this.endHistoryGesture();
    if (doomedBlocks.size > 0) this.syncBlockBar();
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
      this.deletePieces([piece.id]);
      return;
    }

    piece.points = remaining;
    this.clearSelection();
    this.cbs.onChange();
    this.endHistoryGesture();
    this.redraw();
  }

  private handleDeleteKey(): void {
    // A selected ruler is the only thing "in hand" — delete that first.
    if (this.selectedRulerId && this.selectedIds.size === 0) {
      this.deleteSelectedRuler();
      return;
    }

    // Whole pieces, and there may be several: a marquee dragged across the
    // layout selects every point of everything it covers, and that is how you
    // say "these panels" rather than "these handles".
    const whole = this.pattern.pieces.filter((piece) => this.isEntirePieceSelected(piece));
    if (whole.length > 0) {
      this.deletePieces(whole.map((piece) => piece.id));
      return;
    }

    // Anything less than a whole piece is a point edit on the piece in hand.
    if (this.selectedIds.size === 0) return;
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

    // The ruler tool owns every gesture: empty canvas starts a new ruler, and a
    // ruler under the cursor can be picked up, slid or turned.
    if (this.tool === 'ruler') {
      this.onRulerDown(e, p);
      return;
    }

    // The move tool can pick a ruler up off the canvas too — but only when the
    // click is not landing on a pattern point or handle, which take precedence.
    if (this.tool === 'move' && !kind) {
      const rulerHit = this.findRulerHit(p);
      if (rulerHit) {
        this.onRulerDown(e, p, rulerHit);
        return;
      }
    }

    // The sew tool works on the *edges* of a piece, not on the shape inside it,
    // so it has to be offered the click before the block intercept below. A
    // block's outline is exactly what you sew its pieces together by; letting
    // the intercept take the click would make generated pieces unsewable.
    if (this.tool === 'sew') {
      this.setRulerSelection(null);
      this.onSewDown(p);
      return;
    }

    // A generated block piece is edited through its variables, not its points:
    // clicking selects the block, dragging moves the whole draft. Regeneration
    // would otherwise discard whatever you did to an individual point.
    const block = this.blockForPiece(pieceId);
    if (block) {
      this.onBlockPointerDown(e, p, block, pieceId);
      return;
    }

    // Anything else gives the ruler up: a ruler is only "in hand" while nothing
    // else is being edited, so its settings ribbon must not linger.
    this.setRulerSelection(null);

    // A hit on a piece's own body — its fill or its grainline, neither of which
    // carries a `kind` — picks the whole piece. Without this a click inside a
    // piece fell through to the marquee and cleared the selection on release, so
    // the only way to pick up a panel was to catch one of its corners exactly.
    if (this.tool === 'move' && !kind && pieceId) {
      const piece = this.pattern.pieces.find((entry) => entry.id === pieceId);
      if (piece) {
        // Already part of a wider selection? Then this is a drag of the whole
        // thing rather than a re-pick of one piece out of it.
        if (!this.isEntirePieceSelected(piece)) this.selectEntirePiece(piece);
        this.drag = {
          type: 'moveSelection',
          start: p,
          snapshots: this.snapshotSelection(),
        };
        this.svg.setPointerCapture(e.pointerId);
        e.preventDefault();
        this.redraw();
        return;
      }
    }

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

    if (this.tool === 'move' && kind === 'scale') {
      const handle = (target.dataset.handle ?? target.dataset.corner) as ScaleHandle | undefined;
      const box = this.selectionScaleBox();
      if (!handle || !box || this.selectedIds.size < 2) return;
      const fixed = this.scaleFixedPoint(box, handle);
      const center = {
        x: (box.minX + box.maxX) / 2,
        y: (box.minY + box.maxY) / 2,
      };
      const startHandle = handleCentre(box, handle);
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

    // Outside every grip, and outside every element that carries its own
    // meaning: the rotate zone around a corner. A drag starting near a corner
    // turns the selection about its centre, and Shift snaps it to 15° steps.
    if (this.tool === 'move' && !kind && this.selectedIds.size >= 2) {
      const box = this.selectionScaleBox();
      const corner = box ? this.rotateCornerAt(p, box) : null;
      if (corner && box) {
        const center = {
          x: (box.minX + box.maxX) / 2,
          y: (box.minY + box.maxY) / 2,
        };
        this.markBeforeChange();
        this.drag = {
          type: 'rotateSelection',
          center,
          startAngle: angleAbout(p, center),
          snapshots: this.snapshotSelection(),
        };
        this.svg.setPointerCapture(e.pointerId);
        e.preventDefault();
        this.redraw();
        return;
      }
    }

    if (this.tool === 'move' && kind === 'selectionBox') {
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
  private findNearestEdgeAcrossPieces(p: Vec2): {
    piece: PatternPiece;
    edgeIndex: number;
    fromPointId: string;
    toPointId: string;
    /** Where along that edge the point is, in the edge's own winding. */
    t: number;
    dist: number;
  } | null {
    const threshold = Math.max(0.5, 12 / this.screenToPatternScale());
    let best: {
      piece: PatternPiece;
      edgeIndex: number;
      fromPointId: string;
      toPointId: string;
      t: number;
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
          t: hit.t,
          dist: hit.dist,
        };
      }
    }
    return best;
  }

  private sameEdge(a: HoverEdge | SeamEdgeRef, b: HoverEdge | SeamEdgeRef): boolean {
    return sameSeamEdgeTopology(a, b);
  }

  /**
   * Whole-edge reference read from the half a point landed on (Marvelous
   * Designer-style): the half you click is the end the edge is read from, so the
   * sewing direction can be aimed directly. Shared with the 3D sew tool.
   */
  private refForHalf(
    pieceId: string,
    fromPointId: string,
    toPointId: string,
    t: number
  ): HoverEdge {
    return seamRefFromHalf(pieceId, fromPointId, toPointId, t);
  }

  /**
   * Is the place that was clicked already sewn?
   *
   * Not the same question as "does this edge carry a seam": a many-to-many sew
   * leaves several seams along one edge, and the free part of a half-sewn edge is
   * still there to be sewn. Asking by edge alone refuses work that is perfectly
   * possible, and says nothing about why.
   */
  private edgeSewnAt(edge: SeamEdgeRef, t: number): boolean {
    const hit = {
      pieceId: edge.pieceId,
      fromPointId: edge.fromPointId,
      toPointId: edge.toPointId,
      t,
    };
    return this.pattern.seams.some((seam) => seamCoversEdge(seam, hit));
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
    const reverse = this.sewBar.querySelector('[data-sew-reverse]') as HTMLButtonElement;
    const next = this.sewBar.querySelector('[data-sew-next]') as HTMLButtonElement;
    if (this.multiSewPhase === 'source') {
      instruction.textContent = `Side A (${this.multiSewSource.length}): ${this.describeSewEdges(this.multiSewSource)}`;
      instruction.title = instruction.textContent;
      reverse.disabled = this.multiSewSource.length < 2;
      next.textContent = 'Next side';
      next.disabled = this.multiSewSource.length === 0;
    } else {
      instruction.textContent = `Side B (${this.multiSewTarget.length}): ${this.describeSewEdges(this.multiSewTarget)}`;
      instruction.title = instruction.textContent;
      reverse.disabled = this.multiSewTarget.length < 2;
      next.textContent = 'Create seams';
      next.disabled = this.multiSewTarget.length === 0;
    }
  }

  /**
   * The selection *in order*, because the order is what the seams are paired in:
   * hand the two sides over backwards and every seam comes out crossed.
   */
  private describeSewEdges(edges: readonly SeamEdgeRef[]): string {
    if (edges.length === 0) return 'select edges';
    return edges
      .map((edge, i) => {
        const piece = this.pattern.pieces.find((p) => p.id === edge.pieceId);
        return `${i + 1} ${piece?.name ?? '?'}`;
      })
      .join(' \u2192 ');
  }

  private activeSewEdges(): SeamEdgeRef[] | null {
    if (this.multiSewPhase === 'source') return this.multiSewSource;
    return this.multiSewTarget;
  }

  /** Hand the current side over in the opposite order. */
  private reverseMultiSewSide(): void {
    const edges = this.activeSewEdges();
    if (!edges || edges.length < 2) return;
    edges.reverse();
    this.syncSewBar();
    this.redraw();
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

    // Many-to-many selects whole edges (its own ordering / reverse controls set
    // direction), so it stays forward; the segment flow takes direction from the
    // clicked half.
    const edge: SeamEdgeRef =
      this.sewMode === 'many'
        ? {
            pieceId: hit.piece.id,
            fromPointId: hit.fromPointId,
            toPointId: hit.toPointId,
            t0: 0,
            t1: 1,
          }
        : this.refForHalf(hit.piece.id, hit.fromPointId, hit.toPointId, hit.t);

    if (this.sewMode === 'many') {
      this.onManySewDown(edge, hit.piece.id);
      return;
    }

    if (!this.pendingSeam) {
      if (this.edgeSewnAt(edge, hit.t)) return;
      this.pendingSeam = edge;
      this.selectedPieceId = hit.piece.id;
      this.redraw();
      return;
    }

    if (this.sameEdge(this.pendingSeam, edge)) {
      // Same edge: clicking the same half takes the pick back, the other half
      // flips the direction it will be sewn in.
      const sameDirection =
        seamReadsFromSecondHalf(this.pendingSeam) === seamReadsFromSecondHalf(edge);
      this.pendingSeam = sameDirection ? null : edge;
      this.redraw();
      return;
    }

    // Reject duplicate of the same undirected edge pair with the same spans.
    const dup = this.pattern.seams.some((s) =>
      sameSeamBindingPair(s.a, s.b, this.pendingSeam!, edge)
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

  /**
   * The seam under a pattern-space point.
   *
   * Distance to the edge is not enough: a many-to-many sew leaves several seams
   * on one edge, side by side, so the position along the edge decides which one
   * is meant. Reverse and Remove both act on what this returns.
   */
  private findSeamNearClick(p: Vec2): SeamBinding | null {
    const threshold = Math.max(0.5, 12 / this.screenToPatternScale());
    return findSeamNearPoint(this.pattern.seams, this.pattern.pieces, p, threshold);
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

  /**
   * Hand the partners round among the seams sharing this edge.
   *
   * The other half of the fix for a many-to-many run that came out crossed: the
   * direction of each seam is fine, the order they were paired in is not.
   */
  private reverseContextSeamOrder(): void {
    const hit = this.contextSeamHit;
    if (!hit) return;
    const rewritten = reverseSeamsAcrossEdge(this.pattern.seams, hit);
    if (!rewritten) return;
    const byId = new Map(rewritten.map((seam) => [seam.id, seam]));
    this.markBeforeChange();
    this.pattern.seams = this.pattern.seams.map((seam) => byId.get(seam.id) ?? seam);
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
      // With one edge picked, hovering a partner previews the stitches a click
      // would make, so a crossing (wrong-direction) run is visible before it is
      // committed.
      if (this.hoverEdge && !this.sameEdge(this.pendingSeam, this.hoverEdge)) {
        this.drawStitchPreview(this.pendingSeam, this.hoverEdge);
      }
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

  /**
   * Stitches that sewing `pending` to `hovered` would create, drawn as dashed
   * lines at matched arc-length samples. Where they cross, the direction is
   * wrong — the same read as the pattern editor's own seam connectors.
   */
  private drawStitchPreview(pending: SeamEdgeRef, hovered: HoverEdge): void {
    const pieceA = this.pattern.pieces.find((p) => p.id === pending.pieceId);
    const pieceB = this.pattern.pieces.find((p) => p.id === hovered.pieceId);
    if (!pieceA || !pieceB) return;
    // `pending` carries the pick's direction and `hovered` the half's, so the
    // preview is exactly what committing would sew.
    const pairs = buildSeamConnectorPointPairs(pieceA, pending, pieceB, hovered);
    drawSeamConnectorPairs(this.svg, pairs, {
      className: 'pattern-seam-preview-connector',
      strokeWidth: this.px(1.4),
      opacity: 0.9,
    });
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
        ? this.refForHalf(hit.piece.id, hit.fromPointId, hit.toPointId, hit.t)
        : null;
      // Crossing the midpoint changes the direction the stroke previews, so it
      // has to redraw even though the edge itself is unchanged.
      const changed =
        (!!next !== !!this.hoverEdge) ||
        (next &&
          this.hoverEdge &&
          (!this.sameEdge(next, this.hoverEdge) ||
            seamReadsFromSecondHalf(next) !== seamReadsFromSecondHalf(this.hoverEdge)));
      if (changed) {
        this.hoverEdge = next;
        this.redraw();
      }
      return;
    }

    // Hover feedback for rulers, and for the rotate zones beside a selection's
    // corner grips (ruler + move tools only).
    if (!this.drag && (this.tool === 'ruler' || this.tool === 'move')) {
      const point = this.svgPoint(e);
      const hit = this.findRulerHit(point);
      const next = hit?.id ?? null;
      let redraw = false;
      if (next !== this.hoverRulerId) {
        this.hoverRulerId = next;
        redraw = true;
      }

      // The rotate zone sits beside the corner rather than on it, so it has no
      // element of its own to hover: it is measured from the pointer, and only
      // where nothing else already owns the pixel — a point, a grip, or the box
      // itself.
      const free = this.tool === 'move' && !(e.target as SVGElement).dataset?.kind;
      const box = free && this.selectedIds.size >= 2 ? this.selectionScaleBox() : null;
      const zone = box ? this.rotateCornerAt(point, box) : null;
      if (zone !== this.hoverRotate) {
        this.hoverRotate = zone;
        redraw = true;
      }
      if (redraw) this.redraw();
      this.applyCursor(hit ? 'ruler' : zone ? 'rotate' : null);
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

    if (this.drag.type === 'blockMove') {
      const d = this.drag;
      const instance = this.blocks().find((b) => b.id === d.id);
      if (!instance) return;
      // Armed here, on the first movement, rather than on pointerdown: a click
      // that never moves is a selection, and it should not cost an undo step.
      this.markBeforeChange();
      instance.origin = {
        x: d.origin.x + (p.x - d.start.x),
        y: d.origin.y + (p.y - d.start.y),
      };
      const definition = this.blockDefinition(instance);
      if (definition) {
        const generated = generateBlockPieces(
          definition,
          instance,
          this.measurementSet(instance.personId)
        );
        const { pieces, ownership } = spliceBlockPieces(
          this.pattern.pieces,
          instance,
          generated
        );
        this.pattern.pieces = pieces;
        instance.pieces = ownership;
      }
      this.redraw();
      this.cbs.onChange();
      return;
    }

    if (this.drag.type === 'rulerCreate') {
      this.drag.current = p;
      this.drag.snap = e.shiftKey;
      this.redraw();
      return;
    }

    if (this.drag.type === 'rulerMove') {
      const d = this.drag;
      const ruler = this.rulers().find((r) => r.id === d.id);
      if (!ruler) return;
      ruler.center = { x: d.origin.x + (p.x - d.start.x), y: d.origin.y + (p.y - d.start.y) };
      this.redraw();
      this.notifyRulerChange();
      return;
    }

    if (this.drag.type === 'rulerTurn') {
      const d = this.drag;
      const ruler = this.rulers().find((r) => r.id === d.id);
      if (!ruler) return;
      const dx = p.x - ruler.center.x;
      const dy = p.y - ruler.center.y;
      // Dragging tip A aims the ruler's +x axis back through the centre, so the
      // tip stays under the cursor instead of jumping to the far end.
      let deg = (Math.atan2(dy, dx) * 180) / Math.PI + (d.which === 'a' ? 180 : 0);
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      ruler.angle = deg;
      // Freed of a measurement, the ruler can also be sized by its tip.
      if (ruler.measurementId === null) {
        setRulerDrawnLength(ruler, Math.max(1, Math.hypot(dx, dy) * 2));
      }
      this.redraw();
      this.notifyRulerChange();
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
      // Armed here, on the first movement, rather than on pointerdown: picking a
      // piece up and letting go without dragging it is a selection, and it
      // should not leave an empty step on the undo stack.
      if (rawDx !== 0 || rawDy !== 0) this.markBeforeChange();
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

    if (this.drag.type === 'rotateSelection') {
      const d = this.drag;
      let delta = angleAbout(p, d.center) - d.startAngle;
      // Shift snaps the *amount turned*, so a piece can be rotated in exact
      // steps (15° here, the same step the ruler's own turn gesture uses).
      if (e.shiftKey) delta = snapAngle(delta, Math.PI / 12);
      this.applySnapshotsRotated(d.snapshots, d.center, delta);
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

    if (finished.type === 'rulerCreate') {
      this.commitRulerCreate(finished);
      this.endHistoryGesture();
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
