import { describe, expect, it } from 'vitest';
import {
  MANDATORY_MEASUREMENT_IDS,
  defaultMeasurementValues,
  measurementHeightCm,
} from './measurements';
import { normalizeAvatarLibrary } from './avatars';

describe('defaultMeasurementValues', () => {
  it('returns the neutral body at its own height', () => {
    const cm = defaultMeasurementValues('cm');
    expect(cm.height).toBe(170);
    expect(cm.bust).toBe(88.3);
    expect(cm.waist).toBe(73.3);
  });

  it('scales the rest of the body to the requested height', () => {
    const cm = defaultMeasurementValues('cm', 157.5);
    expect(cm.height).toBe(157.5);
    expect(cm.waist).toBeCloseTo(73.3 * (157.5 / 170), 1);
    expect(cm.inseam).toBeCloseTo(78.9, 1);
  });

  it('converts to inches', () => {
    const inch = defaultMeasurementValues('in', 170);
    expect(inch.height).toBeCloseTo(66.9, 1);
    expect(inch.waist).toBeCloseTo(28.9, 1);
  });

  it('covers every mandatory measurement', () => {
    const cm = defaultMeasurementValues('cm');
    for (const id of MANDATORY_MEASUREMENT_IDS) {
      expect(cm[id], id).toBeGreaterThan(0);
    }
  });
});

describe('measurementHeightCm', () => {
  it('reads both display units', () => {
    expect(measurementHeightCm({ height: 170 }, 'cm')).toBe(170);
    expect(measurementHeightCm({ height: 62 }, 'in')).toBeCloseTo(157.5, 1);
  });

  it('ignores missing or nonsense heights', () => {
    expect(measurementHeightCm({}, 'cm')).toBeUndefined();
    expect(measurementHeightCm({ height: 0 }, 'cm')).toBeUndefined();
  });
});

describe('normalizeAvatarLibrary defaults', () => {
  const raw = {
    sets: [{ id: 'a', name: 'A', unit: 'in', values: { height: 62, bust: 38 } }],
    activeId: 'a',
  };

  it('backfills missing mandatory measurements, scaled to the entered height', () => {
    const values = normalizeAvatarLibrary(raw).sets[0]!.values;
    expect(values.bust).toBe(38);
    expect(values.height).toBe(62);
    expect(values.inseam).toBeCloseTo(31.1, 1);
    expect(values.waist).toBeGreaterThan(0);
  });

  it('leaves derived measurements empty — those come from the model', () => {
    const values = normalizeAvatarLibrary(raw).sets[0]!.values;
    expect(values.highBust).toBeUndefined();
    expect(values.weight).toBeUndefined();
  });

  it('is idempotent', () => {
    const once = normalizeAvatarLibrary(raw).sets[0]!.values;
    const again = normalizeAvatarLibrary({
      sets: [{ id: 'a', name: 'A', unit: 'in', values: once }],
      activeId: 'a',
    }).sets[0]!.values;
    expect(again).toEqual(once);
  });
});
