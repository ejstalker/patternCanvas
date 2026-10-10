/**
 * Cylinder geometry for the PBR floor pedestal: a solid cap-topped cylinder that
 * replaces the flat floor in PBR shading. Generated on the CPU because the radius
 * follows the floor and the shape never deforms.
 */
export type CylinderGeometry = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

/**
 * A watertight cylinder with its top cap at `topY`, extending down by `height`.
 * Smooth side normals, flat caps.
 */
export function cylinderGeometry(
  radius: number,
  height: number,
  segments = 64,
  topY = 0
): CylinderGeometry {
  const rings = Math.max(3, Math.floor(segments));
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const bottomY = topY - height;

  // Side wall: one top and one bottom vertex per segment step.
  for (let i = 0; i <= rings; i++) {
    const angle = (i / rings) * Math.PI * 2;
    const nx = Math.cos(angle);
    const nz = Math.sin(angle);
    positions.push(nx * radius, topY, nz * radius);
    normals.push(nx, 0, nz);
    positions.push(nx * radius, bottomY, nz * radius);
    normals.push(nx, 0, nz);
  }
  for (let i = 0; i < rings; i++) {
    const top = i * 2;
    const bottom = top + 1;
    const nextTop = top + 2;
    const nextBottom = top + 3;
    indices.push(top, bottom, nextBottom, top, nextBottom, nextTop);
  }

  for (const [y, ny] of [
    [topY, 1],
    [bottomY, -1],
  ] as const) {
    const center = positions.length / 3;
    positions.push(0, y, 0);
    normals.push(0, ny, 0);
    const ringStart = positions.length / 3;
    for (let i = 0; i <= rings; i++) {
      const angle = (i / rings) * Math.PI * 2;
      positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      normals.push(0, ny, 0);
    }
    for (let i = 0; i < rings; i++) {
      indices.push(center, ringStart + i + 1, ringStart + i);
    }
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
  };
}
