import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from './config.js';
import { makeIdentityGuard, makeKeyOwnerLookup, makeSessionFetch, onboardingApi } from './onboarding-api.js';
import { avatarPath, buildCreateKeyBody, DEPOSIT_MIN_LAMPORTS, ensureIdentityWallet, fundingNextStep, LAUNCH_MIN_LAMPORTS, loadAvatar, MAX_AVATAR_BYTES, mintAndStoreKey, profileGap, resolveAvatar, runOnboard, storeApiKey } from './onboarding.js';
import { defaultAvatarPng } from './default-avatar.js';

const saved = { p: process.env.DFM_AGENT_KEYPAIR_PATH, a: process.env.DFM_AGENT_AVATAR_PATH, k: process.env.DFM_API_KEY, w: process.env.DFM_ALLOW_WRITE_KEY_MINT };
delete process.env.DFM_API_KEY;
delete process.env.DFM_ALLOW_WRITE_KEY_MINT;
delete process.env.DFM_AGENT_KEYPAIR_PATH;
delete process.env.DFM_AGENT_AVATAR_PATH;
const dir = mkdtempSync(join(tmpdir(), 'dfm-onboard-'));
chmodSync(dir, 0o700);
const pubOf = (c: AgentConfig) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(c.keypairPath as string, 'utf8')))).publicKey.toBase58();
const cfg = (over: Partial<AgentConfig> = {}) => ({ keypairJsonEnvPresent: false, ...over }) as AgentConfig;

// identity_create_then_reuse: created once at the default path (0600), picked up by the running config,
// and a second call REUSES it — never a second keypair.
const def = join(dir, 'agent-wallet.json');
const c1 = cfg();
const created = ensureIdentityWallet(c1, pubOf, def);
assert.equal(created.status, 'created');
assert.equal(c1.keypairPath, def, 'the running MCP now signs in with the new key (no restart)');
assert.equal(statSync(def).mode & 0o777, 0o600);
assert.ok(!JSON.stringify(created).includes('['), 'only the public key is returned');
const before = readFileSync(def, 'utf8');
const again = ensureIdentityWallet(cfg(), pubOf, def);
assert.deepEqual([again.status, again.publicKey], ['reused', created.publicKey]);
assert.equal(readFileSync(def, 'utf8'), before, 'never overwritten');

// identity_reuse_explicit_env: DFM_AGENT_KEYPAIR_PATH wins and nothing is created at the default.
const other = join(dir, 'explicit.json');
writeFileSync(other, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
process.env.DFM_AGENT_KEYPAIR_PATH = other;
const fresh = join(dir, 'never.json');
const viaEnv = ensureIdentityWallet(cfg({ keypairPath: other }), pubOf, fresh);
assert.deepEqual([viaEnv.status, viaEnv.source], ['reused', 'DFM_AGENT_KEYPAIR_PATH']);
assert.throws(() => statSync(fresh));
delete process.env.DFM_AGENT_KEYPAIR_PATH;

// S13 keyless_no_second_identity: with DFM_API_KEY set and no keypair, creating an identity is refused.
process.env.DFM_API_KEY = 'dfm_test';
const keyless = join(dir, 'keyless.json');
assert.throws(() => ensureIdentityWallet(cfg(), pubOf, keyless), /already acts for its owner via DFM_API_KEY/);
assert.throws(() => statSync(keyless));
assert.equal(ensureIdentityWallet(cfg(), pubOf, def).status, 'reused', 'an existing identity is still reused');
delete process.env.DFM_API_KEY;

// S15 both_present_note: JSON env + default file ⇒ the file wins, and the note says so.
const both = ensureIdentityWallet(cfg({ keypairJsonEnvPresent: true }), pubOf, def);
assert.equal(both.source, 'default-path');
assert.match(both.note, /both present; the file wins/);

// identity_file_hardening: a symlinked or loose default file is refused, never followed or rewritten.
const link = join(dir, 'link.json');
symlinkSync(def, link);
assert.throws(() => ensureIdentityWallet(cfg(), pubOf, link), /symlink/);
const loose = join(dir, 'loose.json');
writeFileSync(loose, before, { mode: 0o644 });
chmodSync(loose, 0o644);
assert.throws(() => ensureIdentityWallet(cfg(), pubOf, loose), /readable by other users/);
assert.throws(() => ensureIdentityWallet(cfg(), pubOf, join(dir, 'missing', 'k.json')), /does not exist/);

// avatar_local_checks: real image only, ≤ 2 MB, magic bytes must match the extension, no symlinks.
const png = join(dir, 'avatar.png');
writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]));
assert.equal(avatarPath(dir), png);
assert.deepEqual(loadAvatar(png).mime, 'image/png');
const fake = join(dir, 'fake.jpg');
writeFileSync(fake, 'not an image');
assert.throws(() => loadAvatar(fake), /not the image type/);
const big = join(dir, 'big.gif');
writeFileSync(big, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(MAX_AVATAR_BYTES)]));
assert.throws(() => loadAvatar(big), /larger than 2 MB/);
assert.throws(() => loadAvatar(join(dir, 'agent-wallet.json')), /must be a \.png/);
const dirAsPng = join(dir, 'd.png');
mkdirSync(dirAsPng);
assert.throws(() => loadAvatar(dirAsPng), /regular file/, 'S14 fstat on the opened fd refuses a non-file');
const pngLink = join(dir, 'l.png');
symlinkSync(png, pngLink);
assert.throws(() => loadAvatar(pngLink), /no symlinks/);

