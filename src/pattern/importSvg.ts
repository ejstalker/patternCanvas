import type { BezierPoint, PatternPiece, Vec2 } from '../project/types';
import { uid } from '../project/createDefault';

/** Cubic kappa for a quarter-circle / rounded-rect corner. */
const BEZIER_CIRCLE_K = 0.5522847498;

export type SvgImportOptions = {
  /** Extra multiplier after physical conversion (1 = 100%). */
  scale?: number;
};

export type SvgImportResult = {
  pieces: PatternPiece[];
  /** Detected physical width in cm (before scale override). */
  widthCm: number;
  /** Detected physical height in cm (before scale override). */
  heightCm: number;
  /** cm per SVG user unit before the optional scale override. */
  cmPerUserUnit: number;
  warnings: string[];
  error?: string;
};

type Mat2d = [number, number, number, number, number, number]; // a b c d e f

type CubicSeg = { p0: Vec2; c0: Vec2; c1: Vec2; p1: Vec2 };

type Subpath = {
  closed: boolean;
  segs: CubicSeg[];
  start: Vec2;
};

const IDENTITY: Mat2d = [1, 0, 0, 1, 0, 0];

function mul(a: Mat2d, b: Mat2d): Mat2d {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function applyMat(m: Mat2d, p: Vec2): Vec2 {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

function translate(tx: number, ty: number): Mat2d {
  return [1, 0, 0, 1, tx, ty];
}

function scaleMat(sx: number, sy: number): Mat2d {
  return [sx, 0, 0, sy, 0, 0];
}

function rotateMat(deg: number, cx = 0, cy = 0): Mat2d {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const rot: Mat2d = [cos, sin, -sin, cos, 0, 0];
  if (cx === 0 && cy === 0) return rot;
  return mul(translate(cx, cy), mul(rot, translate(-cx, -cy)));
}

function skewXMat(deg: number): Mat2d {
  const t = Math.tan((deg * Math.PI) / 180);
  return [1, 0, t, 1, 0, 0];
}

function skewYMat(deg: number): Mat2d {
  const t = Math.tan((deg * Math.PI) / 180);
  return [1, t, 0, 1, 0, 0];
}

/** Parse a CSS/SVG transform attribute into a matrix. */
function parseTransform(attr: string | null): Mat2d {
  if (!attr || !attr.trim()) return IDENTITY;
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attr))) {
    const kind = match[1].toLowerCase();
    const nums = match[2]
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    let next = IDENTITY;
    switch (kind) {
      case 'matrix':
        if (nums.length >= 6) next = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
        break;
      case 'translate':
        next = translate(nums[0] ?? 0, nums[1] ?? 0);
        break;
      case 'scale':
        next = scaleMat(nums[0] ?? 1, nums[1] ?? nums[0] ?? 1);
        break;
      case 'rotate':
        next = rotateMat(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0);
        break;
      case 'skewx':
        next = skewXMat(nums[0] ?? 0);
        break;
      case 'skewy':
        next = skewYMat(nums[0] ?? 0);
        break;
    }
    m = mul(m, next);
  }
  return m;
}

/**
 * Convert an SVG length string to centimeters.
 * Bare numbers are treated as px @ 96 DPI unless `bareAsUser` is set (then return as-is).
 */
function lengthToCm(raw: string | null | undefined, bareAsUser = false): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-z%]*)$/i);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = (m[2] || '').toLowerCase();
  switch (unit) {
    case 'cm':
      return v;
    case 'mm':
      return v / 10;
    case 'in':
      return v * 2.54;
    case 'pt':
      return (v * 2.54) / 72;
    case 'pc':
      return (v * 2.54) / 6;
    case 'px':
    case '':
      if (bareAsUser) return v;
      return (v * 2.54) / 96;
    case '%':
      return null;
    default:
      return (v * 2.54) / 96;
  }
}

function parseViewBox(raw: string | null): { x: number; y: number; w: number; h: number } | null {
  if (!raw) return null;
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts[2] <= 0 || parts[3] <= 0) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function almostEq(a: Vec2, b: Vec2, eps = 1e-6): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

function almostHandle(a: Vec2, b: Vec2, eps = 1e-5): boolean {
  return almostEq(a, b, eps);
}

function polyArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return a / 2;
}

function sampleCubic(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, steps: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x =
      u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x;
    const y =
      u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y;
    out.push({ x, y });
  }
  return out;
}

