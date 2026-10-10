import { describe, expect, it } from 'vitest';
import { DEFAULT_TONEMAP } from './tonemapping';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  DEFAULT_HDRI,
  DEFAULT_SHADING_MODE,
  SHADING_MODES,
  blurToMipLevel,
  equirectMipLevelCount,
  loadEnvironmentSettings,
  nextShadingMode,
  shadingModeLabel,
} from './environment';

describe('shading mode helpers', () => {
  it('cycles wireframe -> simple -> pbr and wraps around', () => {
    expect(SHADING_MODES).toEqual(['wireframe', 'simple', 'pbr']);
    expect(nextShadingMode('wireframe')).toBe('simple');
    expect(nextShadingMode('simple')).toBe('pbr');
    expect(nextShadingMode('pbr')).toBe('wireframe');
  });

  it('labels each mode', () => {
    expect(shadingModeLabel('wireframe')).toBe('Wireframe');
    expect(shadingModeLabel('simple')).toBe('Simple');
    expect(shadingModeLabel('pbr')).toBe('PBR');
  });
});

describe('blurToMipLevel', () => {
  it('maps the slider across the mip chain, sharp at zero', () => {
    expect(blurToMipLevel(0, 8)).toBe(0);
    expect(blurToMipLevel(1, 8)).toBe(8);
    expect(blurToMipLevel(0.5, 8)).toBe(4);
  });

  it('clamps out-of-range input and copes with no chain', () => {
    expect(blurToMipLevel(-2, 8)).toBe(0);
    expect(blurToMipLevel(4, 8)).toBe(8);
    expect(blurToMipLevel(1, 0)).toBe(0);
  });
});

describe('equirectMipLevelCount', () => {
  it('halves down to a single texel but stops at the softest blur level', () => {
    expect(equirectMipLevelCount(1024)).toBe(7);
    expect(equirectMipLevelCount(256)).toBe(7);
    expect(equirectMipLevelCount(64)).toBe(7);
    expect(equirectMipLevelCount(32)).toBe(6);
    expect(equirectMipLevelCount(2)).toBe(2);
    expect(equirectMipLevelCount(1)).toBe(1);
  });

  it('survives a missing image', () => {
    expect(equirectMipLevelCount(0)).toBe(1);
    expect(equirectMipLevelCount(Number.NaN)).toBe(1);
  });
});

describe('loadEnvironmentSettings', () => {
  it('falls back to the defaults for an empty store', () => {
    expect(loadEnvironmentSettings()).toEqual(DEFAULT_ENVIRONMENT_SETTINGS);
    // A 3D viewport opens in PBR: it is the look the app is for.
    expect(DEFAULT_ENVIRONMENT_SETTINGS.shading).toBe('pbr');
    expect(DEFAULT_SHADING_MODE).toBe('pbr');
    expect(DEFAULT_ENVIRONMENT_SETTINGS.blur).toBe(0.5);
    expect(DEFAULT_ENVIRONMENT_SETTINGS.exposure).toBe(1);
    expect(DEFAULT_ENVIRONMENT_SETTINGS.hdri).toBe(DEFAULT_HDRI);
    expect(DEFAULT_HDRI).toBe('little_paris_eiffel_tower_1k.exr');
    expect(DEFAULT_ENVIRONMENT_SETTINGS.tonemap).toBe(DEFAULT_TONEMAP);
    expect(DEFAULT_TONEMAP).toBe('aces');
  });

  it('round-trips saved settings and repairs junk', () => {
    localStorage.setItem(
      'patternCanvas.environment',
      JSON.stringify({
        hdri: 'studio.exr',
        blur: 0.4,
        exposure: 2.5,
        tonemap: 'lottes',
        background: false,
        shading: 'pbr',
      })
    );
    expect(loadEnvironmentSettings()).toEqual({
      hdri: 'studio.exr',
      blur: 0.4,
      exposure: 2.5,
      tonemap: 'lottes',
      background: false,
      shading: 'pbr',
    });

    localStorage.setItem(
      'patternCanvas.environment',
      JSON.stringify({
        hdri: 7,
        blur: 9,
        exposure: 99,
        tonemap: 'filmic',
        background: 'yes',
        shading: 'smooth',
      })
    );
    expect(loadEnvironmentSettings()).toEqual({
      hdri: DEFAULT_HDRI,
      blur: 1,
      exposure: 4,
      tonemap: DEFAULT_TONEMAP,
      background: true,
      shading: DEFAULT_SHADING_MODE,
    });

    localStorage.setItem('patternCanvas.environment', 'not json');
    expect(loadEnvironmentSettings()).toEqual(DEFAULT_ENVIRONMENT_SETTINGS);
  });
});
