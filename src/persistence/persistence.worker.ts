import type { ProjectDocument } from '../project/types';
import { documentToSavePayload } from './manifestCodec';

export type WorkerSaveRequest = {
  type: 'save';
  project: ProjectDocument;
  projectId: string;
  revision: number;
};

export type WorkerSaveResponse = {
  type: 'save-result';
  payload: Awaited<ReturnType<typeof documentToSavePayload>>;
};

self.onmessage = async (event: MessageEvent<WorkerSaveRequest>) => {
  const msg = event.data;
  if (msg.type !== 'save') return;
  try {
    const payload = await documentToSavePayload(msg.project, {
      projectId: msg.projectId,
      revision: msg.revision,
    });
    const transferables: Transferable[] = [];
    for (const asset of payload.assets) {
      if (asset.blob instanceof Blob) {
        const buf = await asset.blob.arrayBuffer();
        transferables.push(buf);
      }
    }
    for (const pose of payload.poses) {
      transferables.push(pose.positions);
      if (pose.velocities) transferables.push(pose.velocities);
    }
    for (const cache of payload.meshCaches) {
      transferables.push(cache.data);
    }
    (self as unknown as Worker).postMessage(
      { type: 'save-result', payload } satisfies WorkerSaveResponse,
      transferables
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'save-error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
