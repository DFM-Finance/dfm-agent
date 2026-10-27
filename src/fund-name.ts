import { z } from 'zod';

/**
 * Max characters in a NEW fund's name (Diego, 2026-10-27: 32 -> 24). Funds
 * launched earlier keep names up to 32 (the onchain cap); this only gates
 * launch_vault. Mirrors api/src/modules/vault/fund-name.ts, because this npm
 * package does not depend on the api; agent-mcp-parity.spec pins the two.
 */
export const FUND_NAME_MAX = 24;

export const fundNameSchema = z.string().min(1).max(FUND_NAME_MAX);
