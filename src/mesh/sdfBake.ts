import type { SdfVolumeData } from './sdfVolume';
import SdfBakeWorker from './sdfBake.worker?worker';

/** Good starting point: fast enough to iterate, adequate for draping collision. */
export const DEFAULT_SDF_RESOLUTION = 48;

export function computeSdfGrid(
  boundsMin: [number, number, number],
  boundsMax: [number, number, number],
  resolution: number
): { origin: [number, number, number]; voxelSize: number; dim: [number, number, number] } {
  const pad =
    Math.max(boundsMax[0] - boundsMin[0], boundsMax[1] - boundsMin[1], boundsMax[2] - boundsMin[2]) *
      0.05 +
    0.25;
  const origin: [number, number, number] = [
    boundsMin[0] - pad,
    boundsMin[1] - pad,
    boundsMin[2] - pad,
  ];
  const maxDim = Math.max(
    boundsMax[0] - boundsMin[0] + pad * 2,
    boundsMax[1] - boundsMin[1] + pad * 2,
    boundsMax[2] - boundsMin[2] + pad * 2
  );
  const voxelSize = maxDim / resolution;
  return { origin, voxelSize, dim: [resolution, resolution, resolution] };
}

export type BakeSdfOptions = {
  onProgress?: (value: number) => void;
  signal?: AbortSignal;
};

export async function bakeSdfVolume(
  positions: Float32Array,
  indices: Uint32Array,
  boundsMin: [number, number, number],
  boundsMax: [number, number, number],
  resolution: number,
  options: BakeSdfOptions = {}
): Promise<SdfVolumeData> {
  const { onProgress, signal } = options;
  const grid = computeSdfGrid(boundsMin, boundsMax, resolution);
  const posCopy = new Float32Array(positions);
  const idxCopy = new Uint32Array(indices);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('SDF bake cancelled', 'AbortError'));
      return;
    }

    const worker = new SdfBakeWorker();
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      fn();
    };

    const onAbort = () => {
      finish(() => reject(signal!.reason ?? new DOMException('SDF bake cancelled', 'AbortError')));
    };

    signal?.addEventListener('abort', onAbort);

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        onProgress?.(msg.value);
        return;
      }
      if (msg.type === 'done') {
        finish(() =>
          resolve({
            origin: grid.origin,
            voxelSize: grid.voxelSize,
            dim: grid.dim,
            distances: msg.distances,
          })
        );
      } else if (msg.type === 'error') {
        finish(() => reject(new Error(msg.message)));
      }
    };
    worker.onerror = (err) => {
      finish(() => reject(err));
    };
    worker.postMessage({
      positions: posCopy,
      indices: idxCopy,
      origin: grid.origin,
      voxelSize: grid.voxelSize,
      dim: grid.dim,
    });
  });
}
