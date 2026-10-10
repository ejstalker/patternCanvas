/**
 * Tone mapping operators, ported from ~/Documents/Dev/pbr-webgpu.
 *
 * The operators live in WGSL (`src/shaders/tonemapping.wgsl`) and are selected
 * at run time by an index carried in the shading uniforms, so this module is the
 * single place that knows the order of that index.
 */
export const TONEMAP_MODES = ['reinhard', 'uncharted2', 'aces', 'lottes'] as const;

export type TonemapMode = (typeof TONEMAP_MODES)[number];

/** ACES keeps the viewport looking the way it did before the choice existed. */
export const DEFAULT_TONEMAP: TonemapMode = 'aces';

const LABELS: Record<TonemapMode, string> = {
  reinhard: 'Reinhard',
  uncharted2: 'Uncharted 2',
  aces: 'ACES',
  lottes: 'Lottes',
};

export function tonemapLabel(mode: TonemapMode): string {
  return LABELS[mode];
}

export function isTonemapMode(value: unknown): value is TonemapMode {
  return typeof value === 'string' && (TONEMAP_MODES as readonly string[]).includes(value);
}

/** The number a shader sees in its uniform. Unknown modes read as ACES. */
export function tonemapIndex(mode: TonemapMode | string | null | undefined): number {
  const index = TONEMAP_MODES.indexOf((mode ?? '') as TonemapMode);
  return index === -1 ? TONEMAP_MODES.indexOf(DEFAULT_TONEMAP) : index;
}
