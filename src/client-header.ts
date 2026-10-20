import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `x-dfm-client: mcp/<version>` on every DFM API call this package makes.
 *
 * The API stamps it onto a launched fund as `launchedVia: 'mcp'` (marketing:
 * how many funds AI agents launch through the MCP). It is a LABEL only — the
 * server never grants, widens or skips anything because of it.
 */
export const DFM_CLIENT_HEADER = 'x-dfm-client';

export function readPackageVersion(): string {
  try {
    // dist/client-header.js → ../package.json (same layout in the published tarball).
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function dfmClientHeaders(version: string = readPackageVersion()): Record<string, string> {
  return { [DFM_CLIENT_HEADER]: `mcp/${version}` };
}
