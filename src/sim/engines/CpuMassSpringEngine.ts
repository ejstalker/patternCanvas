import type { mat4, vec3 } from 'gl-matrix';
import type { AvatarBody } from '../../mesh/AvatarBody';
import type { MeshGeometry, PatternDocument, SimParams, SimPose } from '../../project/types';
import type { ClothCollider, ClothFloor, ClothSimulator } from '../ClothSimulator';
import { PatternCloth } from '../PatternCloth';

/**
 * Thin adapter: existing CPU mass-spring solver behind ClothSimulator.
 */
export class CpuMassSpringEngine implements ClothSimulator {
  private cloth: PatternCloth;

  constructor(
    mesh: MeshGeometry,
    params: SimParams,
    device: GPUDevice,
    avatar: AvatarBody,
    pattern?: PatternDocument
  ) {
    this.cloth = new PatternCloth(mesh, params, device, avatar, pattern);
  }

  destroy(): void {
    this.cloth.destroy();
  }

  update(simulate?: boolean): void {
    this.cloth.update(simulate);
  }

  applyParams(params: SimParams): void {
    this.cloth.applyParams(params);
  }

  exportPose(): SimPose {
    return this.cloth.exportPose();
  }

  applyPose(pose: SimPose): void {
    this.cloth.applyPose(pose);
  }

  resetToInitialState(): void {
    this.cloth.resetToInitialState();
  }

  setAvatar(avatar: ClothCollider): void {
    this.cloth.setAvatar(avatar as AvatarBody);
  }

  getGround(): ClothCollider {
    return this.cloth.getGround();
  }

  getFloor(): ClothFloor {
    return this.cloth.getFloor();
  }

  getSeamLineVertexCount(): number {
    return this.cloth.getSeamLineVertexCount();
  }

  getSeamLinePositionBuffer(): GPUBuffer | null {
    return this.cloth.getSeamLinePositionBuffer();
  }

  getSeamLineNormalBuffer(): GPUBuffer | null {
    return this.cloth.getSeamLineNormalBuffer();
  }

  getVertexPieceIds(): readonly string[] {
    return this.cloth.getVertexPieceIds();
  }

  raycast(origin: vec3, dir: vec3): { t: number; point: vec3; pieceId: string } | null {
    return this.cloth.raycast(origin, dir);
  }

  getCentroid(pieceId?: string): vec3 {
    return this.cloth.getCentroid(pieceId);
  }

  getPieceCentroidTuple(pieceId: string): [number, number, number] {
    return this.cloth.getPieceCentroidTuple(pieceId);
  }

  setPieceCentroid(pieceId: string, target: [number, number, number]): void {
    this.cloth.setPieceCentroid(pieceId, target);
  }

  applyPieceEulerDegrees(pieceId: string, eulerDeg: [number, number, number]): void {
    this.cloth.applyPieceEulerDegrees(pieceId, eulerDeg);
  }

  applyPieceQuat(pieceId: string, quatXyZw: [number, number, number, number]): void {
    this.cloth.applyPieceQuat(pieceId, quatXyZw);
  }

  translateBy(delta: vec3, pieceId?: string): void {
    this.cloth.translateBy(delta, pieceId);
  }

  rotateBy(axis: vec3, radians: number, pieceId: string): void {
    this.cloth.rotateBy(axis, radians, pieceId);
  }

  setDragging(dragging: boolean): void {
    this.cloth.setDragging(dragging);
  }

  getModelMatrix(): mat4 {
    return this.cloth.getModelMatrix();
  }

  getPositionBuffer(): GPUBuffer {
    return this.cloth.getPositionBuffer();
  }

  getPositionsSnapshot(): Float32Array | null {
    return this.cloth.getPositionsSnapshot();
  }

  getNormalBuffer(): GPUBuffer {
    return this.cloth.getNormalBuffer();
  }

  getColorBuffer(): GPUBuffer | null {
    return this.cloth.getColorBuffer();
  }

  setStrainMapEnabled(enabled: boolean): void {
    this.cloth.setStrainMapEnabled(enabled);
  }

  isStrainMapEnabled(): boolean {
    return this.cloth.isStrainMapEnabled();
  }

  getIndexBuffer(): GPUBuffer {
    return this.cloth.getIndexBuffer();
  }

  getIndexFormat(): GPUIndexFormat {
    return this.cloth.getIndexFormat();
  }

  getIndexCount(): number {
    return this.cloth.getIndexCount();
  }

  getWireframeBuffers(): null {
    return this.cloth.getWireframeBuffers();
  }
}
