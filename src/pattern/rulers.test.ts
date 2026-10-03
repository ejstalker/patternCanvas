import { describe, expect, it } from 'vitest';
import type { PatternRuler } from '../project/types';
import {
  MEASUREMENT_FIELDS,
  newMeasurementSet,
  type MeasurementSet,
} from '../project/measurements';
import {
  buildMeasurementMenu,
  distanceToSegment,
  filterMeasurementMenu,
  fuzzyTokenScore,
  measurementSearchScore,
  measurementSearchTokens,
  measurementValueCm,
  nearestMeasurementField,
  normalizeRulers,
  normalizeAngle,
  rulerAngle,
  rulerEndpoints,
  rulerGraduations,
  rulerLabel,
  rulerLengthCm,
  rulerTextFlipped,
  setRulerDrawnLength,
} from './rulers';

function ruler(overrides: Partial<PatternRuler> = {}): PatternRuler {
  return {
    id: 'r1',
    center: { x: 0, y: 0 },
    angle: 0,
    lengthCm: 40,
    measurementId: null,
    personId: null,
    personName: '',
    half: false,
    ...overrides,
  };
}

function person(values: Record<string, number>, unit: 'cm' | 'in' = 'cm'): MeasurementSet {
  const set = newMeasurementSet('Alex', unit);
  set.values = values;
  return set;
}

/** Two people, one of whom has waist and bust taken. */
function library(): MeasurementSet[] {
  const alex = newMeasurementSet('Alex', 'cm');
  alex.id = 'p-alex';
  alex.values = { waist: 72, bust: 94, hip: 100 };
  const sam = newMeasurementSet('Samantha', 'cm');
  sam.id = 'p-sam';
  sam.values = { waist: 68 };
  return [alex, sam];
}

describe('ruler geometry', () => {
  it('lays a horizontal ruler out around its centre', () => {
    const { a, b } = rulerEndpoints(ruler({ lengthCm: 40 }));
    expect(a).toEqual({ x: -20, y: 0 });
    expect(b).toEqual({ x: 20, y: 0 });
  });

  it('halves the drawn length in half-width mode', () => {
    const r = ruler({ lengthCm: 94, half: true });
    expect(rulerLengthCm(r)).toBeCloseTo(47, 6);
    expect(rulerEndpoints(r).b.x).toBeCloseTo(23.5, 6);
  });

  it('uses a supplied live length instead of the stored snapshot', () => {
    const { b } = rulerEndpoints(ruler({ lengthCm: 40 }), 100);
    expect(b.x).toBeCloseTo(50, 6);
  });

  it('rotates the endpoints with the angle', () => {
    const { a, b } = rulerEndpoints(ruler({ lengthCm: 20, angle: 90 }));
    expect(a.x).toBeCloseTo(0, 6);
    expect(a.y).toBeCloseTo(-10, 6);
    expect(b.y).toBeCloseTo(10, 6);
  });

  it('stores back the full length when resized in half mode', () => {
    const r = ruler({ lengthCm: 10, half: true });
    setRulerDrawnLength(r, 25);
    expect(r.lengthCm).toBeCloseTo(50, 6);
    expect(rulerLengthCm(r)).toBeCloseTo(25, 6);
  });
});

