/**
 * SDF bake worker. The math lives in `sdfBakeCore.ts` (unit-tested); this file
 * only marshals messages.
 */

import { bakeDistances, type SdfBakeRequest } from './sdfBakeCore';

type SdfBakeProgress = { type: 'progress'; value: number };
type SdfBakeResult = { type: 'done'; distances: Float32Array };
type SdfBakeError = { type: 'error'; message: string };

self.onmessage = (event: MessageEvent<SdfBakeRequest>) => {
  try {
    const distances = bakeDistances(event.data, (value) => {
      const progress: SdfBakeProgress = { type: 'progress', value };
      self.postMessage(progress);
    });
    const payload: SdfBakeResult = { type: 'done', distances };
    self.postMessage(payload, { transfer: [distances.buffer] });
  } catch (err) {
    const payload: SdfBakeError = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(payload);
  }
};
