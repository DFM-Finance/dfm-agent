// Fees are factory-global and read live. Since v.2150 the API answers null +
// `feesUnavailable: true` when that read fails, instead of the stored per-vault
// copy (legacy zeros). An agent that prints the null as 0 tells a depositor the
// fund is free; this keeps "unknown" distinct from "zero" on every MCP surface.

export const FEES_UNAVAILABLE_NOTE =
  'Fees unavailable right now: the live factory read failed. Say so; never quote 0 or a remembered rate. Retry get_vault or protocol_facts.';

export interface PresentedFees {
  entryBps: number | null;
  exitBps: number | null;
  feesUnavailable?: true;
  note?: string;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One fee pair as an agent should read it: numbers, or an explicit "unavailable". */
export function presentFees(entry: unknown, exit: unknown, unavailable?: unknown): PresentedFees {
  if (unavailable === true || !isNum(entry) || !isNum(exit)) {
    return { entryBps: null, exitBps: null, feesUnavailable: true, note: FEES_UNAVAILABLE_NOTE };
  }
  return { entryBps: entry, exitBps: exit };
}

/** get_vault passes the API detail through; add the note when its fees are unknown. */
export function withFeesNote<T extends object>(detail: T): T & { feesNote?: string } {
  const d = detail as Record<string, unknown>;
  const fs = (d.feeStructure ?? {}) as Record<string, unknown>;
  const v = (d.vault ?? {}) as Record<string, unknown>;
  const unknown =
    fs.feesUnavailable === true ||
    v.feesUnavailable === true ||
    ('entryFeeBps' in fs && !isNum(fs.entryFeeBps)) ||
    ('exitFeeBps' in fs && !isNum(fs.exitFeeBps));
  return unknown ? { ...detail, feesNote: FEES_UNAVAILABLE_NOTE } : detail;
}