function subpathSample(sp: Subpath, stepsPerSeg = 8): Vec2[] {
  if (sp.segs.length === 0) return [{ ...sp.start }];
  const pts: Vec2[] = [{ ...sp.segs[0].p0 }];
  for (const s of sp.segs) {
    const samp = sampleCubic(s.p0, s.c0, s.c1, s.p1, stepsPerSeg);
    for (let i = 1; i < samp.length; i++) pts.push(samp[i]);
  }
  return pts;
}

function subpathAbsArea(sp: Subpath): number {
  return Math.abs(polyArea(subpathSample(sp)));
}

function transformSeg(seg: CubicSeg, m: Mat2d): CubicSeg {
  return {
    p0: applyMat(m, seg.p0),
    c0: applyMat(m, seg.c0),
    c1: applyMat(m, seg.c1),
    p1: applyMat(m, seg.p1),
  };
}

function transformSubpath(sp: Subpath, m: Mat2d): Subpath {
  return {
    closed: sp.closed,
    start: applyMat(m, sp.start),
    segs: sp.segs.map((s) => transformSeg(s, m)),
  };
}

function lineSeg(a: Vec2, b: Vec2): CubicSeg {
  return { p0: { ...a }, c0: { ...a }, c1: { ...b }, p1: { ...b } };
}

function quadToCubic(p0: Vec2, q: Vec2, p1: Vec2): CubicSeg {
  return {
    p0: { ...p0 },
    c0: { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) },
    c1: { x: p1.x + (2 / 3) * (q.x - p1.x), y: p1.y + (2 / 3) * (q.y - p1.y) },
    p1: { ...p1 },
  };
}

/** Convert an SVG elliptical arc to one or more cubic segments. */
function arcToCubics(
  p0: Vec2,
  rx: number,
  ry: number,
  xAxisRotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Vec2
): CubicSeg[] {
  if (almostEq(p0, p1)) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx < 1e-12 || ry < 1e-12) return [lineSeg(p0, p1)];

  const phi = (xAxisRotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  let rxSq = rx * rx;
  let rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;
  const lambda = x1pSq / rxSq + y1pSq / rySq;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rxSq = rx * rx;
    rySq = ry * ry;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const num = Math.max(0, rxSq * rySq - rxSq * y1pSq - rySq * x1pSq);
  const den = rxSq * y1pSq + rySq * x1pSq;
  const coef = den > 0 ? (sign * Math.sqrt(num / den)) : 0;
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * (-ry * x1p)) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2;

  const angle = (u: Vec2, v: Vec2) => {
    const dot = u.x * v.x + u.y * v.y;
    const len = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
    const ang = Math.acos(Math.max(-1, Math.min(1, len ? dot / len : 1)));
    return u.x * v.y - u.y * v.x < 0 ? -ang : ang;
  };

  const v1: Vec2 = { x: (x1p - cxp) / rx, y: (y1p - cyp) / ry };
  const v2: Vec2 = { x: (-x1p - cxp) / rx, y: (-y1p - cyp) / ry };
  let theta1 = angle({ x: 1, y: 0 }, v1);
  let dTheta = angle(v1, v2);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segments;
  const out: CubicSeg[] = [];
  for (let i = 0; i < segments; i++) {
    const t0 = theta1 + i * delta;
    const t1 = t0 + delta;
    const alpha = (4 / 3) * Math.tan(delta / 4);
    const ep = (t: number) => ({
      x: cx + cosPhi * rx * Math.cos(t) - sinPhi * ry * Math.sin(t),
      y: cy + sinPhi * rx * Math.cos(t) + cosPhi * ry * Math.sin(t),
    });
    const et = (t: number) => ({
      x: -cosPhi * rx * Math.sin(t) - sinPhi * ry * Math.cos(t),
      y: -sinPhi * rx * Math.sin(t) + cosPhi * ry * Math.cos(t),
    });
    const a = ep(t0);
    const b = ep(t1);
    const ta = et(t0);
    const tb = et(t1);
    out.push({
      p0: a,
      c0: { x: a.x + alpha * ta.x, y: a.y + alpha * ta.y },
      c1: { x: b.x - alpha * tb.x, y: b.y - alpha * tb.y },
      p1: b,
    });
  }
  // Snap endpoints to exact start/end to avoid drift.
  if (out.length) {
    out[0].p0 = { ...p0 };
    out[out.length - 1].p1 = { ...p1 };
  }
  return out;
}

function tokenizePath(d: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(Number(m[2]));
  }
  return tokens;
}

