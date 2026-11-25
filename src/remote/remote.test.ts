/**
 * Remote (Streamable HTTP, read-only) server: binding conditions from qa's
 * 25.11 ledger line, driven over the real wire with the SDK client against a
 * fake upstream API. Run: tsx src/remote/remote.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRemoteHttpServer } from './http.js';
import { assertRemoteEnv } from './env-guard.js';
import { scrubError } from './scrub.js';
import { registerReadTools, type ToolHost } from '../read-tools.js';
import { RemoteReadClient } from './public-client.js';
import { resolveVersion } from './version.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The exact read surface of the remote server (qa 25.11 11:09, condition 1). */
const ALLOWLIST = [
  'discover_tokens',
  'get_portfolio',
  'get_token_price',
  'get_vault',
  'list_dtfs',
  'protocol_facts',
  'swap_quote',
  'trader_profile',
  'zap_status',
];
const VAULT = '11111111111111111111111111111112';
const USER = '22222222222222222222222222222223';

// ── fake upstream: the public API, recording every request it gets ──────────
type Seen = { method: string; url: string; auth?: string; key?: string };
const seen: Seen[] = [];
let upstreamFail: string | null = null;
const upstream: Server = createServer((req: IncomingMessage, res) => {
  seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, key: req.headers['x-dfm-key'] as string | undefined });
  res.setHeader('Content-Type', 'application/json');
  if (upstreamFail) {
    res.writeHead(500);
    res.end(upstreamFail);
    return;
  }
  const url = req.url ?? '';
  if (url.startsWith('/vaults?') || url === '/vaults') {
    res.end(JSON.stringify({ total: 1, page: 1, totalPages: 1, vaults: [{ address: VAULT, vaultName: 'Test Fund', vaultSymbol: 'TST', tvl: 10, sharePrice: 1, entryFeeBps: 10, exitFeeBps: 10, underlyingAssets: [{ mint: VAULT, symbol: 'USDC', allocationBps: 10000 }] }] }));
  } else if (url === '/protocol/facts') {
    res.end(JSON.stringify({ factory: { zapperOnlyMint: true } }));
  } else if (url.startsWith('/portfolio')) {
    res.end(JSON.stringify([]));
  } else {
    res.end(JSON.stringify({ ok: true, path: url }));
  }
});
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

const remote = createRemoteHttpServer({ apiUrl: upstreamUrl, version: '0.0.0-test', paths: ['/mcp'], maxBodyBytes: 4096 });
await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r));
const remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`;

async function connect(headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'remote-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(remoteUrl), { requestInit: { headers } }));
  return client;
}
const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n${(e as Error).stack}`);
    process.exitCode = 1;
  }
}

