import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { DEFAULT_AVATAR_SIZE, defaultAvatarPng, identiconCells } from './default-avatar.js';

// default_avatar_is_a_valid_deterministic_png: same pubkey → same bytes; another pubkey → other bytes;
// PNG signature (what the API's magic-byte check reads), IHDR 240×240 RGB, IDAT inflates to the exact raster.
const A = '6VCHVySzyo72GSd4mKhJpiAR2jik3pUeQWLvbvT97iZm';
const B = '3UzV2MViAHEeWJAXkz3LZ5ZDCa5ZpzAHv7PY2k66P1eP';
const a1 = defaultAvatarPng(A);
assert.ok(a1.equals(defaultAvatarPng(A)), 'deterministic');
assert.ok(!a1.equals(defaultAvatarPng(B)), 'differs per identity');
assert.ok(a1.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
assert.equal(a1.subarray(12, 16).toString('latin1'), 'IHDR');
assert.equal(a1.readUInt32BE(16), DEFAULT_AVATAR_SIZE);
assert.equal(a1.readUInt32BE(20), DEFAULT_AVATAR_SIZE);
assert.equal(a1[24], 8);
assert.equal(a1[25], 2);
const idatLen = a1.readUInt32BE(33);
assert.equal(a1.subarray(37, 41).toString('latin1'), 'IDAT');
const raster = inflateSync(a1.subarray(41, 41 + idatLen));
assert.equal(raster.length, DEFAULT_AVATAR_SIZE * (1 + DEFAULT_AVATAR_SIZE * 3));
assert.ok(a1.length < 2 * 1024 * 1024, 'under the 2 MB avatar cap');
assert.equal(a1.subarray(a1.length - 8, a1.length - 4).toString('latin1'), 'IEND');
// the grid is mirrored left↔right
for (const row of identiconCells(A)) assert.deepEqual(row, [...row].reverse());

console.log('default-avatar.test: ok');
