import type { BlockVariableDecl, Vec2 } from '../../project/types';
import type { BlockDefinition, BlockPieceSpec, BlockPointSpec } from './spec';

/**
 * Front and back bodice blocks.
 *
 * Drawn from the *Drafting the Bodice Front* sheet in `docs/patternmaking`
 * (dresspatternmaking.com, the "upper bust" system), cross-checked against the
 * finished blocks in the same folder. It supersedes an earlier attempt built from
 * Armstrong's step-by-step pages: those figures are schematic, their drawn
 * proportions disagree with the measurements they label, and reverse-engineering
 * a construction from them produced an armhole with a corner in it.
 *
 * The shape is the ordinary one every bodice block has, and it is worth stating
 * plainly because it is what the numbers below are arranged around:
 *
 *  - a **straight centre line** down one edge, front and back;
 *  - a **neckline** scooped into the top corner;
 *  - a **shoulder seam** sloping down and out from the neck to the shoulder tip;
 *  - a **deep concave scye** from the tip down and out to the underarm;
 *  - a **side seam** from the underarm to the waist, tapering in;
 *  - a **waist dart** notched up from the hem to the bust point.
 *
 * One width control, from the bust: `bust ÷ 4 + ease`, which is the reference's
 * formula for the whole block. Everything else follows from that plus a length.
 *
 * Coordinates: `x = 0` on the centre front/back, `x` growing toward the side
 * seam; `y = 0` **at the waist**, `y` growing downward, so a bodice hangs in
 * negative y. The waist is the anchor because it is the one landmark front and
 * back truly share: a centre length is measured from each side's own neck point,
 * an armscye depth from the nape, but both pieces end at the same waist line.
 */

/** 1/4" — the reference's waist ease, per panel. */
const QUARTER_IN = 0.635;
/** 1/2" — underarm ease per panel. The reference uses 1.5" for a loose block. */
const UNDERARM_EASE_CM = 1.27;
/** 1" front waist dart. */
const FRONT_DART_INTAKE_CM = 2.54;
/** 1 1/2" back waist dart. */
const BACK_DART_INTAKE_CM = 3.81;
/**
 * Where the scye's hollow sits, and how hard its ends are turned.
 *
 * `INSET` is how far inboard of the narrower end the hollow bites, as a share of
 * the block's width, so a wide block gets a proportionally deeper hollow instead
 * of a flat panel with a nick in it. `RISE` is how far up from the underarm, as
 * a share of the side seam, held inside the span the shoulder tip leaves so a
 * long underarm seam on a short-waisted block cannot put the hollow above the
 * tip and turn the armhole inside out.
 *
 * Both are shares rather than measurements on purpose. A fixed distance goes
 * wrong the moment the block is wide: five centimetres of rise buys a nearly
 * horizontal run to the underarm and the scye reads as a step, not a curve.
 */
const ACROSS_MARK_INSET = 0.08;
const ACROSS_MARK_RISE = 0.45;
/** How far the scye's end tangents reach, as a share of the span they steer. */
const SCYE_HANDLE = 0.5;
/**
 * How far each end tangent is turned off the seam it meets, toward the scye's
 * own line.
 *
 * A drafted scye leaves the side seam square to it and arrives at the shoulder
 * seam square to that. Square at both ends, though, makes the curve hold its
 * line right into the seam and turn all at once, which reads as a horizontal jut
 * at the underarm. Blending each tangent a little toward the far end keeps a
 * definite angle at the seam — which is what makes the join look like a corner
 * rather than somewhere the curve happened to stop — while letting the bend
 * begin immediately.
 */
const SCYE_TURN = 0.3;

type TorsoSide = 'front' | 'back';

