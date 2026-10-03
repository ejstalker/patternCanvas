/** patternCanvas project document model (canonical cm). */

export type UnitDisplay = 'cm' | 'in';

/**
 * The unit a project opens in.
 *
 * Storage is always canonical centimetres — this only decides how numbers are
 * *shown*, and every project records its own choice, so changing this affects
 * new projects only and never rewrites an existing one.
 */
export const DEFAULT_DISPLAY_UNIT: UnitDisplay = 'in';

export type Vec2 = { x: number; y: number };

/** Cubic bezier segment in pattern space (cm). */
export type BezierPoint = {
  id: string;
  anchor: Vec2;
  handleIn: Vec2 | null;
  handleOut: Vec2 | null;
  /**
   * When true, dragging one handle mirrors the other (smooth/parallel).
   * Default false — handles edit independently.
   */
  handlesParallel?: boolean;
};

export type PatternPiece = {
  id: string;
  name: string;
  closed: boolean;
  points: BezierPoint[];
  grainline?: { from: Vec2; to: Vec2 };
};

/**
 * Reference to a pattern edge by durable point IDs (survives inserts elsewhere
 * on the piece). Edge runs fromPointId → toPointId in piece winding order.
 * t0>t1 encodes a reversed sewing direction (like MD sewing notches).
 */
export type SeamEdgeRef = {
  pieceId: string;
  fromPointId: string;
  toPointId: string;
  /** Start fraction along the edge (0..1). */
  t0: number;
  /** End fraction along the edge (0..1). */
  t1: number;
};

export type SeamBinding = {
  id: string;
  a: SeamEdgeRef;
  b: SeamEdgeRef;
  restGapCm: number;
};

/** Tag linking a mesh boundary vertex back to a pattern edge. */
export type SeamVertexTag = {
  pieceId: string;
  fromPointId: string;
  toPointId: string;
  /** Parametric position along the edge (0..1). */
  t: number;
};

/**
 * A linear reference line laid over a pattern — a physical ruler you can park
 * next to the piece while drafting.
 *
 * It measures a *person*, not the pattern: `measurementId` points at one of the
 * body measurements from `MEASUREMENT_FIELDS` and the drawn length tracks that
 * person's live value. `lengthCm` is the last known value, kept so the ruler
 * still draws when the library (or that person) is not available.
 */
export type PatternRuler = {
  id: string;
  /** Centre of the ruler in pattern space (cm). */
  center: Vec2;
  /** Rotation in degrees; 0 lies along +x (reads left to right). */
  angle: number;
  /** Length of the *full* measurement in cm (ignored when `measurementId` is null). */
  lengthCm: number;
  /** Body-measurement field id, or null for a free-standing ruler. */
  measurementId: string | null;
  /** Measurement set ("person") this references, or null. */
  personId: string | null;
  /** Person name snapshot, so the label survives a renamed / missing set. */
  personName: string;
  /** Draw at half the measurement — the usual fold / half-scale drafting length. */
  half: boolean;
};

export type PatternDocument = {
  id: string;
  name: string;
  pieces: PatternPiece[];
  seams: SeamBinding[];
  /** Drafting reference rulers (see `PatternRuler`). */
  rulers?: PatternRuler[];
  /**
   * Parametric block instances (see `BlockInstance`). Their pieces live in
   * `pieces` like any other, so meshing, seams and export need no special case.
   */
  blocks?: BlockInstance[];
  /**
   * Lineage for pieces that were replaced by new ids (e.g. a knife cut):
   * removed piece id → the ids that took its place. Downstream Transform 3D
   * nodes use this to carry the piece's arrangement onto its successors instead
   * of resetting them. Optional — older documents simply have no lineage.
   */
  pieceSuccessors?: Record<string, string[]>;
};

/**
 * How a measurement is scaled before the ease is added.
 *
 * Expressed as a divisor because that is what the drafts use — a bodice width is
 * a *quarter* bust arc — but it is really a scale factor, and some fields need
 * the other direction: a derived `sideLength` is half the underarm seam and
 * doubles to reach the block's number.
 */
export type BlockDivisor = 0.5 | 1 | 2 | 4;

/**
 * A block variable either sits at a fixed number or follows one of a person's
 * measurements, scaled and offset. The scale is not decoration: a bodice width
 * is a quarter bust plus ease, and a skirt panel is a quarter hip.
 */
export type BlockMeasurementSource = {
  /** A `MEASUREMENT_FIELDS` id. */
  fieldId: string;
  /** 1 = the measurement itself, 2 = half, 4 = quarter, 0.5 = double. */
  divisor: BlockDivisor;
  /** Ease added after scaling, in cm. */
  offsetCm: number;
};

