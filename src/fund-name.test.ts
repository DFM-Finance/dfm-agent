import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FUND_NAME_MAX, fundNameSchema } from './fund-name.js';

assert.equal(FUND_NAME_MAX, 24);
// launch_vault name: 24 chars pass, 25 fail, empty fails.
assert.equal(fundNameSchema.safeParse('a'.repeat(24)).success, true);
assert.equal(fundNameSchema.safeParse('a'.repeat(25)).success, false);
assert.equal(fundNameSchema.safeParse('').success, false);

// The tool must use the shared schema, not an inline z.string().max(n).
const src = readFileSync(new URL('./mcp-server.ts', import.meta.url), 'utf8');
const launch = src.slice(src.indexOf("'launch_vault'"), src.indexOf("'launch_vault'") + 4000);
assert.match(launch, /name: fundNameSchema,/);
assert.match(launch, /Name 1–\$\{FUND_NAME_MAX\} characters/);

console.log('fund-name: ok');
