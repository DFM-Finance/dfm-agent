#!/usr/bin/env node
/** Entry of the remote read-only server: `node dist/remote/main.js` (PORT, DFM_API_URL). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRemoteEnv } from './env-guard.js';
import { createRemoteHttpServer } from './http.js';
import { resolveApiUrl } from './public-client.js';

assertRemoteEnv(process.env);
const version = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const apiUrl = resolveApiUrl(process.env.DFM_API_URL);
const port = Number(process.env.PORT ?? 8787);
createRemoteHttpServer({ apiUrl, version }).listen(port, '127.0.0.1', () => {
  console.error(`DFM remote MCP (read-only) on 127.0.0.1:${port}/mcp -> ${apiUrl}`);
});
