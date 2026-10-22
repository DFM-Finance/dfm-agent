/**
 * MONEY-PATH regressions (runnable: `npx tsx agent/src/money-path.test.ts`).
 *
 * `signing.ts`, `keyless.ts` and `api-client.ts` decide how real money moves and
 * had NO tests. These three lock the parts where being wrong is expensive and
 * silent — each one is a bug that has already happened or was one retry away:
 *
 *   1. `isVersionedTxBytes` — the hand-rolled wire-format sniff that picks
 *      `sign()` vs `partialSign()`. Guessing wrong yields "Transaction did not
 *      pass signature verification" at BROADCAST time, long after the code that
 *      caused it. Both branches are exercised against real byte layouts.
 *   2. "an explicit keypair beats an API key" — recorded in keyless.ts as a past
 *      production bug: keying the decision off `config.keypairPath` meant a
 *      stray default-path file silently hijacked writes on a machine set up with
 *      an API key.
 *   3. The idempotency key is STABLE across a retry of the same terminal write
 *      (and DIFFERENT for a different one). A fresh UUID per retry defeats the
 *      server's replay cache entirely — that is how a retried launch_vault paid
 *      the 1 USDC creation fee twice on mainnet.
 *   4. The keyless `/agent/operating/execute` pins its key DETERMINISTICALLY to
 *      tool + canonical args (A7), so a retry after a lost response names the
 *      same operation — and a reordered args object hashes identically.
 *   5. The keypair file is hardened before it is read (A9): loose modes,
 *      symlinks (file or directory), and foreign owners are refused; only a
 *      0600 file in a 0700 dir owned by the process uid loads.
 *
 * No network, no RPC: byte fixtures, a stub fetch, and mkdtemp'd 0700 dirs.
 * The one keypair touched is generated in-memory and never leaves the test.
 */
import { isVersionedTxBytes, loadTestKeypair } from './signing.js';
import { isKeylessMode, hasExplicitKeypair } from './keyless.js';
import { DfmApiClient } from './api-client.js';
import type { AgentConfig } from './config.js';
import type { SiwsSession } from './session.js';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failures++;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

// ── 1. isVersionedTxBytes ────────────────────────────────────────────────
console.log('case: isVersionedTxBytes routes v0 vs legacy on real byte layouts');
{
  // Wire layout: compact-u16 signature count, then `count` × 64 signature bytes,
  // then the message. The message's FIRST byte is the discriminator — high bit
  // set = versioned (0x80 | version), clear = legacy (numRequiredSignatures).
  const tx = (sigCountPrefix: number[], sigs: number, firstMsgByte: number): Buffer =>
    Buffer.concat([
      Buffer.from(sigCountPrefix),
      Buffer.alloc(sigs * 64),
      Buffer.from([firstMsgByte, 0x01, 0x00, 0x01]),
    ]);

  assert(isVersionedTxBytes(tx([1], 1, 0x80)) === true, 'v0 (1 sig, 0x80) → versioned');
  assert(
    isVersionedTxBytes(tx([1], 1, 0x01)) === false,
    'legacy (1 sig, numRequiredSignatures=1) → legacy',
  );
  // The manager endpoints (assets/prepare, transfer-admin) return legacy txs the
  // API has ALREADY partially signed — 2 signature slots, still legacy.
  assert(isVersionedTxBytes(tx([2], 2, 0x02)) === false, 'legacy with 2 sig slots → legacy');
  // An UNSIGNED prepare can carry a zero signature count; the discriminator is
  // then the very next byte and the loop must not skip past it.
  assert(isVersionedTxBytes(tx([0], 0, 0x80)) === true, '0 sigs + 0x80 → versioned');
  assert(isVersionedTxBytes(tx([0], 0, 0x01)) === false, '0 sigs + 0x01 → legacy');
  // Multi-byte compact-u16: 0x80,0x01 = 128. Mis-decoding the continuation bit
  // would land the offset 8KB away from the real discriminator.
  assert(
    isVersionedTxBytes(tx([0x80, 0x01], 128, 0x80)) === true,
    'multi-byte compact-u16 sig count (128) still finds the discriminator',
  );

  // Truncated input must THROW, never guess — a wrong guess signs the wrong way.
  let threw = false;
  try {
    isVersionedTxBytes(Buffer.from([0x01, 0x00]));
  } catch {
    threw = true;
  }
  assert(threw, 'truncated bytes throw instead of returning a guess');
}

