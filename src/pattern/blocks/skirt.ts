import type { BlockVariableDecl, Vec2 } from '../../project/types';
import type { BlockDefinition, BlockPieceSpec, BlockPointSpec } from './spec';

/**
 * Basic skirt block — Armstrong, *Patternmaking for Fashion Design*, Figures 1–4
 * (pp. 48–50).
 *
 * The draft is one rectangle split down the side seam: back panel to the left,
 * front to the right. Each panel covers a quarter of the body, so every width is
 * an **arc** (centre to side seam), never a circumference.
 *
 * Two things in the book take a moment to read, and both matter:
 *
 * - The rectangle's top edge is a *level* line through the centre waist. The
 *   side-seam waist point sits **above** it by (side hip depth − centre hip
 *   depth): the hip sits further from the waist at the side than at the centre,
 *   so the side seam is longer and its waist rides higher.
 * - A dart is a notch in the outline — the boundary dives to the apex and comes
 *   back up. That is why this needs no holes, and fits `PatternPiece` as-is.
 *
 * The book's constants are imperial. Everything here is canonical cm, with the
 * inch figure kept in each variable's note.
 */

/** 1/4" waist ease, per panel. */
const WAIST_EASE_IN = 0.635;
/** 1/2" hip ease, per panel. */
const HIP_EASE_IN = 1.27;
/** 1 1/4" between two darts on one panel. */
const DART_SPACE_IN = 3.175;
/** 5 1/2" back dart (5" for juniors and petites). */
const BACK_DART_LENGTH_IN = 13.97;
/** 3 1/2" front dart. */
const FRONT_DART_LENGTH_IN = 8.89;
/** 1" total front intake, from the Personal Dart Intake Chart. */
const FRONT_DART_INTAKE_IN = 2.54;
/** 2" total back intake — the chart's mid-range figure. */
const BACK_DART_INTAKE_IN = 5.08;
/** 2 1/4" finished band depth. */
const WAISTBAND_DEPTH_IN = 5.715;
/** 1" band ease and overlap. */
const WAISTBAND_OVERLAP_IN = 2.54;
/** Breathing room between pieces on the sheet. */
const PANEL_GAP_CM = 6;