// profile_gap mirrors the API gate.
const W = '6VCHVySzyo72GSd4mKhJpiAR2jik3pUeQWLvbvT97iZm';
assert.deepEqual(profileGap(W, { displayName: '6VCH...7iZm', effectiveAvatarUri: null }), ['displayName', 'avatar']);
assert.deepEqual(profileGap(W, { displayName: 'Agent', effectiveAvatarUri: 'https://x/a.webp' }), []);

// S12 create_key_read_only_and_expiring: read-only only unless the OPERATOR opts in; default 30 d, max 90 d.
const NOW = Date.parse('2026-10-19T00:00:00Z');
assert.deepEqual(buildCreateKeyBody({ name: 'bot' }, NOW), { label: 'bot', policy: { readOnly: true }, expiresAt: '2026-11-18T00:00:00.000Z' });
for (const bad of [{ readOnly: false }, { perOpNotionalUsdc: 1 }, { allowArbitraryPrograms: true }, { allowedOps: ['deposit'] }]) {
  assert.throws(() => buildCreateKeyBody({ name: 'bot', ...bad }, NOW), /DFM_ALLOW_WRITE_KEY_MINT=1/);
}
assert.throws(() => buildCreateKeyBody({ name: 'bot', expiresAt: '2027-02-01T00:00:00Z' }, NOW), /at most 90 days/);
assert.throws(() => buildCreateKeyBody({ name: 'bot', expiresAt: '2026-10-01T00:00:00Z' }, NOW), /future/);
process.env.DFM_ALLOW_WRITE_KEY_MINT = '1';
assert.deepEqual(
  buildCreateKeyBody({ name: 'bot', readOnly: false, perOpNotionalUsdc: 25_000_000, allowedOps: ['deposit'], expiresAt: '2026-12-01T00:00:00Z' }, NOW),
  { label: 'bot', policy: { readOnly: false, perOpNotionalUsdc: 25_000_000, allowedOps: ['deposit'] }, expiresAt: '2026-12-01T00:00:00.000Z' },
);
delete process.env.DFM_ALLOW_WRITE_KEY_MINT;

// S12 store_key_never_returned: the plaintext goes to a 0600 file under a 0700 dir and never into the result.
const keysDir = join(dir, 'api-keys');
const stored = storeApiKey('my bot/../x', { key: 'dfm_SECRETSECRETSECRET', keyPrefix: 'dfm_abcd1234', id: 'k1', policy: { readOnly: true } }, keysDir);
assert.equal(JSON.stringify(stored).includes('SECRET'), false, 'the plaintext never enters the chat');
assert.equal(stored.path, join(keysDir, 'my_bot____x-dfm_abcd1234.key'));
assert.equal(readFileSync(String(stored.path), 'utf8'), 'dfm_SECRETSECRETSECRET\n');
assert.equal(statSync(String(stored.path)).mode & 0o777, 0o600);
assert.equal(statSync(keysDir).mode & 0o777, 0o700);
assert.throws(() => storeApiKey('my bot/../x', { key: 'dfm_OTHER', keyPrefix: 'dfm_abcd1234' }, keysDir), /EEXIST/);

