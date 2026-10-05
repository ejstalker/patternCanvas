import type { BlockVariableDecl, Vec2 } from '../../project/types';
import { mirroredPiece } from './spec';
import type { BlockDefinition, BlockPieceSpec, BlockPointSpec, BlockSeamSpec } from './spec';

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
    id: 'waistbandOverlap',
    label: 'Waistband overlap',
    group: 'Waistband',
    defaultValueCm: WAISTBAND_OVERLAP_IN,
    // Never zero: the band keeps a point where it crosses the centre line, so
    // that the seam onto the skirt has somewhere to land.
    minCm: 1,
    maxCm: 12,
    note: 'How far the back band runs past the centre back for the closure. Its remaining length is the waist arc it has to fit, so the band can never disagree with the skirt.',
  },
  {
    id: 'waistbandDepth',
    label: 'Waistband depth',
    group: 'Waistband',
    defaultValueCm: WAISTBAND_DEPTH_IN,
    minCm: 1.5,
    maxCm: 12,
    note: 'Finished depth, drafted as one piece per skirt panel.',
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

/** How a panel's darts fall along its waist, and what is left once they are sewn. */
export type DartPlan = {
  /** [near leg, far leg] of each dart, in cm from the centre. */
  legs: Array<[number, number]>;
  /** Where each dart *closes* once sewn, in cm from the centre. */
  marks: number[];
  /** The sewn waist arc — the measure you sew to. */
  sewnEnd: number;
};

/**
 * Darts laid out along a waist, in cm from the centre.
 *
 * Darts that would overrun the side-seam point are scaled down together, so a
 * narrow panel never grows a dart hanging off its end.
 */
export function dartPlan(spec: DartSpec, sideX: number): DartPlan {
  const count = Math.max(1, Math.round(spec.count));
  const width = Math.max(0.2, spec.intake / count);
  const start = Math.max(0.5, Math.min(spec.placement, Math.max(0.5, sideX - 1)));
  const needed = count * width + (count - 1) * spec.space;
  const room = Math.max(0.5, sideX - start);
  const scale = needed > room ? room / needed : 1;
  const w = width * scale;
  const s = spec.space * scale;

  const legs: Array<[number, number]> = [];
  const marks: number[] = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    legs.push([cursor, cursor + w]);
    // Sewing a dart brings its two legs together, and what is left of the waist
    // in front of it is the *near* leg — every centimetre of intake before it
    // has been folded away. These are the positions a waistband has to meet,
    // and they are not the leg positions: each dart pulls everything downstream
    // of it in by its own width.
    marks.push(cursor - i * w);
    cursor += w + s;
  }

  return { legs, marks, sewnEnd: sideX - count * w };
}

/** The dart legs alone, for callers that only need to place or draw them. */
export function dartLayout(spec: DartSpec, sideX: number): Array<[number, number]> {
  return dartPlan(spec, sideX).legs;
}

/** One skirt panel, and the dart layout its waistband has to match. */
type PanelDraft = { spec: BlockPieceSpec; plan: DartPlan };

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
): PanelDraft {
  const { waistArc, hipArc, hipDepth, lift, length, darts } = opts;
  // The sewn waist arc, plus the intake the darts take out of the flat edge.
  const sideX = waistArc + darts.intake;
  const y = centre.y;
  const plan = dartPlan(darts, sideX);
  const points: BlockPointSpec[] = [{ key: 'centreWaist', anchor: { x: centre.x, y } }];

  for (const [i, [legA, legB]] of plan.legs.entries()) {
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
    spec: {
      role,
      name: label,
      points,
      grainline: {
        from: { x: centre.x + hipArc * 0.5, y: y + hipDepth },
        to: { x: centre.x + hipArc * 0.5, y: y + length - 3 },
      },
    },
    plan,
  };
}

/**
 * A waistband panel: the strip that goes round the waist above one skirt panel.
 *
 * The strip is sized by the panel it has to fit, never the other way round, so
 * its seam line carries a point at the centre, at every dart **closure**, and at
 * the side seam. That is exactly the vertex list the panel's waist has once its
 * darts are sewn, and between any two of those points each piece has a single
 * edge of the same length — so the band can be sewn on with plain edge-to-edge
 * seams instead of a many-to-many match that has to guess where the darts were.
 *
 * The dart notches themselves are deliberately absent. A notch is the dart, and
 * a dart is sewn to itself, not to a waistband.
 */
function buildBand(
  role: string,
  label: string,
  centreX: number,
  seamY: number,
  plan: DartPlan,
  overlap: number,
  depth: number
): BlockPieceSpec {
  const start = centreX - overlap;
  const seamEnd = centreX + plan.sewnEnd;
  const bottom = seamY + depth;

  const points: BlockPointSpec[] = [];
  // The closure allowance runs past the centre, so the centre itself stays a
  // point of its own and the marks further along keep measuring from it.
  if (overlap > 0) points.push({ key: 'bandStart', anchor: { x: start, y: seamY } });
  points.push({ key: 'bandCentre', anchor: { x: centreX, y: seamY } });
  for (const [i, mark] of plan.marks.entries()) {
    points.push({ key: `bandDart${i}`, anchor: { x: centreX + mark, y: seamY } });
  }
  points.push({ key: 'bandSeamEnd', anchor: { x: seamEnd, y: seamY } });
  points.push({ key: 'bandHemEnd', anchor: { x: seamEnd, y: bottom } });
  points.push({ key: 'bandHemStart', anchor: { x: start, y: bottom } });

  return {
    role,
    name: label,
    points,
    grainline: {
      from: { x: (start + seamEnd) / 2, y: seamY + depth * 0.25 },
      to: { x: (start + seamEnd) / 2, y: seamY + depth * 0.75 },
    },
  };
}

