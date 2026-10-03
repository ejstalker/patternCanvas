/**
 * MakeHuman body measurements, ported verbatim from
 * `makehuman/plugins/0_modeling_a_measurement.py` (`Ruler.Measures`).
 *
 * Each measurement is a polyline of *base-mesh vertex indices*; the measured
 * value is the summed segment length, scaled from the base mesh's decimetres to
 * centimetres (×10), matching `Ruler.getMeasure(..., 'metric')`.
 *
 * Polyline indices refer to the **full** base mesh vertex numbering, so all
 * morph/measurement math must run on the full-resolution position array.
 */

/** Short measure name -> polyline of base-mesh vertex indices. */
export const MH_MEASURE_RULERS: Record<string, readonly number[]> = {
  'neck-circ': [
    7514, 10358, 7631, 7496, 7488, 7489, 7474, 7475, 7531, 7537, 7543, 7549, 7555, 7561, 7743, 7722,
    856, 1030, 1051, 850, 844, 838, 832, 826, 820, 756, 755, 770, 769, 777, 929, 3690, 804, 800,
    808, 801, 799, 803, 7513, 7515, 7521, 7514,
  ],
  'neck-height': [853, 854, 855, 856, 857, 858, 1496, 1491],
  'upperarm-circ': [
    8383, 8393, 8392, 8391, 8390, 8394, 8395, 8399, 10455, 10516, 8396, 8397, 8398, 8388, 8387,
    8386, 10431, 8385, 8384, 8389,
  ],
  'upperarm-length': [8274, 10037],
  'lowerarm-length': [10040, 10548],
  'wrist-circ': [
    10208, 10211, 10212, 10216, 10471, 10533, 10213, 10214, 10215, 10205, 10204, 10203, 10437,
    10202, 10201, 10206, 10200, 10210, 10209, 10208,
  ],
  'frontchest-dist': [1437, 8125],
  'bust-circ': [
    8439, 8455, 8462, 8446, 8478, 8494, 8557, 8510, 8526, 8542, 10720, 10601, 10603, 10602, 10612,
    10611, 10610, 10613, 10604, 10605, 10606, 3942, 3941, 3940, 3950, 3947, 3948, 3949, 3938,
    3939, 3937, 4065, 1870, 1854, 1838, 1885, 1822, 1806, 1774, 1790, 1783, 1767, 1799, 8471,
  ],
  'underbust-circ': [
    10750, 10744, 10724, 10725, 10748, 10722, 10640, 10642, 10641, 10651, 10650, 10649, 10652,
    10643, 10644, 10645, 10646, 10647, 10648, 3988, 3987, 3986, 3985, 3984, 3983, 3982, 3992,
    3989, 3990, 3991, 3980, 3981, 3979, 4067, 4098, 4073, 4072, 4094, 4100, 4082, 4088, 4088,
  ],
  'waist-circ': [
    4121, 10760, 10757, 10777, 10776, 10779, 10780, 10778, 10781, 10771, 10773, 10772, 10775,
    10774, 10814, 10834, 10816, 10817, 10818, 10819, 10820, 10821, 4181, 4180, 4179, 4178, 4177,
    4176, 4175, 4196, 4173, 4131, 4132, 4129, 4130, 4128, 4138, 4135, 4137, 4136, 4133, 4134,
    4108, 4113, 4118, 4121,
  ],
  'napetowaist-dist': [1491, 4181],
  'waisttohip-dist': [4121, 4341],
  'shoulder-dist': [7478, 8274],
  'hips-circ': [
    4341, 10968, 10969, 10971, 10970, 10967, 10928, 10927, 10925, 10926, 10923, 10924, 10868,
    10875, 10861, 10862, 4228, 4227, 4226, 4242, 4234, 4294, 4293, 4296, 4295, 4297, 4298, 4342,
    4345, 4346, 4344, 4343, 4361, 4341,
  ],
  'upperleg-height': [10970, 11230],
  'thigh-circ': [
    11071, 11080, 11081, 11086, 11076, 11077, 11074, 11075, 11072, 11073, 11069, 11070, 11087,
    11085, 11084, 12994, 11083, 11082, 11079, 11071,
  ],
  'lowerleg-height': [11225, 12820],
  'calf-circ': [
    11339, 11336, 11353, 11351, 11350, 13008, 11349, 11348, 11345, 11337, 11344, 11346, 11347,
    11352, 11342, 11343, 11340, 11341, 11338, 11339,
  ],
  'ankle-circ': [
    11460, 11464, 11458, 11459, 11419, 11418, 12958, 12965, 12960, 12963, 12961, 12962, 12964,
    12927, 13028, 12957, 11463, 11461, 11457, 11460,
  ],
  'knee-circ': [
    11223, 11230, 11232, 11233, 11238, 11228, 11229, 11226, 11227, 11224, 11225, 11221, 11222,
    11239, 11237, 11236, 13002, 11235, 11234, 11223,
  ],
};

export type MeasureName = keyof typeof MH_MEASURE_RULERS;

/** Summed polyline length in centimetres (base mesh is in decimetres). */
export function measurePolylineCm(positions: Float32Array, polyline: readonly number[]): number {
  let sum = 0;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1]! * 3;
    const b = polyline[i]! * 3;
    const dx = positions[a]! - positions[b]!;
    const dy = positions[a + 1]! - positions[b + 1]!;
    const dz = positions[a + 2]! - positions[b + 2]!;
    sum += Math.hypot(dx, dy, dz);
  }
  return sum * 10;
}

/** Measure one or more named rulers, summing their lengths (e.g. inseam = upper + lower leg). */
export function measureCm(positions: Float32Array, names: readonly string[]): number {
  let sum = 0;
  for (const name of names) {
    const polyline = MH_MEASURE_RULERS[name];
    if (!polyline) throw new Error(`Unknown MakeHuman measure: ${name}`);
    sum += measurePolylineCm(positions, polyline);
  }
  return sum;
}

/** Standing height in centimetres, matching `Human.getHeightCm` (bbox y-range ×10). */
export function heightCm(positions: Float32Array): number {
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return (maxY - minY) * 10;
}
