import type { SdfVolumeData } from './sdfVolume';
import { SdfVolume } from './sdfVolume';

/** OpenVDB magic number for "VDB " (bytes 56 44 42 20), as a little-endian u32/u64 value. */
export const OPENVDB_MAGIC_LE = 0x56444220;

export function isOpenVdbBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 8) return false;
  return new DataView(buffer).getUint32(0, true) === OPENVDB_MAGIC_LE;
}

export type OpenVdbDensifyOptions = {
  /** Max axis resolution of the dense PCSD volume (default 96). */
  maxResolution?: number;
  /** World scale applied to densified origin / voxel size (avatar import scale). */
  unitToWorld?: number;
  onProgress?: (progress: number, message?: string) => void;
  signal?: AbortSignal;
};

const COMPRESS_ZIP = 0x1;
const COMPRESS_ACTIVE_MASK = 0x2;
const COMPRESS_BLOSC = 0x4;

const NO_MASK_OR_INACTIVE_VALS = 0;
const NO_MASK_AND_MINUS_BG = 1;
const NO_MASK_AND_ONE_INACTIVE_VAL = 2;
const MASK_AND_NO_INACTIVE_VALS = 3;
const MASK_AND_ONE_INACTIVE_VAL = 4;
const MASK_AND_TWO_INACTIVE_VALS = 5;
const NO_MASK_AND_ALL_VALS = 6;

/** Tree_float_5_4_3 layout assumed by OpenVDB level-set exports. */
const LOG2DIM = [5, 4, 3] as const;
const TOTAL = [5 + 4 + 3, 4 + 3, 3] as const; // 12, 7, 3
const DIM = TOTAL.map((t) => 1 << t); // 4096, 128, 8
const NUM_VALUES = LOG2DIM.map((l) => 1 << (3 * l)); // 32768, 4096, 512

type Vec3 = [number, number, number];

type LeafNode = {
  origin: Vec3;
  values: Float32Array;
};

type InternalNode = {
  origin: Vec3;
  depth: 0 | 1;
  childMask: NodeMask;
  valueMask: NodeMask;
  /** Values for non-child slots (tile values). Child slots ignored. */
  values: Float32Array;
  children: Map<number, InternalNode | LeafNode>;
};

type RootTile = { origin: Vec3; value: number; active: boolean };

type FloatLevelSetGrid = {
  name: string;
  background: number;
  /** Index → world: p_world = p_index * scale + translation */
  scale: Vec3;
  translation: Vec3;
  bboxMin: Vec3;
  bboxMax: Vec3;
  rootTiles: RootTile[];
  rootChildren: InternalNode[];
};

class ByteReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  offset = 0;

  constructor(buffer: ArrayBuffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  seek(abs: number): void {
    if (abs < 0 || abs > this.bytes.byteLength) {
      throw new Error(`OpenVDB seek out of range (${abs})`);
    }
    this.offset = abs;
  }

  skip(n: number): void {
    this.seek(this.offset + n);
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i64(): number {
    const v = Number(this.view.getBigInt64(this.offset, true));
    this.offset += 8;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  raw(n: number): Uint8Array {
    const slice = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  /** Length-prefixed string (uint32 + bytes). */
  string(): string {
    const n = this.u32();
    if (n < 0 || n > this.remaining) throw new Error(`OpenVDB bad string length ${n}`);
    const slice = this.raw(n);
    let s = '';
    for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]!);
    return s;
  }

  /** Fixed-length ASCII (e.g. UUID). */
  fixedString(n: number): string {
    const slice = this.raw(n);
    let s = '';
    for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]!);
    return s;
  }

  vec3i(): Vec3 {
    return [this.i32(), this.i32(), this.i32()];
  }

  vec3s(): Vec3 {
    return [this.f32(), this.f32(), this.f32()];
  }

  vec3d(): Vec3 {
    return [this.f64(), this.f64(), this.f64()];
  }
}

class NodeMask {
  readonly size: number;
  readonly words: BigUint64Array;

  constructor(log2dim: number, words: BigUint64Array) {
    this.size = 1 << (3 * log2dim);
    this.words = words;
  }