function parsePathD(d: string): Subpath[] {
  const tokens = tokenizePath(d);
  const subpaths: Subpath[] = [];
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let lastC1: Vec2 | null = null;
  let lastQ: Vec2 | null = null;
  let current: Subpath | null = null;

  const peekNum = () => typeof tokens[i] === 'number';
  const num = () => {
    const v = tokens[i++];
    return typeof v === 'number' ? v : 0;
  };

  const ensure = () => {
    if (!current) {
      current = { closed: false, segs: [], start: { x: cx, y: cy } };
      subpaths.push(current);
    }
  };

  const addSeg = (seg: CubicSeg) => {
    ensure();
    current!.segs.push(seg);
    cx = seg.p1.x;
    cy = seg.p1.y;
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') {
      cmd = t;
      i++;
    } else if (!cmd) {
      i++;
      continue;
    }

    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();

    if (c === 'Z') {
      if (current && current.segs.length) {
        const end = { x: cx, y: cy };
        const start = { x: startX, y: startY };
        if (!almostEq(end, start)) addSeg(lineSeg(end, start));
        current.closed = true;
      }
      cx = startX;
      cy = startY;
      lastC1 = null;
      lastQ = null;
      current = null;
      continue;
    }

    if (c === 'M') {
      let x = num();
      let y = num();
      if (rel) {
        x += cx;
        y += cy;
      }
      cx = x;
      cy = y;
      startX = x;
      startY = y;
      current = { closed: false, segs: [], start: { x, y } };
      subpaths.push(current);
      lastC1 = null;
      lastQ = null;
      // Implicit lineto after moveto
      while (peekNum()) {
        let lx = num();
        let ly = num();
        if (rel) {
          lx += cx;
          ly += cy;
        }
        addSeg(lineSeg({ x: cx, y: cy }, { x: lx, y: ly }));
        lastC1 = null;
        lastQ = null;
      }
      continue;
    }

    if (c === 'L') {
      while (peekNum()) {
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        addSeg(lineSeg({ x: cx, y: cy }, { x, y }));
        lastC1 = null;
        lastQ = null;
      }
      continue;
    }

    if (c === 'H') {
      while (peekNum()) {
        let x = num();
        if (rel) x += cx;
        addSeg(lineSeg({ x: cx, y: cy }, { x, y: cy }));
        lastC1 = null;
        lastQ = null;
      }
      continue;
    }

    if (c === 'V') {
      while (peekNum()) {
        let y = num();
        if (rel) y += cy;
        addSeg(lineSeg({ x: cx, y: cy }, { x: cx, y }));
        lastC1 = null;
        lastQ = null;
      }
      continue;
    }

    if (c === 'C') {
      while (peekNum()) {
        let x1 = num();
        let y1 = num();
        let x2 = num();
        let y2 = num();
        let x = num();
        let y = num();
        if (rel) {
          x1 += cx;
          y1 += cy;
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        const seg: CubicSeg = {
          p0: { x: cx, y: cy },
          c0: { x: x1, y: y1 },
          c1: { x: x2, y: y2 },
          p1: { x, y },
        };
        addSeg(seg);
        lastC1 = { x: x2, y: y2 };
        lastQ = null;
      }
      continue;
    }

    if (c === 'S') {
      while (peekNum()) {
        let x2 = num();
        let y2 = num();
        let x = num();
        let y = num();
        if (rel) {
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        const x1 = lastC1 ? 2 * cx - lastC1.x : cx;
        const y1 = lastC1 ? 2 * cy - lastC1.y : cy;
        const seg: CubicSeg = {
          p0: { x: cx, y: cy },
          c0: { x: x1, y: y1 },
          c1: { x: x2, y: y2 },
          p1: { x, y },
        };
        addSeg(seg);
        lastC1 = { x: x2, y: y2 };
        lastQ = null;
      }
      continue;
    }

    if (c === 'Q') {
      while (peekNum()) {
        let qx = num();
        let qy = num();
        let x = num();
        let y = num();
        if (rel) {
          qx += cx;
          qy += cy;
          x += cx;
          y += cy;
        }
        const seg = quadToCubic({ x: cx, y: cy }, { x: qx, y: qy }, { x, y });
        addSeg(seg);
        lastQ = { x: qx, y: qy };
        lastC1 = null;
      }
      continue;
    }

    if (c === 'T') {
      while (peekNum()) {
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        const qx = lastQ ? 2 * cx - lastQ.x : cx;
        const qy = lastQ ? 2 * cy - lastQ.y : cy;
        const seg = quadToCubic({ x: cx, y: cy }, { x: qx, y: qy }, { x, y });
        addSeg(seg);
        lastQ = { x: qx, y: qy };
        lastC1 = null;
      }
      continue;
    }

    if (c === 'A') {
      while (peekNum()) {
        const rx = Math.abs(num());
        const ry = Math.abs(num());
        const rot = num();
        const large = !!num();
        const sweep = !!num();
        let x = num();
        let y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        const segs = arcToCubics({ x: cx, y: cy }, rx, ry, rot, large, sweep, { x, y });
        for (const seg of segs) addSeg(seg);
        lastC1 = null;
        lastQ = null;
      }
      continue;
    }

    // Unknown / exhausted — advance to avoid infinite loop
    i++;
  }

  return subpaths.filter((sp) => sp.segs.length > 0 || sp.closed);
}

function ellipseSubpath(cx: number, cy: number, rx: number, ry: number): Subpath {
  const ox = rx * BEZIER_CIRCLE_K;
  const oy = ry * BEZIER_CIRCLE_K;
  const r: Vec2 = { x: cx + rx, y: cy };
  const b: Vec2 = { x: cx, y: cy + ry };
  const l: Vec2 = { x: cx - rx, y: cy };
  const t: Vec2 = { x: cx, y: cy - ry };
  return {
    closed: true,
    start: { ...r },
    segs: [
      { p0: r, c0: { x: cx + rx, y: cy + oy }, c1: { x: cx + ox, y: cy + ry }, p1: b },
      { p0: b, c0: { x: cx - ox, y: cy + ry }, c1: { x: cx - rx, y: cy + oy }, p1: l },
      { p0: l, c0: { x: cx - rx, y: cy - oy }, c1: { x: cx - ox, y: cy - ry }, p1: t },
      { p0: t, c0: { x: cx + ox, y: cy - ry }, c1: { x: cx + rx, y: cy - oy }, p1: r },
    ],
  };
}

function rectSubpath(
  x: number,
  y: number,
  w: number,
  h: number,
  rxRaw: number,
  ryRaw: number
): Subpath {
  let rx = Math.max(0, rxRaw);
  let ry = Math.max(0, ryRaw);
  if (rx === 0 && ry === 0) {
    const a = { x, y };
    const b = { x: x + w, y };
    const c = { x: x + w, y: y + h };
    const d = { x, y: y + h };
    return {
      closed: true,
      start: { ...a },
      segs: [lineSeg(a, b), lineSeg(b, c), lineSeg(c, d), lineSeg(d, a)],
    };
  }
  if (rx === 0) rx = ry;
  if (ry === 0) ry = rx;
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);
  const kx = rx * BEZIER_CIRCLE_K;
  const ky = ry * BEZIER_CIRCLE_K;
  const p0 = { x: x + rx, y };
  const p1 = { x: x + w - rx, y };
  const p2 = { x: x + w, y: y + ry };
  const p3 = { x: x + w, y: y + h - ry };
  const p4 = { x: x + w - rx, y: y + h };
  const p5 = { x: x + rx, y: y + h };
  const p6 = { x, y: y + h - ry };
  const p7 = { x, y: y + ry };
  return {
    closed: true,
    start: { ...p0 },
    segs: [
      lineSeg(p0, p1),
      {
        p0: p1,
        c0: { x: p1.x + kx, y: p1.y },
        c1: { x: p2.x, y: p2.y - ky },
        p1: p2,
      },
      lineSeg(p2, p3),
      {
        p0: p3,
        c0: { x: p3.x, y: p3.y + ky },
        c1: { x: p4.x + kx, y: p4.y },
        p1: p4,
      },
      lineSeg(p4, p5),
      {
        p0: p5,
        c0: { x: p5.x - kx, y: p5.y },
        c1: { x: p6.x, y: p6.y + ky },
        p1: p6,
      },
      lineSeg(p6, p7),
      {
        p0: p7,
        c0: { x: p7.x, y: p7.y - ky },
        c1: { x: p0.x - kx, y: p0.y },
        p1: p0,
      },
    ],
  };
}

