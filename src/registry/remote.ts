import { READ_TOOLS } from '../read-tools.js';
import { forLane } from './define.js';

/** What the read-only remote server registers. Reads only, by construction. */
export const remoteTools = forLane(READ_TOOLS, 'remote');
