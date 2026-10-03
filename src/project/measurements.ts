import type { UnitDisplay } from './types';

/**
 * Body measurements used by tailors and patternmakers, grouped the way a
 * measurement chart is usually laid out.
 *
 * The names follow the drafting literature (Aldrich, Seamly, draping blocks):
 * girths around the body plus the vertical "depth" measures that set armhole,
 * bust and crotch placement. `tip` is the standard instruction for where the
 * tape goes — the same wording a teacher would give.
 */
export type MeasurementGroup = 'torso' | 'vertical' | 'arm' | 'leg' | 'general';

export type MeasurementField = {
  id: string;
  label: string;
  group: MeasurementGroup;
  /** How to take it. */
  tip: string;
};

export const MEASUREMENT_GROUPS: Array<{ id: MeasurementGroup; label: string }> = [
  { id: 'torso', label: 'Torso & bust' },
  { id: 'vertical', label: 'Vertical lengths' },
  { id: 'arm', label: 'Arm' },
  { id: 'leg', label: 'Leg' },
  { id: 'general', label: 'General' },
];

export const MEASUREMENT_FIELDS: MeasurementField[] = [
  // Torso — girths and widths.
  {
    id: 'neck',
    label: 'Neck',
    group: 'torso',
    tip: 'Around the base of the neck, through the collarbone notch.',
  },
  {
    id: 'highBust',
    label: 'High bust',
    group: 'torso',
    tip: 'Around the chest, above the bust and under the arms.',
  },
  {
    id: 'bust',
    label: 'Full bust / chest',
    group: 'torso',
    tip: 'Around the fullest part of the bust (or chest), tape level and not pulled tight.',
  },
  {
    id: 'underBust',
    label: 'Underbust',
    group: 'torso',
    tip: 'Around the ribcage directly under the bust.',
  },
  {
    id: 'waist',
    label: 'Natural waist',
    group: 'torso',
    tip: 'Around the narrowest part of the torso — bend sideways, the crease is the waist.',
  },
  {
    id: 'highHip',
    label: 'High hip',
    group: 'torso',
    tip: 'Around the hip bone, roughly 8 cm below the waist.',
  },
  {
    id: 'hip',
    label: 'Full hip',
    group: 'torso',
    tip: 'Around the fullest part of the seat, roughly 20 cm below the waist.',
  },
  {
    id: 'bustSpan',
    label: 'Bust point to bust point',
    group: 'torso',
    tip: 'Between the two bust apexes — sets dart placement.',
  },
  {
    id: 'acrossBack',
    label: 'Across back',
    group: 'torso',
    tip: 'Shoulder blade to shoulder blade, about 10 cm below the neck.',
  },
  {
    id: 'acrossFront',
    label: 'Across chest',
    group: 'torso',
    tip: 'Armhole crease to armhole crease across the front of the chest.',
  },
  {
    id: 'shoulderWidth',
    label: 'Shoulder width',
    group: 'torso',
    tip: 'Shoulder tip to shoulder tip, measured across the back.',
  },
  {
    id: 'shoulderLength',
    label: 'Shoulder length',
    group: 'torso',
    tip: 'Neck point to shoulder tip — one shoulder, not both.',
  },
  {
    id: 'backNeck',
    label: 'Back neck',
    group: 'torso',
    tip: 'From the nape across to the shoulder point — the back neckline width.',
  },
  {
    id: 'bustArc',
    label: 'Bust arc',
    group: 'torso',
    tip: 'From the centre front, over the bust, to the underarm crease at the side seam.',
  },
  {
    id: 'backArc',
    label: 'Back arc',
    group: 'torso',
    tip: 'From the centre back, over the shoulder blade, to the underarm crease at the side seam.',
  },
  {
    id: 'waistArc',
    label: 'Waist arc',
    group: 'torso',
    tip: 'From the centre front (or back) along the waist line to the side seam — a quarter of the waist, roughly.',
  },
  {
    id: 'hipArc',
    label: 'Hip arc',
    group: 'torso',
    tip: 'From the centre front (or back) along the hip line to the side seam.',
  },
  {
    id: 'dartPlacement',
    label: 'Dart placement',
    group: 'torso',
    tip: 'From the centre front (or back) along the waist to where the first dart sits.',
  },

  // Vertical — the depth measures a block is drafted from.
  {
    id: 'napeToWaist',
    label: 'Nape to waist (centre back)',
    group: 'vertical',
    tip: 'From the prominent bone at the neck base straight down to the waist line.',
  },
  {
    id: 'shoulderToWaistBack',
    label: 'Shoulder to waist, back',
    group: 'vertical',
    tip: 'From the shoulder tip at the neck, over the shoulder blade, to the waist.',
  },
  {
    id: 'shoulderToWaistFront',
    label: 'Shoulder to waist, front',
    group: 'vertical',
    tip: 'From the shoulder tip at the neck, over the bust apex, to the waist.',
  },
  {
    id: 'armscyeDepth',
    label: 'Armscye / armhole depth',
    group: 'vertical',
    tip: 'From the nape down to a tape held level under the arms.',
  },
  {
    id: 'neckToBustPoint',
    label: 'Nape to bust point',
    group: 'vertical',
    tip: 'From the nape to the bust apex — the bust depth of a bodice block.',
  },
  {
    id: 'waistToHip',
    label: 'Waist to hip',
    group: 'vertical',
    tip: 'Down the side from the waist line to the fullest part of the hip.',
  },
  {
    id: 'crotchDepth',
    label: 'Crotch depth / rise',
    group: 'vertical',
    tip: 'Sitting on a hard chair, from the waist line down to the seat.',
  },
  {
    id: 'height',
    label: 'Height',
    group: 'vertical',
    tip: 'Standing straight, without shoes.',
  },
  {
    id: 'centerFrontLength',
    label: 'Centre front / back length',
    group: 'vertical',
    tip: 'From the hollow at the front of the neck (or the nape) straight down to the waist line.',
  },
  {
    id: 'sideLength',
    label: 'Side length',
    group: 'vertical',
    tip: 'Down the side from a tape held level under the arm to the waist line — the underarm seam.',
  },
  {
    id: 'shoulderSlope',
    label: 'Shoulder slope',
    group: 'vertical',
    tip: 'The drop from a level line at the nape across to the shoulder tip.',
  },
  {
    id: 'hipDepth',
    label: 'Hip depth (centre)',
    group: 'vertical',
    tip: 'From the waist line straight down the centre front (or back) to the fullest part of the hip.',
  },
  {
    id: 'sideHipDepth',
    label: 'Hip depth (side)',
    group: 'vertical',
    tip: 'From the waist line down the side seam to the fullest part of the hip. Larger than the centre depth on a curved seat.',
  },

  // Arm.
  {
    id: 'shoulderToElbow',
    label: 'Shoulder to elbow',
    group: 'arm',
    tip: 'Arm bent, from the shoulder tip over the point of the elbow.',
  },
  {
    id: 'sleeveLength',
    label: 'Shoulder to wrist (sleeve)',
    group: 'arm',
    tip: 'Arm bent, from the shoulder tip over the elbow to the wrist bone.',
  },
  {
    id: 'underarmToWrist',
    label: 'Underarm to wrist',
    group: 'arm',
    tip: 'From the underarm crease to the wrist bone — the sleeve underarm seam.',
  },
  {
    id: 'upperArm',
    label: 'Upper arm / bicep',
    group: 'arm',
    tip: 'Around the fullest part of the upper arm.',
  },
  {
    id: 'elbow',
    label: 'Elbow',
    group: 'arm',
    tip: 'Around the arm with the elbow bent 90°.',
  },
  {
    id: 'forearm',
    label: 'Forearm',
    group: 'arm',
    tip: 'Around the fullest part of the forearm below the elbow.',
  },
  {
    id: 'wrist',
    label: 'Wrist',
    group: 'arm',
    tip: 'Around the wrist bone — sets the sleeve hem width.',
  },

  // Leg.
  {
    id: 'inseam',
    label: 'Inseam',
    group: 'leg',
    tip: 'From the crotch down the inside of the leg to the ankle bone.',
  },
  {
    id: 'outseam',
    label: 'Outseam',
    group: 'leg',
    tip: 'From the waist down the outside of the leg to the ankle bone.',
  },
  {
    id: 'trouserLength',
    label: 'Trouser length',
    group: 'leg',
    tip: 'From the waist to the finished hem, down the outside of the leg.',
  },
  {
    id: 'thigh',
    label: 'Thigh',
    group: 'leg',
    tip: 'Around the fullest part of the upper thigh.',
  },
  {
    id: 'knee',
    label: 'Knee',
    group: 'leg',
    tip: 'Around the knee with the leg straight.',
  },
  {
    id: 'calf',
    label: 'Calf',
    group: 'leg',
    tip: 'Around the fullest part of the calf.',
  },
  {
    id: 'ankle',
    label: 'Ankle',
    group: 'leg',
    tip: 'Around the ankle bone.',
  },

  // General.
  {
    id: 'weight',
    label: 'Weight',
    group: 'general',
    tip: 'Optional, in kg. Useful as a sanity check when grading the rest of the set.',
  },
];