function polygonSubpath(pointsAttr: string, closed: boolean): Subpath | null {
  const nums = pointsAttr
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (nums.length < 4) return null;
  const pts: Vec2[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push({ x: nums[i], y: nums[i + 1] });
  }
  if (pts.length < 2) return null;
  const segs: CubicSeg[] = [];
  for (let i = 0; i < pts.length - 1; i++) segs.push(lineSeg(pts[i], pts[i + 1]));
  if (closed) segs.push(lineSeg(pts[pts.length - 1], pts[0]));
  return { closed, start: { ...pts[0] }, segs };
}

function attrNum(el: Element, name: string, fallback = 0): number {
  const v = el.getAttribute(name);
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function elementName(el: Element): string {
  const ink =
    el.getAttribute('inkscape:label') ||
    el.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'label');
  const data = el.getAttribute('data-name');
  const id = el.getAttribute('id');
  return (ink || data || id || '').trim();
}

function segsToBezierPoints(sp: Subpath): BezierPoint[] | null {
  if (sp.segs.length === 0) return null;
  const pts: BezierPoint[] = [];
  const first = sp.segs[0].p0;
  pts.push({
    id: uid('pt'),
    anchor: { ...first },
    handleIn: null,
    handleOut: null,
    handlesParallel: false,
  });

  for (const seg of sp.segs) {
    const last = pts[pts.length - 1];
    if (!almostHandle(seg.c0, seg.p0)) {
      last.handleOut = { ...seg.c0 };
    }
    const isClosing =
      sp.closed && almostEq(seg.p1, first) && seg === sp.segs[sp.segs.length - 1];
    if (isClosing) {
      if (!almostHandle(seg.c1, seg.p1)) {
        pts[0].handleIn = { ...seg.c1 };
      }
      continue;
    }
    pts.push({
      id: uid('pt'),
      anchor: { ...seg.p1 },
      handleIn: almostHandle(seg.c1, seg.p1) ? null : { ...seg.c1 },
      handleOut: null,
      handlesParallel: false,
    });
  }

  if (sp.closed && pts.length >= 2 && almostEq(pts[0].anchor, pts[pts.length - 1].anchor)) {
    const last = pts.pop()!;
    if (last.handleIn && !pts[0].handleIn) pts[0].handleIn = last.handleIn;
  }

  if (pts.length < 2) return null;
  // Mark smooth when both handles exist and are roughly opposite.
  for (const pt of pts) {
    if (pt.handleIn && pt.handleOut) {
      const ix = pt.handleIn.x - pt.anchor.x;
      const iy = pt.handleIn.y - pt.anchor.y;
      const ox = pt.handleOut.x - pt.anchor.x;
      const oy = pt.handleOut.y - pt.anchor.y;
      const cross = Math.abs(ix * oy - iy * ox);
      const dot = ix * ox + iy * oy;
      if (cross < 1e-4 * (Math.hypot(ix, iy) * Math.hypot(ox, oy) + 1e-9) && dot < 0) {
        pt.handlesParallel = true;
      }
    }
  }
  return pts;
}