  static read(r: ByteReader, log2dim: number): NodeMask {
    const size = 1 << (3 * log2dim);
    const wordCount = size >> 6;
    const words = new BigUint64Array(wordCount);
    for (let i = 0; i < wordCount; i++) {
      words[i] = r.view.getBigUint64(r.offset, true);
      r.offset += 8;
    }
    return new NodeMask(log2dim, words);
  }

  isOn(offset: number): boolean {
    const wi = offset >>> 6;
    const bi = offset & 63;
    return ((this.words[wi]! >> BigInt(bi)) & 1n) === 1n;
  }

  countOn(): number {
    let n = 0;
    for (let i = 0; i < this.words.length; i++) {
      let w = this.words[i]!;
      // Brian Kernighan popcount
      while (w) {
        w &= w - 1n;
        n++;
      }
    }
    return n;
  }

  forEachOn(fn: (offset: number) => void): void {
    for (let wi = 0; wi < this.words.length; wi++) {
      let w = this.words[wi]!;
      const base = wi * 64;
      while (w) {
        const lowest = w & -w;
        fn(base + lowestBitIndex(lowest));
        w ^= lowest;
      }
    }
  }
}

function lowestBitIndex(lowest: bigint): number {
  let i = 0;
  let v = lowest;
  while (v > 1n) {
    v >>= 1n;
    i++;
  }
  return i;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('OpenVDB load cancelled', 'AbortError');
  }
}

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function readMetadataValue(r: ByteReader, type: string): unknown {
  // All OpenVDB metadata values are size-prefixed.
  const nbytes = r.u32();
  const start = r.offset;
  let value: unknown;
  switch (type) {
    case 'string': {
      let s = '';
      for (let i = 0; i < nbytes; i++) s += String.fromCharCode(r.u8());
      value = s;
      break;
    }
    case 'bool':
      value = r.bool();
      break;
    case 'int32':
      value = r.i32();
      break;
    case 'int64':
      value = r.i64();
      break;
    case 'float':
      value = r.f32();
      break;
    case 'double':
      value = r.f64();
      break;
    case 'vec3i':
      value = r.vec3i();
      break;
    case 'vec3s':
      value = r.vec3s();
      break;
    case 'vec3d':
      value = r.vec3d();
      break;
    default:
      // Unknown / DelayedLoadMetadata: skip raw payload.
      r.skip(nbytes);
      value = null;
      break;
  }
  // Be robust if typed read size disagrees with declared nbytes.
  if (r.offset !== start + nbytes) r.seek(start + nbytes);
  return value;
}

function readMetadataMap(r: ByteReader): Record<string, { type: string; value: unknown }> {
  const count = r.u32();
  const out: Record<string, { type: string; value: unknown }> = {};
  for (let i = 0; i < count; i++) {
    const name = r.string();
    const type = r.string();
    out[name] = { type, value: readMetadataValue(r, type) };
  }
  return out;
}

type BloscCodec = { decode: (src: Uint8Array) => Promise<Uint8Array> | Uint8Array };

async function readFloatData(
  r: ByteReader,
  count: number,
  compression: number,
  blosc: BloscCodec | null
): Promise<Float32Array> {
  const out = new Float32Array(count);
  if (count <= 0) {
    if (compression & (COMPRESS_BLOSC | COMPRESS_ZIP)) {
      // Still need the chunk size header when compression is enabled.
      const n = r.i64();
      if (n > 0) r.skip(n);
    }
    return out;
  }

  const byteCount = count * 4;

  if (compression & COMPRESS_BLOSC) {
    if (!blosc) throw new Error('OpenVDB grid uses blosc compression, but decoder failed to load');
    const n = r.i64();
    if (n <= 0) {
      if (-n !== byteCount) {
        throw new Error(`OpenVDB blosc uncompressed size mismatch (expected ${byteCount}, got ${-n})`);
      }
      for (let i = 0; i < count; i++) out[i] = r.f32();
      return out;
    }
    const compressed = r.raw(n);
    const decoded = await Promise.resolve(blosc.decode(compressed));
    if (!(decoded instanceof Uint8Array) || decoded.byteLength !== byteCount) {
      throw new Error(
        `OpenVDB blosc decode size mismatch (expected ${byteCount}, got ${
          decoded instanceof Uint8Array ? decoded.byteLength : typeof decoded
        })`
      );
    }
    const floats = new Float32Array(count);
    floats.set(new Float32Array(decoded.buffer, decoded.byteOffset, count));
    return floats;
  }

  if (compression & COMPRESS_ZIP) {
    throw new Error('OpenVDB zip-compressed grids are not supported yet (use blosc or uncompressed)');
  }

  for (let i = 0; i < count; i++) out[i] = r.f32();
  return out;
}

