import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeExr, type ExrImage } from './exr';

const HDRI_DIR = resolve(process.cwd(), 'hdri');

const MAGIC = 20000630;

/** Minimal little-endian byte writer for hand-building EXR test fixtures. */
class ByteWriter {
  private readonly bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  u32(value: number): void {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }

  i32(value: number): void {
    this.u32(value >>> 0);
  }

  u64(value: number): void {
    this.u32(value >>> 0);
    this.u32(Math.floor(value / 0x100000000) >>> 0);
  }

  f32(value: number): void {
    const scratch = new DataView(new ArrayBuffer(4));
    scratch.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) this.bytes.push(scratch.getUint8(i));
  }

  ascii(value: string): void {
    for (let i = 0; i < value.length; i++) this.u8(value.charCodeAt(i));
  }

  zstr(value: string): void {
    this.ascii(value);
    this.u8(0);
  }

  raw(value: Uint8Array): void {
    for (const byte of value) this.bytes.push(byte);
  }

  attribute(name: string, type: string, payload: ByteWriter): void {
    this.zstr(name);
    this.zstr(type);
    this.u32(payload.length);
    this.raw(payload.toUint8Array());
  }

  toUint8Array(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.bytes);
  }
}

type ExrFixture = {
  /** Channel names in the order they are stored in the file. */
  channels: string[];
  width: number;
  height: number;
  /** values[y][x][channelIndex] */
  values: number[][][];
  compression?: number;
  pixelType?: number;
};

/**
 * Builds an uncompressed (NO) EXR with float channels, matching the byte layout the
 * scanline reader expects: header, line offset table, then per-scanline blocks.
 */
function buildExr(fixture: ExrFixture): ArrayBuffer {
  const { channels, width, height, values } = fixture;
  const compression = fixture.compression ?? 0; // 0 = NO_COMPRESSION
  const pixelType = fixture.pixelType ?? 2; // 2 = FLOAT

  const header = new ByteWriter();
  header.u32(MAGIC);
  header.u8(2); // version
  header.u8(0); // flags
  header.u8(0); // padding
  header.u8(0); // padding

  const chlist = new ByteWriter();
  for (const name of channels) {
    chlist.zstr(name);
    chlist.i32(pixelType);
    chlist.u8(0); // pLinear
    chlist.u8(0);
    chlist.u8(0);
    chlist.u8(0); // reserved
    chlist.i32(1); // xSampling
    chlist.i32(1); // ySampling
  }
  chlist.u8(0); // end of channel list
  header.attribute('channels', 'chlist', chlist);

  const compressionBytes = new ByteWriter();
  compressionBytes.u8(compression);
  header.attribute('compression', 'compression', compressionBytes);

  const box = new ByteWriter();
  box.u32(0);
  box.u32(0);
  box.u32(width - 1);
  box.u32(height - 1);
  header.attribute('dataWindow', 'box2i', box);

  const display = new ByteWriter();
  display.u32(0);
  display.u32(0);
  display.u32(width - 1);
  display.u32(height - 1);
  header.attribute('displayWindow', 'box2i', display);

  const lineOrder = new ByteWriter();
  lineOrder.u8(0); // INCREASING_Y
  header.attribute('lineOrder', 'lineOrder', lineOrder);

  const aspect = new ByteWriter();
  aspect.f32(1);
  header.attribute('pixelAspectRatio', 'float', aspect);

  const screenCenter = new ByteWriter();
  screenCenter.f32(0);
  screenCenter.f32(0);
  header.attribute('screenWindowCenter', 'v2f', screenCenter);

  const screenWidth = new ByteWriter();
  screenWidth.f32(1);
  header.attribute('screenWindowWidth', 'float', screenWidth);

  header.u8(0); // end of header

  const scanlineBlocks: ByteWriter[] = [];
  for (let y = 0; y < height; y++) {
    const block = new ByteWriter();
    block.u32(y); // line number

    const payload = new ByteWriter();
    for (let c = 0; c < channels.length; c++) {
      for (let x = 0; x < width; x++) {
        payload.f32(values[y][x][c]);
      }
    }

    block.u32(payload.length);
    block.raw(payload.toUint8Array());
    scanlineBlocks.push(block);
  }

  const offsetTableBytes = scanlineBlocks.length * 8;
  const offsets = new ByteWriter();
  let blockOffset = header.length + offsetTableBytes;
  for (const block of scanlineBlocks) {
    offsets.u64(blockOffset);
    blockOffset += block.length;
  }

  const file = new ByteWriter();
  file.raw(header.toUint8Array());
  file.raw(offsets.toUint8Array());
  for (const block of scanlineBlocks) file.raw(block.toUint8Array());

  return file.toUint8Array().buffer;
}

/**
 * Reads the channel names straight from an EXR header without going through the
 * decoder, so tests can reason about alpha presence independently.
 */
function readChannelNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;

  const readString = (): string => {
    let value = '';
    while (offset < bytes.length && bytes[offset] !== 0) value += String.fromCharCode(bytes[offset++]);
    offset++;
    return value;
  };

  while (offset < bytes.length) {
    const name = readString();
    if (name === '') break;

    readString(); // attribute type
    const size = view.getUint32(offset, true);
    offset += 4;

    if (name === 'channels') {
      const end = offset + size;
      const names: string[] = [];
      while (offset < end - 1) {
        names.push(readString());
        offset += 16; // pixelType (4) + pLinear + reserved (4) + xSampling (4) + ySampling (4)
      }
      return names;
    }

    offset += size;
  }

  return [];
}

type LuminanceStats = {  max: number;
  mean: number;
  min: number;
  minAlpha: number;
  maxAlpha: number;
  nonFinite: number;
  pixels: number;
};

