/**
 * Fetch + cache the vendored MakeHuman assets under `/refPpl/mh/`.
 */

import { parseBaseMesh, type BaseMeshSource } from './baseMesh';
import { parseTarget, type TargetDelta } from './targetFile';
import { MACRO_TARGETS, allMeasureTargetNames } from './macroTargets';
import type { TargetResolver } from './generate';

export const MAKEHUMAN_ASSET_BASE = '/refPpl/mh';

/** Every target basename the generator needs. */
export function makeHumanTargetNames(): string[] {
  return [...MACRO_TARGETS, ...allMeasureTargetNames()];
}

let basePromise: Promise<BaseMeshSource> | null = null;

export function loadMakeHumanBase(): Promise<BaseMeshSource> {
  if (!basePromise) {
    basePromise = (async () => {
      const res = await fetch(`${MAKEHUMAN_ASSET_BASE}/base.obj`);
      if (!res.ok) throw new Error(`Failed to load MakeHuman base mesh (${res.status})`);
      return parseBaseMesh(await res.text());
    })();
  }
  return basePromise;
}

const targetCache = new Map<string, TargetDelta | null>();
const targetInflight = new Map<string, Promise<TargetDelta | null>>();

/** Load one target; resolves to null when the file is missing (some measures have no targets). */
export function loadMakeHumanTarget(name: string, signal?: AbortSignal): Promise<TargetDelta | null> {
  const cached = targetCache.get(name);
  if (cached !== undefined) return Promise.resolve(cached);

  const inflight = targetInflight.get(name);
  if (inflight) return inflight;

  const promise = (async (): Promise<TargetDelta | null> => {
    try {
      const res = await fetch(`${MAKEHUMAN_ASSET_BASE}/targets/${name}.target`, { signal });
      if (!res.ok) return null;
      const delta = parseTarget(await res.text());
      targetCache.set(name, delta);
      return delta;
    } catch {
      return null;
    } finally {
      targetInflight.delete(name);
    }
  })();

  targetInflight.set(name, promise);
  return promise;
}

export async function loadMakeHumanTargets(
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, TargetDelta>> {
  const names = makeHumanTargetNames();
  const out = new Map<string, TargetDelta>();
  let done = 0;
  await Promise.all(
    names.map(async (name) => {
      const delta = await loadMakeHumanTarget(name);
      if (delta) out.set(name, delta);
      onProgress?.(++done, names.length);
    })
  );
  return out;
}

export function makeTargetResolver(targets: ReadonlyMap<string, TargetDelta>): TargetResolver {
  return (name) => targets.get(name) ?? null;
}

/** Drop cached assets (tests / HMR). */
export function resetMakeHumanAssets(): void {
  basePromise = null;
  targetCache.clear();
  targetInflight.clear();
}