// onboard stops at the missing step and never creates an app wallet without a profile.
let walletCalls = 0;
const id = { status: 'reused' as const, publicKey: W, source: 'default-path' as const, note: '' };
const stop = await runOnboard({ identity: () => id, getProfile: async () => ({ wallet: W, displayName: 'Agent' }), createAppWallet: async () => { walletCalls++; return {}; } });
assert.deepEqual([stop.done, stop.missingStep, stop.missing], [false, 'set_profile', ['avatar']]);
assert.equal(walletCalls, 0);
// S13 onboard_identity_mismatch: an API key owned by another wallet stops onboarding before anything is created.
const mismatch = await runOnboard({ identity: () => id, assertSameIdentity: makeIdentityGuard(async () => ({ wallet: Keypair.generate().publicKey.toBase58() }), () => W, () => true), getProfile: async () => ({ wallet: W, displayName: 'Agent', effectiveAvatarUri: 'https://x/a.webp' }), createAppWallet: async () => { walletCalls++; return {}; } });
assert.deepEqual([mismatch.done, mismatch.missingStep, walletCalls], [false, 'identity_mismatch', 0]);
const login = await runOnboard({ identity: () => id, getProfile: async () => { throw new Error('401'); }, createAppWallet: async () => ({}) });
assert.equal(login.missingStep, 'login');
const ok = await runOnboard({ identity: () => id, getProfile: async () => ({ wallet: W, displayName: 'Agent', effectiveAvatarUri: 'https://x/a.webp' }), createAppWallet: async () => { walletCalls++; return { status: 'active' }; } });
assert.deepEqual([ok.done, walletCalls], [true, 1]);

// onboard_prints_funding_step: active but empty app wallet → the next step names the identity pubkey,
// the SOL/USDC the launch preflight enforces, and app_wallet_fund; no fake minimum deposit.
const APPW = 'CcAunB2caCcAunB2caCcAunB2caCcAunB2caCcAunB2c';
const unfunded = await runOnboard({ identity: () => id, getProfile: async () => ({ wallet: W, displayName: 'Agent', effectiveAvatarUri: 'https://x/a.webp' }), createAppWallet: async () => ({ status: 'active' }), getBalance: async () => ({ address: APPW, usdcMicros: 0, solLamports: 0 }), keyless: false, writeEnabled: false });
assert.equal(unfunded.missingStep, 'fund_app_wallet');
const nxt = String(unfunded.next);
for (const must of [W, APPW, 'app_wallet_fund {usdc, sol}', '0.0381', '0.02 per deposit', 'DFM_AGENT_WRITE_ENABLED=true', 'no API key is needed']) assert.ok(nxt.includes(must), `next mentions ${must}`);
assert.ok(!/\$12|12 USDC/.test(nxt), 'no invented minimum deposit');
const funded = await runOnboard({ identity: () => id, getProfile: async () => ({ wallet: W, displayName: 'Agent', effectiveAvatarUri: 'https://x/a.webp' }), createAppWallet: async () => ({ status: 'active' }), getBalance: async () => ({ address: APPW, usdcMicros: 20_000_000, solLamports: LAUNCH_MIN_LAMPORTS + DEPOSIT_MIN_LAMPORTS }) });
assert.equal(funded.missingStep, undefined);
assert.match(String(funded.next), /launch_vault/);
const keylessStep = fundingNextStep({ identityPubkey: null, appWallet: APPW, usdcMicros: 0, solLamports: 0, keyless: true, writeEnabled: true });
assert.ok(keylessStep?.includes('app.dfm.finance/account') && !keylessStep.includes('app_wallet_fund {usdc'), 'keyless: the human funds in the app');
assert.equal(fundingNextStep({ identityPubkey: W, appWallet: APPW, usdcMicros: 100_000, solLamports: 1e9, keyless: false, writeEnabled: true }), fundingNextStep({ identityPubkey: W, appWallet: APPW, usdcMicros: 100_000, solLamports: 1e9, keyless: false, writeEnabled: true }));
assert.notEqual(fundingNextStep({ identityPubkey: W, appWallet: APPW, usdcMicros: 100_000, solLamports: 1e9, keyless: false, writeEnabled: true }), null, 'seed alone leaves nothing to deposit');