async function readCompressedValues(
  r: ByteReader,
  destCount: number,
  valueMask: NodeMask,
  background: number,
  compression: number,
  blosc: BloscCodec | null,
  log2dim: number
): Promise<Float32Array> {
  const maskCompressed = (compression & COMPRESS_ACTIVE_MASK) !== 0;
  const metadata = r.u8();

  let inactiveVal0 = metadata === NO_MASK_OR_INACTIVE_VALS ? background : -background;
  let inactiveVal1 = background;

  if (
    metadata === NO_MASK_AND_ONE_INACTIVE_VAL ||
    metadata === MASK_AND_ONE_INACTIVE_VAL ||
    metadata === MASK_AND_TWO_INACTIVE_VALS
  ) {
    inactiveVal0 = r.f32();
    if (metadata === MASK_AND_TWO_INACTIVE_VALS) inactiveVal1 = r.f32();
  }

  let selectionMask: NodeMask | null = null;
  if (
    metadata === MASK_AND_NO_INACTIVE_VALS ||
    metadata === MASK_AND_ONE_INACTIVE_VAL ||
    metadata === MASK_AND_TWO_INACTIVE_VALS
  ) {
    selectionMask = NodeMask.read(r, log2dim);
  }

  let tempCount = destCount;
  if (maskCompressed && metadata !== NO_MASK_AND_ALL_VALS) {
    tempCount = valueMask.countOn();
  }

  const temp = await readFloatData(r, tempCount, compression, blosc);
  const dest = new Float32Array(destCount);

  if (maskCompressed && tempCount !== destCount) {
    let tempIdx = 0;
    for (let destIdx = 0; destIdx < destCount; destIdx++) {
      if (valueMask.isOn(destIdx)) {
        dest[destIdx] = temp[tempIdx++]!;
      } else {
        dest[destIdx] = selectionMask?.isOn(destIdx) ? inactiveVal1 : inactiveVal0;
      }
    }
  } else {
    dest.set(temp.subarray(0, destCount));
  }

  return dest;
}

function offsetToLocalCoord(offset: number, log2dim: number): Vec3 {
  const x = offset >> (2 * log2dim);
  offset &= (1 << (2 * log2dim)) - 1;
  const y = offset >> log2dim;
  const z = offset & ((1 << log2dim) - 1);
  return [x, y, z];
}

async function readInternalNode(
  r: ByteReader,
  depth: 0 | 1,
  origin: Vec3,
  background: number,
  compression: number,
  blosc: BloscCodec | null,
  leavesOut: LeafNode[]
): Promise<InternalNode> {
  const log2dim = LOG2DIM[depth]!;
  const childMask = NodeMask.read(r, log2dim);
  const valueMask = NodeMask.read(r, log2dim);
  const values = await readCompressedValues(
    r,
    NUM_VALUES[depth]!,
    valueMask,
    background,
    compression,
    blosc,
    log2dim
  );

  const node: InternalNode = {
    origin,
    depth,
    childMask,
    valueMask,
    values,
    children: new Map(),
  };

  const childDepth = (depth + 1) as 1 | 2;
  const childDim = DIM[childDepth]!;

  // Collect child offsets in ascending order (mask iteration order == ChildOnIter).
  const childOffsets: number[] = [];
  childMask.forEachOn((offset) => childOffsets.push(offset));

  for (const offset of childOffsets) {
    const local = offsetToLocalCoord(offset, log2dim);
    const childOrigin: Vec3 = [
      origin[0] + local[0] * childDim,
      origin[1] + local[1] * childDim,
      origin[2] + local[2] * childDim,
    ];

    if (childDepth === 2) {
      // Leaf topology: value mask only (buffers come later).
      NodeMask.read(r, LOG2DIM[2]); // leaf topology mask (values come in buffer pass)
      const leaf: LeafNode = {
        origin: childOrigin,
        values: new Float32Array(NUM_VALUES[2]!),
      };
      node.children.set(offset, leaf);
      leavesOut.push(leaf);
    } else {
      const child = await readInternalNode(
        r,
        1,
        childOrigin,
        background,
        compression,
        blosc,
        leavesOut
      );
      node.children.set(offset, child);
    }
  }

  return node;
}

