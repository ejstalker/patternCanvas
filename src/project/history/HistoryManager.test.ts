import { describe, expect, it } from 'vitest';
import { HistoryManager } from './HistoryManager';
import { createSmallFixture } from '../../persistence/fixtures';
import { cloneProject } from './HistoryManager';
import { getDefaultSimCamera } from '../../sim/cameraDefaults';

describe('HistoryManager', () => {
  it('undo restores previous project name', () => {
    const hm = new HistoryManager();
    const project = createSmallFixture();
    hm.push(project);
    project.name = 'Renamed';
    const prev = hm.undo(project);
    expect(prev?.name).toBe('Small fixture');
  });

  it('redo reapplies changes', () => {
    const hm = new HistoryManager();
    const project = createSmallFixture();
    hm.push(project);
    project.name = 'Renamed';
    hm.undo(project);
    project.name = 'Renamed';
    const next = hm.redo(project);
    expect(next?.name).toBe('Renamed');
  });

  it('cloneProject round-trips', () => {
    const project = createSmallFixture();
    const cloned = cloneProject(project);
    expect(cloned.id).toBe(project.id);
  });

  it('undo restores transform pieceTransforms from sidecar', () => {
    const hm = new HistoryManager();
    const project = createSmallFixture();
    const transformId = 'transform_test';
    project.transforms.push({
      id: transformId,
      name: 'Transform',
      meshId: project.meshes[0].id,
      camera: getDefaultSimCamera(),
      pose: null,
      pieceTransforms: {
        piece_a: {
          position: [1, 2, 3],
          rotationDeg: [0, 45, 0],
          rotationQuat: [0, 0.3826834, 0, 0.9238795],
        },
      },
    });
    hm.push(project);
    project.transforms.find((t) => t.id === transformId)!.pieceTransforms.piece_a = {
      position: [9, 9, 9],
      rotationDeg: [90, 0, 0],
    };
    const prev = hm.undo(project);
    const restored = prev?.transforms.find((t) => t.id === transformId);
    expect(restored?.pieceTransforms.piece_a.position).toEqual([1, 2, 3]);
    expect(restored?.pieceTransforms.piece_a.rotationDeg).toEqual([0, 45, 0]);
  });
});
