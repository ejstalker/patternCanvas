declare module 'numcodecs' {
  export class Blosc {
    decode(data: Uint8Array): Promise<Uint8Array> | Uint8Array;
    encode(data: Uint8Array): Promise<Uint8Array> | Uint8Array;
  }
}
