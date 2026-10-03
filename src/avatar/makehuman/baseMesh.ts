/**
 * MakeHuman base mesh handling.
 *
 * `makehuman/data/3dobjs/base.obj` is in decimetres and carries 18486 quads.
 * Face groups are hard-coded ranges (`makehuman/plugins/1_mhapi/_mesh.py`):
 *   body = quads [0, 13378);  everything after is helper/joint geometry.
 * `parseObj` triangulates quads in order, so the body is the first
 * `13378 * 6` index entries.
 */

import { parseObj } from '../../mesh/loadObj';

/** Quad faces [0, BASE_BODY_QUADS) are the `body` group. */
export const BASE_BODY_QUADS = 13378;
/** Two triangles per quad, three indices each. */
const VERTS_PER_QUAD = 6;

export type BaseMeshSource = {
  /** Full base positions (decimetres, MakeHuman vertex numbering) — morph/measure space. */
  positions: Float32Array;
  /** Body-only triangle indices into `positions`. */
  bodyTriangleIndices: Uint32Array;
};

export type RenderMesh = {
  /** Compacted positions (decimetres, same space as the base). */
  positions: Float32Array;
  indices: Uint32Array;
  /** compactIndex -> original MakeHuman vertex id. */
  sourceVertexIds: Uint32Array;
};

export function parseBaseMesh(objText: string): BaseMeshSource {
  const { positions, indices } = parseObj(objText);
  return {
    positions,
    bodyTriangleIndices: indices.subarray(0, BASE_BODY_QUADS * VERTS_PER_QUAD),
  };
}

/** Extract only the vertices referenced by `indices`, remapping the triangle list. */
export function compactMesh(
  positions: Float32Array,
  indices: Uint32Array
): RenderMesh {
  const vertexCount = positions.length / 3;
  const remap = new Int32Array(vertexCount).fill(-1);
  const sourceVertexIds: number[] = [];

  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]!;
    if (remap[v] === -1) {
      remap[v] = sourceVertexIds.length;
      sourceVertexIds.push(v);
    }
  }

  const outPositions = new Float32Array(sourceVertexIds.length * 3);
  for (let i = 0; i < sourceVertexIds.length; i++) {
    const v = sourceVertexIds[i]!;
    outPositions[i * 3] = positions[v * 3]!;
    outPositions[i * 3 + 1] = positions[v * 3 + 1]!;
    outPositions[i * 3 + 2] = positions[v * 3 + 2]!;
  }

  const outIndices = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) outIndices[i] = remap[indices[i]!]!;

  return {
    positions: outPositions,
    indices: outIndices,
    sourceVertexIds: Uint32Array.from(sourceVertexIds),
  };
}

/** Build the body-only render mesh from a (possibly deformed) full position array. */
export function buildRenderMesh(source: BaseMeshSource, positions: Float32Array): RenderMesh {
  return compactMesh(positions, source.bodyTriangleIndices);
}
