/**
 * Minimal ambient types for `bs58` (v4 ships no bundled types and we exclude the
 * phantom `@types/bs58` via tsconfig `types`). Only the two methods we use are
 * declared. The CJS default export is the base58 codec object.
 */
declare module 'bs58' {
  const bs58: {
    encode(bytes: Uint8Array | number[]): string;
    decode(str: string): Uint8Array;
  };
  export default bs58;
}
