#!/usr/bin/env node
/**
 * CLI smoke — guards the `npx @dfm-fi/agent install` UX + the critical
 * backward-compat invariant that a no-arg, non-TTY invocation still starts the
 * stdio MCP server (every existing `claude mcp add dfm -- npx -y @dfm-fi/agent`
 * registration depends on it). Runs offline; wired into `npm test` + publish.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(AGENT_DIR, 'dist', 'cli.js');

let failed = 0;
const ok = (m) => console.log('  ✅', m);
const bad = (m) => { console.error('  ❌', m); failed++; };

function run(args) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 1) help exits 0 and surfaces the one-line install command
{
  const { code, out } = run(['help']);
  if (code === 0 && out.includes('npx -y @dfm-fi/agent install')) ok('help prints the install command (exit 0)');
  else bad(`help broken (code=${code})`);
}

// 2) version prints a semver-ish string
{
  const { code, out } = run(['version']);
  if (code === 0 && /\d+\.\d+\.\d+/.test(out)) ok('version prints a version');
  else bad(`version broken (code=${code}, out=${out.trim()})`);
}

// 3) install --dry-run (read) emits the exact claude mcp add command, no write env
{
  const { code, out } = run(['install', '--dry-run']);
  if (code === 0 && out.includes('claude mcp add dfm -- npx -y @dfm-fi/agent') && !out.includes('DFM_AGENT_WRITE_ENABLED')) {
    ok('install --dry-run (read) emits the register command without write env');
  } else bad(`install --dry-run (read) broken (code=${code})`);
}

// 4) install --write --dry-run includes the write env + keypair path
{
  const { code, out } = run(['install', '--write', '--keypair', '/abs/tw.json', '--dry-run']);
  if (code === 0 && out.includes('DFM_AGENT_WRITE_ENABLED=true') && out.includes('DFM_AGENT_KEYPAIR_PATH=/abs/tw.json')) {
    ok('install --write --dry-run includes write env + keypair');
  } else bad(`install --write --dry-run broken (code=${code})`);
}

// 4b) install --write --api-key --dry-run wires DFM_API_KEY, NEVER a keypair —
//     this is the RECOMMENDED path (Diego, 2026-08-05): agent-driven writes must
//     sign with the Privy operating wallet, never a raw local keypair.
{
  const { code, out } = run(['install', '--write', '--api-key', 'dfm_test123', '--dry-run']);
  if (
    code === 0 &&
    out.includes('DFM_AGENT_WRITE_ENABLED=true') &&
    out.includes('DFM_API_KEY=dfm_test123') &&
    !out.includes('DFM_AGENT_KEYPAIR_PATH')
  ) {
    ok('install --write --api-key --dry-run wires DFM_API_KEY, no keypair env');
  } else bad(`install --write --api-key --dry-run broken (code=${code})`);
}

// 4c) --api-key + --keypair together is a hard error (keyless.ts: a keypair
//     present always wins, so silently accepting both would silently ignore
//     --api-key — reject instead of guessing which one the caller meant).
{
  const { code, out } = run(['install', '--write', '--api-key', 'dfm_x', '--keypair', '/abs/tw.json']);
  if (code !== 0 && /mutually exclusive/i.test(out)) {
    ok('install --api-key + --keypair together is rejected');
  } else bad(`install --api-key + --keypair should have been rejected (code=${code})`);
}

// 5) unknown command exits non-zero (so typos don't silently hang as a server)
{
  const { code } = run(['definitely-not-a-command']);
  if (code !== 0) ok('unknown command exits non-zero');
  else bad('unknown command should exit non-zero');
}

// 6) BACKWARD-COMPAT: no-arg + piped (non-TTY) stdin starts the stdio MCP server
//    (initialize handshake must succeed). This is the invariant that keeps every
//    existing `npx -y @dfm-fi/agent` registration working after the bin change.
await new Promise((resolve) => {
  const srv = spawn('node', [CLI], {
    cwd: AGENT_DIR,
    env: { ...process.env, DFM_API_URL: 'https://app.dfm.finance' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const done = (good, msg) => { try { srv.kill(); } catch { /* noop */ } good ? ok(msg) : bad(msg); resolve(); };
  const t = setTimeout(() => done(false, 'no-arg stdio server did not respond to initialize'), 20_000);
  srv.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === 1 && m.result?.serverInfo?.name === 'dfm-agent') { clearTimeout(t); done(true, 'no-arg non-TTY still serves MCP over stdio'); return; }
    }
  });
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } }) + '\n');
});

if (failed) { console.error(`\nCLI smoke FAILED (${failed}).`); process.exit(1); }
console.log('\n✅ CLI smoke OK — install UX + MCP-server backward-compat verified.');
