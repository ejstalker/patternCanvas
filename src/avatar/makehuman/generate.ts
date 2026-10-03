/**
 * Measurement-driven avatar generation.
 *
 * Mirrors the MakeHuman measurement workflow
 * (`makehuman/plugins/0_modeling_a_measurement.py`): build a weighted target
 * stack, then bisect each measurement slider until the traced polyline length
 * matches the requested value. Solver assumes each measure grows monotonically
 * with its slider, which holds for the shipped measure targets.
 */

import { applyTargets, type TargetEntry } from './morphEngine';
import type { TargetDelta } from './targetFile';
import { macroTargetRequests, measureTargetRequests, type TargetRequest } from './macroTargets';
import { heightCm, measureCm } from './ruler';
import { deriveMeasurements, DERIVED_FIELDS } from './derivedMeasurements';

/** Resolves a target basename to its delta table; returns null when unavailable. */
export type TargetResolver = (name: string) => TargetDelta | null;

/** Avatar measurement field -> MakeHuman ruler(s) that read it back off the mesh. */
export const FIELD_READERS: Record<string, readonly string[]> = {
  neck: ['neck-circ'],
  bust: ['bust-circ'],
  underBust: ['underbust-circ'],
  waist: ['waist-circ'],
  hip: ['hips-circ'],
  shoulderLength: ['shoulder-dist'],
  napeToWaist: ['napetowaist-dist'],
  waistToHip: ['waisttohip-dist'],
  upperArm: ['upperarm-circ'],
  wrist: ['wrist-circ'],
  thigh: ['thigh-circ'],
  knee: ['knee-circ'],
  calf: ['calf-circ'],
  ankle: ['ankle-circ'],
  inseam: ['upperleg-height', 'lowerleg-height'],
  shoulderToElbow: ['upperarm-length'],
  sleeveLength: ['upperarm-length', 'lowerarm-length'],
  underarmToWrist: ['lowerarm-length'],
};

/** Avatar measurement field -> MakeHuman measure slider(s) that drive it. */
export const FIELD_DRIVERS: Record<string, readonly string[]> = {
  neck: ['neck-circ'],
  bust: ['bust-circ'],
  underBust: ['underbust-circ'],
  waist: ['waist-circ'],
  hip: ['hips-circ'],
  shoulderLength: ['shoulder-dist'],
  napeToWaist: ['napetowaist-dist'],
  waistToHip: ['waisttohip-dist'],
  upperArm: ['upperarm-circ'],
  wrist: ['wrist-circ'],
  thigh: ['thigh-circ'],
  knee: ['knee-circ'],
  calf: ['calf-circ'],
  ankle: ['ankle-circ'],
  inseam: ['upperleg-height', 'lowerleg-height'],
  shoulderToElbow: ['upperarm-length'],
  sleeveLength: ['upperarm-length', 'lowerarm-length'],
};

/** Landmark vertex indices (MakeHuman numbering) used for point derivations. */
const LANDMARKS = {
  waist: 4181,
  crotch: 10970,
  hip: 4341,
  nape: 1491,
  shoulderTip: 8274,
} as const;

/**
 * Fields derived from landmark vertices (cm) rather than a ruler polyline —
 * simple vertical distances between known landmarks.
 */
export const LANDMARK_READERS: Record<string, (positions: Float32Array) => number> = {
  crotchDepth: (p) => (p[LANDMARKS.waist * 3 + 1]! - p[LANDMARKS.crotch * 3 + 1]!) * 10,
  hipDepth: (p) => (p[LANDMARKS.waist * 3 + 1]! - p[LANDMARKS.hip * 3 + 1]!) * 10,
  shoulderSlope: (p) => (p[LANDMARKS.nape * 3 + 1]! - p[LANDMARKS.shoulderTip * 3 + 1]!) * 10,
};

/** Every field the model can produce a value for (rulers, landmarks, slices, and stature). */
export function readableFields(): string[] {
  return [
    ...Object.keys(FIELD_READERS),
    ...Object.keys(LANDMARK_READERS),
    ...DERIVED_FIELDS,
    'height',
  ];
}

/** Readable fields the user does not have to supply (not generation drivers). */
export function autoCapableFields(): string[] {
  const drivers = new Set([...Object.keys(FIELD_DRIVERS), 'height']);
  return readableFields().filter((field) => !drivers.has(field));
}

/** Order sliders are solved in; later fields win when they share a slider. */
const SOLVE_ORDER: readonly string[] = [
  'inseam',
  'napeToWaist',
  'waistToHip',
  'neck',
  'bust',
  'underBust',
  'waist',
  'hip',
  'shoulderLength',
  'upperArm',
  'wrist',
  'thigh',
  'knee',
  'calf',
  'ankle',
  'shoulderToElbow',
  'sleeveLength',
];

export type GenerateInput = {
  /** Full base mesh positions in decimetres (MakeHuman vertex numbering). */
  base: Float32Array;
  /** Body-only triangle indices into `base` — used for plane slicing. */
  indices?: Uint32Array;
  resolve: TargetResolver;
  /** 0 = female, 1 = male. */
  gender: number;
  /** Target stature in cm; omitted keeps the MakeHuman average. */
  heightCm?: number;
  /** Entered measurements in cm, keyed by avatar field id. */
  measurements?: Record<string, number>;
  /** Solver re-passes over the driver list for convergence. */
  passes?: number;
};

