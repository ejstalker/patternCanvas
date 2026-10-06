import type { mat4, vec3 } from 'gl-matrix';
import type { SdfVolume } from '../mesh/sdfVolume';
import type { SimParams, SimPose } from '../project/types';

export type DrapeEngineKind = 'cpu-mass-spring' | 'gpu-xpbd';

/** Collision body used for avatar / floor render + CPU resolve. */
export interface ClothCollider {
  getFootprintRadius(): number;
  getModelMatrix(): mat4;
  getPositionBuffer(): GPUBuffer;
  getNormalBuffer(): GPUBuffer;
  getIndexBuffer(): GPUBuffer;
  getIndexCount(): number;
  /** Optional SDF volume for GPU XPBD mesh collision (kind 4). */
  getSdfVolume?(): SdfVolume | null;
}

export interface ClothFloor {
  getModelMatrix(): mat4;
  getPositionBuffer(): GPUBuffer;
  getNormalBuffer(): GPUBuffer;
  getIndexBuffer(): GPUBuffer;
  getIndexCount(): number;
  usesRadialGradient?(): boolean;
  getGradientHalfExtent?(): number;
}

export interface ClothRenderExtras {
  getFloor?(): ClothFloor | null;
  getSeamLineVertexCount?(): number;
  getSeamLinePositionBuffer?(): GPUBuffer | null;
  getSeamLineNormalBuffer?(): GPUBuffer | null;
}

export interface ClothSimulator extends ClothRenderExtras {
  destroy(): void;
  update(simulate?: boolean): void;
  applyParams(params: SimParams): void;
  exportPose(): SimPose;
  applyPose(pose: SimPose): void;
  resetToInitialState(): void;
  setAvatar(avatar: ClothCollider): void;
  getGround(): ClothCollider;

  getVertexPieceIds(): readonly string[];
  raycast(
    origin: vec3,
    dir: vec3
  ): { t: number; point: vec3; pieceId: string } | null;
  getCentroid(pieceId?: string): vec3;
  getPieceCentroidTuple(pieceId: string): [number, number, number];
  setPieceCentroid(pieceId: string, target: [number, number, number]): void;
  applyPieceEulerDegrees(pieceId: string, eulerDeg: [number, number, number]): void;
  applyPieceQuat(pieceId: string, quatXyZw: [number, number, number, number]): void;
  translateBy(delta: vec3, pieceId?: string): void;
  rotateBy(axis: vec3, radians: number, pieceId: string): void;
  /**
   * Pin a piece's particles at their current positions (freeze) or release
   * them. Seam constraints stay live either way: a fixed end simply does not
   * move while the other end is still pulled.
   */
  setPieceFrozen(pieceId: string, frozen: boolean): void;
  isPieceFrozen(pieceId: string): boolean;
  getFrozenPieceIds(): string[];
  /** Live positions of every frozen piece, keyed by piece id (flat xyz). */
  captureFrozenState(): Record<string, number[]>;
  /**
   * Re-pin frozen pieces on a freshly built cloth, placing each at its saved
   * positions when the particle count still matches (otherwise at rest).
   */
  applyFrozenState(state: Record<string, number[]> | null | undefined): void;
  setDragging(dragging: boolean): void;
  /** Latest particle positions (xyz interleaved, world units) for overlays, or null. */
  getPositionsSnapshot?(): Float32Array | null;

  getModelMatrix(): mat4;
  getPositionBuffer(): GPUBuffer;
  getNormalBuffer(): GPUBuffer;
  getIndexBuffer(): GPUBuffer;
  getIndexFormat(): GPUIndexFormat;
  getIndexCount(): number;
  getWireframeBuffers(): {
    positionBuffer: GPUBuffer;
    normalBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    indexFormat: GPUIndexFormat;
    indexCount: number;
  } | null;

  /** Per-vertex RGB for strain visualization (same count as particles). */
  getColorBuffer?(): GPUBuffer | null;
  setStrainMapEnabled?(enabled: boolean): void;
  isStrainMapEnabled?(): boolean;
}