/** The right-hand edge of a piece, for laying the next one along. */
function maxX(spec: BlockPieceSpec): number {
  return Math.max(...spec.points.map((point) => point.anchor.x));
}

/** The run down one side of a panel, from the waist past the hip to the hem. */
const SIDE_RUN: Array<[string, string]> = [
  ['waistSide', 'sideWaist'],
  ['sideWaist', 'sideHip'],
  ['sideHip', 'sideHem'],
];

/**
 * The seams a skirt wants: a side seam down each side, and each panel's waist
 * sewn to its band.
 *
 * The waist is not one seam but one per run *between* darts. The notches are the
 * darts, and a dart is sewn to itself rather than to a waistband, so the band was
 * given a point at every dart closure for exactly this: each run is then a single
 * edge on both pieces, the same length on both, and none of it needs the
 * many-to-many tool that would otherwise have to guess where the darts were.
 */
function buildSeams(values: Record<string, number>): BlockSeamSpec[] {
  const seams: BlockSeamSpec[] = [];

  for (const [fromKey, toKey] of SIDE_RUN) {
    for (const [back, front] of [
      ['skirtBack', 'skirtFront'],
      ['skirtBackMirror', 'skirtFrontMirror'],
    ] as const) {
      seams.push({
        a: { role: back, fromKey, toKey },
        b: { role: front, fromKey, toKey },
      });
    }
  }

  const pairs: Array<[string, string, number]> = [
    ['skirtBack', 'waistbandBack', values.backDartCount],
    ['skirtFront', 'waistbandFront', values.frontDartCount],
    ['skirtBackMirror', 'waistbandBackMirror', values.backDartCount],
    ['skirtFrontMirror', 'waistbandFrontMirror', values.frontDartCount],
  ];
  for (const [panel, band, dartCount] of pairs) {
    const count = Math.max(1, Math.round(dartCount));
    for (let i = 0; i <= count; i++) {
      seams.push({
        a: {
          role: panel,
          fromKey: i === 0 ? 'centreWaist' : `dart${i - 1}b`,
          toKey: i === count ? 'waistSide' : `dart${i}a`,
        },
        b: {
          role: band,
          fromKey: i === 0 ? 'bandCentre' : `bandDart${i - 1}`,
          toKey: i === count ? 'bandSeamEnd' : `bandDart${i}`,
        },
      });
    }
  }

  return seams;
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
  // A panel is drafted a half at a time — centre line out to the side seam — so
  // each one needs its opposite half beside it to be a whole front or back.
  const backMirror = mirroredPiece(back.spec, 'skirtBackMirror', PANEL_GAP_CM);

  const front = buildPanel(
    'skirtFront',
    'Skirt front',
    { x: origin.x + 2 * (values.hipArcBack + PANEL_GAP_CM), y: origin.y },
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
  const frontMirror = mirroredPiece(front.spec, 'skirtFrontMirror', PANEL_GAP_CM);

  const bandY = origin.y + values.skirtLength + PANEL_GAP_CM;
  const waistbandBack = buildBand(
    'waistbandBack',
    'Waistband back',
    origin.x,
    bandY,
    back.plan,
    values.waistbandOverlap,
    values.waistbandDepth
  );
  const waistbandBackMirror = mirroredPiece(
    waistbandBack,
    'waistbandBackMirror',
    PANEL_GAP_CM
  );

  const waistbandFront = buildBand(
    'waistbandFront',
    'Waistband front',
    // Cleared of the back band *and* its mirror, rather than worked out by hand
    // from the offsets — the row is laid out from what is already there.
    maxX(waistbandBackMirror) + PANEL_GAP_CM,
    bandY,
    front.plan,
    // The closure lives at the centre back, so the front band is a plain strip.
    0,
    values.waistbandDepth
  );
  const waistbandFrontMirror = mirroredPiece(
    waistbandFront,
    'waistbandFrontMirror',
    PANEL_GAP_CM
  );

  return [
    back.spec,
    backMirror,
    front.spec,
    frontMirror,
    waistbandBack,
    waistbandBackMirror,
    waistbandFront,
    waistbandFrontMirror,
  ];
}

export const SKIRT_BLOCK: BlockDefinition = {
  id: 'skirt',
  name: 'Basic skirt',
  category: 'skirt',
  description:
    'Two-panel skirt block with waist darts, drafted from waist and hip arcs. Each panel comes with its mirrored half, and each has a waistband cut to the darts it closes over.',
  source: 'Armstrong, Patternmaking for Fashion Design — Figures 1–4, pp. 48–50',
  variables: VARIABLES,
  roles: [
    'skirtBack',
    'skirtBackMirror',
    'skirtFront',
    'skirtFrontMirror',
    'waistbandBack',
    'waistbandBackMirror',
    'waistbandFront',
    'waistbandFrontMirror',
  ],
  build: buildSkirt,
  seams: buildSeams,
};
