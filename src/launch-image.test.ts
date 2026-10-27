/**
 * LAUNCH IMAGE regressions (runnable: `npx tsx src/launch-image.test.ts`).
 *
 * 2026-10-27: an agent launched a fund without asking for an image and then told
 * the user a logo could be added later. It cannot: `create_vault` writes the
 * metadata URI into the vault PDA and `create_vault_metadata` creates the
 * Metaplex metadata with `is_mutable = false`; dtf-vault has no instruction that
 * changes either. So the MCP must (1) accept the image at launch (`logoUri`),
 * (2) tell the host model to ask for it first and that it is permanent, and
 * (3) never promise a later change (`attach_metadata` reuses the launch image).
 *
 * Real MCP plumbing: the registered server is driven by a real MCP Client over
 * an in-memory transport. No keypair, no network — WRITE is disabled here, so an
 * accepted call ends at the WRITE-disabled gate.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { server } from './mcp-server.js';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failures++;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

const client = new Client({ name: 'launch-image-test', version: '0.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const { tools } = await client.listTools();
const launch = tools.find((t) => t.name === 'launch_vault');
const attach = tools.find((t) => t.name === 'attach_metadata');
const props = (launch?.inputSchema.properties ?? {}) as Record<string, { description?: string; type?: string }>;

console.log('launch_vault: the image is asked for, accepted and stated as permanent');
assert(props.logoUri?.type === 'string', 'launch_vault accepts logoUri');
assert(/CANNOT be changed after launch/.test(props.logoUri?.description ?? ''), 'logoUri says it cannot be changed after launch');
assert(/ask your human/i.test(props.logoUri?.description ?? ''), 'logoUri tells the host model to ask the human');
assert(!/ipfs:\/\//.test(props.logoUri?.description ?? ''), 'logoUri names no ipfs:// link (the ingest does not fetch one)');
assert(/GIPHY page link works/.test(props.logoUri?.description ?? ''), 'logoUri says a GIPHY page link is accepted');
assert(/converts it to WebP under 2 MB/.test(props.logoUri?.description ?? ''), 'logoUri says DFM converts and stores the link');
assert(/cannot be changed/.test(launch?.description ?? ''), 'launch_vault description states the image is permanent');
assert(/explicitly decline/.test(launch?.description ?? ''), 'launch_vault launches without an image only after a decline');
assert(
  JSON.stringify(launch?.inputSchema.required ?? []) === JSON.stringify(['name', 'symbol', 'assets']),
  'logoUri stays optional (no schema narrowing for plugins)',
);
assert(/logoUri/.test(client.getInstructions() ?? ''), 'server instructions name logoUri in the CREATE workflow');
assert(/confirm EVERY field with the human — name, symbol, description \(you may propose a draft\)/.test(client.getInstructions() ?? ''), 'server instructions walk every launch field');
assert(/never fill one silently/.test(client.getInstructions() ?? ''), 'server instructions: never fill a field silently');
assert(/confirm EVERY field with your human \(name, symbol, description, logoUri, category, assets, weights\)/.test(launch?.description ?? ''), 'launch_vault lists every field to confirm');
assert(/Ask your human for the fund description \(you may propose a draft\)/.test(props.description?.description ?? ''), 'description field: ask your human, draft allowed');
assert(/cannot be changed after launch/.test(props.description?.description ?? ''), 'description field says it is permanent');
assert(/`description` too \(you may propose a draft\)/.test(launch?.description ?? ''), 'launch_vault description asks for the description');

console.log('no surface promises a later image change');
const everyText = JSON.stringify(tools) + (client.getInstructions() ?? '');
assert(!/vault page/i.test(everyText), 'no tool text points to the vault page for metadata/image');
assert(/cannot add or change the image/.test(attach?.description ?? ''), 'attach_metadata says it reuses the launch image');

console.log('schema: a logoUri passes through to the write gate');
const base = {
  name: 'Image Test',
  symbol: 'IMG',
  assets: [
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', allocationBps: 5000 },
    { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', allocationBps: 5000 },
  ],
};
const text = (r: unknown) =>
  ((r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === 'text')?.text ?? '');
const good = await client.callTool({ name: 'launch_vault', arguments: { ...base, logoUri: 'https://example.com/logo.png' } });
assert(text(good).startsWith('WRITE is disabled.'), 'a logoUri passes the schema and stops at the write gate');

await client.close();
if (failures > 0) {
  console.error(`\n${failures} launch-image assertion(s) failed`);
  process.exit(1);
}
console.log('\nlaunch-image: all assertions passed');
