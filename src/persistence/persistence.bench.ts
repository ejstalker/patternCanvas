import { bench, describe } from 'vitest';
import { documentToSavePayload } from './manifestCodec';
import { createMediumFixture, createLargeFixture } from './fixtures';
import { HistoryManager } from '../project/history/HistoryManager';
import { createSmallFixture } from './fixtures';

describe('persistence benchmarks', () => {
  bench('externalize medium fixture (~10MB class)', async () => {
    const project = createMediumFixture();
    await documentToSavePayload(project, { projectId: project.id, revision: 1 });
  });

  bench('externalize large fixture', async () => {
    const project = createLargeFixture();
    await documentToSavePayload(project, { projectId: project.id, revision: 1 });
  });

  bench('history push stripped snapshot', () => {
    const project = createSmallFixture();
    const hm = new HistoryManager();
    hm.push(project);
  });
});