export type BlockVariableBinding =
  | { mode: 'value'; cm: number }
  | (BlockMeasurementSource & {
      mode: 'measurement';
      /** Snapshot so the block still draws when the library is missing. */
      fallbackCm: number;
    });

/** One editable number a block definition exposes. */
export type BlockVariableDecl = {
  id: string;
  label: string;
  /** Display grouping, e.g. 'Widths' / 'Lengths' / 'Darts'. */
  group: string;
  /**
   * Most variables are lengths in cm and follow the project's display unit.
   * `count` is a number of things (dart count) and `factor` is a 0–1 shaping
   * control (how square a curve turns) — both dimensionless, so neither is ever
   * converted to inches.
   */
  kind?: 'length' | 'count' | 'factor';
  /** Bound automatically when the block is first placed on a person. */
  suggested?: BlockMeasurementSource;
  /** Used when the variable is a plain number. Always in cm. */
  defaultValueCm: number;
  minCm: number;
  maxCm: number;
  /** Why this number is what it is — the draft formula it came from. */
  note?: string;
};

/**
 * A placed block. Its geometry is regenerated from `bindings` whenever a
 * variable changes, so the generated pieces are read-only until detached.
 */
export type BlockInstance = {
  id: string;
  definitionId: string;
  /** The person this block is drafted for; null means the active person. */
  personId: string | null;
  personName: string;
  /** Where the draft's origin sits in pattern space (cm). */
  origin: Vec2;
  /** Variable id → binding. Anything missing falls back to the declaration. */
  bindings: Record<string, BlockVariableBinding>;
  /**
   * Generated pieces, keyed by the role the definition gave them, so
   * regeneration can keep piece and point ids stable and seams survive.
   */
  pieces: Array<{ role: string; pieceId: string }>;
};


export type MeshAlgorithm = 'structuredGrid' | 'delaunay' | 'centroidal';

export type MeshSettings = {
  algorithm: MeshAlgorithm;
  /** Target interior edge length in cm (smaller = denser). */
  targetEdgeCm: number;
  /** Spacing of forced boundary samples in cm. */
  boundarySpacingCm: number;
  /** Lloyd iterations for centroidal algorithm. */
  lloydIterations: number;
};

export type MeshGeometry = {
  vertices: Vec2[];
  /** Parallel to vertices: owning pattern piece for per-piece sim transforms. */
  vertexPieceIds?: Array<string | null>;
  /** Flat triangle indices (i0,i1,i2,...) */
  triangles: number[];
  /** Unique undirected edges [a,b] for springs */
  edges: Array<[number, number]>;
  /**
   * Parallel to vertices: seam/edge tag for boundary verts, null for interior.
   * Used to resolve sew constraints after triangulation.
   */
  boundary?: Array<SeamVertexTag | null>;
};

export type MeshDocument = {
  id: string;
  name: string;
  patternId: string;
  settings: MeshSettings;
  geometry: MeshGeometry | null;
};

export type DrapeEngineKind = 'cpu-mass-spring' | 'gpu-xpbd';

export type SimParams = {
  particleResolution: number;
  mass: number;
  springConst: number;
  dampingConst: number;
  gravity: number;
  wind: [number, number, number];
  fluidDensity: number;
  dragCoeff: number;
  /** Drape backend; defaults to cpu-mass-spring when omitted. */
  engine?: DrapeEngineKind;
  /**
   * Integration substeps per frame (CPU mass-spring + GPU XPBD).
   * Macklin “small steps”: more substeps ≫ better stretch/stability than one big step.
   */
  substeps?: number;
  /**
   * CPU: Provot strain-limit passes per substep.
   * GPU: XPBD constraint iterations per substep.
   */
  constraintIterations?: number;
  /** Stretch compliance; 0 = hard PBD stretch (GPU). */
  stretchCompliance?: number;
  /** Bend compliance; high / omit to disable GPU bending. */
  bendCompliance?: number;
  /**
   * CPU: bend spring stiffness as a fraction of springConst (0 = off).
   * Typical 0.1–0.4 for fold resistance without locking the cloth.
   */
  bendSpringScale?: number;
  /**
   * CPU: Provot max edge length as a multiple of rest (e.g. 1.1 = 10% stretch).
   * ≤ 1 disables strain limiting. Classic Provot uses ~1.05–1.15.
   */
  maxStretch?: number;
  /**
   * CPU: multiplicative velocity retain per substep (0.95–1).
   * Slightly below 1 kills high-frequency spring ringing.
   */
  velocityDamping?: number;
  /** LRA slack multiplier (Velvet longRangeStretchiness). */
  longRangeStretchiness?: number;
  /** Self-collision / SDF particle radius = scalar × avg edge length. */
  particleDiameterScalar?: number;
  /**
   * Contact friction / grip (0–2).
   * Tangential velocity retain ≈ max(0, 1 − friction × 0.95).
   */
  contactFriction?: number;
  enableSelfCollision?: boolean;
  /** Rebuild spatial hash every N substeps. */
  interleavedHash?: number;
  /** Clamp particle speed (world units/s) after each CPU substep / GPU finalize. */
  maxSpeed?: number;
};

