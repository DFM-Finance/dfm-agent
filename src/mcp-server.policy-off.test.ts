import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// #118 regression: Policy changes are off until v2, so the MCP must not offer a
// tool that changes a fund's policy, and its instructions must say so. Parsed
// from source on purpose: importing mcp-server.ts starts a stdio server.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'mcp-server.ts'), 'utf8');
const tools = [...src.matchAll(/server\.registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);

assert.ok(tools.length >= 30, `parsed only ${tools.length} tools — the registerTool parse broke`);
assert.ok(!tools.includes('update_vault_policy'), 'update_vault_policy is back in the MCP tool list');
assert.ok(!tools.some((t) => /polic/.test(t)), `a policy tool is registered: ${tools.filter((t) => /polic/.test(t))}`);
assert.match(src, /POLICY → every fund runs the same default policy; there is no tool to change it/);

console.log(`mcp-server.policy-off: ${tools.length} tools, none changes a policy`);
