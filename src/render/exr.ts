/*
 * Self-contained OpenEXR decoder, derived from three.js's EXRLoader
 * (examples/jsm/loaders/EXRLoader.js, v0.160.0, https://github.com/mrdoob/three.js).
 *
 * Only the decoding core is ported here: header parsing plus the NO/RLE/ZIPS/ZIP/PIZ
 * decompressors and the half/float scanline readers. Texture creation, the loader class,
 * event handling and URL fetching are intentionally omitted. The output is always a
 * Float32 RGBA buffer in row-major order with a top-left origin (alpha is 1 for files
 * without an alpha channel).
 *
 * three.js's EXRLoader carries the ILM OpenEXR and TinyEXR (Syoyo Fujita) copyright
 * notices because its PIZ/Huffman/wavelet code derives from those implementations.
 * They are reproduced verbatim below, followed by three.js's own MIT license.
 */

// /*
// Copyright (c) 2014 - 2017, Syoyo Fujita
// All rights reserved.

// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//     * Redistributions of source code must retain the above copyright
//       notice, this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//     * Neither the name of the Syoyo Fujita nor the
//       names of its contributors may be used to endorse or promote products
//       derived from this software without specific prior written permission.

// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
// */

// // TinyEXR contains some OpenEXR code, which is licensed under ------------

// ///////////////////////////////////////////////////////////////////////////
// //
// // Copyright (c) 2002, Industrial Light & Magic, a division of Lucas
// // Digital Ltd. LLC
// //
// // All rights reserved.
// //
// // Redistribution and use in source and binary forms, with or without
// // modification, are permitted provided that the following conditions are
// // met:
// // *       Redistributions of source code must retain the above copyright
// // notice, this list of conditions and the following disclaimer.
// // *       Redistributions in binary form must reproduce the above
// // copyright notice, this list of conditions and the following disclaimer
// // in the documentation and/or other materials provided with the
// // distribution.
// // *       Neither the name of Industrial Light & Magic nor the names of
// // its contributors may be used to endorse or promote products derived
// // from this software without specific prior written permission.
// //
// // THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// // "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// // LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// // A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// // OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// // SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// // LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// // DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// // THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// // (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// // OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
// //
// ///////////////////////////////////////////////////////////////////////////

/*
The MIT License

Copyright © 2010-2023 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

import { unzlibSync } from 'fflate';

/** A decoded OpenEXR image. `data` holds RGBA floats, row-major, top-left origin. */
export type ExrImage = {
  width: number;
  height: number;
  data: Float32Array;
};

const USHORT_RANGE = 1 << 16;
const BITMAP_SIZE = USHORT_RANGE >> 3;

const HUF_ENCBITS = 16; // literal (value) bit length
const HUF_DECBITS = 14; // decoding bit size (>= 8)

const HUF_ENCSIZE = (1 << HUF_ENCBITS) + 1; // encoding table size
const HUF_DECSIZE = 1 << HUF_DECBITS; // decoding table size
const HUF_DECMASK = HUF_DECSIZE - 1;

const NBITS = 16;
const A_OFFSET = 1 << (NBITS - 1);
const MOD_MASK = (1 << NBITS) - 1;

const SHORT_ZEROCODE_RUN = 59;
const LONG_ZEROCODE_RUN = 63;
const SHORTEST_LONG_RUN = 2 + LONG_ZEROCODE_RUN - SHORT_ZEROCODE_RUN;

const ULONG_SIZE = 8;
const FLOAT32_SIZE = 4;
const INT32_SIZE = 4;
const INT16_SIZE = 2;
const INT8_SIZE = 1;

/** Header `pixelType` for 16-bit half-float samples. */
const PIXEL_TYPE_HALF = 1;
/** Header `pixelType` for 32-bit float samples. */
const PIXEL_TYPE_FLOAT = 2;

const COMPRESSION_NAMES = [
  'NO_COMPRESSION',
  'RLE_COMPRESSION',
  'ZIPS_COMPRESSION',
  'ZIP_COMPRESSION',
  'PIZ_COMPRESSION',
  'PXR24_COMPRESSION',
  'B44_COMPRESSION',
  'B44A_COMPRESSION',
  'DWAA_COMPRESSION',
  'DWAB_COMPRESSION',
] as const;

/** Number of scanlines packed into each compressed block, per compression scheme. */
const SCANLINES_PER_BLOCK: Record<string, number> = {
  NO_COMPRESSION: 1,
  RLE_COMPRESSION: 1,
  ZIPS_COMPRESSION: 1,
  ZIP_COMPRESSION: 16,
  PIZ_COMPRESSION: 32,
};

type Offset = { value: number };

type ExrChannel = {
  name: string;
  pixelType: number;
  pLinear: number;
  xSampling: number;
  ySampling: number;
};

type Box2i = { xMin: number; yMin: number; xMax: number; yMax: number };

type HufDecodeEntry = { len: number; lit: number; p: number[] | null };