// set_profile_default_avatar: no operator file → the generated identicon PNG, flagged default;
// an operator file still wins.
const defAv = resolveAvatar(W, null);
assert.deepEqual([defAv.isDefault, defAv.filename, defAv.mime], [true, 'avatar.png', 'image/png']);
assert.ok(defAv.bytes.equals(defaultAvatarPng(W)));
const opAv = resolveAvatar(W, png);
assert.deepEqual([opAv.isDefault, opAv.mime], [false, 'image/png']);
assert.ok(!opAv.bytes.equals(defAv.bytes), 'the operator image wins');

// session_lane_calls: profile/avatar/key calls go over the SIWS Bearer token (never a dfm_ key),
// re-auth once on 401, carry an idempotency key on writes; the key body passes caps + expiresAt.
const seen: Array<{ url: string; init: RequestInit }> = [];
let tokens = 0;
let first401 = true;
const fakeFetch = (async (url: string, init: RequestInit) => {
  seen.push({ url, init });
  if (first401) { first401 = false; return new Response('expired', { status: 401 }); }
  return new Response(JSON.stringify({ key: 'dfm_x', id: '1' }), { status: 200 });
}) as unknown as typeof fetch;
const oapi = onboardingApi(makeSessionFetch({ apiUrl: 'https://api.test/api/v2' }, { getAccessToken: async () => `t${++tokens}` }, fakeFetch));
const keyBody = buildCreateKeyBody({ name: 'bot' });
const issued = await oapi.createApiKey(keyBody);
assert.equal(issued.key, 'dfm_x');
assert.equal(seen.length, 2, 'one transparent re-auth on 401');
const last = seen[1];
const h = last.init.headers as Record<string, string>;
assert.equal(last.url, 'https://api.test/api/v2/agent/keys');
assert.deepEqual([h.Authorization, h['Content-Type'], typeof h['X-Idempotency-Key'], 'X-DFM-Key' in h], ['Bearer t2', 'application/json', 'string', false]);
assert.deepEqual(JSON.parse(String(last.init.body)), keyBody);
await oapi.uploadAvatar(Buffer.from([1, 2, 3]), 'avatar.png', 'image/png');
const up = seen[2];
assert.ok(up.init.body instanceof FormData, 'avatar is multipart');
assert.equal('Content-Type' in (up.init.headers as Record<string, string>), false, 'fetch sets the multipart boundary');

// S16 identity_guard_fails_closed: unknown owner (no app wallet yet ⇒ null) or an error refuses; only an exact match passes.
for (const owner of [async () => null, async () => ({}), async () => ({ wallet: null }), async () => { throw new Error('503'); }]) {
  const g = makeIdentityGuard(owner as never, () => W, () => true);
  await assert.rejects(g(), /cannot verify whose DFM_API_KEY/);
}
await assert.rejects(makeIdentityGuard(async () => ({ wallet: 'Other111' }), () => W, () => true)(), /belongs to Other111/);
let ownerCalls = 0;
const good = makeIdentityGuard(async () => { ownerCalls++; return { wallet: W }; }, () => W, () => true);
await good();
await good();
assert.equal(ownerCalls, 1, 'a passing check is cached per process');
let noKeyCalls = 0;
await makeIdentityGuard(async () => { noKeyCalls++; return null; }, () => W, () => false)();
assert.equal(noKeyCalls, 0, 'no DFM_API_KEY ⇒ nothing to check');
// keyless onboard with an unknown owner stops (fail closed), never reaching the app wallet.
const unknown = await runOnboard({ identity: () => id, assertSameIdentity: makeIdentityGuard(async () => ({ wallet: null }), () => W, () => true), getProfile: async () => ({ wallet: W, displayName: 'Agent', effectiveAvatarUri: 'https://x/a.webp' }), createAppWallet: async () => { walletCalls++; return {}; } });
assert.deepEqual([unknown.missingStep, walletCalls], ['identity_mismatch', 1]);