async function readLeafBuffers(
  r: ByteReader,
  leaves: LeafNode[],
  background: number,
  compression: number,
  blosc: BloscCodec | null,
  onProgress?: (p: number) => void
): Promise<void> {
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i]!;
    // Buffers re-store the value mask, then compressed values.
    const mask = NodeMask.read(r, LOG2DIM[2]);
    leaf.values = await readCompressedValues(
      r,
      NUM_VALUES[2]!,
      mask,
      background,
      compression,
      blosc,
      LOG2DIM[2]
    );
    if (i % 8 === 0) onProgress?.(i / Math.max(leaves.length, 1));
  }
}

function readTransform(r: ByteReader, version: number): { scale: Vec3; translation: Vec3 } {
  const mapType = r.string();
  if (version < 219) {
    return { scale: [1, 1, 1], translation: [0, 0, 0] };
  }

  if (mapType === 'UniformScaleTranslateMap' || mapType === 'ScaleTranslateMap') {
    const translation = r.vec3d();
    const scale = r.vec3d();
    r.vec3d(); // voxelSize
    r.vec3d(); // scaleInverse
    r.vec3d(); // scaleInverseSq
    r.vec3d(); // scaleInverseDouble
    return { scale, translation };
  }

  if (mapType === 'UniformScaleMap' || mapType === 'ScaleMap') {
    const scale = r.vec3d();
    r.vec3d(); // voxelSize
    r.vec3d();
    r.vec3d();
    r.vec3d();
    return { scale, translation: [0, 0, 0] };
  }

  if (mapType === 'TranslationMap') {
    const translation = r.vec3d();
    return { scale: [1, 1, 1], translation };
  }

  throw new Error(`Unsupported OpenVDB transform map “${mapType}”`);
}