describe('ruler angles', () => {
  it('measures the drag direction in degrees', () => {
    expect(rulerAngle({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0, 6);
    expect(rulerAngle({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(90, 6);
  });

  it('snaps to 15° steps when asked', () => {
    const deg = rulerAngle({ x: 0, y: 0 }, { x: 10, y: 3.2 }, true);
    expect(deg % 15).toBeCloseTo(0, 6);
    expect(deg).toBeCloseTo(15, 6);
  });

  it('normalises negative angles into [0, 360)', () => {
    expect(normalizeAngle(-90)).toBeCloseTo(270, 6);
    expect(normalizeAngle(450)).toBeCloseTo(90, 6);
  });

  it('flips labels only when the ruler reads backwards', () => {
    expect(rulerTextFlipped(0)).toBe(false);
    // Pointing straight down reads top-to-bottom — leave it alone.
    expect(rulerTextFlipped(90)).toBe(false);
    expect(rulerTextFlipped(180)).toBe(true);
    // Pointing straight up would read bottom-to-top, so it flips.
    expect(rulerTextFlipped(-90)).toBe(true);
    expect(rulerTextFlipped(360)).toBe(false);
  });
});

describe('ruler graded scale', () => {
  it('picks a finer graduation as you zoom in (metric)', () => {
    const coarse = rulerGraduations('cm', 1);
    const fine = rulerGraduations('cm', 60);
    expect(coarse.minorCm).toBeGreaterThan(fine.minorCm);
    expect(fine.minorCm).toBeCloseTo(0.1, 6);
    expect(fine.majorCm).toBeCloseTo(1, 6);
  });

  it('never lets minor graduations fall below the legibility floor', () => {
    for (const scale of [0.1, 1, 5, 20, 100, 400]) {
      const { minorCm } = rulerGraduations('cm', scale);
      expect(minorCm * scale).toBeGreaterThanOrEqual(5 - 1e-9);
    }
  });

  it('keeps labelled graduations far enough apart to read', () => {
    // A drafting zoom where 1 cm labels would collide — the step must grow.
    const drafting = rulerGraduations('cm', 11);
    expect(drafting.minorCm * 11).toBeGreaterThanOrEqual(5);
    expect(drafting.majorCm * 11).toBeGreaterThanOrEqual(36);
    expect(drafting).toEqual({ minorCm: 1, majorCm: 5 });

    for (const scale of [0.5, 2, 11, 40, 120]) {
      const { majorCm } = rulerGraduations('cm', scale);
      expect(majorCm * scale).toBeGreaterThanOrEqual(36 - 1e-9);
    }
  });

  it('uses inch graduations for imperial display', () => {
    // At 16 px/cm an eighth of an inch is legible, so that is the step.
    const fine = rulerGraduations('in', 16);
    expect(fine.minorCm).toBeCloseTo(0.3175, 6);
    expect(fine.majorCm).toBeCloseTo(2.54, 6);

    // Zoomed out, whole inches are the smallest legible step.
    const coarse = rulerGraduations('in', 8);
    expect(coarse.minorCm).toBeCloseTo(2.54, 6);
    expect(coarse.majorCm).toBeCloseTo(5.08, 6);
  });

  it('falls back to a sensible scale when layout has not settled', () => {
    const { minorCm, majorCm } = rulerGraduations('cm', 0);
    expect(minorCm).toBeGreaterThan(0);
    expect(majorCm).toBeGreaterThan(minorCm);
    expect(Number.isFinite(minorCm)).toBe(true);
  });
});

describe('measurement lookups', () => {
  it('converts a person measured in inches to canonical cm', () => {
    const set = person({ bust: 37 }, 'in');
    expect(measurementValueCm(set, 'bust')).toBeCloseTo(93.98, 6);
  });

  it('treats missing or non-positive values as "not taken"', () => {
    const set = person({ bust: 0 });
    expect(measurementValueCm(set, 'bust')).toBeNull();
    expect(measurementValueCm(set, 'waist')).toBeNull();
    expect(measurementValueCm(null, 'bust')).toBeNull();
  });

  it('labels a dragged length with the closest measurement on the person', () => {
    const set = person({ bust: 94, waist: 72, hip: 100 });
    expect(nearestMeasurementField(set, 93)).toBe('bust');
    expect(nearestMeasurementField(set, 101)).toBe('hip');
  });

  it('refuses to guess when nothing is close enough', () => {
    const set = person({ bust: 94 });
    expect(nearestMeasurementField(set, 20)).toBeNull();
    expect(nearestMeasurementField(set, 0)).toBeNull();
    expect(nearestMeasurementField(null, 94)).toBeNull();
  });
});

describe('ruler labels', () => {
  it('names the person and measurement, with the length underneath', () => {
    const label = rulerLabel(
      ruler({ measurementId: 'bust', personName: 'Alex' }),
      'cm',
      94,
      'Alex'
    );
    expect(label.primary).toBe('Alex · Full bust / chest');
    expect(label.secondary).toBe('94.0 cm');
  });

  it('marks half-width rulers with the halved length', () => {
    const label = rulerLabel(ruler({ measurementId: 'bust', half: true }), 'cm', 47, '');
    expect(label.secondary).toBe('½ · 47.0 cm');
  });

  it('calls a free ruler a ruler', () => {
    const label = rulerLabel(ruler(), 'cm', 30, '');
    expect(label.primary).toBe('Ruler');
    expect(label.secondary).toBe('30.0 cm');
  });

  it('falls back to the stored person name when the library is gone', () => {
    const label = rulerLabel(
      ruler({ measurementId: 'waist', personName: 'Sam' }),
      'cm',
      72,
      ''
    );
    expect(label.primary).toBe('Sam · Natural waist');
  });
});

describe('hit testing', () => {
  it('measures the perpendicular distance to a segment', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3, 6);
  });

  it('clamps to the segment ends', () => {
    expect(distanceToSegment({ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(4, 6);
    expect(distanceToSegment({ x: 14, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(4, 6);
  });

  it('handles a degenerate segment', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5, 6);
  });
});

describe('measurement picker tree', () => {
  it('lists every person with every field, in library order', () => {
    const sections = buildMeasurementMenu(library());
    expect(sections.map((s) => s.personName)).toEqual(['Alex', 'Samantha']);
    expect(sections[0]!.rows.length).toBe(MEASUREMENT_FIELDS.length);
    expect(sections[0]!.unit).toBe('cm');
    const waist = sections[0]!.rows.find((r) => r.fieldId === 'waist');
    expect(waist?.valueCm).toBe(72);
    expect(waist?.groupLabel).toBe('Torso & bust');
  });

  it('marks untaken measurements as null rather than dropping them', () => {
    const [alex] = buildMeasurementMenu(library());
    expect(alex!.rows.find((r) => r.fieldId === 'crotchDepth')?.valueCm).toBeNull();
  });

  it('splits a query into normalised tokens', () => {
    expect(measurementSearchTokens('Alex waist')).toEqual(['alex', 'waist']);
    expect(measurementSearchTokens('  Nape-to-waist  ')).toEqual(['nape', 'to', 'waist']);
    expect(measurementSearchTokens('')).toEqual([]);
  });

  it('prefers whole words over buried fragments', () => {
    const whole = fuzzyTokenScore('natural waist', 'waist');
    const buried = fuzzyTokenScore('natural waist', 'aist');
    expect(whole).toBeGreaterThan(buried);
    expect(buried).toBeGreaterThan(0);
  });

  it('falls back to an ordered subsequence for abbreviations and typos', () => {
    expect(fuzzyTokenScore('alex', 'alx')).toBeGreaterThan(0);
    expect(fuzzyTokenScore('natural waist', 'wst')).toBeGreaterThan(0);
    // Letters present but out of order is not a match.
    expect(fuzzyTokenScore('waist', 'tsiaw')).toBe(-1);
    expect(fuzzyTokenScore('waist', 'zzz')).toBe(-1);
  });

  it('will not start a fuzzy match mid-word', () => {
    // Without this rule "sam" reaches into outseam and the tree fills with noise.
    expect(fuzzyTokenScore('outseam', 'sam')).toBe(-1);
    expect(fuzzyTokenScore('shouldertowaistback', 'bust')).toBe(-1);
    // At a word boundary it is a genuine abbreviation.
    expect(fuzzyTokenScore('samantha', 'sam')).toBeGreaterThan(0);
  });
});

describe('measurement picker search', () => {
  const menu = () => buildMeasurementMenu(library());

  it('returns the whole tree for an empty query', () => {
    expect(filterMeasurementMenu(menu(), '')).toHaveLength(2);
    expect(filterMeasurementMenu(menu(), '   ')[0]!.rows).toHaveLength(MEASUREMENT_FIELDS.length);
  });

  it('matches a person and a measurement together', () => {
    // The example from the request: "Alex waist" → Alex's waist, first.
    const result = filterMeasurementMenu(menu(), 'Alex waist');
    expect(result.map((s) => s.personName)).toEqual(['Alex']);
    expect(result[0]!.rows[0]!.fieldId).toBe('waist');
    // Every remaining hit is still a waist measurement, not just anything Alex owns.
    for (const row of result[0]!.rows) {
      expect(`${row.label} ${row.fieldId}`.toLowerCase()).toContain('waist');
    }
    // Samantha has a waist too, but her name does not match "alex".
    expect(result).toHaveLength(1);
  });

  it('drops people who have no matching measurement', () => {
    const result = filterMeasurementMenu(menu(), 'alex inseam');
    expect(result.map((s) => s.personName)).toEqual(['Alex']);
  });

  it('matches a person name alone to everything they own', () => {
    // A bare name is a browse request: show that person's whole chart.
    const result = filterMeasurementMenu(menu(), 'sam');
    expect(result).toHaveLength(1);
    expect(result[0]!.personName).toBe('Samantha');
    expect(result[0]!.rows).toHaveLength(MEASUREMENT_FIELDS.length);
    expect(result[0]!.rows.find((r) => r.fieldId === 'waist')?.valueCm).toBe(68);
  });

  it('matches a measurement across everybody', () => {
    const result = filterMeasurementMenu(menu(), 'waist');
    expect(result.map((s) => s.personName)).toEqual(['Alex', 'Samantha']);
    for (const section of result) {
      expect(section.rows[0]!.fieldId).toBe('waist');
      expect(
        section.rows.every((r) => `${r.label} ${r.fieldId}`.toLowerCase().includes('waist'))
      ).toBe(true);
    }
  });

  it('finds measurements by drafting group', () => {
    const result = filterMeasurementMenu(menu(), 'alex leg');
    expect(result).toHaveLength(1);
    expect(result[0]!.rows.length).toBeGreaterThan(3);
    expect(result[0]!.rows.every((r) => r.groupLabel === 'Leg')).toBe(true);
  });

  it('finds camelCase field ids that the label does not spell out', () => {
    // "bustSpan" is labelled "Bust point to bust point".
    const result = filterMeasurementMenu(menu(), 'alex bustspan');
    expect(result[0]!.rows.map((r) => r.fieldId)).toEqual(['bustSpan']);
  });

  it('tolerates abbreviations', () => {
    const result = filterMeasurementMenu(menu(), 'alx wst');
    expect(result).toHaveLength(1);
    expect(result[0]!.personName).toBe('Alex');
    expect(result[0]!.rows[0]!.fieldId).toBe('waist');
  });

  it('surfaces an unmeasured field rather than hiding the gap', () => {
    // Samantha is matched by name, and "bust" reaches her group label — the row
    // shows up with no value, so it renders disabled and you learn it is missing.
    const result = filterMeasurementMenu(menu(), 'sam bust');
    expect(result).toHaveLength(1);
    const bust = result[0]!.rows.find((r) => r.fieldId === 'bust');
    expect(bust).toBeDefined();
    expect(bust!.valueCm).toBeNull();
  });

  it('ranks the strongest match first within a person', () => {
    const result = filterMeasurementMenu(menu(), 'alex bust');
    // The field actually called "bust" beats "Bust point to bust point".
    expect(result[0]!.rows[0]!.fieldId).toBe('bust');
  });

  it('reads an exact measurement name as that measurement, not its group', () => {
    // "bust" is both a field and half of the "Torso & bust" group name. The
    // group reading would bury it under every other torso measurement.
    const result = filterMeasurementMenu(menu(), 'alex bust');
    const ids = result[0]!.rows.map((r) => r.fieldId);
    // The field actually called "bust" wins; the rest are every other field
    // whose name mentions a bust, in whatever order the ranking puts them.
    expect(ids[0]).toBe('bust');
    expect([...ids].sort()).toEqual(
      ['bust', 'bustArc', 'bustSpan', 'highBust', 'neckToBustPoint', 'underBust'].sort()
    );
    expect(ids).not.toContain('neck');
    expect(ids).not.toContain('waist');
  });

  it('still reads a group name that is not also a measurement', () => {
    const result = filterMeasurementMenu(menu(), 'alex arm');
    expect(result).toHaveLength(1);
    const ids = result[0]!.rows.map((r) => r.fieldId);
    // The whole Arm group comes through...
    for (const id of ['upperArm', 'elbow', 'forearm', 'wrist', 'sleeveLength']) {
      expect(ids).toContain(id);
    }
    // ...alongside fields whose own name mentions an arm.
    expect(ids).toContain('armscyeDepth');
    expect(ids).not.toContain('waist');
  });

  it('returns nothing for a query that cannot match', () => {
    expect(filterMeasurementMenu(menu(), 'zzzzz')).toEqual([]);
  });
});

describe('ruler persistence', () => {
  it('round-trips a valid ruler', () => {
    const original = ruler({ measurementId: 'bust', personId: 'p1', personName: 'Alex', half: true });
    const [loaded] = normalizeRulers([original]);
    expect(loaded).toEqual(original);
  });

  it('drops entries that cannot be drawn', () => {
    const out = normalizeRulers([
      null,
      'nope',
      { id: 'no-center' },
      { id: 'bad-center', center: { x: NaN, y: 0 } },
      { id: '', center: { x: 0, y: 0 } },
      ruler({ id: 'ok' }),
    ]);
    expect(out.map((r) => r.id)).toEqual(['ok']);
  });

  it('coerces a partial entry into a drawable ruler', () => {
    const [loaded] = normalizeRulers([{ id: 'x', center: { x: 1, y: 2 } }]);
    expect(loaded).toEqual({
      id: 'x',
      center: { x: 1, y: 2 },
      angle: 0,
      lengthCm: 0,
      measurementId: null,
      personId: null,
      personName: '',
      half: false,
    });
  });

  it('returns an empty list for junk input', () => {
    expect(normalizeRulers(undefined)).toEqual([]);
    expect(normalizeRulers({})).toEqual([]);
  });
});
