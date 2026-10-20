import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson,
  checkSignerRequest,
  DFM_PRIVY_APP_ID,
  DFM_PRIVY_SIGNER_QUORUM_ID,
  loadOrCreateOwnerKey,
  POLICY_UPDATE_NOTICE,
  policyUpdateNotice,
  runCreateAppWallet,
  type SignerRequest,
} from './app-wallet-owner.js';

delete process.env.DFM_PRIVY_SIGNER_QUORUM_ID;
delete process.env.DFM_PRIVY_APP_ID;
const dir = mkdtempSync(join(tmpdir(), 'dfm-owner-key-'));
chmodSync(dir, 0o700);
const path = join(dir, 'app-wallet-owner.pem');

// 1. Created once, mode 0600, P-256; reused (never overwritten) on the next load.
const a = loadOrCreateOwnerKey(path);
assert.equal(a.created, true);
assert.equal(statSync(path).mode & 0o777, 0o600);
const pemBefore = readFileSync(path, 'utf8');
const pub = createPublicKey({ key: Buffer.from(a.publicKey, 'base64'), format: 'der', type: 'spki' });
assert.equal(pub.asymmetricKeyDetails?.namedCurve, 'prime256v1');
const b = loadOrCreateOwnerKey(path);
assert.equal(b.created, false);
assert.equal(b.publicKey, a.publicKey);
assert.equal(readFileSync(path, 'utf8'), pemBefore, 'an existing owner key is never rewritten');
assert.ok(!JSON.stringify(a).includes('PRIVATE KEY'), 'the key object exposes no private material');

// 2. S5 key_file_hardening: loose perms, symlinked file, symlinked dir, missing nested dir — all refused.
const loose = join(dir, 'loose.pem');
writeFileSync(loose, pemBefore, { mode: 0o644 });
chmodSync(loose, 0o644);
assert.throws(() => loadOrCreateOwnerKey(loose), /readable by other users/);
const linkFile = join(dir, 'link.pem');
symlinkSync(path, linkFile);
assert.throws(() => loadOrCreateOwnerKey(linkFile), /symlink/);
const realDir = join(dir, 'real');
mkdirSync(realDir, { mode: 0o700 });
const linkDir = join(dir, 'linkdir');
symlinkSync(realDir, linkDir);
assert.throws(() => loadOrCreateOwnerKey(join(linkDir, 'k.pem')), /symlink/);
assert.throws(() => loadOrCreateOwnerKey(join(dir, 'no', 'such', 'k.pem')), /does not exist/);
const openDir = join(dir, 'open');
mkdirSync(openDir);
chmodSync(openDir, 0o777);
assert.throws(() => loadOrCreateOwnerKey(join(openDir, 'k.pem')), /writable by other users/);

// 3. The payload is rebuilt locally; same vector shape as the API spec (expiry included).
const now = Date.now();
const expiry = String(now + 5 * 60 * 1000);
const mkReq = (over: Partial<{ signer: string; policy: string; appId: string; expiry: string }> = {}): SignerRequest => {
  const body = { additional_signers: [{ signer_id: over.signer ?? DFM_PRIVY_SIGNER_QUORUM_ID, override_policy_ids: [over.policy ?? 'pol-agent-1'] }] };
  const headers = { 'privy-app-id': over.appId ?? DFM_PRIVY_APP_ID, 'privy-request-expiry': over.expiry ?? expiry };
  const url = 'https://api.privy.io/v1/wallets/w-agent-1';
  return { method: 'PATCH', url, body, headers, payload: canonicalJson({ version: 1, method: 'PATCH', url, body, headers }) };
};
const req = mkReq();
const ids = { walletId: 'w-agent-1', policyId: 'pol-agent-1' };
assert.equal(
  req.payload,
  '{"body":{"additional_signers":[{"override_policy_ids":["pol-agent-1"],"signer_id":"elhpm1tlfxhqimb397m9opg8"}]},' +
    `"headers":{"privy-app-id":"cmrgqda8l00yo0cl9j49ye64k","privy-request-expiry":"${expiry}"},"method":"PATCH","url":"https://api.privy.io/v1/wallets/w-agent-1","version":1}`,
);
assert.equal(checkSignerRequest(req, ids, now), req.payload);