async function parseFloatLevelSetGrid(
  buffer: ArrayBuffer,
  blosc: BloscCodec | null,
  signal?: AbortSignal
): Promise<FloatLevelSetGrid> {
  const r = new ByteReader(buffer);
  const magic = Number(r.view.getBigUint64(0, true));
  r.offset = 8;
  if (magic !== OPENVDB_MAGIC_LE) throw new Error('Not an OpenVDB file');

  const version = r.u32();
  if (version > 211) {
    r.u32(); // library major
    r.u32(); // library minor
  }

  const hasGridOffsets = r.u8() !== 0;
  // Legacy per-file compression byte (versions 220–221 only).
  if (version >= 220 && version < 222) r.u8();

  r.fixedString(36); // uuid
  readMetadataMap(r); // file-level metadata

  const gridCount = r.u32();
  if (gridCount <= 0) throw new Error('OpenVDB file has no grids');

  type Cand = {
    score: number;
    name: string;
    gridClass: string;
    meta: Record<string, { type: string; value: unknown }>;
    compression: number;
    transform: { scale: Vec3; translation: Vec3 };
    leaves: LeafNode[];
    rootTiles: RootTile[];
    rootChildren: InternalNode[];
    background: number;
  };

  const candidates: Cand[] = [];

  for (let gi = 0; gi < gridCount; gi++) {
    throwIfAborted(signal);
    const uniqueName = r.string();
    const gridName = uniqueName.split('\x1e')[0] ?? uniqueName;
    let gridType = r.string();
    if (version >= 216) r.string(); // instance parent

    const gridBufferPosition = r.i64();
    const blockBufferPosition = r.i64();
    const endBufferPosition = r.i64();

    if (hasGridOffsets) {
      if (gridBufferPosition > 0) r.seek(gridBufferPosition);
    }

    let compression = COMPRESS_ACTIVE_MASK;
    if (version >= 222) compression = r.u32();

    const meta = readMetadataMap(r);
    const gridClass = String(meta['class']?.value ?? '');
    const valueType = String(meta['value_type']?.value ?? 'float');
    const transform =
      version < 216
        ? (() => {
            // Old order: topology then transform — unsupported here.
            throw new Error('OpenVDB files older than format 216 are not supported');
          })()
        : readTransform(r, version);

    // Only densify float trees we understand.
    const isFloatTree =
      valueType === 'float' &&
      (gridType === 'Tree_float_5_4_3' || gridType.includes('float'));

    if (!isFloatTree) {
      if (hasGridOffsets && endBufferPosition > 0) r.seek(endBufferPosition);
      else throw new Error(`Unsupported OpenVDB grid type “${gridType}” in sequential VDB`);
      continue;
    }

    const topologyCount = r.u32();
    if (topologyCount !== 1) throw new Error('Multi-buffer OpenVDB trees are not supported');

    const background = r.f32();
    const numTiles = r.u32();
    const numChildren = r.u32();
    const rootTiles: RootTile[] = [];
    const rootChildren: InternalNode[] = [];
    const leaves: LeafNode[] = [];

    for (let i = 0; i < numTiles; i++) {
      rootTiles.push({ origin: r.vec3i(), value: r.f32(), active: r.bool() });
    }
    for (let i = 0; i < numChildren; i++) {
      const origin = r.vec3i();
      rootChildren.push(
        await readInternalNode(r, 0, origin, background, compression, blosc, leaves)
      );
    }

    // Leaf value buffers follow topology (even when delayed-load metadata is present).
    if (hasGridOffsets && blockBufferPosition > 0 && r.offset !== blockBufferPosition) {
      r.seek(blockBufferPosition);
    }
    await readLeafBuffers(r, leaves, background, compression, blosc);

    if (hasGridOffsets && endBufferPosition > 0) r.seek(endBufferPosition);

    const nameLower = gridName.toLowerCase();
    const classLower = gridClass.toLowerCase();
    let score = 0;
    if (classLower.includes('level set') || classLower.includes('levelset')) score += 100;
    if (nameLower.includes('sdf') || nameLower.includes('distance') || nameLower.includes('level')) {
      score += 50;
    }
    if (classLower.includes('fog') || nameLower.includes('density')) score -= 20;

    candidates.push({
      score,
      name: gridName,
      gridClass,
      meta,
      compression,
      transform,
      leaves,
      rootTiles,
      rootChildren,
      background,
    });
  }

  if (candidates.length === 0) throw new Error('OpenVDB file has no grids');
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0]!;

  const bboxMin = (best.meta['file_bbox_min']?.value as Vec3 | undefined) ?? [0, 0, 0];
  const bboxMax = (best.meta['file_bbox_max']?.value as Vec3 | undefined) ?? [0, 0, 0];

  return {
    name: best.name,
    background: best.background,
    scale: best.transform.scale,
    translation: best.transform.translation,
    bboxMin,
    bboxMax,
    rootTiles: best.rootTiles,
    rootChildren: best.rootChildren,
  };
}

function leafCoordToOffset(local: Vec3): number {
  const log2dim = LOG2DIM[2];
  return (local[0] << (2 * log2dim)) | (local[1] << log2dim) | local[2];
}

