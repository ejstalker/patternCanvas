/** patternCanvas project document model (canonical cm). */

export type UnitDisplay = 'cm' | 'in';

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

export type PatternDocument = {
  id: string;
  name: string;
  pieces: PatternPiece[];
  seams: SeamBinding[];
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
   * Contact friction / grip (0–1).
   * CPU: tangential velocity retain ≈ 1 − friction.
   * GPU: Coulomb μ in SDF contact.
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
  /** Data URL or other browser-loadable image src (reference / snapshot). */
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
