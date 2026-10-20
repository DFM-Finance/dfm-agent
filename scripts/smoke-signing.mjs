#!/usr/bin/env node
/**
 * Post-build signing smoke — #19 regression guard.
 *
 * Loads a freshly-generated keypair from a 64-byte secret array (the exact
 * path the agent uses), SIWS-signs a message, and verifies the signature
 * against the ORIGINAL public key. Catches ANY change that corrupts the loaded
 * key — e.g. zeroing the buffer that backs `Keypair.fromSecretKey` (the v.490
 * bug that broke every agent sign-in with a 401 "Invalid signature").
 *
 * Exits non-zero on failure so it BLOCKS the publish (wired into release.sh +
 * publish-agent.yml after the build). Run locally with `npm test`.
 */
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58pkg from 'bs58';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signSiwsMessage } from '../dist/signing.js';

const bs58 = bs58pkg.default ?? bs58pkg;

// A9: the loader refuses loose modes and world-writable dirs (and /tmp IS one
// on Linux), so the throwaway key lives in a private 0700 dir, written 0600.
const smokeDir = mkdtempSync(join(tmpdir(), 'dfm-smoke-'));

const kp = Keypair.generate();
const message = 'dfm.finance wants you to sign in\nNonce: smoke-test';
// Cover BOTH supported key-file shapes: the 64-byte full secret (Keypair.fromSecretKey)
// AND the 32-byte seed (Keypair.fromSeed) — the v.490 bug only manifested on one path,
// so the guard must exercise both.
const cases = [
  { name: '64-byte secret', bytes: Array.from(kp.secretKey) },
  { name: '32-byte seed', bytes: Array.from(kp.secretKey.slice(0, 32)) },
];
for (const c of cases) {
  const tmp = join(smokeDir, `dfm-smoke-kp-${process.pid}-${c.bytes.length}.json`);
  writeFileSync(tmp, JSON.stringify(c.bytes), { mode: 0o600 });
  try {
    const cfg = { keypairPath: tmp, cluster: 'mainnet-beta', writeEnabled: true };
    const sig = bs58.decode(signSiwsMessage(cfg, message));
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(message), sig, kp.publicKey.toBytes());
    if (!ok) {
      console.error(`❌ signing smoke FAILED on the ${c.name} path: SIWS signature does not verify (loaded key corrupted?)`);
      process.exit(1);
    }
    console.log(`✅ signing smoke OK (${c.name}) — SIWS signature verifies`);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
  }
}
