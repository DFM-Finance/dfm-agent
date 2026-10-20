/**
 * `discover_tokens` output shaping (#109): `/assets/search` answers ~100 rows of
 * full Jupiter metadata (90–117 KB per query) — more than an MCP host can put in
 * context, so the one legitimate way to get a mint fell back to a file. The
 * agent needs the identity, the safety signals and whether a fund may hold it.
 */
export const DEFAULT_TOKEN_LIMIT = 10;
export const MAX_TOKEN_LIMIT = 50;

const LEAN_FIELDS = [
  'mint', 'symbol', 'name', 'decimals', 'isVerified', 'assetClass', 'isToken2022',
  'liquidityUsd', 'mcap', 'organicScoreLabel', 'basketEligibility', 'eligibilityReason',
] as const;

export function leanTokenRows(rows: unknown, limit: number = DEFAULT_TOKEN_LIMIT): unknown {
  if (!Array.isArray(rows)) return rows;
  const n = Math.min(Math.max(1, Math.floor(limit)), MAX_TOKEN_LIMIT);
  const out = rows.slice(0, n).map((r) => {
    const row = r as Record<string, unknown>;
    const lean: Record<string, unknown> = {};
    for (const k of LEAN_FIELDS) if (row[k] !== undefined) lean[k] = row[k];
    return lean;
  });
  return { results: out, shown: out.length, total: rows.length };
}