/** Units a field is stored in. Everything except weight is a length. */
export function isWeightField(fieldId: string): boolean {
  return fieldId === 'weight';
}

/**
 * Measurements a 3D avatar must supply to drive generation — one per MakeHuman
 * slider. Everything else is derived from the generated model.
 */
export const MANDATORY_MEASUREMENT_IDS: readonly string[] = [
  'height',
  'neck',
  'bust',
  'underBust',
  'waist',
  'hip',
  'shoulderLength',
  'napeToWaist',
  'waistToHip',
  'upperArm',
  'wrist',
  'thigh',
  'knee',
  'calf',
  'ankle',
  'inseam',
  'shoulderToElbow',
  'sleeveLength',
];

/**
 * Defaults for the mandatory measurements, in centimetres.
 *
 * These are the measurements of the generator's own neutral body (MakeHuman
 * default proportions at 170 cm, average gender), so a new avatar generates
 * without any slider being pushed out of range.
 */
export const DEFAULT_MEASUREMENT_CM: Record<string, number> = {
  height: 170,
  neck: 33.2,
  bust: 88.3,
  underBust: 74.6,
  waist: 73.3,
  hip: 93.5,
  shoulderLength: 13.6,
  napeToWaist: 37.6,
  waistToHip: 18.7,
  upperArm: 25.1,
  wrist: 13.7,
  thigh: 52.8,
  knee: 34.8,
  calf: 36.7,
  ankle: 19.9,
  inseam: 85.2,
  shoulderToElbow: 27.2,
  sleeveLength: 50.3,
};

