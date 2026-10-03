import { describe, expect, it } from 'vitest';
import { parseTarget } from './targetFile';
import { applyTargets } from './morphEngine';
import { macroFactors, measureTargetRequests, targetWeight } from './macroTargets';
import { heightCm, measurePolylineCm } from './ruler';
import { autoCapableFields, FIELD_DRIVERS, generateAvatar, type TargetResolver } from './generate';
import {
  DEFAULT_MEASUREMENT_CM,
  MANDATORY_MEASUREMENT_IDS,
} from '../../project/measurements';
import type { TargetDelta } from './targetFile';

const MAX_VERT = 13029; // highest index used by the shipped rulers

function emptyBase(): Float32Array {
  return new Float32Array(MAX_VERT * 3);
}

function setVert(positions: Float32Array, index: number, x: number, y: number, z: number): void {
  positions[index * 3] = x;
  positions[index * 3 + 1] = y;
  positions[index * 3 + 2] = z;
}

function delta(entries: Array<[number, number, number, number]>): TargetDelta {
  return {
    indices: Uint32Array.from(entries.map(([i]) => i)),
    deltas: Float32Array.from(entries.flatMap(([, x, y, z]) => [x, y, z])),
  };
}

describe('mandatory measurements', () => {
  it('matches the generator drivers exactly', () => {
    const drivers = [...Object.keys(FIELD_DRIVERS), 'height'].sort();
    expect([...MANDATORY_MEASUREMENT_IDS].sort()).toEqual(drivers);
  });

  it('has a positive default for every mandatory measurement', () => {
    for (const id of MANDATORY_MEASUREMENT_IDS) {
      expect(DEFAULT_MEASUREMENT_CM[id], id).toBeGreaterThan(0);
    }
  });

  it('never marks a mandatory measurement as auto-capable', () => {
    const mandatory = new Set(MANDATORY_MEASUREMENT_IDS);
    for (const field of autoCapableFields()) expect(mandatory.has(field), field).toBe(false);
  });
});

describe('parseTarget', () => {
  it('parses vertex translation lines and ignores comments', () => {
    const text = '# header\n\n0 1 2 3\n4 -1 -2 -3\n';
    const parsed = parseTarget(text);
    expect(Array.from(parsed.indices)).toEqual([0, 4]);
    expect(Array.from(parsed.deltas)).toEqual([1, 2, 3, -1, -2, -3]);
  });
});

describe('applyTargets', () => {
  it('adds weight * delta per affected vertex', () => {
    const base = new Float32Array([1, 2, 3, 4, 5, 6]);
    const d = delta([
      [1, 10, 0, 0],
      [0, 0, 20, 0],
    ]);
    const out = applyTargets(base, [{ delta: d, weight: 0.5 }]);
    expect(Array.from(out)).toEqual([1, 2 + 10, 3, 4 + 5, 5, 6]);
    expect(Array.from(base)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('macro weighting', () => {
  it('maps gender 0/1 to female/male', () => {
    expect(macroFactors(0, 0.5).female).toBe(1);
    expect(macroFactors(0, 0.5).male).toBe(0);
    expect(macroFactors(1, 0.5).male).toBe(1);
    expect(macroFactors(0.25, 0.5).male).toBeCloseTo(0.25);
  });

  it('ramps height at the extremes only', () => {
    expect(macroFactors(0, 1).maxheight).toBeCloseTo(1);
    expect(macroFactors(0, 1).minheight).toBe(0);
    expect(macroFactors(0, 0).minheight).toBeCloseTo(1);
    expect(macroFactors(0, 0.5).maxheight).toBe(0);
    expect(macroFactors(0, 0.5).minheight).toBe(0);
  });

  it('multiplies the factor values named by the target', () => {
    const f = macroFactors(0.3, 0.5);
    expect(targetWeight('caucasian-female-young', f)).toBeCloseTo(0.7);
    expect(targetWeight('universal-male-young-averagemuscle-averageweight', f)).toBeCloseTo(0.3);
  });

  it('splits measure sliders into decr/incr requests', () => {
    expect(measureTargetRequests('waist-circ', 0.4)).toEqual([
      { name: 'measure-waist-circ-incr', weight: 0.4 },
    ]);
    expect(measureTargetRequests('waist-circ', -0.4)).toEqual([
      { name: 'measure-waist-circ-decr', weight: 0.4 },
    ]);
    expect(measureTargetRequests('waist-circ', 0)).toEqual([]);
  });
});

describe('ruler', () => {
  it('sums polyline segments in cm', () => {
    const positions = new Float32Array(9);
    // vertices 0,1,2 along +x at x = 0, 1, 2 decimetres
    positions[0] = 0;
    positions[3] = 1;
    positions[6] = 2;
    expect(measurePolylineCm(positions, [0, 1, 2])).toBeCloseTo(20);
  });

  it('measures height from the y bounding box', () => {
    const positions = new Float32Array(6);
    positions[1] = 0;
    positions[4] = 17; // 17 dm = 170 cm
    expect(heightCm(positions)).toBeCloseTo(170);
  });
});

describe('generateAvatar', () => {
  it('drives a measure slider to the requested value', () => {
    const base = emptyBase();
    setVert(base, 8274, 0, 0, 0);
    setVert(base, 10037, 10, 0, 0);

    const targets = new Map<string, TargetDelta>([
      ['measure-upperarm-length-incr', delta([[10037, 10, 0, 0]])],
      ['measure-upperarm-length-decr', delta([[10037, -10, 0, 0]])],
    ]);
    const resolve: TargetResolver = (name) => targets.get(name) ?? null;

    const result = generateAvatar({
      base,
      resolve,
      gender: 0,
      measurements: { shoulderToElbow: 150 },
    });

    expect(result.measured.shoulderToElbow).toBeCloseTo(150, 1);
    const w = result.weights.get('measure-upperarm-length-incr') ?? 0;
    expect(w).toBeCloseTo(0.5, 2);
  });

  it('drives stature through the macro height ramp', () => {
    const base = emptyBase();
    setVert(base, 0, 0, 0, 0);
    setVert(base, 1, 0, 17, 0);

    const targets = new Map<string, TargetDelta>([
      ['female-young-averagemuscle-averageweight-maxheight', delta([[1, 0, 1, 0]])],
    ]);
    const resolve: TargetResolver = (name) => targets.get(name) ?? null;

    const result = generateAvatar({ base, resolve, gender: 0, heightCm: 175 });
    expect(result.measured.height).toBeCloseTo(175, 1);
  });

  it('reports entered fields with no driver as underived', () => {
    const base = emptyBase();
    setVert(base, 0, 0, 0, 0);
    setVert(base, 1, 0, 17, 0);
    const result = generateAvatar({
      base,
      resolve: () => null,
      gender: 0.5,
      measurements: { bustSpan: 18, waist: 70 },
    });
    expect(result.underived).toContain('bustSpan');
    expect(result.driven).not.toContain('bustSpan');
  });
});
