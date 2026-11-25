import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
};

/** The version the remote MCP reports in serverInfo: `<root>/VERSION` (stamped per release), else package.json, else 0.0.0. */
export function resolveVersion(root: string): string {
  const stamped = read(join(root, 'VERSION'));
  if (stamped && /^\d+\.\d+\.\d+$/.test(stamped)) return stamped;
  try {
    return JSON.parse(read(join(root, 'package.json')) ?? '{}').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
