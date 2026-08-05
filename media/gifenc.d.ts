/**
 * Minimal ambient typings for the parts of gifenc we use.
 * The upstream package ships no TypeScript declarations.
 */
declare module 'gifenc' {
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number
  ): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][]
  ): Uint8Array;
  export function GIFEncoder(): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: number[][]; delay?: number }
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
}