type TorsoGeometry = {
  /** Along the shoulder line, centre → shoulder-neck point. */
  neckWidth: number;
  /** Shoulder line down to the neck point on the centre line. */
  neckDepth: number;
  /** 0 reaches the straight chord, 1 a full quarter round. */
  neckCurve: number;
  /**
   * Top line down the centre line to the waist — **the block's full height**.
   *
   * The top line is taken as level through the shoulder-neck points, which is
   * the drafting convention (the nape and both neck points are treated as sitting
   * on one horizontal). Everything else hangs off it: the shoulder tip drops from
   * it by `shoulderSlope`, and the neckline depth cuts *down* into it.
   *
   * Front and back are drafted to the same height from the same measurement,
   * because the side seams have to meet. It is also what stops a neckline edit
   * from moving the shoulder line, and through it the whole armhole.
   */
  length: number;
  /**
   * Underarm down to the waist — the underarm seam.
   *
   * Measured from the *waist*, not from the top line, and that is the whole
   * reason front and back line up. Each side's top line sits at a different
   * height (the nape is above the hollow of the neck), so an armhole depth
   * measured from the top would put the two underarms at different heights and
   * the side seams would not meet. The underarm is a body landmark; anchor it to
   * a body landmark.
   */
  sideLength: number;
  /** Centre line out to the side seam at the underarm — the block's width. */
  width: number;
  /** Centre line out to the waist at the side seam, *including* the dart. */
  waistWidth: number;
  /** Shoulder line down to the shoulder tip. */
  shoulderSlope: number;
  /** Shoulder-neck point out to the shoulder tip, along the seam. */
  shoulderLength: number;
  dartPlacement: number;
  dartIntake: number;
  dartLength: number;
};

const subtract = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const times = (v: Vec2, k: number): Vec2 => ({ x: v.x * k, y: v.y * k });
const magnitude = (v: Vec2): number => Math.hypot(v.x, v.y);

function direction(v: Vec2): Vec2 {
  const m = magnitude(v);
  return m < 1e-9 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
}

/** Straight-line interpolation, for steering one tangent toward another. */
const mix = (a: Vec2, b: Vec2, t: number): Vec2 => add(a, times(subtract(b, a), t));

/** Rotate a direction a quarter turn, choosing the arm that points centreward. */
function inboard(d: Vec2): Vec2 {
  const p: Vec2 = { x: -d.y, y: d.x };
  return p.x <= 0 ? p : times(p, -1);
}

/** Rotate a direction a quarter turn, choosing the arm that points downward. */
function downward(d: Vec2): Vec2 {
  const p: Vec2 = { x: -d.y, y: d.x };
  return p.y >= 0 ? p : times(p, -1);
}

/**
 * The scye, as two cubics meeting at the hollow.
 *
 * It leaves the underarm at a right angle to the side seam, hollows in to the
 * mark, then swings back out to the shoulder tip and meets the shoulder seam at
 * a right angle in its turn. Both halves take the *same* tangent at the mark:
 * giving them their own chord directions leaves a 60° corner there, which reads
 * as a defect rather than an armhole.
 *
 * The cost of a shared tangent is that the mark's tangent follows the shoulder
 * tip, so deepening the neck moves it slightly. The mark's *position* does not
 * move, and a smooth armhole is worth more than a fully decoupled one.
 */
function scyeHandles(
  underarm: Vec2,
  tip: Vec2,
  across: Vec2,
  neckShoulder: Vec2,
  waistSide: Vec2,
  rise: number
): { underarmOut: Vec2; acrossIn: Vec2; acrossOut: Vec2; tipIn: Vec2 } {
  // The hollow's tangent runs along the lower half of the scye, which is the
  // direction the curve arrives on. Both halves share it, so they meet without a
  // corner. Anchoring it to the *lower* chord rather than the scye's whole span
  // is what keeps the underarm end out of reach of the neckline: the tip moves
  // when the neck does, and a tangent drawn from it would drag the bottom of the
  // armhole around with every neckline edit.
  const hollow = direction(subtract(across, underarm));

  // Each end starts square to the seam it meets — that join is a right angle on
  // the body — and is eased toward the scye's own line so the bend starts here
  // rather than a centimetre inside the seam.
  const leaving = direction(
    mix(inboard(direction(subtract(underarm, waistSide))), hollow, SCYE_TURN)
  );
  const arriving = direction(
    mix(downward(direction(subtract(tip, neckShoulder))), times(hollow, -1), SCYE_TURN)
  );

  const lower = magnitude(subtract(across, underarm)) * SCYE_HANDLE;
  const upper = magnitude(subtract(tip, across)) * SCYE_HANDLE;
  // Held to the hollow's own height as a ceiling, so the handles reaching into
  // it can never outrun the span of the half they steer.
  const mid = Math.min(lower, rise) * SCYE_HANDLE;

  return {
    underarmOut: add(underarm, times(leaving, lower)),
    acrossIn: subtract(across, times(hollow, mid)),
    acrossOut: add(across, times(hollow, mid)),
    // Arrive at the tip travelling down the armhole, not along the shoulder seam.
    tipIn: add(tip, times(arriving, upper)),
  };
}