function probeInternal(node: InternalNode, p: Vec3): number | null {
  const log2dim = LOG2DIM[node.depth]!;
  const childShift = TOTAL[node.depth]! - log2dim;
  const local: Vec3 = [
    (p[0] - node.origin[0]) >> childShift,
    (p[1] - node.origin[1]) >> childShift,
    (p[2] - node.origin[2]) >> childShift,
  ];
  const offset = (local[0] << (2 * log2dim)) | (local[1] << log2dim) | local[2];

  if (offset < 0 || offset >= NUM_VALUES[node.depth]!) return null;

  const child = node.children.get(offset);
  if (child) {
    if ('depth' in child) return probeInternal(child, p);
    const leaf = child;
    const lx = p[0] - leaf.origin[0];
    const ly = p[1] - leaf.origin[1];
    const lz = p[2] - leaf.origin[2];
    if (lx < 0 || ly < 0 || lz < 0 || lx >= 8 || ly >= 8 || lz >= 8) return null;
    return leaf.values[leafCoordToOffset([lx, ly, lz])]!;
  }

  return node.values[offset]!;
}

function probeGrid(grid: FloatLevelSetGrid, p: Vec3): number {
  const rootDim = DIM[0]!;
  // Match root key: origin aligned down to child DIM.
  const key: Vec3 = [
    p[0] & ~(rootDim - 1),
    p[1] & ~(rootDim - 1),
    p[2] & ~(rootDim - 1),
  ];

  for (const child of grid.rootChildren) {
    if (child.origin[0] === key[0] && child.origin[1] === key[1] && child.origin[2] === key[2]) {
      const v = probeInternal(child, p);
      if (v !== null) return v;
    }
  }

  for (const tile of grid.rootTiles) {
    if (tile.origin[0] === key[0] && tile.origin[1] === key[1] && tile.origin[2] === key[2]) {
      return tile.value;
    }
  }

  return grid.background;
}

function indexToWorld(grid: FloatLevelSetGrid, p: Vec3): Vec3 {
  return [
    p[0] * grid.scale[0] + grid.translation[0],
    p[1] * grid.scale[1] + grid.translation[1],
    p[2] * grid.scale[2] + grid.translation[2],
  ];
}

/**
 * Parse an OpenVDB (.vdb) ArrayBuffer and densify the best level-set grid
 * into patternCanvas's dense SdfVolumeData layout.
 *
 * Supports sequential (hasGridOffsets=0) files and blosc-compressed float leaves.
 * The npm `openvdb` package cannot load these — it skips no-offset grids and
 * never reads float leaf buffers.
 */
