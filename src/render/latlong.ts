/**
 * The one latlong mapping in the app.
 *
 * A direction maps to an equirectangular (`texture_2d`) uv with the zenith on
 * the first row — the convention of every `.exr` in `hdri/`, where row 0 is the
 * sky. This is the only place the mapping is defined, and every pass that reads
 * the HDRI uses it: the capture that bakes the light-probe cubemap, and the
 * skybox that paints the background.
 *
 * A second copy with the opposite sign is very easy to write and very hard to
 * see — the sky looks right while the cloth is lit from the wrong hemisphere —
 * so `latlong.test.ts` pins both the formula and the fact that there is only one
 * definition.
 */
export const LATLONG_WGSL = /* wgsl */ `
const INV_TWO_PI = 0.15915494;
const INV_PI = 0.31830989;

fn latlongUv(direction: vec3<f32>) -> vec2<f32> {
  let d = normalize(direction);
  return vec2<f32>(
    atan2(d.z, d.x) * INV_TWO_PI + 0.5,
    0.5 - asin(clamp(d.y, -1.0, 1.0)) * INV_PI,
  );
}
`;

/** The same mapping in TypeScript, so the convention can be tested. */
export function latlongUv(direction: readonly [number, number, number]): [number, number] {
  const [x, y, z] = direction;
  const length = Math.hypot(x, y, z) || 1;
  return [
    Math.atan2(z / length, x / length) / (2 * Math.PI) + 0.5,
    0.5 - Math.asin(Math.max(-1, Math.min(1, y / length))) / Math.PI,
  ];
}