// ── 2. an explicit keypair beats an API key ──────────────────────────────
console.log('case: an EXPLICIT keypair always wins over DFM_API_KEY');
{
  const env = { ...process.env };
  const reset = (): void => {
    delete process.env.DFM_API_KEY;
    delete process.env.DFM_AGENT_KEYPAIR_PATH;
    delete process.env.DFM_AGENT_KEYPAIR_JSON;
  };
  // `config.keypairPath` is populated from a DEFAULT path when that file merely
  // exists — the exact field the old bug keyed off. Keyless must ignore it.
  const cfgWithDefaultKeypair = {
    keypairPath: '/home/someone/.config/dfm/agent-wallet.json',
    keypairJsonEnvPresent: false,
  } as unknown as AgentConfig;

  reset();
  process.env.DFM_API_KEY = 'dfm_test_key_value';
  assert(hasExplicitKeypair() === false, 'no keypair env var → no explicit keypair');
  assert(
    isKeylessMode(cfgWithDefaultKeypair) === true,
    'API key + only a DEFAULT-PATH keypair file → KEYLESS (the fixed bug)',
  );

  process.env.DFM_AGENT_KEYPAIR_PATH = '/tmp/explicit-wallet.json';
  assert(hasExplicitKeypair() === true, 'DFM_AGENT_KEYPAIR_PATH → explicit keypair');
  assert(
    isKeylessMode(cfgWithDefaultKeypair) === false,
    'API key + EXPLICIT keypair → local signing wins (never keyless)',
  );

  delete process.env.DFM_AGENT_KEYPAIR_PATH;
  process.env.DFM_AGENT_KEYPAIR_JSON = '[1,2,3]';
  assert(
    isKeylessMode(cfgWithDefaultKeypair) === false,
    'API key + EXPLICIT inline keypair JSON → local signing wins',
  );

  reset();
  assert(isKeylessMode(cfgWithDefaultKeypair) === false, 'no API key → never keyless');
  process.env = env;
}