export type SimPose = {
  positions: number[];
  velocities?: number[];
};

export type SimCameraState = {
  distance: number;
  azimuth: number;
  elevation: number;
  target: [number, number, number];
};

export type SimInstance = {
  id: string;
  name: string;
  params: SimParams;
  pose: SimPose | null;
  camera: SimCameraState;
  dropped: boolean;
};

export type CanvasNodeBase = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
};

export type PatternFrameNode = CanvasNodeBase & {
  type: 'patternFrame';
  patternId: string;
};

export type MeshFrameNode = CanvasNodeBase & {
  type: 'meshFrame';
  meshId: string;
};

export type SimViewportNode = CanvasNodeBase & {
  type: 'simViewport';
  simId: string;
};

/** Per-piece placement from the default flat layout (world units). */
export type PieceTransform3d = {
  /** World-space centroid after arrangement. */
  position: [number, number, number];
  /** Euler XYZ degrees (inspector / legacy). Used when rotationQuat is absent. */
  rotationDeg: [number, number, number];
  /** Orientation from rest pose (x,y,z,w). Preferred over euler when present. */
  rotationQuat?: [number, number, number, number];
};

/** Static 3D arrangement stage — sets initial sim pose without physics. */
export type Transform3dInstance = {
  id: string;
  name: string;
  meshId: string;
  camera: SimCameraState;
  /** Full vertex pose after arrangement; passed to connected sim nodes. */
  pose: SimPose | null;
  /** Inspector-friendly per-piece offsets from default flat layout. */
  pieceTransforms: Record<string, PieceTransform3d>;
};

export type Transform3dNode = CanvasNodeBase & {
  type: 'transform3d';
  transformId: string;
};

export type ImageNode = CanvasNodeBase & {
  type: 'image';
  /** IndexedDB asset reference when persisted externally. */
  assetId?: string;
  /** Data URL, blob URL, or other browser-loadable image src (reference / snapshot). */
  src: string;
  label?: string;
  /** Natural pixel aspect (width/height) for Shift-resize locking. */
  naturalAspect?: number;
};

export type TextAnnotationNode = CanvasNodeBase & {
  type: 'text';
  text: string;
  fontSize: number;
};

export type CanvasNode =
  | PatternFrameNode
  | MeshFrameNode
  | Transform3dNode
  | SimViewportNode
  | ImageNode
  | TextAnnotationNode;

export type MeshSimAssignment = {
  id: string;
  meshId: string;
  simId: string;
};

export type MeshTransformAssignment = {
  id: string;
  meshId: string;
  transformId: string;
};

export type TransformSimAssignment = {
  id: string;
  transformId: string;
  simId: string;
};

export type ProjectDocument = {
  version: 2;
  id: string;
  name: string;
  displayUnit: UnitDisplay;
  canvas: {
    panX: number;
    panY: number;
    zoom: number;
    nodes: CanvasNode[];
  };
  patterns: PatternDocument[];
  meshes: MeshDocument[];
  transforms: Transform3dInstance[];
  sims: SimInstance[];
  assignments: MeshSimAssignment[];
  meshTransformAssignments: MeshTransformAssignment[];
  transformSimAssignments: TransformSimAssignment[];
  activeSimId: string | null;
};

export const CM_PER_INCH = 2.54;

export function cmToDisplay(cm: number, unit: UnitDisplay): number {
  return unit === 'in' ? cm / CM_PER_INCH : cm;
}

export function displayToCm(value: number, unit: UnitDisplay): number {
  return unit === 'in' ? value * CM_PER_INCH : value;
}

export function formatLength(cm: number, unit: UnitDisplay, digits = 2): string {
  const v = cmToDisplay(cm, unit);
  return `${v.toFixed(digits)} ${unit}`;
}