function subpathToPiece(sp: Subpath, name: string): PatternPiece | null {
  // Auto-close near-closed open paths
  let closed = sp.closed;
  if (!closed && sp.segs.length >= 2) {
    const end = sp.segs[sp.segs.length - 1].p1;
    if (almostEq(sp.start, end, 1e-4)) closed = true;
  }
  if (!closed) return null;
  const points = segsToBezierPoints({ ...sp, closed: true });
  // Two curved points can form a closed lens; triangulation needs ≥3 but import keeps them editable.
  if (!points || points.length < 2) return null;
  return {
    id: uid('piece'),
    name,
    closed: true,
    points,
  };
}

type Collected = {
  subpaths: Array<{ sp: Subpath; name: string; fillRule: string; sourceId: number }>;
  warnings: string[];
  nextSourceId: number;
};

type CanvasBox = { x: number; y: number; w: number; h: number };

function paintIsNone(raw: string | null): boolean {
  if (raw == null) return true;
  const s = raw.trim().toLowerCase();
  return s === '' || s === 'none' || s === 'transparent';
}

function hasVisibleStroke(el: Element): boolean {
  if (paintIsNone(el.getAttribute('stroke'))) return false;
  const sw = el.getAttribute('stroke-width');
  if (sw != null && sw !== '' && Number(sw) === 0) return false;
  return true;
}

/** Figma/Illustrator artboard: unstroked rect covering the viewBox. */
function isArtboardRect(el: Element, canvas: CanvasBox): boolean {
  if (hasVisibleStroke(el)) return false;
  const x = attrNum(el, 'x');
  const y = attrNum(el, 'y');
  const w = attrNum(el, 'width');
  const h = attrNum(el, 'height');
  if (!(w > 0) || !(h > 0)) return false;
  const tol = Math.max(0.5, Math.min(canvas.w, canvas.h) * 0.002);
  return (
    Math.abs(x - canvas.x) <= tol &&
    Math.abs(y - canvas.y) <= tol &&
    Math.abs(w - canvas.w) <= tol &&
    Math.abs(h - canvas.h) <= tol
  );
}