// S17 session_lane_guarded: every session call runs the identity guard first; a mismatch sends nothing.
let sent17 = 0;
const guarded = onboardingApi(makeSessionFetch({ apiUrl: 'https://api.test' }, { getAccessToken: async () => 't' },
  (async () => { sent17++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
  makeIdentityGuard(async () => ({ wallet: 'Other111' }), () => W, () => true)));
await assert.rejects(guarded.updateProfile({ displayName: 'x' }), /belongs to Other111/);
await assert.rejects(guarded.createApiKey({}), /belongs to Other111/);
assert.equal(sent17, 0);

// S18 key_store_preflight_and_revoke: a bad store dir refuses BEFORE minting; a failed write after the mint revokes.
let mints = 0;
const revoked: string[] = [];
const keyApi = {
  createApiKey: async () => { mints++; return { key: 'dfm_LIVEKEYLIVEKEY', keyPrefix: 'dfm_live1234', id: 'k9' }; },
  revokeApiKey: async (kid: string) => { revoked.push(kid); return {}; },
};
const looseDir = join(dir, 'loose-keys');
mkdirSync(looseDir);
chmodSync(looseDir, 0o777);
await assert.rejects(mintAndStoreKey({ name: 'bot' }, keyApi, looseDir), /writable by other users/);
assert.equal(mints, 0, 'nothing minted when the store is unsafe');
const okDir = join(dir, 'keys-ok');
writeFileSync(join(dir, 'placeholder'), '');
mkdirSync(okDir, { mode: 0o700 });
writeFileSync(join(okDir, 'bot-dfm_live1234.key'), 'taken', { mode: 0o600 });
await assert.rejects(mintAndStoreKey({ name: 'bot' }, keyApi, okDir), /was revoked, nothing is left live/);
assert.deepEqual([mints, revoked], [1, ['k9']]);

// S19 guard_uses_key_owner_route: the lookup hits agent-wallet/owner with X-DFM-Key (never a Bearer),
// and a non-2xx (e.g. a route without key support) makes the guard refuse.
const lookups: Array<{ url: string; init: RequestInit }> = [];
const lookup = makeKeyOwnerLookup({ apiUrl: 'https://api.test/api/v2' }, () => 'dfm_ro', (async (url: string, init: RequestInit) => {
  lookups.push({ url, init });
  return new Response(JSON.stringify({ wallet: W }), { status: 200 });
}) as unknown as typeof fetch);
await makeIdentityGuard(lookup, () => W, () => true)();
const lh = lookups[0].init.headers as Record<string, string>;
assert.equal(lookups[0].url, 'https://api.test/api/v2/agent/operating/embedded/agent-wallet/owner');
assert.deepEqual([lh['X-DFM-Key'], 'Authorization' in lh, lookups[0].init.method], ['dfm_ro', false, 'GET']);
const down = makeKeyOwnerLookup({ apiUrl: 'https://api.test' }, () => 'dfm_ro', (async () => new Response('x', { status: 503 })) as unknown as typeof fetch);
await assert.rejects(makeIdentityGuard(down, () => W, () => true)(), /cannot verify whose DFM_API_KEY.*503/);

if (saved.p) process.env.DFM_AGENT_KEYPAIR_PATH = saved.p;
if (saved.a) process.env.DFM_AGENT_AVATAR_PATH = saved.a;
if (saved.k) process.env.DFM_API_KEY = saved.k;
if (saved.w) process.env.DFM_ALLOW_WRITE_KEY_MINT = saved.w;
console.log('onboarding: ok');

// Owner-signed actions run in the same `npm test` step (package.json is claimed by another agent; move to its own entry when free).
await import('./owner-actions.test.js');