// ── 3. the idempotency key is stable across a retry ──────────────────────
console.log('case: X-Idempotency-Key is STABLE across a retry of the same write');
{
  const sent: Array<{ path: string; key?: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ path: String(url), key: headers['X-Idempotency-Key'] });
    return new Response(JSON.stringify({ signature: 'sig', confirmed: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const prevKey = process.env.DFM_API_KEY;
  process.env.DFM_API_KEY = 'dfm_test_key_value';
  const api = new DfmApiClient(
    { apiUrl: 'https://api.test' } as unknown as AgentConfig,
    {} as unknown as SiwsSession,
  );

  const VAULT = 'Vau1t1111111111111111111111111111111111111';
  const SIG = '5'.repeat(88);

  await api.submitSignedTx('prepared-tx-abc', 'AAAA');
  await api.submitSignedTx('prepared-tx-abc', 'AAAA'); // the RETRY
  await api.submitSignedTx('prepared-tx-xyz', 'AAAA'); // a DIFFERENT tx
  assert(
    sent[0]!.key !== undefined && sent[0]!.key === sent[1]!.key,
    '/tx/submit retry reuses the SAME key (the server can dedupe the broadcast)',
  );
  assert(
    sent[2]!.key !== sent[0]!.key,
    '/tx/submit for a DIFFERENT preparedTxId gets a DIFFERENT key',
  );

  sent.length = 0;
  await api.confirmCreateVault(SIG, VAULT);
  await api.confirmCreateVault(SIG, VAULT); // the RETRY
  assert(sent[0]!.key === sent[1]!.key, 'create/confirm retry reuses the SAME key');

  // Endpoint prefixes matter: the server's Redis key is `idempotency:<caller>:<key>`
  // with NO path component, so two routes keyed on the same signature would
  // replay each other's cached response.
  const createKey = sent[0]!.key;
  sent.length = 0;
  await api.confirmUpdateAssets(VAULT, SIG);
  assert(
    sent[0]!.key !== createKey,
    'assets/confirm and create/confirm on the SAME signature do NOT collide',
  );

  const assetsKey = sent[0]!.key;
  sent.length = 0;
  await api.confirmAcceptAdminTransfer(VAULT, SIG);
  await api.confirmAcceptAdminTransfer(VAULT, SIG);
  assert(
    sent[0]!.key === sent[1]!.key,
    'admin acceptance confirm retry reuses the SAME key',
  );
  assert(
    sent[0]!.key !== createKey && sent[0]!.key !== assetsKey,
    'admin acceptance confirmation has its OWN endpoint prefix',
  );

  // A /prepare is NOT a retryable-identity call: it must ask for a genuinely new
  // transaction (fresh blockhash), so its key must differ every time.
  sent.length = 0;
  await api.prepareZapInCloseV2(VAULT);
  await api.prepareZapInCloseV2(VAULT);
  assert(
    sent[0]!.key !== undefined && sent[0]!.key !== sent[1]!.key,
    'a re-prepare gets a FRESH key (a pinned one would replay a stale tx)',
  );

  globalThis.fetch = realFetch;
  if (prevKey === undefined) delete process.env.DFM_API_KEY;
  else process.env.DFM_API_KEY = prevKey;
}

// ── 4. a slow keyless launch keeps the vault address after polling ─────────
console.log('case: keyless 202 polling preserves vaultAddress');
{
  const realFetch = globalThis.fetch;
  const prevKey = process.env.DFM_API_KEY;
  process.env.DFM_API_KEY = 'dfm_test_key_value';
  const api = new DfmApiClient(
    { apiUrl: 'https://api.test' } as unknown as AgentConfig,
    {} as unknown as SiwsSession,
  );
  const vaultAddress = 'Vau1t1111111111111111111111111111111111111';

  let call = 0;
  globalThis.fetch = (async () => {
    call += 1;
    const body =
      call === 1
        ? { status: 'pending', jobId: 'job-launch', poll: '/agent/operating/execute/job-launch' }
        : {
            jobStatus: 'done',
            signature: 'SIG_LATE',
            execStatus: 'complete',
            vaultAddress,
          };
    return new Response(JSON.stringify(body), {
      status: call === 1 ? 202 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const launched = await api.executeViaOperatingWallet('launch_vault', {});
  assert(
    launched.vaultAddress === vaultAddress,
    'a 202/polled launch returns its vault address to MCP/CLI callers',
  );

  globalThis.fetch = realFetch;
  if (prevKey === undefined) delete process.env.DFM_API_KEY;
  else process.env.DFM_API_KEY = prevKey;
}

// ── 5. the keyless execute reuses a key ONLY for a retry (A7 + #109) ─────
console.log('case: keyless execute key — a retry reuses it, a NEW identical call does not');
{
  const sent: Array<{ key?: string }> = [];
  let failNext = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ key: headers['X-Idempotency-Key'] });
    if (failNext > 0) {
      failNext--;
      return new Response(JSON.stringify({ statusCode: 502, message: 'bad gateway' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ signature: 'sig', status: 'complete' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const prevKey = process.env.DFM_API_KEY;
  process.env.DFM_API_KEY = 'dfm_test_key_value';
  const api = new DfmApiClient(
    { apiUrl: 'https://api.test' } as unknown as AgentConfig,
    {} as unknown as SiwsSession,
  );

  // A7: the response is LOST (here: a 502) and the agent retries the same
  // write. A fresh key per attempt is what executed it twice.
  failNext = 1;
  await api.executeViaOperatingWallet('deposit', { vault: 'V1', amount: '5' }).catch(() => undefined);
  await api.executeViaOperatingWallet('deposit', { amount: '5', vault: 'V1' }); // the RETRY, keys reordered
  assert(
    sent[0]!.key !== undefined && sent[0]!.key === sent[1]!.key,
    'a retry of an UNANSWERED operation reuses the SAME key (server collapses it)',
  );
  assert(sent[0]!.key!.startsWith('opexec-'), 'the key carries its own route prefix');
  assert(sent[0]!.key!.length <= 128, 'the key fits the server limit (≤ 128)');

  // #109: once a call returned, an identical call is a NEW operation — the
  // server must execute it, not replay a cached result for 24 h.
  await api.executeViaOperatingWallet('deposit', { vault: 'V1', amount: '5' });
  assert(sent[2]!.key !== sent[1]!.key, 'an identical call AFTER a result gets a NEW key');

  // A different tool is always a different key.
  await api.executeViaOperatingWallet('redeem', { vault: 'V1', amount: '5' });
  assert(sent[3]!.key !== sent[2]!.key, 'different tool → a DIFFERENT key');

  globalThis.fetch = realFetch;
  if (prevKey === undefined) delete process.env.DFM_API_KEY;
  else process.env.DFM_API_KEY = prevKey;
}

// ── 6. the keypair FILE is hardened before it is read (A9) ───────────────
console.log('case: keypair path refuses loose modes, symlinks, foreign owners');
{
  // mkdtemp → a 0700 dir owned by us: the BASELINE that must pass. Every case
  // below breaks exactly one rule from it. Failures run FIRST — a successful
  // load caches the keypair module-wide and would mask later assertions.
  const root = mkdtempSync(join(tmpdir(), 'dfm-signing-'));
  const SECRET = JSON.stringify(Array.from(Keypair.generate().secretKey));
  const expectThrow = (fn: () => unknown, pattern: RegExp, msg: string): void => {
    try {
      fn();
      assert(false, msg);
    } catch (e) {
      assert(pattern.test((e as Error).message), `${msg} (threw: ${(e as Error).message})`);
    }
  };

  // A loose mode: anything group/other-readable is refused outright.
  const loose = join(root, 'loose.json');
  writeFileSync(loose, SECRET, { mode: 0o600 });
  chmodSync(loose, 0o644);
  expectThrow(
    () => loadTestKeypair({ keypairPath: loose } as unknown as AgentConfig),
    /readable by other users/,
    'mode 0644 keypair is REFUSED',
  );

  // A symlinked FILE: lstat sees the link itself, so a link pointing at a
  // perfectly good file is still refused — the check is about the path.
  const real = join(root, 'real.json');
  writeFileSync(real, SECRET, { mode: 0o600 });
  const linkFile = join(root, 'link.json');
  symlinkSync(real, linkFile);
  expectThrow(
    () => loadTestKeypair({ keypairPath: linkFile } as unknown as AgentConfig),
    /is a symlink/,
    'a symlinked keypair FILE is REFUSED',
  );

  // A symlinked DIRECTORY: the file behind it is fine; the path to it is not.
  const realDir = join(root, 'realdir');
  mkdirSync(realDir, { mode: 0o700 });
  writeFileSync(join(realDir, 'k.json'), SECRET, { mode: 0o600 });
  const linkDir = join(root, 'linkdir');
  symlinkSync(realDir, linkDir);
  expectThrow(
    () => loadTestKeypair({ keypairPath: join(linkDir, 'k.json') } as unknown as AgentConfig),
    /is a symlink/,
    'a keypair behind a symlinked DIRECTORY is REFUSED',
  );

  // A foreign owner: same file, but the process uid is not the file's. (No
  // chown needed — getuid is what the check consults.)
  const realGetuid = process.getuid;
  process.getuid = (() => 99999) as typeof process.getuid;
  expectThrow(
    () => loadTestKeypair({ keypairPath: real } as unknown as AgentConfig),
    /not owned by the current user/,
    'a keypair owned by ANOTHER uid is REFUSED',
  );
  process.getuid = realGetuid;

  // The baseline: our 0700 dir + 0600 file loads and signs.
  const good = loadTestKeypair({ keypairPath: real } as unknown as AgentConfig);
  assert(
    good.publicKey.toBase58() === Keypair.fromSecretKey(Uint8Array.from(JSON.parse(SECRET))).publicKey.toBase58(),
    'a hardened 0600 keypair in a 0700 dir still LOADS',
  );

  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} money-path assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nmoney-path: all assertions passed');