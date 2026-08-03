/** Parsed triangle mesh from a Wavefront OBJ (positions in source units). */
export type ObjMesh = {
  positions: Float32Array;
  /** Triangle list (i0, i1, i2, …). */
  indices: Uint32Array;
};

/**
 * Minimal OBJ loader: `v` positions and `f` faces (triangles or quads).
 * Face indices may include `/vt/vn`; only vertex indices are used.
 */
export function parseObj(text: string): ObjMesh {
  const verts: number[] = [];
  const tris: number[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('v ')) {
      const parts = line.split(/\s+/);
      verts.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
      continue;
    }

    if (!line.startsWith('f ')) continue;
    const corners = line
      .slice(2)
      .trim()
      .split(/\s+/)
      .map((token) => {
        const slash = token.indexOf('/');
        const idx = slash >= 0 ? token.slice(0, slash) : token;
        return parseInt(idx, 10) - 1;
      });

    if (corners.length < 3) continue;
    for (let i = 1; i + 1 < corners.length; i++) {
      tris.push(corners[0], corners[i], corners[i + 1]);
    }
  }

  return {
    positions: new Float32Array(verts),
    indices: new Uint32Array(tris),
  };
}