/**
 * The neckline, as one cubic whose handles swing out of the corner.
 *
 * `curve` runs 0 → 1. At 0 both handles collapse onto their own anchors and the
 * neckline is the straight chord from the shoulder-neck point to the centre
 * line. At 1 the curve is the full quarter round, each end square to the line it
 * meets.
 *
 * The handles must run *along* the neckline, not across it: the tangent at the
 * shoulder-neck point is parallel to the centre line, and the tangent at the
 * centre line is parallel to the shoulder line. Point them the other way — at
 * the corner the two lines make — and the curve bulges up into the neck instead
 * of scooping down into the chest, which is a neckline drawn inside out.
 */
function necklineHandles(
  neckShoulder: Vec2,
  neckCentre: Vec2,
  curve: number
): { shoulderOut: Vec2; centreIn: Vec2 } {
  // 4/3 · (√2 − 1) ≈ 0.5523 is the standard cubic approximation of a quarter
  // circle. Above that the curve overshoots the ellipse and starts to bulge.
  const k = Math.min(1, Math.max(0, curve)) * 0.5523;
  return {
    shoulderOut: {
      x: neckShoulder.x,
      y: neckShoulder.y + (neckCentre.y - neckShoulder.y) * k,
    },
    centreIn: {
      x: neckCentre.x + (neckShoulder.x - neckCentre.x) * k,
      y: neckCentre.y,
    },
  };
}

/**
 * One bodice side, as a closed outline.
 *
 * Wound from the neck point: down the centre line, out along the waist through
 * the dart, up the side seam, around the scye, back along the shoulder and home
 * through the neckline. The dart is a notch — the boundary dives to the apex and
 * comes back — the same trick the skirt uses, and the reason this needs no holes.
 */
function buildTorso(g: TorsoGeometry, side: TorsoSide, origin: Vec2): BlockPieceSpec {
  const centreWaist: Vec2 = { x: origin.x, y: origin.y };
  // The top line is the datum, so the neck depth is *subtracted* from the block's
  // height rather than added on top of it. Reading it the other way round means
  // dragging the centre length never changes the size of the block — it just
  // slides the whole draft up and down under a collar that grows with it.
  const topLine = origin.y - g.length;
  const neckShoulder: Vec2 = { x: origin.x + g.neckWidth, y: topLine };
  const neckCentre: Vec2 = { x: origin.x, y: topLine + g.neckDepth };

  const dartA: Vec2 = { x: origin.x + g.dartPlacement, y: centreWaist.y };
  const dartB: Vec2 = { x: origin.x + g.dartPlacement + g.dartIntake, y: centreWaist.y };
  const dartApex: Vec2 = { x: (dartA.x + dartB.x) / 2, y: centreWaist.y - g.dartLength };

  // `waistWidth` is the flat pattern width, so it already contains the dart.
  // Measuring it to the body's waist arc instead would take the dart out twice
  // and draft a bodice two centimetres too tight.
  const waistSide: Vec2 = { x: origin.x + g.waistWidth, y: centreWaist.y };
  const underarm: Vec2 = { x: origin.x + g.width, y: origin.y - g.sideLength };
  const tip: Vec2 = {
    x: neckShoulder.x + g.shoulderLength,
    y: neckShoulder.y + g.shoulderSlope,
  };

  // The hollow is the armhole's deepest point: inboard of whichever end of the
  // scye is already nearest the centre, so it can never push the curve out past
  // the shoulder tip or the underarm. Its height is a share of the underarm
  // seam, held inside the span the tip leaves so the armhole cannot invert.
  //
  // Nothing here reads the neckline. The tip drops from the top line by the
  // shoulder slope and the hollow rises from the waist, so the whole of the
  // armhole — anchors and handles together — is fixed by waist-anchored
  // measurements, and a neckline edit cannot smear into it.
  const span = Math.max(g.length - g.shoulderSlope - g.sideLength, 1);
  const rise = Math.min(Math.max(g.sideLength * ACROSS_MARK_RISE, span * 0.25), span * 0.9);
  const across: Vec2 = {
    x: Math.min(tip.x, underarm.x) - g.width * ACROSS_MARK_INSET,
    y: underarm.y - rise,
  };

  const scye = scyeHandles(underarm, tip, across, neckShoulder, waistSide, rise);
  const neck = necklineHandles(neckShoulder, neckCentre, g.neckCurve);

  const isFront = side === 'front';
  const points: BlockPointSpec[] = [
    { key: 'neckCentre', anchor: neckCentre, handleIn: neck.centreIn },
    { key: 'centreWaist', anchor: centreWaist },
    { key: 'dartA', anchor: dartA },
    { key: 'dartApex', anchor: dartApex },
    { key: 'dartB', anchor: dartB },
    { key: 'waistSide', anchor: waistSide },
    { key: 'underarm', anchor: underarm, handleOut: scye.underarmOut },
    { key: 'across', anchor: across, handleIn: scye.acrossIn, handleOut: scye.acrossOut },
    { key: 'shoulderTip', anchor: tip, handleIn: scye.tipIn },
    { key: 'neckShoulder', anchor: neckShoulder, handleOut: neck.shoulderOut },
  ];

  return {
    role: isFront ? 'bodiceFront' : 'bodiceBack',
    name: isFront ? 'Bodice front' : 'Bodice back',
    points,
    // Straight down the panel, which is how the warp runs on a woven bodice.
    grainline: {
      from: { x: origin.x + g.width * 0.4, y: origin.y - g.sideLength * 0.5 },
      to: { x: origin.x + g.width * 0.4, y: origin.y - 4 },
    },
  };
}