type PizChannel = { start: number; end: number; nx: number; ny: number; size: number };

type ExrDecoder = {
  viewer: DataView;
  array: Uint8Array<ArrayBuffer>;
  offset: Offset;
  size: number;
  width: number;
  height: number;
  channels: number;
  lines: number;
  scanlineBlockSize: number;
  bytesPerLine: number;
  inputSize: number;
  /** Header pixel type: {@link PIXEL_TYPE_HALF} or {@link PIXEL_TYPE_FLOAT}. */
  type: number;
  uncompress: (info: ExrDecoder) => DataView;
  getter: (view: DataView, offset: Offset) => number;
};

function decode(buffer: ArrayBuffer): ExrImage {
  const uInt8Array = new Uint8Array(buffer);
  const textDecoder = new TextDecoder();

  // Scratch objects reused by the bitstream helpers, mirroring the reference decoder.
  const getBitsReturn = { l: 0, c: 0, lc: 0 };
  const getCharReturn = { c: 0, lc: 0 };
  const getCodeReturn = { c: 0, lc: 0 };
  const wdec14Return = { a: 0, b: 0 };
  const hufTableBuffer: number[] = new Array<number>(59).fill(0);

  function reverseLutFromBitmap(bitmap: Uint8Array, lut: Uint16Array): number {
    let k = 0;

    for (let i = 0; i < USHORT_RANGE; ++i) {
      if (i === 0 || (bitmap[i >> 3] & (1 << (i & 7))) !== 0) {
        lut[k++] = i;
      }
    }

    const n = k - 1;

    while (k < USHORT_RANGE) lut[k++] = 0;

    return n;
  }

  function hufClearDecTable(hdec: HufDecodeEntry[]): void {
    for (let i = 0; i < HUF_DECSIZE; i++) {
      hdec[i] = { len: 0, lit: 0, p: null };
    }
  }

  function getBits(
    nBits: number,
    c: number,
    lc: number,
    bytes: Uint8Array,
    inOffset: Offset
  ): void {
    while (lc < nBits) {
      c = (c << 8) | parseUint8Array(bytes, inOffset);
      lc += 8;
    }

    lc -= nBits;

    getBitsReturn.l = (c >> lc) & ((1 << nBits) - 1);
    getBitsReturn.c = c;
    getBitsReturn.lc = lc;
  }

  function hufCanonicalCodeTable(hcode: number[]): void {
    for (let i = 0; i <= 58; ++i) hufTableBuffer[i] = 0;
    for (let i = 0; i < HUF_ENCSIZE; ++i) hufTableBuffer[hcode[i]] += 1;

    let c = 0;

    for (let i = 58; i > 0; --i) {
      const nc = (c + hufTableBuffer[i]) >> 1;
      hufTableBuffer[i] = c;
      c = nc;
    }

    for (let i = 0; i < HUF_ENCSIZE; ++i) {
      const l = hcode[i];
      if (l > 0) hcode[i] = l | (hufTableBuffer[l]++ << 6);
    }
  }

  function hufUnpackEncTable(
    bytes: Uint8Array,
    inOffset: Offset,
    ni: number,
    im: number,
    iM: number,
    hcode: number[]
  ): boolean {
    const p = inOffset;
    let c = 0;
    let lc = 0;

    for (; im <= iM; im++) {
      if (p.value - inOffset.value > ni) return false;

      getBits(6, c, lc, bytes, p);

      const l = getBitsReturn.l;
      c = getBitsReturn.c;
      lc = getBitsReturn.lc;

      hcode[im] = l;

      if (l === LONG_ZEROCODE_RUN) {
        if (p.value - inOffset.value > ni) {
          throw new Error('EXR decode: malformed PIZ Huffman encoding table.');
        }

        getBits(8, c, lc, bytes, p);

        let zerun = getBitsReturn.l + SHORTEST_LONG_RUN;
        c = getBitsReturn.c;
        lc = getBitsReturn.lc;

        if (im + zerun > iM + 1) {
          throw new Error('EXR decode: malformed PIZ Huffman encoding table.');
        }

        while (zerun--) hcode[im++] = 0;

        im--;
      } else if (l >= SHORT_ZEROCODE_RUN) {
        let zerun = l - SHORT_ZEROCODE_RUN + 2;

        if (im + zerun > iM + 1) {
          throw new Error('EXR decode: malformed PIZ Huffman encoding table.');
        }

        while (zerun--) hcode[im++] = 0;

        im--;
      }
    }

    hufCanonicalCodeTable(hcode);

    return true;
  }

  function hufLength(code: number): number {
    return code & 63;
  }

  function hufCode(code: number): number {
    return code >> 6;
  }

  function hufBuildDecTable(
    hcode: number[],
    im: number,
    iM: number,
    hdecod: HufDecodeEntry[]
  ): boolean {
    for (; im <= iM; im++) {
      const c = hufCode(hcode[im]);
      const l = hufLength(hcode[im]);

      if (c >> l) {
        throw new Error('EXR decode: invalid PIZ Huffman table entry.');
      }

      if (l > HUF_DECBITS) {
        const pl = hdecod[c >> (l - HUF_DECBITS)];

        if (pl.len) {
          throw new Error('EXR decode: invalid PIZ Huffman table entry.');
        }

        pl.lit++;

        let table = pl.p;

        if (table) {
          const grown: number[] = new Array<number>(pl.lit);
          for (let i = 0; i < pl.lit - 1; ++i) {
            grown[i] = table[i];
          }
          table = grown;
        } else {
          table = new Array<number>(1);
        }

        table[pl.lit - 1] = im;
        pl.p = table;
      } else if (l) {
        let plOffset = 0;

        for (let i = 1 << (HUF_DECBITS - l); i > 0; i--) {
          const pl = hdecod[(c << (HUF_DECBITS - l)) + plOffset];

          if (pl.len || pl.p) {
            throw new Error('EXR decode: invalid PIZ Huffman table entry.');
          }

          pl.len = l;
          pl.lit = im;

          plOffset++;
        }
      }
    }

    return true;
  }

  function getChar(c: number, lc: number, bytes: Uint8Array, inOffset: Offset): void {
    c = (c << 8) | parseUint8Array(bytes, inOffset);
    lc += 8;

    getCharReturn.c = c;
    getCharReturn.lc = lc;
  }

  function getCode(
    po: number,
    rlc: number,
    c: number,
    lc: number,
    bytes: Uint8Array,
    inOffset: Offset,
    outBuffer: Uint16Array,
    outBufferOffset: Offset,
    outBufferEndOffset: number
  ): void {
    if (po === rlc) {
      if (lc < 8) {
        getChar(c, lc, bytes, inOffset);
        c = getCharReturn.c;
        lc = getCharReturn.lc;
      }

      lc -= 8;

      let cs = c >> lc;
      cs = new Uint8Array([cs])[0];

      if (outBufferOffset.value + cs > outBufferEndOffset) {
        return;
      }

      const s = outBuffer[outBufferOffset.value - 1];

      while (cs-- > 0) {
        outBuffer[outBufferOffset.value++] = s;
      }
    } else if (outBufferOffset.value < outBufferEndOffset) {
      outBuffer[outBufferOffset.value++] = po;
    } else {
      return;
    }

    getCodeReturn.c = c;
    getCodeReturn.lc = lc;
  }

  function UInt16(value: number): number {
    return value & 0xffff;
  }

  function Int16(value: number): number {
    const ref = UInt16(value);
    return ref > 0x7fff ? ref - 0x10000 : ref;
  }

  function wdec14(l: number, h: number): void {
    const ls = Int16(l);
    const hs = Int16(h);

    const hi = hs;
    const ai = ls + (hi & 1) + (hi >> 1);

    const as = ai;
    const bs = ai - hi;

    wdec14Return.a = as;
    wdec14Return.b = bs;
  }

  function wdec16(l: number, h: number): void {
    const m = UInt16(l);
    const d = UInt16(h);

    const bb = (m - (d >> 1)) & MOD_MASK;
    const aa = (d + bb - A_OFFSET) & MOD_MASK;

    wdec14Return.a = aa;
    wdec14Return.b = bb;
  }

  function wav2Decode(
    buffer: Uint16Array,
    j: number,
    nx: number,
    ox: number,
    ny: number,
    oy: number,
    mx: number
  ): number {
    const w14 = mx < 1 << 14;
    const n = nx > ny ? ny : nx;
    let p = 1;
    let p2 = 0;
    let py = 0;

    while (p <= n) p <<= 1;

    p >>= 1;
    p2 = p;
    p >>= 1;

    while (p >= 1) {
      py = 0;
      const ey = py + oy * (ny - p2);
      const oy1 = oy * p;
      const oy2 = oy * p2;
      const ox1 = ox * p;
      const ox2 = ox * p2;
      let i00 = 0;
      let i01 = 0;
      let i10 = 0;
      let i11 = 0;

      for (; py <= ey; py += oy2) {
        let px = py;
        const ex = py + ox * (nx - p2);

        for (; px <= ex; px += ox2) {
          const p01 = px + ox1;
          const p10 = px + oy1;
          const p11 = p10 + ox1;

          if (w14) {
            wdec14(buffer[px + j], buffer[p10 + j]);

            i00 = wdec14Return.a;
            i10 = wdec14Return.b;

            wdec14(buffer[p01 + j], buffer[p11 + j]);

            i01 = wdec14Return.a;
            i11 = wdec14Return.b;

            wdec14(i00, i01);

            buffer[px + j] = wdec14Return.a;
            buffer[p01 + j] = wdec14Return.b;

            wdec14(i10, i11);

            buffer[p10 + j] = wdec14Return.a;
            buffer[p11 + j] = wdec14Return.b;
          } else {
            wdec16(buffer[px + j], buffer[p10 + j]);

            i00 = wdec14Return.a;
            i10 = wdec14Return.b;

            wdec16(buffer[p01 + j], buffer[p11 + j]);

            i01 = wdec14Return.a;
            i11 = wdec14Return.b;

            wdec16(i00, i01);

            buffer[px + j] = wdec14Return.a;
            buffer[p01 + j] = wdec14Return.b;

            wdec16(i10, i11);

            buffer[p10 + j] = wdec14Return.a;
            buffer[p11 + j] = wdec14Return.b;
          }
        }

        if (nx & p) {
          const p10 = px + oy1;

          if (w14) wdec14(buffer[px + j], buffer[p10 + j]);
          else wdec16(buffer[px + j], buffer[p10 + j]);

          i00 = wdec14Return.a;
          buffer[p10 + j] = wdec14Return.b;

          buffer[px + j] = i00;
        }
      }

      if (ny & p) {
        let px = py;
        const ex = py + ox * (nx - p2);

        for (; px <= ex; px += ox2) {
          const p01 = px + ox1;

          if (w14) wdec14(buffer[px + j], buffer[p01 + j]);
          else wdec16(buffer[px + j], buffer[p01 + j]);

          i00 = wdec14Return.a;
          buffer[p01 + j] = wdec14Return.b;

          buffer[px + j] = i00;
        }
      }

      p2 = p;
      p >>= 1;
    }

    return py;
  }

  function hufDecode(
    encodingTable: number[],
    decodingTable: HufDecodeEntry[],
    bytes: Uint8Array,
    inOffset: Offset,
    ni: number,
    rlc: number,
    no: number,
    outBuffer: Uint16Array,
    outOffset: Offset
  ): boolean {
    let c = 0;
    let lc = 0;
    const outBufferEndOffset = no;
    const inOffsetEnd = Math.trunc(inOffset.value + (ni + 7) / 8);

    while (inOffset.value < inOffsetEnd) {
      getChar(c, lc, bytes, inOffset);

      c = getCharReturn.c;
      lc = getCharReturn.lc;

      while (lc >= HUF_DECBITS) {
        const index = (c >> (lc - HUF_DECBITS)) & HUF_DECMASK;
        const pl = decodingTable[index];

        if (pl.len) {
          lc -= pl.len;

          getCode(pl.lit, rlc, c, lc, bytes, inOffset, outBuffer, outOffset, outBufferEndOffset);

          c = getCodeReturn.c;
          lc = getCodeReturn.lc;
        } else {
          if (!pl.p) {
            throw new Error('EXR decode: malformed PIZ Huffman stream.');
          }

          let j = 0;

          for (; j < pl.lit; j++) {
            const l = hufLength(encodingTable[pl.p[j]]);

            while (lc < l && inOffset.value < inOffsetEnd) {
              getChar(c, lc, bytes, inOffset);

              c = getCharReturn.c;
              lc = getCharReturn.lc;
            }

            if (lc >= l) {
              if (
                hufCode(encodingTable[pl.p[j]]) === ((c >> (lc - l)) & ((1 << l) - 1))
              ) {
                lc -= l;

                getCode(
                  pl.p[j],
                  rlc,
                  c,
                  lc,
                  bytes,
                  inOffset,
                  outBuffer,
                  outOffset,
                  outBufferEndOffset
                );

                c = getCodeReturn.c;
                lc = getCodeReturn.lc;

                break;
              }
            }
          }

          if (j === pl.lit) {
            throw new Error('EXR decode: malformed PIZ Huffman stream.');
          }
        }
      }
    }

    const i = (8 - ni) & 7;

    c >>= i;
    lc -= i;

    while (lc > 0) {
      const pl = decodingTable[(c << (HUF_DECBITS - lc)) & HUF_DECMASK];

      if (pl.len) {
        lc -= pl.len;

        getCode(pl.lit, rlc, c, lc, bytes, inOffset, outBuffer, outOffset, outBufferEndOffset);

        c = getCodeReturn.c;
        lc = getCodeReturn.lc;
      } else {
        throw new Error('EXR decode: malformed PIZ Huffman stream.');
      }
    }

    return true;
  }

  function hufUncompress(
    bytes: Uint8Array,
    inDataView: DataView,
    inOffset: Offset,
    nCompressed: number,
    outBuffer: Uint16Array,
    nRaw: number
  ): void {
    const outOffset: Offset = { value: 0 };
    const initialInOffset = inOffset.value;

    const im = parseUint32(inDataView, inOffset);
    const iM = parseUint32(inDataView, inOffset);

    inOffset.value += 4;

    const nBits = parseUint32(inDataView, inOffset);

    inOffset.value += 4;

    if (im < 0 || im >= HUF_ENCSIZE || iM < 0 || iM >= HUF_ENCSIZE) {
      throw new Error('EXR decode: malformed PIZ Huffman table range.');
    }

    const freq = new Array<number>(HUF_ENCSIZE).fill(0);
    const hdec: HufDecodeEntry[] = new Array(HUF_DECSIZE);

    hufClearDecTable(hdec);

    const ni = nCompressed - (inOffset.value - initialInOffset);

    hufUnpackEncTable(bytes, inOffset, ni, im, iM, freq);

    if (nBits > 8 * (nCompressed - (inOffset.value - initialInOffset))) {
      throw new Error('EXR decode: malformed PIZ Huffman bit count.');
    }

    hufBuildDecTable(freq, im, iM, hdec);

    hufDecode(freq, hdec, bytes, inOffset, nBits, iM, nRaw, outBuffer, outOffset);
  }

  function applyLut(lut: Uint16Array, data: Uint16Array, nData: number): void {
    for (let i = 0; i < nData; ++i) {
      data[i] = lut[data[i]];
    }
  }

  function predictor(source: Uint8Array): void {
    for (let t = 1; t < source.length; t++) {
      const d = source[t - 1] + source[t] - 128;
      source[t] = d;
    }
  }

  function interleaveScalar(source: Uint8Array, out: Uint8Array): void {
    let t1 = 0;
    let t2 = Math.floor((source.length + 1) / 2);
    let s = 0;
    const stop = source.length - 1;

    while (true) {
      if (s > stop) break;
      out[s++] = source[t1++];

      if (s > stop) break;
      out[s++] = source[t2++];
    }
  }

  function decodeRunLength(source: ArrayBufferLike): number[] {
    let size = source.byteLength;
    const out: number[] = [];
    let p = 0;

    const reader = new DataView(source);

    while (size > 0) {
      const l = reader.getInt8(p++);

      if (l < 0) {
        const count = -l;
        size -= count + 1;

        for (let i = 0; i < count; i++) {
          out.push(reader.getUint8(p++));
        }
      } else {
        const count = l;
        size -= 2;

        const value = reader.getUint8(p++);

        for (let i = 0; i < count + 1; i++) {
          out.push(value);
        }
      }
    }

    return out;
  }

  function uncompressRAW(info: ExrDecoder): DataView {
    return new DataView(info.array.buffer, info.offset.value, info.size);
  }

  function uncompressRLE(info: ExrDecoder): DataView {
    const compressed = info.viewer.buffer.slice(
      info.offset.value,
      info.offset.value + info.size
    );

    const rawBuffer = new Uint8Array(decodeRunLength(compressed));
    const tmpBuffer = new Uint8Array(rawBuffer.length);

    predictor(rawBuffer); // revert predictor
    interleaveScalar(rawBuffer, tmpBuffer); // interleave pixels

    return new DataView(tmpBuffer.buffer);
  }

  function uncompressZIP(info: ExrDecoder): DataView {
    const compressed = info.array.slice(info.offset.value, info.offset.value + info.size);

    const rawBuffer = unzlibSync(compressed);
    const tmpBuffer = new Uint8Array(rawBuffer.length);

    predictor(rawBuffer); // revert predictor
    interleaveScalar(rawBuffer, tmpBuffer); // interleave pixels

    return new DataView(tmpBuffer.buffer);
  }

  function uncompressPIZ(info: ExrDecoder): DataView {
    const inDataView = info.viewer;
    const inOffset: Offset = { value: info.offset.value };

    const outBuffer = new Uint16Array(
      info.width * info.scanlineBlockSize * (info.channels * info.type)
    );
    const bitmap = new Uint8Array(BITMAP_SIZE);

    // Setup channel info
    let outBufferEnd = 0;
    const pizChannelData: PizChannel[] = new Array(info.channels);
    for (let i = 0; i < info.channels; i++) {
      pizChannelData[i] = {
        start: outBufferEnd,
        end: outBufferEnd,
        nx: info.width,
        ny: info.lines,
        size: info.type,
      };

      outBufferEnd += info.width * info.lines * info.type;
    }

    // Read range compression data
    const minNonZero = parseUint16(inDataView, inOffset);
    const maxNonZero = parseUint16(inDataView, inOffset);

    if (maxNonZero >= BITMAP_SIZE) {
      throw new Error('EXR decode: malformed PIZ bitmap.');
    }

    if (minNonZero <= maxNonZero) {
      for (let i = 0; i < maxNonZero - minNonZero + 1; i++) {
        bitmap[i + minNonZero] = parseUint8(inDataView, inOffset);
      }
    }

    // Reverse LUT
    const lut = new Uint16Array(USHORT_RANGE);
    const maxValue = reverseLutFromBitmap(bitmap, lut);

    const length = parseUint32(inDataView, inOffset);

    // Huffman decoding
    hufUncompress(info.array, inDataView, inOffset, length, outBuffer, outBufferEnd);

    // Wavelet decoding
    for (let i = 0; i < info.channels; ++i) {
      const cd = pizChannelData[i];

      for (let j = 0; j < pizChannelData[i].size; ++j) {
        wav2Decode(outBuffer, cd.start + j, cd.nx, cd.size, cd.ny, cd.nx * cd.size, maxValue);
      }
    }

    // Expand the pixel data to their original range
    applyLut(lut, outBuffer, outBufferEnd);

    // Rearrange the pixel data into the format expected by the caller.
    let tmpOffset = 0;
    const tmpBuffer = new Uint8Array(outBuffer.buffer.byteLength);
    for (let y = 0; y < info.lines; y++) {
      for (let c = 0; c < info.channels; c++) {
        const cd = pizChannelData[c];

        const n = cd.nx * cd.size;
        const cp = new Uint8Array(outBuffer.buffer, cd.end * INT16_SIZE, n * INT16_SIZE);

        tmpBuffer.set(cp, tmpOffset);
        tmpOffset += n * INT16_SIZE;
        cd.end += n;
      }
    }

    return new DataView(tmpBuffer.buffer);
  }

  function parseNullTerminatedString(offset: Offset): string {
    let endOffset = 0;

    while (true) {
      const index = offset.value + endOffset;
      if (index >= uInt8Array.length) {
        throw new Error('EXR decode: unexpected end of data while reading the header.');
      }
      if (uInt8Array[index] === 0) break;
      endOffset += 1;
    }

    const stringValue = textDecoder.decode(
      uInt8Array.subarray(offset.value, offset.value + endOffset)
    );

    offset.value = offset.value + endOffset + 1;

    return stringValue;
  }

  function parseFixedLengthString(offset: Offset, size: number): string {
    const stringValue = textDecoder.decode(
      uInt8Array.subarray(offset.value, offset.value + size)
    );

    offset.value = offset.value + size;

    return stringValue;
  }

  function parseRational(dataView: DataView, offset: Offset): [number, number] {
    const x = parseInt32(dataView, offset);
    const y = parseUint32(dataView, offset);

    return [x, y];
  }

  function parseTimecode(dataView: DataView, offset: Offset): [number, number] {
    const x = parseUint32(dataView, offset);
    const y = parseUint32(dataView, offset);

    return [x, y];
  }

  function parseInt32(dataView: DataView, offset: Offset): number {
    const Int32 = dataView.getInt32(offset.value, true);

    offset.value = offset.value + INT32_SIZE;

    return Int32;
  }

  function parseUint32(dataView: DataView, offset: Offset): number {
    const Uint32 = dataView.getUint32(offset.value, true);

    offset.value = offset.value + INT32_SIZE;

    return Uint32;
  }

  function parseUint8Array(bytes: Uint8Array, offset: Offset): number {
    const Uint8 = bytes[offset.value];

    offset.value = offset.value + INT8_SIZE;

    return Uint8;
  }

  function parseUint8(dataView: DataView, offset: Offset): number {
    const Uint8 = dataView.getUint8(offset.value);

    offset.value = offset.value + INT8_SIZE;

    return Uint8;
  }

  function parseInt64(dataView: DataView, offset: Offset): number {
    let int: number;

    if ('getBigInt64' in DataView.prototype) {
      int = Number(dataView.getBigInt64(offset.value, true));
    } else {
      int =
        dataView.getUint32(offset.value + 4, true) +
        Number(dataView.getUint32(offset.value, true) << 32);
    }

    offset.value += ULONG_SIZE;

    return int;
  }

  function parseFloat32(dataView: DataView, offset: Offset): number {
    const float = dataView.getFloat32(offset.value, true);

    offset.value += FLOAT32_SIZE;

    return float;
  }

  // https://stackoverflow.com/questions/5678432/decompressing-half-precision-floats-in-javascript
  function decodeFloat16(binary: number): number {
    const exponent = (binary & 0x7c00) >> 10,
      fraction = binary & 0x03ff;

    return (
      (binary >> 15 ? -1 : 1) *
      (exponent
        ? exponent === 0x1f
          ? fraction
            ? NaN
            : Infinity
          : Math.pow(2, exponent - 15) * (1 + fraction / 0x400)
        : 6.103515625e-5 * (fraction / 0x400))
    );
  }

  function parseUint16(dataView: DataView, offset: Offset): number {
    const Uint16 = dataView.getUint16(offset.value, true);

    offset.value += INT16_SIZE;

    return Uint16;
  }

  function parseFloat16(dataView: DataView, offset: Offset): number {
    return decodeFloat16(parseUint16(dataView, offset));
  }

  function parseChlist(dataView: DataView, offset: Offset, size: number): ExrChannel[] {
    const startOffset = offset.value;
    const channels: ExrChannel[] = [];

    while (offset.value < startOffset + size - 1) {
      const name = parseNullTerminatedString(offset);
      const pixelType = parseInt32(dataView, offset);
      const pLinear = parseUint8(dataView, offset);
      offset.value += 3; // reserved, three chars
      const xSampling = parseInt32(dataView, offset);
      const ySampling = parseInt32(dataView, offset);

      channels.push({
        name,
        pixelType,
        pLinear,
        xSampling,
        ySampling,
      });
    }

    offset.value += 1;

    return channels;
  }

  function parseChromaticities(dataView: DataView, offset: Offset): Record<string, number> {
    const redX = parseFloat32(dataView, offset);
    const redY = parseFloat32(dataView, offset);
    const greenX = parseFloat32(dataView, offset);
    const greenY = parseFloat32(dataView, offset);
    const blueX = parseFloat32(dataView, offset);
    const blueY = parseFloat32(dataView, offset);
    const whiteX = parseFloat32(dataView, offset);
    const whiteY = parseFloat32(dataView, offset);

    return { redX, redY, greenX, greenY, blueX, blueY, whiteX, whiteY };
  }

  function parseCompression(dataView: DataView, offset: Offset): string {
    const compression = parseUint8(dataView, offset);

    return COMPRESSION_NAMES[compression] ?? `UNKNOWN_COMPRESSION_${compression}`;
  }

  function parseBox2i(dataView: DataView, offset: Offset): Box2i {
    const xMin = parseUint32(dataView, offset);
    const yMin = parseUint32(dataView, offset);
    const xMax = parseUint32(dataView, offset);
    const yMax = parseUint32(dataView, offset);

    return { xMin, yMin, xMax, yMax };
  }

  function parseLineOrder(dataView: DataView, offset: Offset): string {
    const lineOrders = ['INCREASING_Y'];

    const lineOrder = parseUint8(dataView, offset);

    return lineOrders[lineOrder] ?? `UNKNOWN_LINE_ORDER_${lineOrder}`;
  }

  function parseV2f(dataView: DataView, offset: Offset): [number, number] {
    const x = parseFloat32(dataView, offset);
    const y = parseFloat32(dataView, offset);

    return [x, y];
  }

  function parseV3f(dataView: DataView, offset: Offset): [number, number, number] {
    const x = parseFloat32(dataView, offset);
    const y = parseFloat32(dataView, offset);
    const z = parseFloat32(dataView, offset);

    return [x, y, z];
  }

  function parseValue(
    dataView: DataView,
    offset: Offset,
    type: string,
    size: number
  ): unknown {
    if (type === 'string' || type === 'stringvector' || type === 'iccProfile') {
      return parseFixedLengthString(offset, size);
    } else if (type === 'chlist') {
      return parseChlist(dataView, offset, size);
    } else if (type === 'chromaticities') {
      return parseChromaticities(dataView, offset);
    } else if (type === 'compression') {
      return parseCompression(dataView, offset);
    } else if (type === 'box2i') {
      return parseBox2i(dataView, offset);
    } else if (type === 'lineOrder') {
      return parseLineOrder(dataView, offset);
    } else if (type === 'float') {
      return parseFloat32(dataView, offset);
    } else if (type === 'v2f') {
      return parseV2f(dataView, offset);
    } else if (type === 'v3f') {
      return parseV3f(dataView, offset);
    } else if (type === 'int') {
      return parseInt32(dataView, offset);
    } else if (type === 'rational') {
      return parseRational(dataView, offset);
    } else if (type === 'timecode') {
      return parseTimecode(dataView, offset);
    } else {
      offset.value += size;
      return undefined;
    }
  }

  function parseHeader(dataView: DataView, offset: Offset): Record<string, unknown> {
    if (dataView.byteLength < 8 || dataView.getUint32(0, true) !== 20000630) {
      throw new Error('EXR decode: provided file is not in OpenEXR format.');
    }

    const header: Record<string, unknown> = {};

    header.version = dataView.getUint8(4);

    const spec = dataView.getUint8(5); // fullMask

    header.spec = {
      singleTile: !!(spec & 2),
      longName: !!(spec & 4),
      deepFormat: !!(spec & 8),
      multiPart: !!(spec & 16),
    };

    // start of header
    offset.value = 8; // start at 8 - after pre-amble

    let keepReading = true;

    while (keepReading) {
      const attributeName = parseNullTerminatedString(offset);

      if (attributeName === '') {
        keepReading = false;
      } else {
        const attributeType = parseNullTerminatedString(offset);
        const attributeSize = parseUint32(dataView, offset);
        const attributeValue = parseValue(dataView, offset, attributeType, attributeSize);

        if (attributeValue !== undefined) {
          header[attributeName] = attributeValue;
        }
      }
    }

    if ((spec & ~0x04) !== 0) {
      // unsupported tiled, deep-image, multi-part
      throw new Error('EXR decode: provided file is currently unsupported (tiled/deep/multi-part).');
    }

    return header;
  }

  function setupDecoder(
    header: Record<string, unknown>,
    dataView: DataView,
    offset: Offset
  ): ExrDecoder {
    const channels = header.channels as ExrChannel[];
    const compression = header.compression as string;
    const dataWindow = header.dataWindow as Box2i;

    if (!Array.isArray(channels) || channels.length === 0) {
      throw new Error('EXR decode: header has no channels.');
    }

    if (!dataWindow) {
      throw new Error('EXR decode: header has no data window.');
    }

    for (const channel of channels) {
      if (channel.xSampling !== 1 || channel.ySampling !== 1) {
        throw new Error('EXR decode: subsampled channels are unsupported.');
      }
    }

    const width = dataWindow.xMax - dataWindow.xMin + 1;
    const height = dataWindow.yMax - dataWindow.yMin + 1;

    if (width <= 0 || height <= 0) {
      throw new Error('EXR decode: header has an empty data window.');
    }

    const scanlineBlockSize = SCANLINES_PER_BLOCK[compression];

    if (typeof compression !== 'string' || scanlineBlockSize === undefined) {
      throw new Error(`EXR decode: ${String(compression)} is unsupported.`);
    }

    const uncompress =
      compression === 'NO_COMPRESSION'
        ? uncompressRAW
        : compression === 'RLE_COMPRESSION'
          ? uncompressRLE
          : compression === 'PIZ_COMPRESSION'
            ? uncompressPIZ
            : uncompressZIP;

    const type = channels[0].pixelType;

    for (const channel of channels) {
      if (channel.pixelType !== type) {
        throw new Error('EXR decode: mixed channel pixel types are unsupported.');
      }
    }

    let inputSize: number;
    let getter: (view: DataView, offset: Offset) => number;

    if (type === PIXEL_TYPE_HALF) {
      inputSize = INT16_SIZE;
      getter = parseFloat16;
    } else if (type === PIXEL_TYPE_FLOAT) {
      inputSize = FLOAT32_SIZE;
      getter = parseFloat32;
    } else {
      throw new Error(
        `EXR decode: unsupported pixelType ${type} for ${compression}.`
      );
    }

    const decoder: ExrDecoder = {
      viewer: dataView,
      array: uInt8Array,
      offset,
      size: 0,
      width,
      height,
      channels: channels.length,
      lines: scanlineBlockSize,
      scanlineBlockSize,
      bytesPerLine: width * inputSize * channels.length,
      inputSize,
      type,
      uncompress,
      getter,
    };

    const blockCount = Math.ceil(height / scanlineBlockSize);

    for (let i = 0; i < blockCount; i++) {
      parseInt64(dataView, offset); // scanlineOffset
    }

    return decoder;
  }

  // start parsing file [START]

  const bufferDataView = new DataView(buffer);
  const offset: Offset = { value: 0 };

  const header = parseHeader(bufferDataView, offset);
  const decoder = setupDecoder(header, bufferDataView, offset);

  const channels = header.channels as ExrChannel[];

  const width = decoder.width;
  const height = decoder.height;
  const outputChannels = 4;
  const output = new Float32Array(width * height * outputChannels);

  // Default every channel to 1 so that images without an alpha channel are opaque;
  // channels present in the file overwrite their slot below.
  output.fill(1);

  const tmpOffset: Offset = { value: 0 };
  const channelOffsets: Record<string, number> = { R: 0, G: 1, B: 2, A: 3, Y: 0 };

  const blockCount = Math.ceil(height / decoder.scanlineBlockSize);

  for (let scanlineBlockIdx = 0; scanlineBlockIdx < blockCount; scanlineBlockIdx++) {
    const line = parseUint32(bufferDataView, offset); // line_no
    decoder.size = parseUint32(bufferDataView, offset); // data_len
    decoder.lines =
      line + decoder.scanlineBlockSize > height ? height - line : decoder.scanlineBlockSize;

    const isCompressed = decoder.size < decoder.lines * decoder.bytesPerLine;
    const viewer = isCompressed ? decoder.uncompress(decoder) : uncompressRAW(decoder);

    offset.value += decoder.size;

    for (let line_y = 0; line_y < decoder.scanlineBlockSize; line_y++) {
      const true_y = line_y + scanlineBlockIdx * decoder.scanlineBlockSize;
      if (true_y >= height) break;

      for (let channelID = 0; channelID < decoder.channels; channelID++) {
        const cOff = channelOffsets[channels[channelID].name];
        if (cOff === undefined) continue;

        for (let x = 0; x < decoder.width; x++) {
          tmpOffset.value =
            (line_y * (decoder.channels * decoder.width) + channelID * decoder.width + x) *
            decoder.inputSize;

          const outIndex =
            true_y * (width * outputChannels) + x * outputChannels + cOff;

          output[outIndex] = decoder.getter(viewer, tmpOffset);
        }
      }
    }
  }

  return { width, height, data: output };
}

/**
 * Decodes an OpenEXR file into a Float32 RGBA image.
 *
 * Supports uncompressed, RLE, ZIPS, ZIP and PIZ scanline compression, with FLOAT or
 * HALF pixel types. Unsupported compression schemes (PXR24, B44, B44A, DWAA, DWAB),
 * tiled/deep/multi-part files and malformed data throw an {@link Error}.
 */
export function decodeExr(buffer: ArrayBuffer): ExrImage {
  try {
    return decode(buffer);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`decodeExr: malformed or truncated EXR data (${error.message})`);
    }

    throw error;
  }
}