export async function densifyOpenVdbToSdf(
  buffer: ArrayBuffer,
  options: OpenVdbDensifyOptions = {}
): Promise<SdfVolumeData> {
  const maxResolution = Math.max(16, Math.min(128, options.maxResolution ?? 96));
  const unitToWorld = options.unitToWorld ?? 1;
  const { onProgress, signal } = options;

  throwIfAborted(signal);
  onProgress?.(0.02, 'Loading OpenVDB decoder…');

  let blosc: BloscCodec | null = null;
  try {
    const { Blosc } = await import('numcodecs');
    blosc = new Blosc();
  } catch {
    blosc = null;
  }

  throwIfAborted(signal);
  onProgress?.(0.05, 'Parsing OpenVDB…');

  const grid = await parseFloatLevelSetGrid(buffer, blosc, signal);
  onProgress?.(0.2, `Densifying “${grid.name}”…`);

  const minX = Math.min(grid.bboxMin[0], grid.bboxMax[0]);
  const minY = Math.min(grid.bboxMin[1], grid.bboxMax[1]);
  const minZ = Math.min(grid.bboxMin[2], grid.bboxMax[2]);
  const maxX = Math.max(grid.bboxMin[0], grid.bboxMax[0]);
  const maxY = Math.max(grid.bboxMin[1], grid.bboxMax[1]);
  const maxZ = Math.max(grid.bboxMin[2], grid.bboxMax[2]);

  const w0 = indexToWorld(grid, [minX, minY, minZ]);
  const w1 = indexToWorld(grid, [maxX, maxY, maxZ]);
  const worldMin: Vec3 = [
    Math.min(w0[0], w1[0]),
    Math.min(w0[1], w1[1]),
    Math.min(w0[2], w1[2]),
  ];
  const worldMax: Vec3 = [
    Math.max(w0[0], w1[0]),
    Math.max(w0[1], w1[1]),
    Math.max(w0[2], w1[2]),
  ];

  const sizeX = Math.max(worldMax[0] - worldMin[0], 1e-6);
  const sizeY = Math.max(worldMax[1] - worldMin[1], 1e-6);
  const sizeZ = Math.max(worldMax[2] - worldMin[2], 1e-6);
  const maxSize = Math.max(sizeX, sizeY, sizeZ);

  const voxelSize = maxSize / (maxResolution - 1);
  const nx = Math.max(2, Math.min(maxResolution, Math.round(sizeX / voxelSize) + 1));
  const ny = Math.max(2, Math.min(maxResolution, Math.round(sizeY / voxelSize) + 1));
  const nz = Math.max(2, Math.min(maxResolution, Math.round(sizeZ / voxelSize) + 1));
  const stepWorldX = sizeX / (nx - 1);
  const stepWorldY = sizeY / (ny - 1);
  const stepWorldZ = sizeZ / (nz - 1);

  // Sample in index space: world = index * scale + translation
  // → index = (world - translation) / scale
  const invS: Vec3 = [
    grid.scale[0] !== 0 ? 1 / grid.scale[0] : 0,
    grid.scale[1] !== 0 ? 1 / grid.scale[1] : 0,
    grid.scale[2] !== 0 ? 1 / grid.scale[2] : 0,
  ];

  const count = nx * ny * nz;
  const distances = new Float32Array(count);
  const chunkRows = Math.max(1, Math.floor(8192 / Math.max(nx, 1)));
  let done = 0;

  for (let iz = 0; iz < nz; iz++) {
    throwIfAborted(signal);
    const wz = worldMin[2] + iz * stepWorldZ;
    const izIndex = (wz - grid.translation[2]) * invS[2];
    for (let iy = 0; iy < ny; iy++) {
      const wy = worldMin[1] + iy * stepWorldY;
      const iyIndex = (wy - grid.translation[1]) * invS[1];
      const row = iy * nx + iz * nx * ny;
      for (let ix = 0; ix < nx; ix++) {
        const wx = worldMin[0] + ix * stepWorldX;
        const ixIndex = (wx - grid.translation[0]) * invS[0];
        const value = probeGrid(grid, [
          Math.round(ixIndex),
          Math.round(iyIndex),
          Math.round(izIndex),
        ]);
        // Distance scales with linear transform (uniform scale expected for SDF).
        const distScale =
          (Math.abs(grid.scale[0]) + Math.abs(grid.scale[1]) + Math.abs(grid.scale[2])) / 3;
        distances[row + ix] =
          typeof value === 'number' && Number.isFinite(value)
            ? value * distScale * unitToWorld
            : grid.background * distScale * unitToWorld;
        done++;
      }
      if (iy % chunkRows === 0) {
        onProgress?.(0.2 + 0.78 * (done / count), 'Densifying OpenVDB…');
        await yieldFrame();
        throwIfAborted(signal);
      }
    }
  }

  onProgress?.(1, 'OpenVDB densified');
  return {
    origin: [worldMin[0] * unitToWorld, worldMin[1] * unitToWorld, worldMin[2] * unitToWorld],
    voxelSize: voxelSize * unitToWorld,
    dim: [nx, ny, nz],
    distances,
  };
}

/** Decode PCSD .sdf or densify OpenVDB .vdb into SdfVolumeData. */
export async function decodeSdfOrOpenVdb(
  buffer: ArrayBuffer,
  options: OpenVdbDensifyOptions & { fileName?: string } = {}
): Promise<{ data: SdfVolumeData; source: 'pcsd' | 'openvdb' }> {
  const name = (options.fileName ?? '').toLowerCase();
  const looksVdb = name.endsWith('.vdb') || isOpenVdbBuffer(buffer);
  if (looksVdb) {
    const data = await densifyOpenVdbToSdf(buffer, options);
    return { data, source: 'openvdb' };
  }
  const vol = SdfVolume.decode(buffer);
  return {
    data: {
      origin: [vol.origin[0], vol.origin[1], vol.origin[2]],
      voxelSize: vol.voxelSize,
      dim: vol.dim,
      distances: vol.distances,
    },
    source: 'pcsd',
  };
}
