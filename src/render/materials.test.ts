import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MATERIALS,
  MaterialLibrary,
  PEDESTAL_DARKENING,
  hexToLinear,
  linearToHex,
  loadMaterialSettings,
} from './materials';

beforeEach(() => {
  localStorage.clear();
});

describe('linear <-> sRGB hex', () => {
  it('round-trips the studio defaults', () => {
    for (const material of Object.values(DEFAULT_MATERIALS)) {
      const color = material.color;
      const back = hexToLinear(linearToHex(color));
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(color[i]!, 2);
    }
  });

  it('maps the ends of the range', () => {
    expect(linearToHex([0, 0, 0])).toBe('#000000');
    expect(linearToHex([1, 1, 1])).toBe('#ffffff');
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToLinear('nonsense')).toEqual([1, 1, 1]);
  });
});

describe('MaterialLibrary', () => {
  it('starts from the shipped defaults and persists changes', () => {
    const library = new MaterialLibrary();
    expect(library.get('cloth').color).toEqual(DEFAULT_MATERIALS.cloth.color);

    library.set('cloth', { color: [0.2, 0.4, 0.6], roughness: 0.3, metallic: 0.8 });
    expect(library.get('cloth')).toEqual({ color: [0.2, 0.4, 0.6], roughness: 0.3, metallic: 0.8 });

    const reloaded = loadMaterialSettings();
    expect(reloaded.cloth.color).toEqual([0.2, 0.4, 0.6]);
    expect(reloaded.cloth.metallic).toBe(0.8);
    // Untouched roles keep their defaults.
    expect(reloaded.reference).toEqual(DEFAULT_MATERIALS.reference);
  });

  it('clamps out-of-range values instead of storing them', () => {
    const library = new MaterialLibrary();
    library.set('reference', { color: [-1, 4, 0.5], roughness: 7, metallic: -2 });
    const reference = library.get('reference');
    expect(reference.color).toEqual([0, 1, 0.5]);
    expect(reference.roughness).toBe(1);
    expect(reference.metallic).toBe(0);
  });

  it('derives the pedestal from the reference, 25% darker', () => {
    const library = new MaterialLibrary();
    library.set('reference', { color: [0.8, 0.4, 0.2], roughness: 0.25, metallic: 0.5 });
    library.set('pedestal', { roughness: 0.9, metallic: 0 });
    const pedestal = library.pedestal();
    expect(pedestal.color).toEqual([0.8 * PEDESTAL_DARKENING, 0.4 * PEDESTAL_DARKENING, 0.2 * PEDESTAL_DARKENING]);
    // Its shading params stay its own.
    expect(pedestal.roughness).toBe(0.9);
    expect(pedestal.metallic).toBe(0);
  });

  it('ignores a stored pedestal colour: it always follows the reference', () => {
    const library = new MaterialLibrary();
    library.set('pedestal', { color: [0, 1, 0] });
    expect(library.pedestal().color).toEqual(
      DEFAULT_MATERIALS.reference.color.map((c) => c * PEDESTAL_DARKENING)
    );
  });

  it('answers forPiece with the cloth material for now', () => {
    const library = new MaterialLibrary();
    library.set('cloth', { color: [0.1, 0.2, 0.3] });
    expect(library.forPiece('front-panel')).toEqual(library.get('cloth'));
    expect(library.forPiece()).toEqual(library.get('cloth'));
  });

  it('notifies listeners once per real change', () => {
    const library = new MaterialLibrary();
    const listener = vi.fn();
    const off = library.onChange(listener);

    library.set('cloth', { roughness: 0.4 });
    expect(listener).toHaveBeenCalledTimes(1);
    // Same value: no notification.
    library.set('cloth', { roughness: 0.4 });
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    library.set('cloth', { roughness: 0.9 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('hands out copies, so callers cannot mutate the store', () => {
    const library = new MaterialLibrary();
    const material = library.get('cloth');
    material.color[0] = 0;
    material.roughness = 0;
    expect(library.get('cloth').color[0]).not.toBe(0);
    expect(library.get('cloth').roughness).not.toBe(0);
  });

  it('survives junk in the store', () => {
    localStorage.setItem('patternCanvas.materials', '{"cloth":{"color":"red","roughness":"x"}}');
    const restored = loadMaterialSettings();
    expect(restored.cloth.color).toEqual(DEFAULT_MATERIALS.cloth.color);
    expect(restored.cloth.roughness).toBe(DEFAULT_MATERIALS.cloth.roughness);

    localStorage.setItem('patternCanvas.materials', 'not json');
    expect(loadMaterialSettings()).toEqual({ ...DEFAULT_MATERIALS });
  });
});
