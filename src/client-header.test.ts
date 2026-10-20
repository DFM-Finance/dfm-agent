// Regression: every DFM API call from this package carries `x-dfm-client:
// mcp/<version>` — the API's `launchedVia: 'mcp'` label rests on it.
import assert from 'node:assert/strict';
import { DFM_CLIENT_HEADER, dfmClientHeaders, readPackageVersion } from './client-header.js';

assert.equal(DFM_CLIENT_HEADER, 'x-dfm-client');
assert.deepEqual(dfmClientHeaders('0.2.1950'), { 'x-dfm-client': 'mcp/0.2.1950' });
const v = readPackageVersion();
assert.match(v, /^\d+\.\d+\.\d+/, `package version unreadable: ${v}`);
assert.equal(dfmClientHeaders()[DFM_CLIENT_HEADER], `mcp/${v}`);
console.log('client-header: 4/4 ok');
