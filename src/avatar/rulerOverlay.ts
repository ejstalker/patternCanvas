/**
 * Build 3D "ruler" polylines for the generated avatar so the editor can draw the
 * tape lines over the model and reveal them on hover.
 *
 * Points come from either the MakeHuman ruler polylines (hand-authored vertex
 * chains) or the plane-slice/landmark derivations in `derivedMeasurements`.
 */

import { MEASUREMENT_FIELDS } from '../project/measurements';
import { FIELD_READERS } from './makehuman/generate';
import { MH_MEASURE_RULERS } from './makehuman/ruler';

export type MeasurementRuler = {
  field: string;
  label: string;
  /** Ordered polyline points (xyz triples, decimetres, MakeHuman numbering). */
  points: Float32Array;
  /** Midpoint of the polyline, for the label anchor. */
  anchor: [number, number, number];
  color: [number, number, number];
  /** True when the wearer entered this measurement (drives the model). */
  driven: boolean;
};

const FIELD_LABELS = new Map(MEASUREMENT_FIELDS.map((f) => [f.id, f.label]));

/** Colour by measurement group so the tape lines read apart. */
const GROUP_COLORS: Record<string, [number, number, number]> = {
  torso: [0.98, 0.62, 0.35],
  vertical: [0.55, 0.82, 0.98],
  arm: [0.72, 0.95, 0.6],
  leg: [0.95, 0.72, 0.95],
  general: [0.9, 0.9, 0.9],
};

const FIELD_GROUPS = new Map(MEASUREMENT_FIELDS.map((f) => [f.id, f.group]));

export function buildMeasurementRulers(
  positions: Float32Array,
  measured: Record<string, number>,
  driven: ReadonlySet<string>,
  unit: 'cm' | 'in',
  extras: Record<string, Float32Array> = {}
): MeasurementRuler[] {
  const rulers: MeasurementRuler[] = [];
  const factor = unit === 'in' ? 1 / 2.54 : 1;
  const fields = new Set([...Object.keys(FIELD_READERS), ...Object.keys(extras)]);

  for (const field of fields) {
    const value = measured[field];
    if (!Number.isFinite(value)) continue;

    let points = extras[field] ?? null;
    if (!points) {
      const names = FIELD_READERS[field];
      if (!names) continue;
      const acc: number[] = [];
      for (const name of names) {
        const polyline = MH_MEASURE_RULERS[name];
        if (!polyline) continue;
        for (const vertex of polyline) {
          const i = vertex * 3;
          acc.push(positions[i]!, positions[i + 1]!, positions[i + 2]!);
        }
      }
      if (acc.length === 0) continue;
      points = Float32Array.from(acc);
    }
    if (points.length < 6) continue;

    let ax = 0;
    let ay = 0;
    let az = 0;
    const count = points.length / 3;
    for (let i = 0; i < count; i++) {
      ax += points[i * 3]!;
      ay += points[i * 3 + 1]!;
      az += points[i * 3 + 2]!;
    }

    const group = FIELD_GROUPS.get(field) ?? 'general';
    rulers.push({
      field,
      label: `${FIELD_LABELS.get(field) ?? field} ${(value * factor).toFixed(1)}${unit}`,
      points,
      anchor: [ax / count, ay / count, az / count],
      color: GROUP_COLORS[group] ?? GROUP_COLORS.general!,
      driven: driven.has(field),
    });
  }

  return rulers;
}
