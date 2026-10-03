import {
  CM_PER_INCH,
  formatLength,
  type PatternRuler,
  type UnitDisplay,
  type Vec2,
} from '../project/types';
import { MEASUREMENT_FIELDS, MEASUREMENT_GROUPS, type MeasurementSet } from '../project/measurements';

/**
 * Geometry, labelling and persistence helpers for the pattern-editor ruler
 * tool. Pure functions only — the editor owns the DOM.
 */

/** Minor graduations never sit closer together than this on screen. */
const MIN_TICK_GAP_PX = 5;

/**
 * Labelled graduations need far more room than bare ticks — a pattern ruler is
 * a working tool, not a printed one, so the numbers must stay legible at the
 * zoom you draft at.
 */
const MIN_LABEL_GAP_PX = 36;

/** Assumed viewport size before flex layout settles (mirrors `grid.ts`). */
const FALLBACK_LAYOUT_PX = 360;

/**
 * Graduation pairs `[minor, major]` in *display* units. A ruler shows the
 * graduations of the unit you draft in — 1 cm with millimetres, or 1 in with
 * eighths — stepping up a ladder as you zoom out so the ticks never collapse
 * into a solid bar. Both rows ascend on both axes.
 */
const CM_LADDER: Array<[number, number]> = [
  [0.1, 1],
  [0.25, 1],
  [0.5, 1],
  [1, 5],
  [2, 10],
  [5, 10],
  [10, 50],
  [20, 100],
  [50, 100],
  [100, 500],
];

const IN_LADDER: Array<[number, number]> = [
  [0.0625, 1],
  [0.125, 1],
  [0.25, 1],
  [0.5, 1],
  [1, 2],
  [2, 12],
  [6, 12],
  [12, 60],
];

export type RulerHit = { id: string; part: 'body' | 'a' | 'b' };

export type RulerLabel = { primary: string; secondary: string };

/** Minor / major graduation spacing in cm for the current zoom. */
export function rulerGraduations(
  unit: UnitDisplay,
  scale: number
): { minorCm: number; majorCm: number } {
  const ladder = unit === 'in' ? IN_LADDER : CM_LADDER;
  const base = unit === 'in' ? CM_PER_INCH : 1;
  const settled = scale > 0 && Number.isFinite(scale);
  const s = settled ? scale : FALLBACK_LAYOUT_PX / 60;
  for (const [minor, major] of ladder) {
    // Two constraints: ticks must not merge, and the numbers must not collide.
    if (minor * base * s >= MIN_TICK_GAP_PX && major * base * s >= MIN_LABEL_GAP_PX) {
      return { minorCm: minor * base, majorCm: major * base };
    }
  }
  const last = ladder[ladder.length - 1]!;
  return { minorCm: last[0] * base, majorCm: last[1] * base };
}

/** The stored (full) length, ignoring any live measurement lookup. */
export function rulerFullLengthCm(ruler: PatternRuler): number {
  const full = Number.isFinite(ruler.lengthCm) ? Math.max(0, ruler.lengthCm) : 0;
  return full;
}

/** Drawn length in cm from the stored snapshot alone. */
export function rulerLengthCm(ruler: PatternRuler): number {
  const full = rulerFullLengthCm(ruler);
  return ruler.half ? full / 2 : full;
}

/**
 * Turn a *drawn* length back into the stored full length, so a free ruler can
 * be resized by dragging a tip without the half/full mode fighting the gesture.
 */
export function setRulerDrawnLength(ruler: PatternRuler, drawnCm: number): void {
  const drawn = Number.isFinite(drawnCm) ? Math.max(0.5, drawnCm) : 0.5;
  ruler.lengthCm = ruler.half ? drawn * 2 : drawn;
}

/**
 * Endpoints in pattern space. Pass `lengthCm` when the caller resolves the
 * length from a live measurement instead of the stored snapshot.
 */
export function rulerEndpoints(
  ruler: PatternRuler,
  lengthCm: number = rulerLengthCm(ruler)
): { a: Vec2; b: Vec2 } {
  const half = Math.max(0, lengthCm) / 2;
  const th = (ruler.angle * Math.PI) / 180;
  const dx = Math.cos(th) * half;
  const dy = Math.sin(th) * half;
  return {
    a: { x: ruler.center.x - dx, y: ruler.center.y - dy },
    b: { x: ruler.center.x + dx, y: ruler.center.y + dy },
  };
}

/** Angle in degrees from `a` to `b`, optionally snapped to 15° steps. */
export function rulerAngle(a: Vec2, b: Vec2, snap = false): number {
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (!snap) return deg;
  return Math.round(deg / 15) * 15;
}

/** Normalise to [0, 360). */
export function normalizeAngle(deg: number): number {
  const a = deg % 360;
  return a < 0 ? a + 360 : a;
}

