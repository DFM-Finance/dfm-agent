/**
 * Per-request context (spec 011 T5, CA-3.1, 3.3, 2.6, 4.5, 4.10; qa B4).
 * Runnable: `npx tsx src/context.test.ts`.
 *
 * The credential travels on an explicit context, never through `process.env`.
 * Two callers with two keys inside ONE server instance must not see each other.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { DfmApiClient } from './api-client.js';
import { SiwsSession } from './session.js';
import { loadConfig, resolveKeypairPath, type AgentConfig } from './config.js';
import { isKeylessMode } from './keyless.js';
import { getTestWalletPubkey, loadTestKeypair, signBase64Transaction, signSiwsMessage } from './signing.js';
import { confirmGate, writeGate } from './gates.js';
import {
  enterSharedLane,
  envCredentials,
  processKeypairStore,
  requestCredentials,
  requestScope,
  resetSharedLaneForTests,
  stdioContext,
  type CredentialSource,
  type RequestContext,
} from './context.js';

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

const creds = (o: { apiKey?: string; keypairPath?: string; keypairJson?: string }): CredentialSource => ({
  apiKey: () => o.apiKey,
  keypairPath: () => o.keypairPath,
  keypairJson: () => o.keypairJson,
});

/** process.env that throws on any write: proves the context path never mutates it. */
function withFrozenEnv<T>(fn: () => Promise<T>): Promise<T> {
  const real = process.env;
  process.env = new Proxy(real, {
    set(_t, k) { throw new Error(`process.env write: ${String(k)}`); },
    deleteProperty(_t, k) { throw new Error(`process.env delete: ${String(k)}`); },
  });
  return fn().finally(() => { process.env = real; });
}

const config: AgentConfig = { apiUrl: 'https://ctx.invalid/api/v2', cluster: 'mainnet-beta', keypairJsonEnvPresent: false, writeEnabled: true };