export type GenerateResult = {
  /** Full deformed vertex array (decimetres, MakeHuman vertex numbering). */
  positions: Float32Array;
  /** Target basename -> applied weight. */
  weights: Map<string, number>;
  /** Every readable field, measured off the final mesh (cm). */
  measured: Record<string, number>;
  /** Entered fields that were solved for. */
  driven: string[];
  /** Entered fields with no MakeHuman driver (derived-only). */
  underived: string[];
  /** Driven fields whose goal was outside the MakeHuman slider range (goal not reached). */
  saturated: string[];
  /** Plane-slice/landmark measurement polylines (decimetres) keyed by field. */
  rulerPolylines: Record<string, Float32Array>;
};

const SOLVE_ITERATIONS = 36;

function addWeight(weights: Map<string, number>, request: TargetRequest): void {
  weights.set(request.name, (weights.get(request.name) ?? 0) + request.weight);
}

class Solver {
  readonly weights = new Map<string, number>();
  private heightSlider = 0.5;
  private measureSliders: Record<string, number> = {};
  private lastPositions: Float32Array | null = null;

  constructor(
    private readonly base: Float32Array,
    private readonly resolve: TargetResolver,
    private readonly gender: number
  ) {}

  positions(): Float32Array {
    if (!this.lastPositions) this.apply();
    return this.lastPositions!;
  }

  private apply(): Float32Array {
    this.weights.clear();
    for (const request of macroTargetRequests(this.gender, this.heightSlider)) {
      addWeight(this.weights, request);
    }
    for (const [measure, value] of Object.entries(this.measureSliders)) {
      for (const request of measureTargetRequests(measure, value)) addWeight(this.weights, request);
    }

    const entries: TargetEntry[] = [];
    for (const [name, weight] of this.weights) {
      const delta = this.resolve(name);
      if (delta) entries.push({ delta, weight });
    }

    this.lastPositions = applyTargets(this.base, entries);
    return this.lastPositions;
  }

  private setSliders(names: readonly string[], value: number): Float32Array {
    for (const name of names) this.measureSliders[name] = value;
    return this.apply();
  }

  /** Bisect the macro height knob so the mesh's stature matches `goalCm`. */
  solveHeight(goalCm: number): void {
    const at = (h: number): number => {
      this.heightSlider = h;
      return heightCm(this.apply());
    };
    let lo = 0;
    let hi = 1;
    if (goalCm <= at(lo)) {
      this.heightSlider = lo;
      this.apply();
      return;
    }
    if (goalCm >= at(hi)) {
      this.heightSlider = hi;
      this.apply();
      return;
    }
    for (let i = 0; i < SOLVE_ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid) < goalCm) lo = mid;
      else hi = mid;
    }
    this.heightSlider = (lo + hi) / 2;
    this.apply();
  }

  /** Bisect a group of measure sliders (driven together) so the summed measure matches `goalCm`. */
  solveMeasure(names: readonly string[], goalCm: number): void {
    const at = (value: number): number => measureCm(this.setSliders(names, value), names);
    let lo = -1;
    let hi = 1;
    if (goalCm <= at(lo)) {
      this.setSliders(names, lo);
      return;
    }
    if (goalCm >= at(hi)) {
      this.setSliders(names, hi);
      return;
    }
    for (let i = 0; i < SOLVE_ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid) < goalCm) lo = mid;
      else hi = mid;
    }
    this.setSliders(names, (lo + hi) / 2);
  }
}

export function generateAvatar(input: GenerateInput): GenerateResult {
  const solver = new Solver(input.base, input.resolve, input.gender);
  const measurements = input.measurements ?? {};
  const driven: string[] = [];
  const underived: string[] = [];

  const goals = SOLVE_ORDER.filter((field) => measurements[field] !== undefined);
  const hasHeight = input.heightCm !== undefined;
  if (hasHeight) driven.push('height');

  // Height and leg-length sliders interact, so re-solve height each pass.
  const passes = Math.max(1, input.passes ?? 8);
  for (let pass = 0; pass < passes; pass++) {
    if (hasHeight) solver.solveHeight(input.heightCm!);
    for (const field of goals) solver.solveMeasure(FIELD_DRIVERS[field]!, measurements[field]!);
  }
  driven.push(...goals);

  for (const field of Object.keys(measurements)) {
    if (field !== 'height' && !FIELD_DRIVERS[field]) underived.push(field);
  }

  const positions = solver.positions();

  const measured: Record<string, number> = {};
  for (const [field, names] of Object.entries(FIELD_READERS)) {
    measured[field] = measureCm(positions, names);
  }
  for (const [field, read] of Object.entries(LANDMARK_READERS)) {
    measured[field] = read(positions);
  }
  const derived = deriveMeasurements(positions, input.indices ?? new Uint32Array());
  Object.assign(measured, derived.values);
  measured.height = heightCm(positions);

  const saturated: string[] = [];
  const TOLERANCE_CM = 0.5;
  if (hasHeight && Math.abs(measured.height - input.heightCm!) > TOLERANCE_CM) {
    saturated.push('height');
  }
  for (const field of goals) {
    if (Math.abs((measured[field] ?? 0) - measurements[field]!) > TOLERANCE_CM) {
      saturated.push(field);
    }
  }

  return {
    positions,
    weights: new Map(solver.weights),
    measured,
    driven,
    underived,
    saturated,
    rulerPolylines: derived.polylines,
  };
}
