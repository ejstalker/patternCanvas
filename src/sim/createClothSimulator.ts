import type { AvatarBody } from '../mesh/AvatarBody';
import type { MeshGeometry, PatternDocument, SimParams } from '../project/types';
import type { ClothSimulator, DrapeEngineKind } from './ClothSimulator';
import { CpuMassSpringEngine } from './engines/CpuMassSpringEngine';
import { XpbdGpuEngine } from './engines/gpu/XpbdGpuEngine';

export function resolveEngineKind(params: SimParams, force?: DrapeEngineKind): DrapeEngineKind {
  if (force) return force;
  return params.engine ?? 'cpu-mass-spring';
}

/**
 * Factory for drape engines. Transform 3D may force CPU until GPU piece ops are ready;
 * GPU piece ops are now implemented so Transform can also use resolveEngineKind.
 */
export function createClothSimulator(
  kind: DrapeEngineKind,
  mesh: MeshGeometry,
  params: SimParams,
  device: GPUDevice,
  avatar: AvatarBody,
  pattern?: PatternDocument
): ClothSimulator {
  if (kind === 'gpu-xpbd') {
    return new XpbdGpuEngine(mesh, params, device, avatar, pattern);
  }
  return new CpuMassSpringEngine(mesh, params, device, avatar, pattern);
}