/** Read the geometry out of resolved values, falling back to the defaults. */
function readGeometry(values: Record<string, number>, fallback: TorsoGeometry): TorsoGeometry {
  const out = {} as TorsoGeometry;
  for (const key of Object.keys(fallback) as Array<keyof TorsoGeometry>) {
    const value = values[key];
    out[key] = Number.isFinite(value) ? value : fallback[key];
  }
  return out;
}

/**
 * The three neckline controls, shared so front and back can never drift apart in
 * name or meaning. Only the default depth differs — a back neck is a shallow
 * scoop, a front one drops well below the shoulder line.
 */
function necklineVariables(
  defaultDepth: number,
  maxDepth: number,
  defaultCurve: number
): BlockVariableDecl[] {
  return [
    {
      id: 'neckWidth',
      label: 'Neckline width',
      group: 'Neckline',
      suggested: { fieldId: 'backNeck', divisor: 1, offsetCm: 0.3175 },
      defaultValueCm: 7.3,
      // Generous on purpose: a back neck is a half width — nape to shoulder point
      // — but people measure the whole neck often enough that a tight cap would
      // silently rewrite a real measurement into a wrong one.
      minCm: 3,
      maxCm: 20,
      note: 'Centre line out to the shoulder-neck point. Back neck (12) plus 1/8", a half width.',
    },
    {
      id: 'neckDepth',
      label: 'Neckline depth',
      group: 'Neckline',
      defaultValueCm: defaultDepth,
      minCm: 0,
      maxCm: maxDepth,
      note: 'Shoulder line down to the neck point on the centre line. Zero gives a plain corner.',
    },
    {
      id: 'neckCurve',
      label: 'Neckline curve',
      group: 'Neckline',
      kind: 'factor',
      defaultValueCm: defaultCurve,
      minCm: 0,
      maxCm: 1,
      note: 'How much of a quarter round the neck is cut to. 0 leaves the straight chord across the corner; 1 is the full scoop.',
    },
  ];
}

