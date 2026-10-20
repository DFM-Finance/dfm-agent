/**
 * DEFAULT AVATAR for headless agents (2026-10-20). The API's onboarding gate
 * wants a chosen name AND an avatar before an app wallet can be created; a
 * vanilla headless agent has no operator image, so `set_profile` used to stop
 * dead. This draws a deterministic 5×5 mirrored identicon from the identity
 * public key and encodes it as a PNG with no dependency beyond node:zlib — the
 * API accepts PNG (magic-byte check in profile.controller.ts) and re-encodes it
 * to WebP. Same pubkey → same bytes, so re-running set_profile is idempotent.
 * An operator-provided image always wins (see `avatarPath`).
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const GRID = 5;
const CELL = 40;
const MARGIN = 20;
export const DEFAULT_AVATAR_SIZE = GRID * CELL + 2 * MARGIN; // 240 px

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** HSL (h 0-360, s/l 0-1) → 8-bit RGB. */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Which cells are filled: 15 bits for the left 3 columns, mirrored to 5. */
export function identiconCells(seed: string): boolean[][] {
  const h = createHash('sha256').update(seed, 'utf8').digest();
  const cells: boolean[][] = [];
  for (let y = 0; y < GRID; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < GRID; x++) {
      const col = x < 3 ? x : GRID - 1 - x;
      row.push((h[y * 3 + col] & 1) === 1);
    }
    cells.push(row);
  }
  return cells;
}

/** A deterministic PNG identicon for `seed` (the identity public key). */
export function defaultAvatarPng(seed: string): Buffer {
  const h = createHash('sha256').update(seed, 'utf8').digest();
  const fg = hsl(((h[20] << 8) | h[21]) % 360, 0.55, 0.5);
  const bg: [number, number, number] = [242, 242, 242];
  const cells = identiconCells(seed);
  const size = DEFAULT_AVATAR_SIZE;
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let py = 0; py < size; py++) {
    const rowOff = py * (1 + size * 3);
    raw[rowOff] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      const cx = Math.floor((px - MARGIN) / CELL);
      const cy = Math.floor((py - MARGIN) / CELL);
      const on = px >= MARGIN && py >= MARGIN && cx < GRID && cy < GRID && cells[cy][cx];
      const [r, g, b] = on ? fg : bg;
      const o = rowOff + 1 + px * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
