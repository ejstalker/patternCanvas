/**
 * Parser for MakeHuman `.target` morph files.
 *
 * A target is a sparse list of per-vertex translation vectors in the base mesh's
 * units (decimetres). MakeHuman applies them *linearly and additively*:
 *
 *   coord[i] += sum(weight_j * delta_j[i])
 *
 * Format (ASCII): one `vertexIndex dx dy dz` per line; `#` comments and blank
 * lines ignored. Trailing time values are not present in shipped targets.
 *
 * Ported from `makehuman/core/algos3d.py` (`Target._load_text`).
 */

export type TargetDelta = {
  /** Base-mesh vertex indices affected by this target. */
  indices: Uint32Array;
  /** Flat xyz deltas, `indices.length * 3` floats, in decimetres. */
  deltas: Float32Array;
};

/** Parse the text of a MakeHuman `.target` file into a compact delta table. */
export function parseTarget(text: string): TargetDelta {
  const indices: number[] = [];
  const deltas: number[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;

    const index = Number.parseInt(parts[0]!, 10);
    const x = Number.parseFloat(parts[1]!);
    const y = Number.parseFloat(parts[2]!);
    const z = Number.parseFloat(parts[3]!);
    if (!Number.isFinite(index) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }

    indices.push(index);
    deltas.push(x, y, z);
  }

  return {
    indices: new Uint32Array(indices),
    deltas: new Float32Array(deltas),
  };
}
