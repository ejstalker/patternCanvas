import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TONEMAP,
  TONEMAP_MODES,
  isTonemapMode,
  tonemapIndex,
  tonemapLabel,
} from './tonemapping';
import toneMappingWgsl from '../shaders/tonemapping.wgsl?raw';

describe('tonemap modes', () => {
  it('lists the operators the reference project offers, ACES by default', () => {
    expect(TONEMAP_MODES).toEqual(['reinhard', 'uncharted2', 'aces', 'lottes']);
    expect(DEFAULT_TONEMAP).toBe('aces');
  });

  it('labels each mode', () => {
    expect(TONEMAP_MODES.map(tonemapLabel)).toEqual([
      'Reinhard',
      'Uncharted 2',
      'ACES',
      'Lottes',
    ]);
  });

  it('recognises stored values', () => {
    expect(isTonemapMode('lottes')).toBe(true);
    expect(isTonemapMode('filmic')).toBe(false);
    expect(isTonemapMode(3)).toBe(false);
    expect(isTonemapMode(undefined)).toBe(false);
  });

  it('numbers the modes the way the shader switch expects, ACES as the fallback', () => {
    expect(TONEMAP_MODES.map((mode) => tonemapIndex(mode))).toEqual([0, 1, 2, 3]);
    expect(tonemapIndex('nonsense')).toBe(2);
    expect(tonemapIndex(null)).toBe(2);
    expect(tonemapIndex(undefined)).toBe(DEFAULT_TONEMAP === 'aces' ? 2 : -1);
  });
});

describe('tonemapping shader', () => {
  it('carries an operator per mode and a switch keyed on the index', () => {
    for (const fn of [
      'tonemapReinhard',
      'tonemapUncharted2',
      'tonemapUncharted2Helper',
      'tonemapAces',
      'tonemapLottes',
    ]) {
      expect(toneMappingWgsl).toContain(`fn ${fn}(`);
    }
    expect(toneMappingWgsl).toContain('fn toneMapping(color: vec3<f32>, mode: u32)');
    expect(toneMappingWgsl).toContain('case 0u');
    expect(toneMappingWgsl).toContain('case 1u');
    expect(toneMappingWgsl).toContain('case 3u');
    // ACES is the default arm, so index 2 must not be listed as its own case.
    expect(toneMappingWgsl).not.toContain('case 2u');
  });
});
