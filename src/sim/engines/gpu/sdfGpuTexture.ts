import type { SdfVolume } from '../../../mesh/sdfVolume';

export type ObstacleGpu = {
  center: [number, number, number, number];
  rot0: [number, number, number, number];
  rot1: [number, number, number, number];
  rot2: [number, number, number, number];
  a: [number, number, number, number];
  b: [number, number, number, number];
  kind: number;
  pad: [number, number, number];
};

const OBSTACLE_FLOATS = 28; // 7 vec4s

export function packObstacles(obstacles: ObstacleGpu[]): Float32Array {
  // Obstacle.kind is u32 in WGSL — must write integer bit pattern, not f32(kind).
  const out = new Float32Array(Math.max(obstacles.length, 1) * OBSTACLE_FLOATS);
  const u32 = new Uint32Array(out.buffer);
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    const base = i * OBSTACLE_FLOATS;
    out.set(o.center, base);
    out.set(o.rot0, base + 4);
    out.set(o.rot1, base + 8);
    out.set(o.rot2, base + 12);
    out.set(o.a, base + 16);
    out.set(o.b, base + 20);
    u32[base + 24] = o.kind >>> 0;
    u32[base + 25] = o.pad[0] >>> 0;
    u32[base + 26] = o.pad[1] >>> 0;
    u32[base + 27] = o.pad[2] >>> 0;
  }
  return out;
}

export function makeIdentityMeshObstacle(
  boundsMin: [number, number, number],
  boundsMax: [number, number, number]
): ObstacleGpu {
  return {
    center: [0, 0, 0, 0],
    rot0: [1, 0, 0, 0],
    rot1: [0, 1, 0, 0],
    rot2: [0, 0, 1, 0],
    a: [boundsMin[0], boundsMin[1], boundsMin[2], 0],
    b: [boundsMax[0], boundsMax[1], boundsMax[2], 0],
    kind: 4, // mesh
    pad: [0, 0, 0],
  };
}

function volumeBounds(volume: SdfVolume): {
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
} {
  const [nx, ny, nz] = volume.dim;
  return {
    boundsMin: [volume.origin[0], volume.origin[1], volume.origin[2]],
    boundsMax: [
      volume.origin[0] + nx * volume.voxelSize,
      volume.origin[1] + ny * volume.voxelSize,
      volume.origin[2] + nz * volume.voxelSize,
    ],
  };
}

/** Upload SdfVolume distances as R32Float 3D texture. */
export function createSdfGpuTexture(
  device: GPUDevice,
  volume: SdfVolume
): { texture: GPUTexture; view: GPUTextureView; obstacle: ObstacleGpu } {
  const [nx, ny, nz] = volume.dim;
  const { boundsMin, boundsMax } = volumeBounds(volume);
  const texture = device.createTexture({
    size: [nx, ny, nz],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    dimension: '3d',
  });
  device.queue.writeTexture(
    { texture },
    volume.distances.buffer.slice(
      volume.distances.byteOffset,
      volume.distances.byteOffset + volume.distances.byteLength
    ) as ArrayBuffer,
    { bytesPerRow: nx * 4, rowsPerImage: ny },
    [nx, ny, nz]
  );
  return {
    texture,
    view: texture.createView(),
    obstacle: makeIdentityMeshObstacle(boundsMin, boundsMax),
  };
}

/** 1×1×1 dummy SDF so bind group always has a texture. */
export function createDummySdfTexture(device: GPUDevice): {
  texture: GPUTexture;
  view: GPUTextureView;
} {
  const texture = device.createTexture({
    size: [1, 1, 1],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    dimension: '3d',
  });
  device.queue.writeTexture({ texture }, new Float32Array([1e6]), { bytesPerRow: 4, rowsPerImage: 1 }, [
    1, 1, 1,
  ]);
  return { texture, view: texture.createView() };
}