function luminanceStats(image: ExrImage): LuminanceStats {
  const { data } = image;
  let max = -Infinity;
  let min = Infinity;
  let sum = 0;
  let minAlpha = Infinity;
  let maxAlpha = -Infinity;
  let nonFinite = 0;
  let pixels = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) {
      nonFinite++;
    }

    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (l > max) max = l;
    if (l < min) min = l;
    sum += l;
    pixels++;

    if (a < minAlpha) minAlpha = a;
    if (a > maxAlpha) maxAlpha = a;
  }

  return { max, mean: sum / pixels, min, minAlpha, maxAlpha, nonFinite, pixels };
}

describe('decodeExr', () => {
  it('decodes a hand-built uncompressed 2x2 float image without alpha', () => {
    // Channels are stored B, G, R like the repo's HDRIs; the decoder must re-order them
    // into RGBA and the first scanline must land on the first output row (top-left origin).
    const values = [
      [
        [3, 2, 1],
        [6, 5, 4],
      ],
      [
        [9, 8, 7],
        [12, 11, 10],
      ],
    ];

    const image = decodeExr(
      buildExr({ channels: ['B', 'G', 'R'], width: 2, height: 2, values })
    );

    expect(image.width).toBe(2);
    expect(image.height).toBe(2);
    expect(image.data.length).toBe(2 * 2 * 4);
    expect(Array.from(image.data)).toEqual([
      1, 2, 3, 1,
      4, 5, 6, 1,
      7, 8, 9, 1,
      10, 11, 12, 1,
    ]);
  });

  it('carries an explicit alpha channel through and preserves negative values', () => {
    const values = [
      [
        [0.5, -1.25, 2, 0.25],
        [1, 2, 3, 1],
      ],
    ];

    const image = decodeExr(
      buildExr({ channels: ['R', 'G', 'B', 'A'], width: 2, height: 1, values })
    );

    expect(Array.from(image.data)).toEqual([0.5, -1.25, 2, 0.25, 1, 2, 3, 1]);
  });

  it('throws for an unsupported compression scheme', () => {
    const values = [
      [
        [1, 1, 1],
        [1, 1, 1],
      ],
    ];

    let error: unknown;
    try {
      decodeExr(buildExr({ channels: ['B', 'G', 'R'], width: 2, height: 1, values, compression: 9 }));
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/DWAB_COMPRESSION is unsupported/);
  });

  it('throws for input that is not an EXR file', () => {
    expect(() => decodeExr(new ArrayBuffer(64))).toThrow(/not in OpenEXR format/);
    expect(() => decodeExr(new ArrayBuffer(0))).toThrow(/not in OpenEXR format/);
  });

  it('throws for a truncated header', () => {
    const values = [
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
    ];
    const full = buildExr({ channels: ['B', 'G', 'R'], width: 2, height: 1, values });

    expect(() => decodeExr(full.slice(0, 40))).toThrow(Error);
  });

  it('throws for truncated scanline data', () => {
    const values = [
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
      [
        [7, 8, 9],
        [10, 11, 12],
      ],
    ];
    const full = buildExr({ channels: ['B', 'G', 'R'], width: 2, height: 2, values });

    // Drop most of the last scanline block so its payload runs past the end of the buffer.
    expect(() => decodeExr(full.slice(0, full.byteLength - 30))).toThrow(Error);
  });

  it('decodes every HDRI in hdri/ and produces plausible HDR luminance', () => {
    const files = readdirSync(HDRI_DIR)
      .filter((name) => name.endsWith('.exr'))
      .sort();

    expect(files.length).toBeGreaterThanOrEqual(2);

    const startedAt = performance.now();

    for (const name of files) {
      const raw = readFileSync(resolve(HDRI_DIR, name));
      const bytes = new Uint8Array(raw);
      const channelNames = readChannelNames(bytes);

      const fileStartedAt = performance.now();
      const image = decodeExr(bytes.buffer);
      const elapsed = performance.now() - fileStartedAt;

      const stats = luminanceStats(image);
      console.log(
        `${name}: ${image.width}x${image.height} channels=[${channelNames.join(',')}] decode=${elapsed.toFixed(0)}ms ` +
          `luminance max=${stats.max.toFixed(3)} mean=${stats.mean.toFixed(4)} min=${stats.min.toFixed(4)} ` +
          `alpha=[${stats.minAlpha}, ${stats.maxAlpha}]`
      );

      expect(channelNames.length).toBeGreaterThanOrEqual(3);
      expect(image.width).toBe(1024);
      expect(image.height).toBe(512);
      expect(image.data.length).toBe(1024 * 512 * 4);
      expect(stats.nonFinite).toBe(0);
      expect(stats.pixels).toBe(1024 * 512);

      // Real HDR environment maps must contain highlights far above 1.0 and a positive
      // mean luminance; tone-mapped 0..1 data would fail both.
      expect(stats.max).toBeGreaterThan(1);
      expect(stats.mean).toBeGreaterThan(0);

      // Alpha is finite and non-negative everywhere. Colour-only files come through fully
      // opaque; the alpha-bearing HDRIs here carry their own constant coverage values, so
      // only the absent-alpha case is asserted exactly.
      expect(stats.minAlpha).toBeGreaterThanOrEqual(0);

      if (!channelNames.includes('A')) {
        expect(stats.minAlpha).toBe(1);
        expect(stats.maxAlpha).toBe(1);
      }
    }

    console.log(`hdri/: decoded ${files.length} files in ${(performance.now() - startedAt).toFixed(0)}ms`);
  }, 300_000);
});