function bodyVariables(
  lengthLabel: string,
  lengthNote: string,
  widthNote: string,
  dartIntakeCm: number
): BlockVariableDecl[] {
  return [
    {
      id: 'width',
      label: 'Width (bust ÷ 4)',
      group: 'Body',
      suggested: { fieldId: 'bust', divisor: 4, offsetCm: UNDERARM_EASE_CM },
      defaultValueCm: 24.5,
      minCm: 14,
      maxCm: 42,
      // Front and back take the same width on purpose: they have to meet at the
      // side seam, so a difference here is a seam that does not match.
      note: widthNote,
    },
    {
      id: 'length',
      label: lengthLabel,
      group: 'Body',
      // Both sides draw their height from the same field. In drafting the nape
      // and the two shoulder-neck points sit on one level line, so this is the
      // only measurement that gives front and back the height a side seam needs.
      // The front's *centre* length — hollow to waist — is this less the
      // neckline depth, which is exactly why it is the wrong thing to bind here.
      suggested: { fieldId: 'napeToWaist', divisor: 1, offsetCm: 0 },
      defaultValueCm: 38,
      minCm: 22,
      maxCm: 56,
      note: lengthNote,
    },
    {
      id: 'sideLength',
      label: 'Side length',
      group: 'Body',
      // The avatar derives this as half the underarm seam — it measures from the
      // underarm landmark on the under-bust loop, which sits well above the
      // armpit — so the block doubles it rather than misreading the field.
      suggested: { fieldId: 'sideLength', divisor: 0.5, offsetCm: 0 },
      defaultValueCm: 18,
      minCm: 10,
      maxCm: 34,
      note: 'Underarm down the side seam to the waist. Sketched at twice the measurement the avatar derives, which is a half length.',
    },
    {
      id: 'waistWidth',
      label: 'Width at the waist',
      group: 'Body',
      // The dart belongs in the offset, not left for the drafter to remember.
      // The hem is measured out to the side seam and the dart added on top of it,
      // so a binding that stopped at the ease would draft a bodice as many
      // centimetres too tight as the dart is wide.
      suggested: { fieldId: 'waist', divisor: 4, offsetCm: QUARTER_IN + dartIntakeCm },
      defaultValueCm: 18.5 + QUARTER_IN + dartIntakeCm,
      minCm: 12,
      maxCm: 38,
      // The reference measures the hem out to the side seam and then adds the
      // dart on top, which is exactly what this number is.
      note: "Centre line out to the side seam at the waist, the dart's fabric included. Waist ÷ 4 plus ease, plus the dart.",
    },
  ];
}

function shoulderVariables(shoulderNote: string): BlockVariableDecl[] {
  return [
    {
      id: 'shoulderLength',
      label: 'Shoulder length',
      group: 'Shoulder',
      suggested: { fieldId: 'shoulderLength', divisor: 1, offsetCm: 0 },
      defaultValueCm: 12.5,
      minCm: 7,
      maxCm: 20,
      note: shoulderNote,
    },
    {
      id: 'shoulderSlope',
      label: 'Shoulder slope',
      group: 'Shoulder',
      suggested: { fieldId: 'shoulderSlope', divisor: 1, offsetCm: 0 },
      // A real shoulder drops 5–6 cm from the neck point out to the tip. The
      // common 3.5 cm figure gives a 15° seam, which no bodice block shows and
      // which puts the armhole in the wrong place.
      defaultValueCm: 5.5,
      minCm: 2,
      maxCm: 10,
      note: 'Shoulder line down to the shoulder tip — the drop from a level line at the neck out to the tip.',
    },
  ];
}

function dartVariables(
  placement: number,
  intake: number,
  length: number,
  intakeNote: string
): BlockVariableDecl[] {
  return [
    {
      id: 'dartPlacement',
      label: 'Dart placement',
      group: 'Waist dart',
      suggested: { fieldId: 'dartPlacement', divisor: 1, offsetCm: 0 },
      defaultValueCm: placement,
      minCm: 3,
      maxCm: 20,
      note: 'Centre line out to the first dart leg, along the waistline.',
    },
    {
      id: 'dartIntake',
      label: 'Dart intake',
      group: 'Waist dart',
      defaultValueCm: intake,
      minCm: 0.5,
      maxCm: 9,
      note: intakeNote,
    },
    {
      id: 'dartLength',
      label: 'Dart length',
      group: 'Waist dart',
      defaultValueCm: length,
      minCm: 4,
      maxCm: 22,
      note: 'Waist up to the apex. On the front the apex is the bust point; the back dart stops a little lower.',
    },
  ];
}