const VARIABLES: BlockVariableDecl[] = [
  // Lengths.
  {
    id: 'skirtLength',
    label: 'Skirt length',
    group: 'Lengths',
    defaultValueCm: 60,
    minCm: 25,
    maxCm: 110,
    note: 'A to B — as desired. No body measurement fixes this.',
  },
  {
    id: 'hipDepth',
    label: 'Hip depth, centre (25)',
    group: 'Lengths',
    suggested: { fieldId: 'hipDepth', divisor: 1, offsetCm: 0 },
    defaultValueCm: 20,
    minCm: 8,
    maxCm: 40,
    note: 'Waist line down the centre to the fullest part of the hip.',
  },
  {
    id: 'sideHipDepth',
    label: 'Hip depth, side (26)',
    group: 'Lengths',
    suggested: { fieldId: 'sideHipDepth', divisor: 1, offsetCm: 0 },
    defaultValueCm: 21,
    minCm: 8,
    maxCm: 42,
    note: 'C to P. Larger than the centre depth — that is what lifts the side waist.',
  },
  {
    id: 'backDartLength',
    label: 'Back dart length',
    group: 'Lengths',
    defaultValueCm: BACK_DART_LENGTH_IN,
    minCm: 4,
    maxCm: 20,
    note: 'Square down 5 1/2" from each back dart centre.',
  },
  {
    id: 'frontDartLength',
    label: 'Front dart length',
    group: 'Lengths',
    defaultValueCm: FRONT_DART_LENGTH_IN,
    minCm: 3,
    maxCm: 16,
    note: 'Front dart legs are 3 1/2" long.',
  },

  // Widths.
  {
    id: 'hipArcBack',
    label: 'Back hip arc (23)',
    group: 'Widths',
    suggested: { fieldId: 'hip', divisor: 4, offsetCm: HIP_EASE_IN },
    defaultValueCm: 25,
    minCm: 10,
    maxCm: 45,
    note: 'A quarter of the hip plus 1/2" ease (A to D).',
  },
  {
    id: 'hipArcFront',
    label: 'Front hip arc (23)',
    group: 'Widths',
    suggested: { fieldId: 'hip', divisor: 4, offsetCm: HIP_EASE_IN },
    defaultValueCm: 25,
    minCm: 10,
    maxCm: 45,
    note: 'A quarter of the hip plus 1/2" ease (A to H).',
  },
  {
    id: 'waistArcBack',
    label: 'Back waist arc (19)',
    group: 'Widths',
    suggested: { fieldId: 'waist', divisor: 4, offsetCm: WAIST_EASE_IN },
    defaultValueCm: 20,
    minCm: 8,
    maxCm: 40,
    note: 'A quarter of the waist plus 1/4" ease — the measure you sew to.',
  },
  {
    id: 'waistArcFront',
    label: 'Front waist arc (19)',
    group: 'Widths',
    suggested: { fieldId: 'waist', divisor: 4, offsetCm: WAIST_EASE_IN },
    defaultValueCm: 20,
    minCm: 8,
    maxCm: 40,
    note: 'A quarter of the waist plus 1/4" ease.',
  },

  // Darts.
  {
    id: 'backDartIntake',
    label: 'Back dart intake (total)',
    group: 'Darts',
    defaultValueCm: BACK_DART_INTAKE_IN,
    minCm: 0,
    maxCm: 14,
    note: 'D to K adds 2" of intake. Read the figure off the dart chart.',
  },
  {
    id: 'frontDartIntake',
    label: 'Front dart intake (total)',
    group: 'Darts',
    defaultValueCm: FRONT_DART_INTAKE_IN,
    minCm: 0,
    maxCm: 14,
    note: 'H to M adds 1" of intake.',
  },
  {
    id: 'backDartCount',
    label: 'Back dart count',
    group: 'Darts',
    kind: 'count',
    defaultValueCm: 2,
    minCm: 1,
    maxCm: 3,
    note: 'One below a 6" hip-minus-waist difference, two above it.',
  },
  {
    id: 'frontDartCount',
    label: 'Front dart count',
    group: 'Darts',
    kind: 'count',
    defaultValueCm: 1,
    minCm: 1,
    maxCm: 2,
    note: 'One below an 8" difference, two above it.',
  },
  {
    id: 'dartSpace',
    label: 'Space between darts',
    group: 'Darts',
    defaultValueCm: DART_SPACE_IN,
    minCm: 1,
    maxCm: 10,
    note: 'Mark dart space 1 1/4" between two darts.',
  },
  {
    id: 'backDartPlacement',
    label: 'Back dart placement (20)',
    group: 'Darts',
    suggested: { fieldId: 'dartPlacement', divisor: 1, offsetCm: 0 },
    defaultValueCm: 9,
    minCm: 2,
    maxCm: 25,
    note: 'D to L — centre back along the waist to the first dart.',
  },
  {
    id: 'frontDartPlacement',
    label: 'Front dart placement (20)',
    group: 'Darts',
    suggested: { fieldId: 'dartPlacement', divisor: 1, offsetCm: 0 },
    defaultValueCm: 9,
    minCm: 2,
    maxCm: 25,
    note: 'H to N — centre front along the waist to the first dart.',
  },

  // Waistband.
  {
    id: 'waistbandLength',
    label: 'Waistband length',
    group: 'Waistband',
    suggested: { fieldId: 'waist', divisor: 1, offsetCm: WAISTBAND_OVERLAP_IN },
    defaultValueCm: 72,
    minCm: 40,
    maxCm: 150,
    note: 'Full waist plus 1" for ease and overlap.',
  },
  {
    id: 'waistbandDepth',
    label: 'Waistband depth',
    group: 'Waistband',
    defaultValueCm: WAISTBAND_DEPTH_IN,
    minCm: 1.5,
    maxCm: 12,
    note: 'Finished depth. Cut two, or one on the fold.',
  },
];

export type DartSpec = {
  /** Centre to the first dart's near leg. */
  placement: number;
  /** Total intake across every dart on this panel. */
  intake: number;
  /** How many darts to spread it over. */
  count: number;
  /** Space between adjacent darts. */
  space: number;
  /** How far the apex sits below the waist line. */
  length: number;
};

/**
 * Dart legs laid out along a waist, in cm from the centre.
 *
 * Darts that would overrun the side-seam point are scaled down together, so a
 * narrow panel never grows a dart hanging off its end.
 */
export function dartLayout(spec: DartSpec, sideX: number): Array<[number, number]> {
  const count = Math.max(1, Math.round(spec.count));
  const width = Math.max(0.2, spec.intake / count);
  const start = Math.max(0.5, Math.min(spec.placement, Math.max(0.5, sideX - 1)));
  const needed = count * width + (count - 1) * spec.space;
  const room = Math.max(0.5, sideX - start);
  const scale = needed > room ? room / needed : 1;
  const w = width * scale;
  const s = spec.space * scale;

  const out: Array<[number, number]> = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    out.push([cursor, cursor + w]);
    cursor += w + s;
  }
  return out;
}

