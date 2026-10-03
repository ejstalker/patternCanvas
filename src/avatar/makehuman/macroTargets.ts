/**
 * MakeHuman macro-detail weighting, ported from `makehuman/apps/human.py`
 * (`_setGenderVals`, `_setHeightVals`) and
 * `makehuman/apps/humanmodifier.py` (`getTargetWeights`).
 *
 * Scope: gender + height are variable; age is fixed to "young" (25y), race to
 * "caucasian", muscle and weight to "average". Each macro target's weight is the
 * product of the factor values named by its filename tokens.
 */

import { MH_MEASURE_RULERS } from './ruler';

export type MacroFactors = Record<string, number>;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Female <-> male is 0..1 (`Human.setGender`); height is 0..1 (`Human.setHeight`). */
export function macroFactors(gender: number, height: number): MacroFactors {
  const g = clamp01(gender);
  const h = clamp01(height);

  const maxheightVal = Math.max(0, h * 2 - 1);
  const minheightVal = Math.max(0, 1 - h * 2);
  const averageheightVal = Math.max(0, 1 - maxheightVal - minheightVal);

  return {
    // Gender.
    male: g,
    female: 1 - g,
    // Age fixed to young (25y).
    baby: 0,
    child: 0,
    young: 1,
    old: 0,
    // Race fixed to caucasian.
    caucasian: 1,
    asian: 0,
    african: 0,
    // Muscle fixed to average.
    maxmuscle: 0,
    averagemuscle: 1,
    minmuscle: 0,
    // Weight fixed to average.
    maxweight: 0,
    averageweight: 1,
    minweight: 0,
    // Height ramp.
    maxheight: maxheightVal,
    averageheight: averageheightVal,
    minheight: minheightVal,
  };
}

/** Macro target basenames we vendor (gender/age=young/muscle=average/weight=average/race=caucasian). */
export const MACRO_TARGETS: readonly string[] = [
  'caucasian-female-young',
  'caucasian-male-young',
  'universal-female-young-averagemuscle-averageweight',
  'universal-male-young-averagemuscle-averageweight',
  'female-young-averagemuscle-averageweight-minheight',
  'female-young-averagemuscle-averageweight-maxheight',
  'male-young-averagemuscle-averageweight-minheight',
  'male-young-averagemuscle-averageweight-maxheight',
];

/** Product of factor values for every token in a macro target name that is a known factor. */
export function targetWeight(name: string, factors: MacroFactors): number {
  let weight = 1;
  for (const token of name.split('-')) {
    const value = factors[token];
    if (value !== undefined) weight *= value;
  }
  return weight;
}

export type TargetRequest = { name: string; weight: number };

/** Macro target requests for the current gender/height. Zero-weight targets are dropped. */
export function macroTargetRequests(gender: number, height: number): TargetRequest[] {
  const factors = macroFactors(gender, height);
  const out: TargetRequest[] = [];
  for (const name of MACRO_TARGETS) {
    const weight = targetWeight(name, factors);
    if (weight !== 0) out.push({ name, weight });
  }
  return out;
}

/** Measure target requests for a signed slider value in [-1, 1] (decr for negative, incr for positive). */
export function measureTargetRequests(measure: string, value: number): TargetRequest[] {
  const v = value < -1 ? -1 : value > 1 ? 1 : value;
  if (v < 0) return [{ name: `measure-${measure}-decr`, weight: -v }];
  if (v > 0) return [{ name: `measure-${measure}-incr`, weight: v }];
  return [];
}

/** All measure target basenames we need to load (both directions of every ruler). */
export function allMeasureTargetNames(): string[] {
  const names: string[] = [];
  for (const measure of Object.keys(MH_MEASURE_RULERS)) {
    names.push(`measure-${measure}-decr`, `measure-${measure}-incr`);
  }
  return names;
}
