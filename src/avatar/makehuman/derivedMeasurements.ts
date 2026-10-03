/**
 * Tailor measurements derived from the generated mesh by plane slicing and
 * landmark geometry — the fields MakeHuman ships no hand-authored ruler for
 * (arcs, cross-section widths, and girths at arbitrary heights).
 *
 * These are approximations: slices give the surface contour at a height, while
 * arcs/widths assume the front is +Z and the side is the extreme |X| point of
 * the torso loop.
 */

import { MH_MEASURE_RULERS, heightCm, measureCm } from './ruler';
import {
  arcIndices,
  distanceCm,
  frontApexes,
  halfWidthCm,
  indexByMaxAbsX,
  indexByMaxZ,
  indexByMinZ,
  lengthOfIndicesCm,
  loopNearest,
  pointsFromIndices,
  polylineCentroidY,
  sliceAtY,
  surfaceAreaDm2,
  torsoLoop,
  vertexXYZ,
  type SliceLoop,
} from './slice';

/** Landmark vertex indices (MakeHuman numbering). */
const V = {
  nape: 1491,
  shoulderTip: 8274,
  backWaist: 4181,
  elbow: 10037,
  wrist: 10548,
} as const;

/** Field ids this module can produce. */
export const DERIVED_FIELDS: readonly string[] = [
  'highBust',
  'highHip',
  'acrossBack',
  'acrossFront',
  'shoulderWidth',
  'bustSpan',
  'bustArc',
  'backArc',
  'waistArc',
  'hipArc',
  'dartPlacement',
  'elbow',
  'forearm',
  'backNeck',
  'shoulderToWaistBack',
  'shoulderToWaistFront',
  'armscyeDepth',
  'neckToBustPoint',
  'centerFrontLength',
  'sideLength',
  'sideHipDepth',
  'outseam',
  'trouserLength',
  'weight',
];

export type DerivedMeasurements = {
  values: Record<string, number>;
  /** 3D polylines (decimetres) keyed by field, for the ruler overlay. */
  polylines: Record<string, Float32Array>;
};

function loopPoint(loop: SliceLoop, index: number): [number, number, number] {
  const i = index * 3;
  return [loop.points[i]!, loop.points[i + 1]!, loop.points[i + 2]!];
}

function line(points: Array<[number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  });
  return out;
}

