/**
 * Signing refuses every DFM-held wallet (spec 011 T6, CA-4.12). Runnable:
 * `npx tsx src/signing.dfm-held.test.ts`.
 *
 * We cannot load the protocol wallet's secret key here (and never will), so the
 * refusal is exercised through `refuseDfmHeld`, the one check `loadTestKeypair`
 * runs on every key it loads, with a predicate that matches a throwaway key. The
 * list itself holds SHA-256 digests so the published package names no address.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { DFM_HELD_WALLET_DIGESTS, isDfmHeldWallet } from './dfm-held-wallets.js';
import { PROTOCOL_WALLET } from './owner-tx-verify.js';
import { loadTestKeypair, refuseDfmHeld } from './signing.js';
import { createKeypairStore, envCredentials } from './context.js';

let failures = 0;
async function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

const REFUSAL = /^REFUSING to load the protocol wallet as the agent test keypair\./;
// The address stays in the one file the mirror guard allows (owner-tx-verify.ts); a test never holds it.
const PROTOCOL = PROTOCOL_WALLET;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

await t('the protocol wallet is still refused, by address', () => {
  assert.equal(isDfmHeldWallet(PROTOCOL), true);
});

await t('the list is digests only: distinct sha256 hex strings, none an address', () => {
  assert.ok(DFM_HELD_WALLET_DIGESTS.length > 0);
  assert.equal(new Set(DFM_HELD_WALLET_DIGESTS).size, DFM_HELD_WALLET_DIGESTS.length);
  for (const d of DFM_HELD_WALLET_DIGESTS) assert.match(d, /^[0-9a-f]{64}$/);
  assert.ok(DFM_HELD_WALLET_DIGESTS.includes(sha(PROTOCOL)));
});

// Every digest's preimage, by reference only: the public mirror ships this file, so a
// preimage is imported from a file already allowed to hold it, never written here.
const HELD_PREIMAGES: readonly string[] = [PROTOCOL];

await t('every digest has an on-curve preimage (an off-curve address has no key to refuse)', () => {
  for (const a of HELD_PREIMAGES) assert.ok(PublicKey.isOnCurve(new PublicKey(a).toBytes()), 'a listed preimage is off-curve');
  assert.deepEqual([...DFM_HELD_WALLET_DIGESTS].sort(), HELD_PREIMAGES.map(sha).sort(), 'a digest has no on-curve preimage in this test');
});

await t('the on-curve check can fail: a PDA is off-curve', () => {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('dfm-held')], SystemProgram.programId);
  assert.equal(PublicKey.isOnCurve(pda.toBytes()), false);
});

await t('an ordinary key is not DFM-held', () => {
  assert.equal(isDfmHeldWallet(Keypair.generate().publicKey.toBase58()), false);
});

await t('a key the list matches is refused, with a message that names no key', () => {
  const kp = Keypair.generate();
  assert.throws(
    () => refuseDfmHeld(kp, (pk) => pk === kp.publicKey.toBase58()),
    (e: Error) => REFUSAL.test(e.message) && !e.message.includes(kp.publicKey.toBase58()),
  );
});

const hostScope = (kp: Keypair, store = createKeypairStore()) =>
  ({ kind: 'host' as const, keypairs: store, credentials: { ...envCredentials, keypairJson: () => JSON.stringify([...kp.secretKey]) } });
const cfg = { apiUrl: 'https://x.invalid/api/v2', cluster: 'mainnet-beta' as const, keypairJsonEnvPresent: true, writeEnabled: true };

await t('loadTestKeypair refuses a held key and caches nothing (the refusal is wired into the loader)', () => {
  const kp = Keypair.generate();
  const store = createKeypairStore();
  assert.throws(() => loadTestKeypair(cfg, hostScope(kp, store), (pk) => pk === kp.publicKey.toBase58()), (e: Error) => REFUSAL.test(e.message));
  assert.equal(store.get(), null, 'a refused key was cached');
});

await t('an ordinary key still loads through the same path (the check refuses nothing else)', () => {
  const kp = Keypair.generate();
  const store = createKeypairStore();
  assert.equal(loadTestKeypair(cfg, hostScope(kp, store)).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(store.get()?.publicKey.toBase58(), kp.publicKey.toBase58());
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\ndfm-held: all green');