// S1 pinned_signer_and_app: a compromised server that names its OWN signer (consistently, in step AND
// request) or another Privy app is refused — the check is against the pins, not the server's answer.
assert.throws(() => checkSignerRequest(mkReq({ signer: 'insider-quorum' }), ids, now), /refusing to sign/);
assert.throws(() => checkSignerRequest(mkReq({ appId: 'other-app' }), ids, now), /refusing to sign/);
process.env.DFM_PRIVY_SIGNER_QUORUM_ID = 'local-override';
assert.equal(checkSignerRequest(mkReq({ signer: 'local-override' }), ids, now), mkReq({ signer: 'local-override' }).payload);
delete process.env.DFM_PRIVY_SIGNER_QUORUM_ID;

// S4 expiry bounds: past, or more than 10 minutes ahead, or non-numeric → refused.
for (const e of [String(now - 1), String(now + 11 * 60 * 1000), 'soon']) {
  assert.throws(() => checkSignerRequest(mkReq({ expiry: e }), ids, now), /refusing to sign/);
}

// S10 exact_shape: extra fields anywhere, two entries, two policies, missing expiry header → refused.
const entry = req.body.additional_signers[0];
for (const bad of [
  { ...req, body: { additional_signers: [entry, { ...entry }] } },
  { ...req, body: { additional_signers: [{ ...entry, override_policy_ids: ['pol-agent-1', 'pol-x'] }] } },
  { ...req, body: { additional_signers: [{ ...entry, extra: true }] } },
  { ...req, body: { ...req.body, owner: { public_key: 'attacker' } } },
  { ...req, headers: { 'privy-app-id': DFM_PRIVY_APP_ID } },
  { ...req, headers: { ...req.headers, 'privy-idempotency-key': 'x' } },
  { ...req, extra: 1 },
  { ...req, url: 'https://api.privy.io/v1/wallets/other' },
  { ...req, method: 'POST' },
  { ...req, payload: req.payload.replace('pol-agent-1', 'pol-x') },
]) {
  assert.throws(() => checkSignerRequest(bad as SignerRequest, ids, now), /refusing to sign/);
}
assert.throws(() => checkSignerRequest(req, { ...ids, policyId: 'pol-other' }, now), /refusing to sign/);

// 4. End-to-end flow: only the PUBLIC key goes out; the signature verifies over the payload.
const sent: string[] = [];
const appWallet = { operatingWalletAddress: 'B7Zd', status: 'active' };
const res = await runCreateAppWallet(
  {
    beginAgentAppWallet: async (k) => {
      sent.push(k);
      return { status: 'awaiting_owner_signature', walletId: 'w-agent-1', address: 'B7Zd', signerId: DFM_PRIVY_SIGNER_QUORUM_ID, policyId: 'pol-agent-1', request: mkReq({ expiry: String(Date.now() + 60_000) }) };
    },
    confirmAgentAppWallet: async (k, sig) => {
      sent.push(k, sig);
      return { status: 'active', created: true, appWallet };
    },
  },
  path,
);
assert.equal(res.status, 'active');
assert.deepEqual(res.appWallet, appWallet);
assert.ok(sent.every((s) => !s.includes('PRIVATE')), 'nothing sent carries the private key');
assert.equal(sent[0], a.publicKey);

// Signature check over the exact payload.
const sig = a.sign(req.payload);
assert.ok(verify('sha256', Buffer.from(req.payload), pub, Buffer.from(sig, 'base64')), 'owner signature verifies');

// 5. Already active: no signature is produced at all.
let confirmed = false;
await runCreateAppWallet(
  {
    beginAgentAppWallet: async () => ({ status: 'active', created: false, appWallet }),
    confirmAgentAppWallet: async () => { confirmed = true; return { status: 'active', created: false, appWallet }; },
  },
  path,
);
assert.equal(confirmed, false);

// 6. S3(a) policy_update_notice: app_wallet/whoami surface a pending reissue; nothing otherwise.
assert.deepEqual(policyUpdateNotice({ policyUpdateRequired: true }), { policyUpdate: POLICY_UPDATE_NOTICE });
assert.match(POLICY_UPDATE_NOTICE, /run create_app_wallet to approve/);
for (const op of [null, undefined, {}, { policyUpdateRequired: false }, { policyUpdateRequired: 'true' }]) {
  assert.deepEqual(policyUpdateNotice(op as never), {});
}

console.log('app-wallet-owner: ok');