export function deriveMeasurements(
  positions: Float32Array,
  indices: Uint32Array
): DerivedMeasurements {
  const values: Record<string, number> = {};
  const polylines: Record<string, Float32Array> = {};

  const cache = new Map<string, SliceLoop[]>();
  const slice = (key: string, y: number): SliceLoop[] => {
    const hit = cache.get(key);
    if (hit) return hit;
    const result = sliceAtY(positions, indices, y);
    cache.set(key, result);
    return result;
  };

  const bustY = polylineCentroidY(positions, MH_MEASURE_RULERS['bust-circ']!);
  const underBustY = polylineCentroidY(positions, MH_MEASURE_RULERS['underbust-circ']!);
  const waistY = polylineCentroidY(positions, MH_MEASURE_RULERS['waist-circ']!);
  const hipY = polylineCentroidY(positions, MH_MEASURE_RULERS['hips-circ']!);
  const neckY = polylineCentroidY(positions, MH_MEASURE_RULERS['neck-circ']!);

  const nape = vertexXYZ(positions, V.nape);
  const shoulderTip = vertexXYZ(positions, V.shoulderTip);
  const shoulderY = (nape[1] + shoulderTip[1]) / 2;
  const highHipY = waistY - 0.8; // ≈ 8 cm below the waist

  const bust = torsoLoop(slice('bust', bustY));
  const underBust = torsoLoop(slice('underBust', underBustY));
  const waist = torsoLoop(slice('waist', waistY));
  const hip = torsoLoop(slice('hip', hipY));

  // Girths at arbitrary heights. Above the bust the A-pose arms merge with the
  // torso, so step down until the torso loop is clean (arms excluded).
  const bustWidthCm = bust ? (bust.maxX - bust.minX) * 10 : Infinity;
  let highBustLoop: SliceLoop | null = null;
  for (let step = 0; step < 8 && !highBustLoop; step++) {
    const y = bustY + 0.7 - step * 0.15;
    const loop = torsoLoop(slice(`highBust:${y.toFixed(2)}`, y));
    if (loop && (loop.maxX - loop.minX) * 10 <= bustWidthCm * 1.2) highBustLoop = loop;
  }
  if (highBustLoop) {
    values.highBust = highBustLoop.perimeterCm;
    polylines.highBust = highBustLoop.points;
  }
  const highHip = torsoLoop(slice('highHip', highHipY));
  if (highHip) {
    values.highHip = highHip.perimeterCm;
    polylines.highHip = highHip.points;
  }

  // Arm girths.
  const elbowY = positions[V.elbow * 3 + 1]!;
  const wristY = positions[V.wrist * 3 + 1]!;
  const elbowPoint = vertexXYZ(positions, V.elbow);
  const elbowLoop = loopNearest(slice('elbow', elbowY), elbowPoint[0], elbowPoint[2]);
  if (elbowLoop) {
    values.elbow = elbowLoop.perimeterCm;
    polylines.elbow = elbowLoop.points;
  }
  const forearmLoop = loopNearest(slice('forearm', (elbowY + wristY) / 2), elbowPoint[0], elbowPoint[2]);
  if (forearmLoop) {
    values.forearm = forearmLoop.perimeterCm;
    polylines.forearm = forearmLoop.points;
  }

  // Cross-section widths, taken at the bust level where the torso loop is clean.
  const chest = torsoLoop(slice('chest', bustY));
  if (chest) {
    const back = halfWidthCm(chest, false);
    const front = halfWidthCm(chest, true);
    if (back > 0) values.acrossBack = back;
    if (front > 0) values.acrossFront = front;
  }
  const shoulderLoop = torsoLoop(slice('shoulder', shoulderY));
  if (shoulderLoop) values.shoulderWidth = (shoulderLoop.maxX - shoulderLoop.minX) * 10;

  // Arcs around the girth loops.
  if (bust) {
    const front = arcIndices(bust, indexByMaxZ(bust), indexByMaxAbsX(bust), true);
    values.bustArc = lengthOfIndicesCm(bust, front);
    polylines.bustArc = pointsFromIndices(bust, front);

    const back = arcIndices(bust, indexByMinZ(bust), indexByMaxAbsX(bust), false);
    values.backArc = lengthOfIndicesCm(bust, back);
    polylines.backArc = pointsFromIndices(bust, back);

    const apexes = frontApexes(bust);
    if (apexes) values.bustSpan = distanceCm(apexes[0], apexes[1]);
  }
  if (waist) {
    const path = arcIndices(waist, indexByMaxZ(waist), indexByMaxAbsX(waist), true);
    values.waistArc = lengthOfIndicesCm(waist, path);
    polylines.waistArc = pointsFromIndices(waist, path);
    values.dartPlacement = values.waistArc * 0.35;
  }
  if (hip) {
    const path = arcIndices(hip, indexByMaxZ(hip), indexByMaxAbsX(hip), true);
    values.hipArc = lengthOfIndicesCm(hip, path);
    polylines.hipArc = pointsFromIndices(hip, path);
  }

  // Landmark distances.
  values.backNeck = distanceCm(nape, shoulderTip);
  values.shoulderToWaistBack = distanceCm(shoulderTip, vertexXYZ(positions, V.backWaist));

  if (waist) {
    const frontWaist = loopPoint(waist, indexByMaxZ(waist));
    values.shoulderToWaistFront = distanceCm(shoulderTip, frontWaist);
    polylines.shoulderToWaistFront = line([shoulderTip, frontWaist]);
  }
  if (underBust) {
    const underarm = loopPoint(underBust, indexByMaxAbsX(underBust));
    values.armscyeDepth = distanceCm(nape, underarm);
    polylines.armscyeDepth = line([nape, underarm]);
    if (waist) {
      const waistSide = loopPoint(waist, indexByMaxAbsX(waist));
      values.sideLength = distanceCm(underarm, waistSide);
      polylines.sideLength = line([underarm, waistSide]);
    }
  }
  if (bust) {
    const apexes = frontApexes(bust);
    if (apexes) {
      values.neckToBustPoint = distanceCm(nape, apexes[1]);
      polylines.neckToBustPoint = line([nape, apexes[1]]);
    }
  }
  const neckLoop = torsoLoop(slice('neck', neckY));
  if (neckLoop && waist) {
    const notch = loopPoint(neckLoop, indexByMaxZ(neckLoop));
    const frontWaist = loopPoint(waist, indexByMaxZ(waist));
    values.centerFrontLength = (notch[1] - frontWaist[1]) * 10;
    polylines.centerFrontLength = line([notch, frontWaist]);
  }
  if (waist && hip) {
    const waistSide = loopPoint(waist, indexByMaxAbsX(waist));
    const hipSide = loopPoint(hip, indexByMaxAbsX(hip));
    values.sideHipDepth = distanceCm(waistSide, hipSide);
    polylines.sideHipDepth = line([waistSide, hipSide]);
  }

  // Composites.
  const outseam =
    measureCm(positions, ['waisttohip-dist']) +
    measureCm(positions, ['upperleg-height']) +
    measureCm(positions, ['lowerleg-height']);
  values.outseam = outseam;
  values.trouserLength = outseam;

  const height = heightCm(positions);
  if (height > 0) {
    const bsa = surfaceAreaDm2(positions, indices) / 100; // m²
    values.weight = (bsa * bsa * 3600) / height;
  }

  return { values, polylines };
}
