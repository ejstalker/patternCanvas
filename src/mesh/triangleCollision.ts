import { vec3 } from 'gl-matrix';

const _ab = vec3.create();
const _ac = vec3.create();
const _ap = vec3.create();
const _bp = vec3.create();
const _cp = vec3.create();

/** Closest point on triangle ABC to point P (Ericson, Real-Time Collision Detection). */
export function closestPointOnTriangle(p: vec3, a: vec3, b: vec3, c: vec3, out: vec3): vec3 {
  vec3.sub(_ab, b, a);
  vec3.sub(_ac, c, a);
  vec3.sub(_ap, p, a);

  const d1 = vec3.dot(_ab, _ap);
  const d2 = vec3.dot(_ac, _ap);
  if (d1 <= 0 && d2 <= 0) return vec3.copy(out, a);

  vec3.sub(_bp, p, b);
  const d3 = vec3.dot(_ab, _bp);
  const d4 = vec3.dot(_ac, _bp);
  if (d3 >= 0 && d4 <= d3) return vec3.copy(out, b);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return vec3.scaleAndAdd(out, a, _ab, v);
  }

  vec3.sub(_cp, p, c);
  const d5 = vec3.dot(_ab, _cp);
  const d6 = vec3.dot(_ac, _cp);
  if (d6 >= 0 && d5 <= d6) return vec3.copy(out, c);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return vec3.scaleAndAdd(out, a, _ac, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    vec3.sub(_cp, c, b);
    return vec3.scaleAndAdd(out, b, _cp, w);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  vec3.scale(out, a, 1 - v - w);
  vec3.scaleAndAdd(out, out, _ab, v);
  vec3.scaleAndAdd(out, out, _ac, w);
  return out;
}

export function triangleNormal(a: vec3, b: vec3, c: vec3, out: vec3): vec3 {
  vec3.sub(_ab, b, a);
  vec3.sub(_ac, c, a);
  vec3.cross(out, _ab, _ac);
  const len = vec3.length(out);
  if (len > 1e-8) vec3.scale(out, out, 1 / len);
  else vec3.set(out, 0, 1, 0);
  return out;
}
