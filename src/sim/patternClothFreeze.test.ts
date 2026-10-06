import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatternCloth } from './PatternCloth';
import { DEFAULT_SIM_PARAMS } from '../project/createDefault';
import type { AvatarBody } from '../mesh/AvatarBody';
import type { MeshGeometry } from '../project/types';

/** Minimal stand-in for a GPUBuffer — enough for buffer creation + writes. */
class FakeBuffer {
  private mapped: ArrayBuffer | null = null;
  constructor(readonly size: number) {}
  getMappedRange(): ArrayBuffer {
    if (!this.mapped) this.mapped = new ArrayBuffer(this.size);
    return this.mapped;
  }
  unmap(): void {
    this.mapped = null;
  }
  destroy(): void {}
}

function fakeDevice(): GPUDevice {
  return {
    createBuffer: (desc: { size: number }) => new FakeBuffer(desc.size),
    queue: { writeBuffer: () => {} },
  } as unknown as GPUDevice;
}

function fakeAvatar(): AvatarBody {
  return {
    getFootprintRadius: () => 3,
    resolveParticle: () => false,
    getModelMatrix: () => new Float32Array(16),
    getPositionBuffer: () => new FakeBuffer(4),
    getNormalBuffer: () => new FakeBuffer(4),
    getIndexBuffer: () => new FakeBuffer(4),
    getIndexCount: () => 0,
    getSdfVolume: () => null,
  } as unknown as AvatarBody;
}

/** Two separated quads, one pattern piece each. */
function twoPieceMesh(): MeshGeometry {
  const vertices = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
    { x: 40, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 20 },
    { x: 40, y: 20 },
  ];
  const edges: Array<[number, number]> = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [0, 2],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [4, 6],
  ];
  return {
    vertices,
    vertexPieceIds: ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B'],
    triangles: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
    edges,
  };
}

function makeCloth(): PatternCloth {
  return new PatternCloth(twoPieceMesh(), { ...DEFAULT_SIM_PARAMS }, fakeDevice(), fakeAvatar());
}

function pieceCentroid(cloth: PatternCloth, pieceId: string): number[] {
  const ids = cloth.getVertexPieceIds();
  const snap = cloth.getPositionsSnapshot()!;
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== pieceId) continue;
    sum[0] += snap[i * 3];
    sum[1] += snap[i * 3 + 1];
    sum[2] += snap[i * 3 + 2];
    n++;
  }
  return sum.map((v) => v / Math.max(n, 1));
}

describe('PatternCloth freeze', () => {
  let now = 0;

  beforeEach(() => {
    (globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage = {
      VERTEX: 1,
      INDEX: 2,
      COPY_DST: 4,
      STORAGE: 8,
      UNIFORM: 16,
      COPY_SRC: 32,
    };
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 16));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pins a frozen piece in place while the free piece keeps moving', () => {
    const cloth = makeCloth();
    cloth.setPieceFrozen('A', true);
    expect(cloth.isPieceFrozen('A')).toBe(true);
    expect(cloth.isPieceFrozen('B')).toBe(false);

    const aBefore = cloth.captureFrozenState()['A']!;
    const bBeforeY = pieceCentroid(cloth, 'B')[1];

    for (let i = 0; i < 40; i++) cloth.update(true);

    const aAfter = cloth.captureFrozenState()['A']!;
    const bAfterY = pieceCentroid(cloth, 'B')[1];

    // Frozen piece held its exact positions…
    expect(aAfter).toEqual(aBefore);
    expect(aAfter).toHaveLength(4 * 3);
    // …while the free piece obeyed gravity.
    expect(bAfterY).toBeLessThan(bBeforeY - 1e-4);
  });

  it('re-applies frozen positions to a rebuilt cloth, and releases on unfreeze', () => {
    const cloth = makeCloth();
    cloth.setPieceFrozen('A', true);
    const saved = cloth.captureFrozenState();

    const rebuilt = makeCloth();
    rebuilt.applyFrozenState(saved);
    expect(rebuilt.isPieceFrozen('A')).toBe(true);
    expect(rebuilt.isPieceFrozen('B')).toBe(false);
    expect(rebuilt.captureFrozenState()['A']).toEqual(saved['A']);

    // Released piece can move again.
    rebuilt.setPieceFrozen('A', false);
    expect(rebuilt.isPieceFrozen('A')).toBe(false);
    const yBefore = pieceCentroid(rebuilt, 'A')[1];
    for (let i = 0; i < 40; i++) rebuilt.update(true);
    expect(pieceCentroid(rebuilt, 'A')[1]).toBeLessThan(yBefore - 1e-4);
  });

  it('resets the frozen set on resetToInitialState', () => {
    const cloth = makeCloth();
    cloth.setPieceFrozen('A', true);
    cloth.resetToInitialState();
    expect(cloth.getFrozenPieceIds()).toEqual([]);
    expect(cloth.isPieceFrozen('A')).toBe(false);
  });
});