await t('two callers with two keys in ONE instance never cross, even with the first one slower', async () => {
  const seen: Array<{ key: string | undefined; path: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const key = (init?.headers as Record<string, string>)?.['X-DFM-Key'];
    seen.push({ key, path: String(url) });
    await new Promise((r) => setTimeout(r, key === 'dfm_AAAA' ? 40 : 1));
    return new Response(JSON.stringify({ who: key }), { status: 200 });
  }) as typeof fetch;
  try {
    await withFrozenEnv(async () => {
      const base = new DfmApiClient(config, new SiwsSession(config));
      const a = base.forRequest(creds({ apiKey: 'dfm_AAAA' }));
      const b = base.forRequest(creds({ apiKey: 'dfm_BBBB' }));
      const [ra, rb] = await Promise.all([a.getPortfolioPositions(), b.getPortfolioPositions()]);
      assert.deepEqual(ra, { who: 'dfm_AAAA' });
      assert.deepEqual(rb, { who: 'dfm_BBBB' });
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen.map((s) => s.key).sort(), ['dfm_AAAA', 'dfm_BBBB']);
});

await t('the default client still reads the key from the environment, in the same place as before', async () => {
  const realFetch = globalThis.fetch;
  let sent: string | undefined;
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    sent = (init?.headers as Record<string, string>)['X-DFM-Key'];
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  process.env.DFM_API_KEY = ' dfm_ENV1 ';
  try {
    await new DfmApiClient(config, new SiwsSession(config)).getPortfolioPositions();
    assert.equal(sent, 'dfm_ENV1');
  } finally {
    delete process.env.DFM_API_KEY;
    globalThis.fetch = realFetch;
  }
});

await t('keyless mode is decided from the context credentials, not from the process env', async () => {
  await withFrozenEnv(async () => {
    assert.equal(isKeylessMode(config, creds({ apiKey: 'dfm_X' })), true);
    assert.equal(isKeylessMode(config, creds({ apiKey: 'dfm_X', keypairPath: '/k.json' })), false);
    assert.equal(isKeylessMode(config, creds({ apiKey: 'dfm_X', keypairJson: '[1]' })), false);
    assert.equal(isKeylessMode(config, creds({})), false);
  });
});

const ONLY_DFM_KEY = /this server only accepts a dfm_ key/;

/** A host that CAN sign in (throwaway key in its env) and a fetch that records what a request really sent. */
function hostWithSignIn() {
  const hostKp = Keypair.generate();
  process.env.DFM_AGENT_KEYPAIR_JSON = JSON.stringify([...hostKp.secretKey]);
  const hostConfig: AgentConfig = { ...config, keypairJsonEnvPresent: true };
  const sent: Array<{ path: string; headers: Record<string, string> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(config.apiUrl, '');
    sent.push({ path, headers: (init?.headers ?? {}) as Record<string, string> });
    if (path === '/auth/nonce') return new Response(JSON.stringify({ message: 'host sign-in' }), { status: 200 });
    if (path === '/auth/siws') return new Response(JSON.stringify({ accessToken: 'HOST-TOKEN', expiresIn: '1h' }), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { hostKp, hostConfig, sent, restore: () => { globalThis.fetch = realFetch; delete process.env.DFM_AGENT_KEYPAIR_JSON; } };
}

await t('forRequest never signs in with the host keypair', async () => {
  const h = hostWithSignIn();
  try {
    const base = new DfmApiClient(h.hostConfig, new SiwsSession(h.hostConfig));
    // Scenario A: a caller with no credential must not ride the host token.
    await assert.rejects(base.forRequest(creds({})).getPortfolioPositions(), ONLY_DFM_KEY);
    // Scenario B: a caller's dfm_ key on a session-only route must not sign in as the host.
    await assert.rejects(base.forRequest(creds({ apiKey: 'dfm_CALLER' })).beginAgentAppWallet('owner-pub'), ONLY_DFM_KEY);
    assert.deepEqual(h.sent.filter((s) => s.path.startsWith('/auth/')), [], 'a request signed in (nonce/siws) as the host');
    assert.ok(h.sent.every((s) => !JSON.stringify(s.headers).includes('HOST-TOKEN')), 'the host token was sent');
    assert.equal(h.sent.length, 0, 'a refused request still reached the network');
  } finally {
    h.restore();
  }
});

await t('a request scope never loads DFM_AGENT_KEYPAIR_PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-host-'));
  const hostKey = join(dir, 'host.json');
  writeFileSync(hostKey, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  const hostConfig: AgentConfig = { ...config, keypairPath: hostKey };
  process.env.DFM_AGENT_KEYPAIR_PATH = hostKey;
  try {
    assert.throws(() => loadTestKeypair(hostConfig, requestScope), ONLY_DFM_KEY);
    assert.throws(() => signSiwsMessage(hostConfig, 'm', requestScope), ONLY_DFM_KEY);
    assert.throws(() => signBase64Transaction(hostConfig, 'AA==', requestScope), ONLY_DFM_KEY);
    assert.equal(processKeypairStore.get(), null, 'the host key leaked into the process cache');
  } finally {
    delete process.env.DFM_AGENT_KEYPAIR_PATH;
  }
});

await t('request credentials hold only a dfm_ key, never a keypair', () => {
  const c = requestCredentials(' dfm_ok ');
  assert.equal(c.apiKey(), 'dfm_ok');
  assert.equal(c.keypairPath(), undefined);
  assert.equal(c.keypairJson(), undefined);
  assert.throws(() => requestCredentials('not-a-dfm-key'), ONLY_DFM_KEY);
  assert.throws(() => requestCredentials(undefined), ONLY_DFM_KEY);
  assert.throws(() => requestCredentials('[1,2,3]'), ONLY_DFM_KEY);
});

await t('forRequest strips a keypair a credential source offers (a shared lane never signs for a caller)', async () => {
  const h = hostWithSignIn();
  try {
    const base = new DfmApiClient(h.hostConfig, new SiwsSession(h.hostConfig));
    const smuggled = creds({ apiKey: 'dfm_K', keypairJson: JSON.stringify([...Keypair.generate().secretKey]), keypairPath: '/x.json' });
    await assert.rejects(base.forRequest(smuggled).beginAgentAppWallet('owner-pub'), ONLY_DFM_KEY);
  } finally {
    h.restore();
  }
});

await t('shared lane: the host defaults (env credentials, host keypair, stdio context) throw once it is entered', async () => {
  const hostKp = Keypair.generate();
  process.env.DFM_AGENT_KEYPAIR_JSON = JSON.stringify([...hostKp.secretKey]);
  const hostConfig: AgentConfig = { ...config, keypairJsonEnvPresent: true };
  enterSharedLane();
  try {
    const SHARED = /shared lane/;
    assert.throws(() => new DfmApiClient(hostConfig, new SiwsSession(hostConfig)), SHARED);
    assert.throws(() => loadTestKeypair(hostConfig), SHARED);
    assert.throws(() => signSiwsMessage(hostConfig, 'm'), SHARED);
    assert.throws(() => getTestWalletPubkey(hostConfig), SHARED);
    assert.throws(() => isKeylessMode(hostConfig), SHARED);
    assert.throws(() => stdioContext(hostConfig), SHARED);
    // An explicit request client is the way in, and it works.
    assert.doesNotThrow(() => new DfmApiClient(hostConfig, null, requestCredentials('dfm_k')));
  } finally {
    resetSharedLaneForTests();
    delete process.env.DFM_AGENT_KEYPAIR_JSON;
  }
  assert.doesNotThrow(() => stdioContext(config), 'the reset must restore stdio');
});

await t('stdio keeps its process-lifetime cache: the default scope fills processKeypairStore', () => {
  const kp = Keypair.generate();
  process.env.DFM_AGENT_KEYPAIR_JSON = JSON.stringify([...kp.secretKey]);
  try {
    const c = { ...config, keypairJsonEnvPresent: true };
    assert.equal(loadTestKeypair(c).publicKey.toBase58(), kp.publicKey.toBase58());
    assert.equal(processKeypairStore.get()?.publicKey.toBase58(), kp.publicKey.toBase58());
  } finally {
    delete process.env.DFM_AGENT_KEYPAIR_JSON;
  }
});

await t('the Next lane config never resolves the default keypair file; stdio still does', () => {
  const exists = () => true;
  assert.equal(resolveKeypairPath(undefined, true, exists), undefined);
  assert.equal(resolveKeypairPath('  ', true, exists), undefined);
  assert.equal(resolveKeypairPath('/own.json', true, exists), '/own.json');
  assert.ok(resolveKeypairPath(undefined, false, exists)?.endsWith('agent-wallet.json'));
  assert.equal(resolveKeypairPath(undefined, false, () => false), undefined);
  assert.equal(loadConfig({ noDefaultKeypair: true }).keypairPath, process.env.DFM_AGENT_KEYPAIR_PATH || undefined);
});

await t('gates take the lane context: one lane off, another on, same process', () => {
  const on = { ...stdioContext(config), writeEnabled: true } as RequestContext;
  const off = { ...stdioContext(config), writeEnabled: false } as RequestContext;
  assert.equal(writeGate(on).ok, true);
  const refused = writeGate(off);
  assert.equal(refused.ok, false);
  assert.match((refused as { result: { content: Array<{ text: string }> } }).result.content[0].text, /^WRITE is disabled\./);
  const strict = { ...on, gates: { nonInteractive: () => false, confirmRequired: () => true } } as RequestContext;
  assert.equal(confirmGate(strict, 'deposit', undefined).ok, false);
  assert.equal(confirmGate(strict, 'deposit', 'deposit').ok, true);
  assert.equal(confirmGate(strict, 'app_wallet_rearm', 'rearm_app_wallet', 'rearm_app_wallet').ok, true);
  assert.equal(confirmGate({ ...strict, gates: { nonInteractive: () => true, confirmRequired: () => true } } as RequestContext, 'deposit', undefined).ok, true);
  assert.equal(confirmGate(on, 'deposit', undefined).ok, true, 'default: no phrase needed');
});

await t('envCredentials reads the env at call time and returns what the old code read', () => {
  process.env.DFM_API_KEY = ' dfm_Z ';
  process.env.DFM_AGENT_KEYPAIR_PATH = ' /p.json ';
  try {
    assert.equal(envCredentials.apiKey(), 'dfm_Z');
    assert.equal(envCredentials.keypairPath(), '/p.json');
  } finally {
    delete process.env.DFM_API_KEY;
    delete process.env.DFM_AGENT_KEYPAIR_PATH;
  }
  assert.ok(!envCredentials.apiKey());
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\ncontext: all green');