/**
 * Defaults converted into the display unit.
 *
 * Pass the avatar's own height to get the neutral body scaled to that height,
 * which keeps the defaults inside the generator's achievable range.
 */
export function defaultMeasurementValues(
  unit: UnitDisplay,
  heightCm: number = DEFAULT_MEASUREMENT_CM.height!
): Record<string, number> {
  const scale = heightCm / DEFAULT_MEASUREMENT_CM.height!;
  const out: Record<string, number> = {};
  for (const [id, cm] of Object.entries(DEFAULT_MEASUREMENT_CM)) {
    const value = id === 'height' ? heightCm : cm * scale;
    out[id] = unit === 'in' ? Math.round((value / 2.54) * 10) / 10 : Math.round(value * 10) / 10;
  }
  return out;
}

/** The avatar's own height in cm, or undefined when it has not been entered. */
export function measurementHeightCm(
  values: Record<string, number>,
  unit: UnitDisplay
): number | undefined {
  const raw = values.height;
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
  return unit === 'in' ? raw * 2.54 : raw;
}

/** A named set of measurements — one "person" you draft for. */
export type MeasurementSet = {
  id: string;
  name: string;
  /** Display unit for this person's numbers. */
  unit: UnitDisplay;
  /** Field id → value. Missing means "not taken yet". */
  values: Record<string, number>;
  updatedAt: number;
};

export type MeasurementLibrary = {
  sets: MeasurementSet[];
  activeId: string | null;
};

export function newMeasurementSet(name: string, unit: UnitDisplay = 'cm'): MeasurementSet {
  return {
    id: `mset_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name,
    unit,
    values: {},
    updatedAt: Date.now(),
  };
}

/** Blank library with a single person, used on first run. */
export function createDefaultMeasurementLibrary(): MeasurementLibrary {
  const first = newMeasurementSet('Person 1');
  return { sets: [first], activeId: first.id };
}

/** Defensive load — tolerates partial / hand-edited payloads. */
export function normalizeMeasurementLibrary(raw: unknown): MeasurementLibrary {
  const source = (raw ?? {}) as Partial<MeasurementLibrary>;
  const sets: MeasurementSet[] = [];
  if (Array.isArray(source.sets)) {
    for (const entry of source.sets) {
      if (!entry || typeof entry !== 'object') continue;
      const set = entry as Partial<MeasurementSet>;
      if (typeof set.id !== 'string' || !set.id) continue;
      const values: Record<string, number> = {};
      for (const [key, value] of Object.entries(set.values ?? {})) {
        const n = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(n)) values[key] = n;
      }
      sets.push({
        id: set.id,
        name: typeof set.name === 'string' && set.name ? set.name : 'Unnamed',
        unit: set.unit === 'in' ? 'in' : 'cm',
        values,
        updatedAt: typeof set.updatedAt === 'number' ? set.updatedAt : Date.now(),
      });
    }
  }
  if (sets.length === 0) return createDefaultMeasurementLibrary();
  const activeId = sets.some((s) => s.id === source.activeId)
    ? (source.activeId as string)
    : sets[0]!.id;
  return { sets, activeId };
}
