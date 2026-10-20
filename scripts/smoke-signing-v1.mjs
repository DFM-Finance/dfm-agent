#!/usr/bin/env node
/**
 * v.1509 — the keypair lane signs a Solana v1 wire (the API's ZAP_TX_V1_* paths).
 * web3.js 1.99 parses v1 but cannot write it back, so `signBase64Transaction`
 * signs the wire IN PLACE. This smoke compiles a real v1 transaction with the
 * monorepo SDK (built dist; skipped with a notice when it is not built), signs
 * it, and verifies: the returned bytes are the input bytes with ONLY the payer's
 * signature slot filled, and that signature verifies against the message.
 */
import { Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { existsSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signBase64Transaction } from '../dist/signing.js';

const here = dirname(fileURLToPath(import.meta.url));
const sdkDist = resolve(here, '../../packages/sdk/dist/solana/index.cjs');
if (!existsSync(sdkDist)) {
  console.log('⚠️  v1 signing smoke SKIPPED — packages/sdk/dist not built (run `npm run build` in packages/sdk)');
  process.exit(0);
}
const { compileV1 } = createRequire(import.meta.url)(sdkDist);

const kp = Keypair.generate();
const compiled = compileV1({
  payerKey: kp.publicKey,
  recentBlockhash: Keypair.generate().publicKey.toBase58(), // syntactically valid, never lands
  instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })],
  computeUnitLimit: 200_000,
  loadedAccountsDataSizeLimit: 65_536,
});
const unsigned = Buffer.from(compiled.wireBytes);
// A9: the loader refuses loose modes and world-writable dirs — private 0700
// dir, 0600 file, same as smoke-signing.mjs.
const smokeDir = mkdtempSync(join(tmpdir(), 'dfm-smoke-v1-'));
const tmp = join(smokeDir, `kp-${process.pid}.json`);
writeFileSync(tmp, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
try {
  const cfg = { keypairPath: tmp, cluster: 'mainnet-beta', writeEnabled: true };
  const signed = Buffer.from(signBase64Transaction(cfg, unsigned.toString('base64')), 'base64');
  const tx = VersionedTransaction.deserialize(signed);
  const message = signed.subarray(1 + 64 * tx.signatures.length);
  const problems = [];
  if (tx.version !== 1) problems.push(`version ${tx.version} != 1`);
  if (signed.length !== unsigned.length) problems.push(`length ${signed.length} != ${unsigned.length}`);
  if (!message.equals(unsigned.subarray(1 + 64 * tx.signatures.length))) problems.push('message bytes changed');
  if (!nacl.sign.detached.verify(message, tx.signatures[0], kp.publicKey.toBytes())) problems.push('signature does not verify');
  if (problems.length) {
    console.error(`❌ v1 signing smoke FAILED: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('✅ v1 signing smoke OK — v1 wire signed in place, signature verifies, message untouched');
} finally {
  try {
    unlinkSync(tmp);
  } catch {
    /* best-effort */
  }
}