/**
 * True when the ruler points leftwards on screen, so its labels would read
 * upside down and need a 180° flip.
 *
 * The interval is deliberately half-open at 90°: a ruler pointing straight down
 * reads top-to-bottom and is fine, while one pointing straight up would read
 * bottom-to-top — which a label should never do.
 */
export function rulerTextFlipped(deg: number): boolean {
  const a = normalizeAngle(deg);
  return a > 90 && a <= 270;
}

/** Shortest distance from `p` to the segment `a`→`b`. */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

export function measurementField(id: string | null) {
  if (!id) return null;
  return MEASUREMENT_FIELDS.find((field) => field.id === id) ?? null;
}

/** A person's number for a field, converted from their display unit to cm. */
export function measurementValueCm(
  set: MeasurementSet | null | undefined,
  id: string | null
): number | null {
  if (!set || !id) return null;
  const raw = set.values[id];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return set.unit === 'in' ? raw * CM_PER_INCH : raw;
}

/**
 * The measurement on this person closest to a dragged length, if any is a
 * sensible match. Drawing a 94 cm line on someone whose bust is 94 cm should
 * label itself rather than leaving you to pick from a dropdown.
 */
export function nearestMeasurementField(
  set: MeasurementSet | null | undefined,
  lengthCm: number
): string | null {
  if (!set || !(lengthCm > 0)) return null;
  let best: string | null = null;
  let bestErr = Infinity;
  for (const field of MEASUREMENT_FIELDS) {
    const value = measurementValueCm(set, field.id);
    if (value == null) continue;
    const err = Math.abs(value - lengthCm) / value;
    if (err < bestErr) {
      bestErr = err;
      best = field.id;
    }
  }
  return bestErr <= 0.2 ? best : null;
}

/** The two lines of text drawn on the ruler. */
export function rulerLabel(
  ruler: PatternRuler,
  unit: UnitDisplay,
  lengthCm: number,
  personName: string
): RulerLabel {
  const field = measurementField(ruler.measurementId);
  const name = (personName || ruler.personName || '').trim();
  const primary = field ? (name ? `${name} · ${field.label}` : field.label) : 'Ruler';
  const shown = formatLength(lengthCm, unit, 1);
  return { primary, secondary: ruler.half ? `½ · ${shown}` : shown };
}

// ── Measurement picker tree ────────────────────────────────────────────────
//
// The hold-to-open menu under the ruler tool: everybody in the library, their
// measurements, and a search box that matches a person and a measurement
// together ("alex waist").

export type MeasurementMenuRow = {
  fieldId: string;
  label: string;
  groupLabel: string;
  /** Canonical cm, or null when this person has not been measured for it. */
  valueCm: number | null;
};

export type MeasurementMenuSection = {
  personId: string;
  personName: string;
  /** The unit this person's numbers were taken in, for display. */
  unit: UnitDisplay;
  rows: MeasurementMenuRow[];
};

