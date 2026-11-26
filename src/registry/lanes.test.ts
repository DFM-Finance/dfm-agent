/**
 * Lane contract (spec 011 T4, CA-1.1-1.3, CA-6.1): what each lane serves is exactly
 * its committed allowlist, and every registered tool carries a class and a
 * decision for every lane. Runnable: `npx tsx src/registry/lanes.test.ts`.
 *
 * The allowlists are the public contract. A lane may not gain or lose a tool
 * without a change to its JSON file in the same commit, so the diff shows it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { READ_TOOLS } from '../read-tools.js';
import { createRemoteServer } from '../remote/server.js';
import { server as stdioServer } from '../mcp-server.js';
import { LANES, TOOL_CLASSES } from './types.js';
import { forLane } from './define.js';
import { remoteTools } from './remote.js';
import { stdioTools } from './stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const allow = (lane: string): string[] =>
  (JSON.parse(readFileSync(join(here, 'allowlists', `${lane}.json`), 'utf8')) as { tools: string[] }).tools;

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

async function listed(server: { connect(t: unknown): Promise<void> }): Promise<string[]> {
  const client = new Client({ name: 'lanes-test', version: '0.0.0' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  const names = (await client.listTools()).tools.map((x) => x.name).sort();
  await client.close();
  return names;
}

await t('every tool has a class and an explicit yes/no for each lane', () => {
  for (const def of READ_TOOLS) {
    assert.ok((TOOL_CLASSES as readonly string[]).includes(def.class), `${def.name}: unknown class ${String(def.class)}`);
    for (const lane of LANES) assert.equal(typeof def.lanes[lane], 'boolean', `${def.name}: no decision for lane ${lane}`);
  }
});

await t('tool names are unique and each allowlist is sorted and duplicate-free', () => {
  assert.equal(new Set(READ_TOOLS.map((d) => d.name)).size, READ_TOOLS.length);
  for (const lane of LANES) {
    const names = allow(lane);
    assert.deepEqual(names, [...new Set(names)].sort(), `${lane}.json must be sorted and unique`);
  }
});

await t('remote tools/list equals the remote allowlist (and today\'s 9 reads)', async () => {
  const { server } = createRemoteServer('0.0.0', 'http://127.0.0.1:1');
  assert.deepEqual(await listed(server), allow('remote'));
  assert.deepEqual(remoteTools.map((d) => d.name).sort(), allow('remote'));
  assert.equal(allow('remote').length, 9);
});

await t('stdio tools/list equals the stdio allowlist (38)', async () => {
  assert.deepEqual(await listed(stdioServer), allow('stdio'));
  assert.equal(allow('stdio').length, 38);
  for (const d of stdioTools) assert.ok(allow('stdio').includes(d.name), `${d.name} is in the registry but not on the stdio allowlist`);
});

await t('next: the tools flagged for it are exactly the next allowlist (reads only until the moves)', () => {
  assert.deepEqual(forLane(READ_TOOLS, 'next').map((d) => d.name).sort(), allow('next'));
});

await t('no lane serves a read tool its allowlist does not name', () => {
  for (const lane of LANES) for (const d of forLane(READ_TOOLS, lane)) assert.ok(allow(lane).includes(d.name), `${d.name} flagged for ${lane}, not allowlisted`);
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nlanes: all green');