function collectFromElement(
  el: Element,
  parentMat: Mat2d,
  out: Collected,
  canvas: CanvasBox
): void {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
  if (
    tag === 'defs' ||
    tag === 'clippath' ||
    tag === 'mask' ||
    tag === 'symbol' ||
    tag === 'marker' ||
    tag === 'pattern' ||
    tag === 'style' ||
    tag === 'script' ||
    tag === 'metadata' ||
    tag === 'title' ||
    tag === 'desc'
  ) {
    return;
  }

  const local = parseTransform(el.getAttribute('transform'));
  const mat = mul(parentMat, local);
  const name = elementName(el);
  const fillRule = (
    el.getAttribute('fill-rule') ||
    el.getAttribute('clip-rule') ||
    'nonzero'
  ).toLowerCase();

  if (tag === 'g' || tag === 'a' || tag === 'svg') {
    for (const child of Array.from(el.children)) {
      collectFromElement(child, mat, out, canvas);
    }
    return;
  }

  if (tag === 'text' || tag === 'tspan' || tag === 'image' || tag === 'foreignobject') {
    out.warnings.push(`Skipped unsupported <${tag}> element`);
    return;
  }

  if (tag === 'use') {
    out.warnings.push('Skipped <use> references (not expanded)');
    return;
  }

  let subs: Subpath[] = [];

  if (tag === 'path') {
    const d = el.getAttribute('d');
    if (!d) return;
    subs = parsePathD(d);
  } else if (tag === 'rect') {
    const x = attrNum(el, 'x');
    const y = attrNum(el, 'y');
    const w = attrNum(el, 'width');
    const h = attrNum(el, 'height');
    if (w <= 0 || h <= 0) return;
    if (isArtboardRect(el, canvas)) return;
    const rx = attrNum(el, 'rx');
    const ry = attrNum(el, 'ry', rx);
    subs = [rectSubpath(x, y, w, h, rx, ry)];
  } else if (tag === 'circle') {
    const cx = attrNum(el, 'cx');
    const cy = attrNum(el, 'cy');
    const r = attrNum(el, 'r');
    if (r <= 0) return;
    subs = [ellipseSubpath(cx, cy, r, r)];
  } else if (tag === 'ellipse') {
    const cx = attrNum(el, 'cx');
    const cy = attrNum(el, 'cy');
    const rx = attrNum(el, 'rx');
    const ry = attrNum(el, 'ry');
    if (rx <= 0 || ry <= 0) return;
    subs = [ellipseSubpath(cx, cy, rx, ry)];
  } else if (tag === 'polygon') {
    const pts = el.getAttribute('points');
    if (!pts) return;
    const sp = polygonSubpath(pts, true);
    if (sp) subs = [sp];
  } else if (tag === 'polyline') {
    const pts = el.getAttribute('points');
    if (!pts) return;
    const sp = polygonSubpath(pts, false);
    if (sp) {
      // Close if first≈last
      if (sp.segs.length && almostEq(sp.start, sp.segs[sp.segs.length - 1].p1, 1e-4)) {
        sp.closed = true;
      }
      subs = [sp];
    }
  } else if (tag === 'line') {
    out.warnings.push('Skipped open <line> (not a closed panel)');
    return;
  } else {
    // Unknown shape — still walk children if any
    for (const child of Array.from(el.children)) {
      collectFromElement(child, mat, out, canvas);
    }
    return;
  }

  const sourceId = out.nextSourceId++;
  for (let i = 0; i < subs.length; i++) {
    const sp = transformSubpath(subs[i], mat);
    const label =
      name ||
      (subs.length > 1 ? `Path ${out.subpaths.length + 1}` : `Piece ${out.subpaths.length + 1}`);
    out.subpaths.push({
      sp,
      name: subs.length > 1 && name ? `${name} ${i + 1}` : label,
      fillRule,
      sourceId,
    });
  }
}

/**
 * Parse an SVG document string into closed pattern pieces in centimeters.
 * Applies physical width/height (or px@96dpi) mapping, then optional scale.
 */