const FRONT_DEFAULTS: TorsoGeometry = {
  neckWidth: 7.3,
  neckDepth: 7,
  // Nearly a full quarter round, which is what a front neckline is. Too little
  // and the chord between the neck point and the hollow reads as a long diagonal
  // no drafted neckline shows.
  neckCurve: 0.8,
  length: 38,
  sideLength: 18,
  width: 24.5,
  // Kept in step with the width-at-the-waist default below, which is built from
  // it: 18.5 + 1/4" ease + a 1" dart.
  waistWidth: 21.7,
  shoulderSlope: 5.5,
  shoulderLength: 12.5,
  dartPlacement: 9,
  dartIntake: FRONT_DART_INTAKE_CM,
  dartLength: 15,
};

const BACK_DEFAULTS: TorsoGeometry = {
  ...FRONT_DEFAULTS,
  // A back neck is a shallow, nearly straight scoop running out to the nape's
  // own level, so it wants far less curve than the front.
  neckCurve: 0.55,
  neckDepth: 1.9,
  // The height is *not* overridden: front and back are drafted to one top line,
  // or the side seams would not meet.
  // A back waist takes a wider dart, so the hem carries more fabric for it.
  waistWidth: 18.5 + QUARTER_IN + BACK_DART_INTAKE_CM,
  dartIntake: BACK_DART_INTAKE_CM,
  dartLength: 15,
};

export const BODICE_FRONT_BLOCK: BlockDefinition = {
  id: 'bodiceFront',
  name: 'Bodice front',
  category: 'bodice',
  description:
    'Fitted front bodice with a bust-point waist dart. One width, set from the bust.',
  source: 'Drafting the Bodice Front — dresspatternmaking.com, upper-bust system',
  roles: ['bodiceFront'],
  variables: [
    ...necklineVariables(FRONT_DEFAULTS.neckDepth, 16, FRONT_DEFAULTS.neckCurve),
    ...bodyVariables(
      'Centre length',
      "Top line down the centre front to the waist — the block's full height. The hollow sits the neckline depth below it.",
      'Centre line out to the side seam at the underarm. Bust ÷ 4 plus ease — the one width the whole block is built on.',
      FRONT_DART_INTAKE_CM
    ),
    ...shoulderVariables('Shoulder-neck point out to the shoulder tip, along the seam.'),
    ...dartVariables(
      FRONT_DEFAULTS.dartPlacement,
      FRONT_DEFAULTS.dartIntake,
      FRONT_DEFAULTS.dartLength,
      'How much the dart takes out — roughly the bust width less the waist width.'
    ),
  ],
  build: (values, origin) => [buildTorso(readGeometry(values, FRONT_DEFAULTS), 'front', origin)],
};

export const BODICE_BACK_BLOCK: BlockDefinition = {
  id: 'bodiceBack',
  name: 'Bodice back',
  category: 'bodice',
  description:
    'Fitted back bodice with a waist dart and a shallow scoop neck, drafted off the same skeleton as the front.',
  source: 'Drafting the Bodice Front — dresspatternmaking.com, upper-bust system',
  roles: ['bodiceBack'],
  variables: [
    ...necklineVariables(BACK_DEFAULTS.neckDepth, 12, BACK_DEFAULTS.neckCurve),
    ...bodyVariables(
      'Centre back length',
      "Nape down the centre back to the waist — the block's full height, and the same one the front is drafted to.",
      'Centre line out to the side seam at the underarm. Bust ÷ 4 plus ease, matching the front so the side seams meet.',
      BACK_DART_INTAKE_CM
    ),
    ...shoulderVariables(
      'Shoulder-neck point out to the shoulder tip. A back shoulder dart would add 1/2"; there is none here.'
    ),
    ...dartVariables(
      BACK_DEFAULTS.dartPlacement,
      BACK_DEFAULTS.dartIntake,
      BACK_DEFAULTS.dartLength,
      'How much the dart takes out. The back waist usually needs a wider dart than the front.'
    ),
  ],
  build: (values, origin) => [buildTorso(readGeometry(values, BACK_DEFAULTS), 'back', origin)],
};
