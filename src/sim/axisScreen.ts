import { mat4, vec3, vec4 } from 'gl-matrix';

/** One world axis as the camera currently shows it on screen. */
export type ScreenAxis = {
  /** Unit screen direction: x right, y down. */
  x: number;
  y: number;
  /** Screen length of a world unit along the axis as a fraction of the length
   *  it would have square to the view — 0 pointing at the camera, 1 across it. */
  foreshorten: number;
  /** Viewer-relative depth cue: larger is nearer the viewer. */
  depth: number;
};

export type ScreenAxes = Record<'x' | 'y' | 'z', ScreenAxis>;

const AXIS_IDS = ['x', 'y', 'z'] as const;
type AxisKey = (typeof AXIS_IDS)[number];

const WORLD_AXES: Record<AxisKey, readonly [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/**
 * The camera's own basis, read back out of its view-projection matrix.
 *
 * The view matrix's rows are the camera's right, up and backward axes in world
 * space, and both projections in use (perspectiveZO, orthoZO) scale those rows
 * by a plain diagonal — so normalising the rows of the captured matrix recovers
 * the basis, whatever the camera's azimuth, incline, zoom or projection.
 */
export function cameraBasis(viewProj: mat4): { right: vec3; up: vec3; forward: vec3 } {
  const right = normalizeRow(viewProj, 0);
  const up = normalizeRow(viewProj, 1);
  const back = normalizeRow(viewProj, 2);
  // A z-flipping projection (perspectiveZO) leaves the third row pointing the
  // wrong way, so the sign comes back from the basis being right-handed:
  // right × up = backward.
  const cross = vec3.cross(vec3.create(), right, up);
  if (vec3.dot(cross, back) < 0) vec3.negate(back, back);
  return { right, up, forward: vec3.negate(vec3.create(), back) };
}

/**
 * Screen direction of the world axes for the camera's orientation alone — the
 * reading a navigation gnomon wants, as if the axes met at the view centre.
 */
export function viewAxisDirections(viewProj: mat4): ScreenAxes {
  const basis = cameraBasis(viewProj);
  const out = {} as ScreenAxes;
  for (const id of AXIS_IDS) {
    const { cx, cy, ...rest } = reading(basis, WORLD_AXES[id]);
    const len = Math.hypot(cx, cy);
    out[id] = {
      ...rest,
      x: len > 1e-6 ? cx / len : 0,
      y: len > 1e-6 ? -cy / len : 0,
    };
  }
  return out;
}

/**
 * Screen direction of the world axes as they actually project from a world
 * point — what a transform gnomon sitting on that point must follow. The
 * perspective divide is included, so the arrows run along the axes as drawn,
 * while their length cue stays the view reading's, so the arrows of a gizmo
 * keep a steady size as it moves around the viewport.
 */
export function pointAxisDirections(
  viewProj: mat4,
  origin: vec3,
  widthPx: number,
  heightPx: number
): ScreenAxes {
  const basis = cameraBasis(viewProj);
  const clip = clipPoint(viewProj, origin);

  const out = {} as ScreenAxes;
  for (const id of AXIS_IDS) {
    const axis = WORLD_AXES[id];
    const { foreshorten, depth } = reading(basis, axis);
    const end = clipPoint(viewProj, origin, axis);
    if (Math.abs(clip[3]) < 1e-9 || Math.abs(end[3]) < 1e-9) {
      out[id] = { x: 0, y: 0, foreshorten, depth };
      continue;
    }
    const dx = (end[0] / end[3] - clip[0] / clip[3]) * 0.5 * widthPx;
    const dy = -(end[1] / end[3] - clip[1] / clip[3]) * 0.5 * heightPx;
    const len = Math.hypot(dx, dy);
    out[id] = {
      x: len > 1e-6 ? dx / len : 0,
      y: len > 1e-6 ? dy / len : 0,
      foreshorten,
      depth,
    };
  }
  return out;
}

/**
 * How one world axis reads in camera space: its screen-plane components (cx
 * across, cy up), how much shorter the view makes it, and its depth cue.
 */
function reading(
  basis: { right: vec3; up: vec3; forward: vec3 },
  axis: readonly [number, number, number]
): { cx: number; cy: number; foreshorten: number; depth: number } {
  const cx = dot3(basis.right, axis);
  const cy = dot3(basis.up, axis);
  return {
    cx,
    cy,
    foreshorten: clamp01(Math.hypot(cx, cy)),
    depth: -dot3(basis.forward, axis),
  };
}

/** Clip-space point for `origin`, optionally moved one world unit along `axis`. */
function clipPoint(viewProj: mat4, origin: vec3, axis?: readonly [number, number, number]): vec4 {
  const clip = vec4.fromValues(
    origin[0] + (axis ? axis[0] : 0),
    origin[1] + (axis ? axis[1] : 0),
    origin[2] + (axis ? axis[2] : 0),
    1
  );
  vec4.transformMat4(clip, clip, viewProj);
  return clip;
}

/** Row `i` of the matrix's 3x3 part (gl-matrix stores columns). */
function normalizeRow(m: mat4, i: number): vec3 {
  const v = vec3.fromValues(m[i], m[4 + i], m[8 + i]);
  const len = vec3.length(v);
  if (len < 1e-12) return vec3.fromValues(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
  return vec3.scale(v, v, 1 / len);
}

function dot3(v: vec3, a: readonly [number, number, number]): number {
  return v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
