#!/usr/bin/env node
/** Entry of the remote read-only server: `node dist/remote/main.js` (PORT, DFM_API_URL). */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRemoteEnv } from './env-guard.js';
import { createRemoteHttpServer } from './http.js';
import { resolveApiUrl } from './public-client.js';
import { resolveVersion } from './version.js';

assertRemoteEnv(process.env);
/** release.sh stamps `agent/VERSION` = <major>.<minor>.<build> (the npm number); package.json alone says 0.2.0. */
const version = resolveVersion(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const apiUrl = resolveApiUrl(process.env.DFM_API_URL);
const port = Number(process.env.PORT ?? 8787);
createRemoteHttpServer({ apiUrl, version }).listen(port, '127.0.0.1', () => {
  console.error(`DFM remote MCP (read-only) on 127.0.0.1:${port}/mcp -> ${apiUrl}`);
});
