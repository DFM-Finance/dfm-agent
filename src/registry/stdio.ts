import { READ_TOOLS } from '../read-tools.js';
import { forLane } from './define.js';

/**
 * What the stdio server takes from the registry. Reads only for now: the other
 * 29 tools are still registered inline in `mcp-server.ts` and move here class by
 * class (T7-T11). The stdio allowlist already names all 38.
 */
export const stdioTools = forLane(READ_TOOLS, 'stdio');