/** The full tree, in library and field order. */
export function buildMeasurementMenu(sets: MeasurementSet[]): MeasurementMenuSection[] {
  return sets.map((set) => ({
    personId: set.id,
    personName: set.name,
    unit: set.unit,
    rows: MEASUREMENT_FIELDS.map((field) => ({
      fieldId: field.id,
      label: field.label,
      groupLabel: MEASUREMENT_GROUPS.find((g) => g.id === field.group)?.label ?? field.group,
      valueCm: measurementValueCm(set, field.id),
    })),
  }));
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Split a query into searchable tokens ("Alex waist" → ["alex", "waist"]). */
export function measurementSearchTokens(query: string): string[] {
  return normalizeSearchText(query)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * How many skipped characters the ordered-subsequence fallback will tolerate.
 * Kept tight on purpose: without a cap, "bust" would "match" any haystack
 * containing b-u-s-t in order — including "Back vertical lengths shouldertowais**t**" —
 * and the tree would fill with nonsense.
 */
const MAX_SUBSEQUENCE_GAPS = 4;

/**
 * Loosely match one token against one haystack. Substrings beat scattered
 * letters, and a match at a word boundary beats one buried mid-word:
 * "wais" → "waist", "wst" → "waist", "alx" → "alex". `-1` means no match.
 */
export function fuzzyTokenScore(haystack: string, token: string): number {
  if (!token) return 0;
  const at = haystack.indexOf(token);
  if (at >= 0) {
    const boundary = at === 0 || !/[a-z0-9]/.test(haystack[at - 1]!);
    return (boundary ? 120 : 80) - Math.min(at, 40);
  }
  // Ordered subsequence, so abbreviations and dropped letters still land. It has
  // to *start* on a word boundary — otherwise "sam" would reach outseam — and
  // *end* on one too, otherwise "leg" would reach into "length".
  let cursor = 0;
  let gaps = 0;
  let start = -1;
  let last = -1;
  for (let i = 0; i < haystack.length && cursor < token.length; i++) {
    if (haystack[i] === token[cursor]) {
      if (cursor === 0) start = i;
      last = i;
      cursor += 1;
    } else if (cursor > 0) {
      gaps += 1;
      if (gaps > MAX_SUBSEQUENCE_GAPS) return -1;
    }
  }
  if (cursor < token.length) return -1;
  if (start !== 0 && /[a-z0-9]/.test(haystack[start - 1]!)) return -1;
  if (last < haystack.length - 1 && /[a-z0-9]/.test(haystack[last + 1]!)) return -1;
  return 40 - gaps;
}

/** Score for a token that names the field outright. Beats any fragment. */
const EXACT_MATCH_SCORE = 200;

/**
 * Score one row against the whole query. Every token has to land somewhere —
 * on the person or on the measurement — which is what makes "alex waist" mean
 * "Alex's waist", not "everything belonging to Alex or mentioning a waist".
 *
 * `groupTokens` limits which tokens may also be read as a drafting-group name;
 * see `filterMeasurementMenu` for why.
 */
export function measurementSearchScore(
  personName: string,
  row: MeasurementMenuRow,
  tokens: string[],
  groupTokens: ReadonlySet<string> = new Set(tokens)
): number {
  if (tokens.length === 0) return 0;
  const person = normalizeSearchText(personName);
  const label = normalizeSearchText(row.label);
  // The id is searched too, so camelCase names match ("bustSpan" → "span").
  const fieldId = normalizeSearchText(row.fieldId);
  const group = normalizeSearchText(row.groupLabel);
  let total = 0;
  for (const token of tokens) {
    let best: number;
    let fromName = false;
    if (token === fieldId || token === label) {
      // "bust" should reach the bust measurement, not merely the one whose
      // label happens to begin with the word.
      best = EXACT_MATCH_SCORE;
    } else {
      const nameScore = fuzzyTokenScore(person, token);
      const groupScore = groupTokens.has(token) ? fuzzyTokenScore(group, token) : -1;
      best = Math.max(
        fuzzyTokenScore(label, token),
        fuzzyTokenScore(fieldId, token),
        groupScore
      );
      if (nameScore > best) {
        best = nameScore;
        fromName = true;
      }
    }
    if (best < 0) return -1;
    // A hit on a person's name is the stronger signal, so it sorts first.
    total += best + (fromName ? 8 : 0);
  }
  return total;
}

/**
 * Filter the tree by query. People with nothing matching drop out entirely;
 * within a person the best matches sort first, staying in field order on a tie.
 */
export function filterMeasurementMenu(
  sections: MeasurementMenuSection[],
  query: string
): MeasurementMenuSection[] {
  const tokens = measurementSearchTokens(query);
  if (tokens.length === 0) return sections;

  // A token that exactly names a measurement means *that* measurement, not the
  // drafting group named after it. "bust" is both a field and half of
  // "Torso & bust", and reading it as the group buries it under every torso
  // measurement. "leg" names no field, so it still reaches the Leg group.
  const groupTokens = new Set(tokens);
  const allRows = sections.flatMap((section) => section.rows);
  for (const token of tokens) {
    const namesAField = allRows.some(
      (row) =>
        normalizeSearchText(row.fieldId) === token || normalizeSearchText(row.label) === token
    );
    if (namesAField) groupTokens.delete(token);
  }

  const out: MeasurementMenuSection[] = [];
  for (const section of sections) {
    const scored = section.rows
      .map((row) => ({
        row,
        score: measurementSearchScore(section.personName, row, tokens, groupTokens),
      }))
      .filter((entry) => entry.score >= 0);
    if (scored.length === 0) continue;
    // `sort` is stable, so equal scores keep the field order they arrived in.
    scored.sort((a, b) => b.score - a.score);
    out.push({ ...section, rows: scored.map((entry) => entry.row) });
  }
  return out;
}

/** Defensive load for rulers coming from a file written by an older build. */
export function normalizeRulers(raw: unknown): PatternRuler[] {
  if (!Array.isArray(raw)) return [];
  const out: PatternRuler[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Partial<PatternRuler>;
    if (typeof r.id !== 'string' || !r.id) continue;
    const center = r.center as Vec2 | undefined;
    if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) continue;
    out.push({
      id: r.id,
      center: { x: center.x, y: center.y },
      angle: Number.isFinite(r.angle) ? (r.angle as number) : 0,
      lengthCm: Number.isFinite(r.lengthCm) ? Math.max(0, r.lengthCm as number) : 0,
      measurementId: typeof r.measurementId === 'string' ? r.measurementId : null,
      personId: typeof r.personId === 'string' ? r.personId : null,
      personName: typeof r.personName === 'string' ? r.personName : '',
      half: r.half === true,
    });
  }
  return out;
}