export function parseSvgToPieces(svgText: string, opts: SvgImportOptions = {}): SvgImportResult {
  const warnings: string[] = [];
  const scale = opts.scale != null && opts.scale > 0 ? opts.scale : 1;

  const trimmed = svgText.trim();
  if (!trimmed) {
    return {
      pieces: [],
      widthCm: 0,
      heightCm: 0,
      cmPerUserUnit: 1,
      warnings,
      error: 'Empty SVG file',
    };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(trimmed, 'image/svg+xml');
  } catch {
    return {
      pieces: [],
      widthCm: 0,
      heightCm: 0,
      cmPerUserUnit: 1,
      warnings,
      error: 'Could not parse SVG',
    };
  }

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    return {
      pieces: [],
      widthCm: 0,
      heightCm: 0,
      cmPerUserUnit: 1,
      warnings,
      error: 'Invalid SVG markup',
    };
  }

  const svg = doc.documentElement;
  if (!svg || svg.tagName.toLowerCase().replace(/^svg:/, '') !== 'svg') {
    return {
      pieces: [],
      widthCm: 0,
      heightCm: 0,
      cmPerUserUnit: 1,
      warnings,
      error: 'Document is not an SVG',
    };
  }

  const viewBox = parseViewBox(svg.getAttribute('viewBox'));
  const widthCmAttr = lengthToCm(svg.getAttribute('width'));
  const heightCmAttr = lengthToCm(svg.getAttribute('height'));

  let vbW = viewBox?.w ?? 0;
  let vbH = viewBox?.h ?? 0;
  if (!vbW || !vbH) {
    // Fall back to numeric width/height as user units
    const wu = lengthToCm(svg.getAttribute('width'), true);
    const hu = lengthToCm(svg.getAttribute('height'), true);
    vbW = wu && wu > 0 ? wu : 100;
    vbH = hu && hu > 0 ? hu : 100;
    if (!viewBox) {
      warnings.push('No viewBox — using width/height as user units');
    }
  }

  let widthCm = widthCmAttr && widthCmAttr > 0 ? widthCmAttr : 0;
  let heightCm = heightCmAttr && heightCmAttr > 0 ? heightCmAttr : 0;

  // If only one physical dimension is set, preserve aspect via viewBox.
  if (widthCm > 0 && !(heightCm > 0)) heightCm = widthCm * (vbH / vbW);
  if (heightCm > 0 && !(widthCm > 0)) widthCm = heightCm * (vbW / vbH);

  // No physical size → treat user units as CSS px @ 96 DPI.
  if (!(widthCm > 0) || !(heightCm > 0)) {
    widthCm = (vbW * 2.54) / 96;
    heightCm = (vbH * 2.54) / 96;
    warnings.push('No physical width/height — treating user units as px @ 96 DPI');
  }

  const cmPerUserUnit = widthCm / vbW;

  // Map viewBox origin into positive user space via translate, then scale to cm.
  const rootMat = mul(
    scaleMat(cmPerUserUnit * scale, cmPerUserUnit * scale),
    viewBox ? translate(-viewBox.x, -viewBox.y) : IDENTITY
  );

  const elementWarnings: string[] = [];
  const collected: Collected = { subpaths: [], warnings: elementWarnings, nextSourceId: 1 };
  const canvas: CanvasBox = viewBox
    ? { x: viewBox.x, y: viewBox.y, w: viewBox.w, h: viewBox.h }
    : { x: 0, y: 0, w: vbW, h: vbH };
  // Also honor transform on the root <svg>
  const rootWithTransform = mul(rootMat, parseTransform(svg.getAttribute('transform')));
  for (const child of Array.from(svg.children)) {
    collectFromElement(child, rootWithTransform, collected, canvas);
  }

  // Group consecutive subpaths from the same compound path for hole detection.
  // Heuristic: within each collected entry that came from one <path>, skip
  // smaller opposite-winding contours as holes.
  const pieces: PatternPiece[] = [];
  let openSkipped = 0;
  let holeSkipped = 0;
  let tinySkipped = 0;
  let pieceIndex = 0;

  // Re-walk isn't needed — each collected item may already be one subpath.
  // For hole detection, group by contiguous same-name entries from a multi-subpath path
  // by checking fillRule and relative areas among consecutive closed subpaths that
  // share a base name prefix. Simpler approach: for each closed subpath, if its
  // absolute area is much smaller than a previous closed subpath that contains its
  // centroid (point-in-poly), treat as hole when fill-rule is evenodd OR opposite winding.

  const closedCandidates: Array<{
    sp: Subpath;
    name: string;
    fillRule: string;
    sourceId: number;
    area: number;
    signed: number;
    sample: Vec2[];
  }> = [];

  for (const item of collected.subpaths) {
    let sp = item.sp;
    if (!sp.closed) {
      // Near-close
      if (sp.segs.length >= 2) {
        const end = sp.segs[sp.segs.length - 1].p1;
        if (almostEq(sp.start, end, 1e-3 * Math.max(1, cmPerUserUnit))) {
          sp = { ...sp, closed: true };
        }
      }
    }
    if (!sp.closed) {
      openSkipped++;
      continue;
    }
    const sample = subpathSample(sp);
    const signed = polyArea(sample);
    const area = Math.abs(signed);
    if (area < 1e-4) {
      tinySkipped++;
      continue;
    }
    closedCandidates.push({
      sp,
      name: item.name,
      fillRule: item.fillRule,
      sourceId: item.sourceId,
      area,
      signed,
      sample,
    });
  }

  function pointInPoly(pt: Vec2, poly: Vec2[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x;
      const yi = poly[i].y;
      const xj = poly[j].x;
      const yj = poly[j].y;
      const intersect =
        yi > pt.y !== yj > pt.y &&
        pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-30) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  const usedAsHole = new Set<number>();
  for (let i = 0; i < closedCandidates.length; i++) {
    if (usedAsHole.has(i)) continue;
    const a = closedCandidates[i];
    for (let j = 0; j < closedCandidates.length; j++) {
      if (i === j || usedAsHole.has(j)) continue;
      const b = closedCandidates[j];
      // Holes only exist as extra subpaths of the same compound path — never
      // across sibling elements (Figma exports every panel with evenodd).
      if (a.sourceId !== b.sourceId) continue;
      if (b.area >= a.area * 0.95) continue;
      // Centroid of b
      let cx = 0;
      let cy = 0;
      for (const p of b.sample) {
        cx += p.x;
        cy += p.y;
      }
      cx /= b.sample.length;
      cy /= b.sample.length;
      if (!pointInPoly({ x: cx, y: cy }, a.sample)) continue;
      const opposite = a.signed * b.signed < 0;
      const evenodd = a.fillRule === 'evenodd' || b.fillRule === 'evenodd';
      if (opposite || evenodd) {
        usedAsHole.add(j);
        holeSkipped++;
      }
    }
  }

  for (let i = 0; i < closedCandidates.length; i++) {
    if (usedAsHole.has(i)) continue;
    const c = closedCandidates[i];
    pieceIndex++;
    const name =
      c.name && !/^Piece\s+\d+$/i.test(c.name) && !/^Path\s+\d+$/i.test(c.name)
        ? c.name
        : `Piece ${pieceIndex}`;
    const piece = subpathToPiece(c.sp, name);
    if (piece) pieces.push(piece);
    else tinySkipped++;
  }

  if (openSkipped) warnings.push(`Skipped ${openSkipped} open path(s)`);
  if (holeSkipped) {
    warnings.push(
      `Skipped ${holeSkipped} hole contour(s) — holes are not supported (import outer outlines only)`
    );
  }
  if (tinySkipped) warnings.push(`Skipped ${tinySkipped} degenerate outline(s)`);
  {
    const seen = new Set(warnings);
    for (const w of elementWarnings) {
      if (seen.has(w)) continue;
      seen.add(w);
      warnings.push(w);
    }
  }

  if (pieces.length === 0) {
    return {
      pieces: [],
      widthCm: widthCm * scale,
      heightCm: heightCm * scale,
      cmPerUserUnit: cmPerUserUnit * scale,
      warnings,
      error: 'No closed outlines found to import',
    };
  }

  return {
    pieces,
    widthCm: widthCm * scale,
    heightCm: heightCm * scale,
    cmPerUserUnit: cmPerUserUnit * scale,
    warnings,
  };
}

/** Apply an additional uniform scale (about origin) to already-parsed pieces. */
export function scalePieces(pieces: PatternPiece[], factor: number): PatternPiece[] {
  if (factor === 1) return pieces;
  return pieces.map((piece) => ({
    ...piece,
    id: uid('piece'),
    points: piece.points.map((pt) => ({
      ...pt,
      id: uid('pt'),
      anchor: { x: pt.anchor.x * factor, y: pt.anchor.y * factor },
      handleIn: pt.handleIn
        ? { x: pt.handleIn.x * factor, y: pt.handleIn.y * factor }
        : null,
      handleOut: pt.handleOut
        ? { x: pt.handleOut.x * factor, y: pt.handleOut.y * factor }
        : null,
    })),
    grainline: piece.grainline
      ? {
          from: {
            x: piece.grainline.from.x * factor,
            y: piece.grainline.from.y * factor,
          },
          to: { x: piece.grainline.to.x * factor, y: piece.grainline.to.y * factor },
        }
      : undefined,
  }));
}