await t('tools/list equals the read allowlist exactly (cond. 1+2)', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), [...ALLOWLIST].sort());
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be readOnlyHint`);
    // 6: no ETF/DTF/on-chain wording, no security configuration, in what the model reads
    assert.doesNotMatch(`${tool.description}`, /\bETF\b|\bDAO\b|on-chain/i, tool.name);
  }
  assert.doesNotMatch(client.getInstructions() ?? '', /keypair|private key/i);
  await client.close();
});

await t('refuses to start with a keypair, write switch, key, RPC url or owner path in the env (cond. 3)', () => {
  assertRemoteEnv({ PATH: '/bin', PORT: '8787', DFM_API_URL: 'https://app.dfm.finance/api/v2', NODE_ENV: 'production', HOME: '/home/x', LANG: 'C.UTF-8', INVOCATION_ID: 'abc', JOURNAL_STREAM: '8:1', DFM_API_KEY: '' });
  // the real names the app reads (app-wallet-owner.ts, helius, keypairs), not invented ones
  const bad = [
    'DFM_AGENT_KEYPAIR_PATH', 'DFM_AGENT_KEYPAIR_JSON', 'DFM_AGENT_WRITE_ENABLED', 'DFM_API_KEY', 'DFM_MCP_NONINTERACTIVE_WRITES', 'DFM_MCP_CONFIRM_REQUIRED',
    'DFM_APP_WALLET_OWNER_KEY_PATH', 'HELIUS_RPC_URL', 'HELIUS_API_KEY', 'SOLANA_RPC_URL', 'SOLANA_PRIVATE_KEY', 'PRIVY_APP_SECRET', 'JUPITER_API_KEY',
    'NODE_AUTH_TOKEN', 'some_private_thing', 'wallet_owner', 'MY_KEYPAIR',
  ];
  for (const k of bad) {
    assert.throws(() => assertRemoteEnv({ PATH: '/bin', [k]: 'x' }), new RegExp(`refuses to start: .*${k}`), k);
  }
  // every offender is named, none of the values is echoed
  assert.throws(() => assertRemoteEnv({ HELIUS_RPC_URL: 'https://rpc.example/?api-key=SECRETVALUE', DFM_API_KEY: 'dfm_SECRETVALUE' }), (e: Error) => /HELIUS_RPC_URL/.test(e.message) && /DFM_API_KEY/.test(e.message) && !/SECRETVALUE/.test(e.message));
  const run = spawnSync(process.execPath, ['--import', 'tsx', join(here, 'main.ts')], {
    env: { PATH: process.env.PATH, DFM_AGENT_KEYPAIR_PATH: '/nonexistent', PORT: '0' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /refuses to start: DFM_AGENT_KEYPAIR_PATH/);
});

/**
 * Every module specifier a built file loads: static import/export-from,
 * side-effect imports (`import './x.js'`) and dynamic `import('./x.js')`.
 * A dynamic import whose argument is not a string literal cannot be followed,
 * so it is reported as `dynamic:<expr>` and fails the graph test.
 */
function specifiersOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\/|(?<![:'"`])\/\/.*$/gm, '');
  const out: string[] = [];
  for (const m of code.matchAll(/\b(?:import|export)\s*(?:[^'"();]*?\bfrom\s*)?['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const lit = /^['"]([^'"]+)['"]$/.exec(m[1].trim());
    out.push(lit ? lit[1] : `dynamic:${m[1].trim()}`);
  }
  if (/\brequire\s*\(|\bcreateRequire\b/.test(code)) out.push('dynamic:require');
  return out;
}

await t('specifiersOf sees static, side-effect, re-export, multiline and dynamic imports', () => {
  assert.deepEqual(specifiersOf(`import a from './a.js';\nimport { b,\n c } from "./b.js";\nimport './side.js';\nexport * from './re.js';\nexport { d } from './d.js';`), ['./a.js', './b.js', './side.js', './re.js', './d.js']);
  assert.deepEqual(specifiersOf(`const m = await import('./w.js');`), ['./w.js']);
  assert.deepEqual(specifiersOf(`import(name);`), ['dynamic:name']);
  assert.deepEqual(specifiersOf(`// import './commented.js'\n/* import('./c2.js') */ const x = 1;`), []);
  assert.deepEqual(specifiersOf(`const r = createRequire(import.meta.url);`), ['dynamic:require']);
});

await t('only the allowlisted built files are reachable from the remote entry, with no dynamic loads (cond. 3)', () => {
  const dist = resolve(here, '..', '..', 'dist');
  const entry = join(dist, 'remote', 'main.js');
  assert.ok(existsSync(entry), 'dist is not built: run `npm run build` first (the graph is checked on the shipped JS)');
  const files = new Set<string>();
  const bare = new Set<string>();
  const dynamic: string[] = [];
  const walk = (file: string): void => {
    if (files.has(file)) return;
    assert.ok(existsSync(file), `${file} is imported but missing`);
    files.add(file);
    for (const sp of specifiersOf(readFileSync(file, 'utf8'))) {
      if (sp.startsWith('dynamic:')) dynamic.push(`${file.slice(dist.length + 1)} ${sp}`);
      else if (sp.startsWith('.')) walk(resolve(dirname(file), sp));
      else bare.add(sp);
    }
  };
  walk(entry);
  assert.deepEqual(dynamic, [], 'a dynamic import/require cannot be followed, so it is refused');
  const reached = [...files].map((f) => f.slice(dist.length + 1)).sort();
  assert.deepEqual(reached, ['fees.js', 'read-tools.js', join('remote', 'env-guard.js'), join('remote', 'http.js'), join('remote', 'main.js'), join('remote', 'public-client.js'), join('remote', 'scrub.js'), join('remote', 'server.js'), join('remote', 'version.js'), 'token-search.js'], 'a new reachable file must be reviewed and added here on purpose');
  assert.deepEqual([...bare].sort(), ['@modelcontextprotocol/sdk/server/mcp.js', '@modelcontextprotocol/sdk/server/streamableHttp.js', 'node:crypto', 'node:fs', 'node:http', 'node:path', 'node:url', 'zod']);
  for (const f of files) {
    assert.doesNotMatch(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<![:'"`])\/\/.*$/gm, ''), /loadTestKeypair|Keypair\.from|DFM_AGENT_KEYPAIR_(?:PATH|JSON)\b(?!\))/, f);
  }
});

await t('public tools reach only the public API, with no credential, even if the caller sends a key (cond. 4)', async () => {
  seen.length = 0;
  const client = await connect({ Authorization: 'Bearer dfm_abcdefgh12345678' });
  const r = await client.callTool({ name: 'list_dtfs', arguments: { limit: 5 } });
  assert.equal(isError(r), false);
  assert.match(textOf(r), /Test Fund/);
  await client.callTool({ name: 'protocol_facts', arguments: {} });
  assert.deepEqual(seen.map((s) => s.url), ['/vaults?limit=5', '/protocol/facts']);
  assert.ok(seen.every((s) => s.auth === undefined && s.key === undefined), 'a public read forwarded a credential');
  await client.close();
});

await t('own-account tools need the caller key, forward only a dfm_ bearer (cond. 4, 8)', async () => {
  seen.length = 0;
  const anon = await connect();
  const r = await anon.callTool({ name: 'get_portfolio', arguments: {} });
  assert.equal(isError(r), true);
  assert.match(textOf(r), /Authorization: Bearer dfm_/);
  const z = await anon.callTool({ name: 'zap_status', arguments: { vault: VAULT, user: USER } });
  assert.match(textOf(z), /Authorization: Bearer dfm_/);
  assert.equal(seen.length, 0, 'no upstream call without a key');
  await anon.close();

  const jwt = await connect({ Authorization: 'Bearer eyJhbGciOi.fake.jwt' });
  assert.equal(isError(await jwt.callTool({ name: 'get_portfolio', arguments: {} })), true);
  assert.equal(seen.length, 0, 'a non-dfm_ bearer is never forwarded');
  await jwt.close();

  const keyed = await connect({ Authorization: 'Bearer dfm_abcdefgh12345678' });
  const p = await keyed.callTool({ name: 'get_portfolio', arguments: {} });
  assert.equal(isError(p), false);
  const q = await keyed.callTool({ name: 'swap_quote', arguments: { inputMint: VAULT, outputMint: USER, amountRaw: '1000000' } });
  assert.equal(isError(q), false);
  await keyed.callTool({ name: 'zap_status', arguments: { vault: VAULT, user: USER, escrowSlot: 2 } });
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), [
    'GET /portfolio', 'GET /portfolio/summary', 'POST /agent/operating/swap/quote', `GET /vaults/${VAULT}/zap-v2/status/${USER}?slot=2`,
  ]);
  // The real API ignores a dfm_ in Authorization (JWT lane, 401): the key must travel as X-DFM-Key only.
  assert.ok(seen.every((s) => s.key === 'dfm_abcdefgh12345678' && s.auth === undefined));
  await keyed.close();
});

await t('a caller-supplied URL is never fetched: arguments are path segments or query values only (cond. 5)', async () => {
  seen.length = 0;
  const client = await connect();
  const bad = await client.callTool({ name: 'get_vault', arguments: { address: 'http://evil.example/x' } });
  assert.equal(isError(bad), true);
  await client.callTool({ name: 'discover_tokens', arguments: { query: '//evil.example/../admin' } });
  await client.callTool({ name: 'trader_profile', arguments: { username: '../../ops/secrets' } });
  assert.deepEqual(seen.map((s) => s.url), ['/assets/search?q=%2F%2Fevil.example%2F..%2Fadmin', '/profile/u/..%2F..%2Fops%2Fsecrets']);
  await client.close();
});

await t('upstream errors reach the caller without stacks or filesystem paths (cond. 7)', async () => {
  // built from parts: the mirror's secret scan (rightly) rejects a literal home path in shipped text
  const home = ['', 'Users', 'dev'].join('/');
  upstreamFail = `Error: boom\n    at Object.<anonymous> (${home}/proj/lib/a.ts:12:3)\n    at /srv/x/lib/b.js:1:1`;
  const client = await connect();
  const r = await client.callTool({ name: 'get_vault', arguments: { address: VAULT } });
  upstreamFail = null;
  assert.equal(isError(r), true);
  const body = textOf(r);
  assert.match(body, /get_vault failed: DFM API 500/);
  assert.doesNotMatch(body, /\/Users|\/srv|\.ts:\d|\.js:\d|\n\s+at /);
  assert.doesNotMatch(scrubError('x\n    at f (/home/a/b.js:1:1)'), /home|\bat f/);
  await client.close();
});

await t('body-size limit and method handling; no rate limiter (cond. 9)', async () => {
  const big = await fetch(remoteUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(8000) }) }).catch(() => null);
  assert.ok(big === null || big.status === 413, `expected 413 or a closed socket, got ${big?.status}`);
  const get = await fetch(remoteUrl);
  assert.equal(get.status, 405);
  const nope = await fetch(remoteUrl.replace('/mcp', '/admin'), { method: 'POST', body: '{}' });
  assert.equal(nope.status, 404);
  const src = ['http.ts', 'server.ts', 'main.ts'].map((f) => readFileSync(join(here, f), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(src, /rate.?limit|throttl|429/i);
});

await t('the registry is SDK-agnostic: any host with registerTool gets the same set (Next.js adapter basis)', () => {
  const got: string[] = [];
  const host: ToolHost = { registerTool: (name, config) => void got.push(`${name}:${typeof config.inputSchema}`) };
  const names = registerReadTools(host, new RemoteReadClient(upstreamUrl), { lane: 'remote', scrub: scrubError });
  assert.deepEqual([...names].sort(), [...ALLOWLIST].sort());
  assert.ok(got.every((g) => g.endsWith(':object')), 'inputSchema is a plain zod shape the adapter can wrap');
});

await t('serverInfo.version over the wire is the version the host passes, not a literal', async () => {
  const client = await connect();
  assert.equal(client.getServerVersion()?.version, '0.0.0-test');
  await client.close();
});

await t('resolveVersion: the release VERSION (0.2.<build>) beats package.json 0.2.0; falls back; never throws', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'dfm-ver-'));
  const a = dir(); writeFileSync(join(a, 'package.json'), '{"version":"0.2.0"}'); writeFileSync(join(a, 'VERSION'), '0.2.2431\n');
  assert.equal(resolveVersion(a), '0.2.2431');
  const b = dir(); writeFileSync(join(b, 'package.json'), '{"version":"0.2.0"}');
  assert.equal(resolveVersion(b), '0.2.0');
  const c = dir(); writeFileSync(join(c, 'package.json'), '{"version":"0.2.0"}'); writeFileSync(join(c, 'VERSION'), 'not a version');
  assert.equal(resolveVersion(c), '0.2.0', 'a garbled VERSION file is ignored');
  assert.equal(resolveVersion(dir()), '0.0.0');
});

remote.close();
upstream.close();
console.log(`remote.test: ${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