/** One skirt panel: centre waist at `centre`, body width measured along +x. */
function buildPanel(
  role: string,
  label: string,
  centre: Vec2,
  opts: {
    waistArc: number;
    hipArc: number;
    hipDepth: number;
    lift: number;
    length: number;
    darts: DartSpec;
  }
): BlockPieceSpec {
  const { waistArc, hipArc, hipDepth, lift, length, darts } = opts;
  // The sewn waist arc, plus the intake the darts take out of the flat edge.
  const sideX = waistArc + darts.intake;
  const y = centre.y;
  const points: BlockPointSpec[] = [{ key: 'centreWaist', anchor: { x: centre.x, y } }];

  for (const [i, [legA, legB]] of dartLayout(darts, sideX).entries()) {
    points.push({ key: `dart${i}a`, anchor: { x: centre.x + legA, y } });
    points.push({
      key: `dart${i}apex`,
      anchor: { x: centre.x + (legA + legB) / 2, y: y + darts.length },
    });
    points.push({ key: `dart${i}b`, anchor: { x: centre.x + legB, y } });
  }

  points.push({ key: 'waistSide', anchor: { x: centre.x + sideX, y } });
  // The raised side-seam waist, then down past the hip line to the hem.
  points.push({
    key: 'sideWaist',
    anchor: { x: centre.x + hipArc, y: y - lift },
    handlesParallel: true,
  });
  points.push({
    key: 'sideHip',
    anchor: { x: centre.x + hipArc, y: y + hipDepth },
    handlesParallel: true,
  });
  points.push({ key: 'sideHem', anchor: { x: centre.x + hipArc, y: y + length } });
  points.push({ key: 'centreHem', anchor: { x: centre.x, y: y + length } });

  return {
    role,
    name: label,
    points,
    grainline: {
      from: { x: centre.x + hipArc * 0.5, y: y + hipDepth },
      to: { x: centre.x + hipArc * 0.5, y: y + length - 3 },
    },
  };
}

function buildSkirt(values: Record<string, number>, origin: Vec2): BlockPieceSpec[] {
  const hipDepth = values.hipDepth;
  // Side hip depth exceeding centre depth is what raises the side-seam waist.
  const lift = Math.max(0, (values.sideHipDepth ?? hipDepth) - hipDepth);

  const back = buildPanel('skirtBack', 'Skirt back', origin, {
    waistArc: values.waistArcBack,
    hipArc: values.hipArcBack,
    hipDepth,
    lift,
    length: values.skirtLength,
    darts: {
      placement: values.backDartPlacement,
      intake: values.backDartIntake,
      count: values.backDartCount,
      space: values.dartSpace,
      length: values.backDartLength,
    },
  });

  const front = buildPanel(
    'skirtFront',
    'Skirt front',
    { x: origin.x + values.hipArcBack + PANEL_GAP_CM, y: origin.y },
    {
      waistArc: values.waistArcFront,
      hipArc: values.hipArcFront,
      hipDepth,
      lift,
      length: values.skirtLength,
      darts: {
        placement: values.frontDartPlacement,
        intake: values.frontDartIntake,
        count: values.frontDartCount,
        space: values.dartSpace,
        length: values.frontDartLength,
      },
    }
  );

  const bandX = origin.x;
  const bandY = origin.y + values.skirtLength + PANEL_GAP_CM;
  const waistband: BlockPieceSpec = {
    role: 'waistband',
    name: 'Waistband',
    points: [
      { key: 'band-tl', anchor: { x: bandX, y: bandY } },
      { key: 'band-tr', anchor: { x: bandX + values.waistbandLength, y: bandY } },
      {
        key: 'band-br',
        anchor: { x: bandX + values.waistbandLength, y: bandY + values.waistbandDepth },
      },
      { key: 'band-bl', anchor: { x: bandX, y: bandY + values.waistbandDepth } },
    ],
    grainline: {
      from: { x: bandX + values.waistbandLength * 0.5, y: bandY + values.waistbandDepth * 0.25 },
      to: { x: bandX + values.waistbandLength * 0.5, y: bandY + values.waistbandDepth * 0.75 },
    },
  };

  return [back, front, waistband];
}

export const SKIRT_BLOCK: BlockDefinition = {
  id: 'skirt',
  name: 'Basic skirt',
  category: 'skirt',
  description:
    'Two-panel skirt block with waist darts, drafted from waist and hip arcs. Cut the band twice.',
  source: 'Armstrong, Patternmaking for Fashion Design — Figures 1–4, pp. 48–50',
  variables: VARIABLES,
  roles: ['skirtBack', 'skirtFront', 'waistband'],
  build: buildSkirt,
};
