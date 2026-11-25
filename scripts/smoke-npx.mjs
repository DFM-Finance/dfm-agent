#!/usr/bin/env node
/**
 * npx smoke — `claude mcp add dfm -- npx -y @dfm-fi/agent` and the dfm-plugins
 * bridge (`npx @dfm-fi/agent@latest`) run the package's ONLY bin. With two bins
 * npm cannot pick one and fails with "could not determine executable to run"
 * (e074e1ee shipped that). This packs the real tarball and runs it through npx
 * in a clean temp dir, the way a user's machine does.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'dfm-npx-smoke-'));
let failed = 0;
try {
  const bins = readFileSync(join(AGENT_DIR, 'package.json'), 'utf8');
  const binCount = Object.keys(JSON.parse(bins).bin ?? {}).length;
  if (binCount !== 1) { console.error(`  ❌ package.json declares ${binCount} bins; npx needs exactly 1`); failed++; }

  const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', tmp, '--ignore-scripts'], { cwd: AGENT_DIR, encoding: 'utf8', timeout: 120_000 });
  const tgz = (pack.stdout || '').trim().split('\n').pop();
  if (pack.status !== 0 || !tgz) { console.error('  ❌ npm pack failed', pack.stderr); process.exit(1); }

  const work = mkdtempSync(join(tmp, 'run-'));
  const env = { ...process.env, npm_config_cache: join(tmp, 'cache'), npm_config_update_notifier: 'false' };
  const r = spawnSync('npx', ['-y', `file:${join(tmp, tgz)}`, '--help'], { cwd: work, env, encoding: 'utf8', timeout: 180_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0) console.log('  ✅ npx -y file:<tgz> --help exits 0 (one bin, resolvable)');
  else { console.error(`  ❌ npx exited ${r.status}: ${out.slice(0, 300)}`); failed++; }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
