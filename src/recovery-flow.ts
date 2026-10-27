/**
 * Zap-v2 STALL RECOVERY drivers — cancel + update-envelope. Real-money WRITE.
 *
 * ⚠️ GATED. Reachable only when DFM_AGENT_WRITE_ENABLED=true.
 * REVIEW: real-money path — parent must review before enabling.
 *
 * When a deposit/redeem stalls mid-crank (a leg can't meet its pinned floor),
 * there are exactly two operator levers:
 *
 *   • cancel          — return the escrow's CURRENT holdings (USDC + whatever
 *                       basket legs already filled) to the test wallet as-is. No
 *                       swaps, no oracle. Owner anytime; anyone after expiry.
 *
 *   • update-envelope — LOOSEN the pinned per-leg min-out floors (+ slippage,
 *                       + optional expiry extension) so the orchestrator can
 *                       complete the stuck legs. The contract enforces monotonic
 *                       LOOSENING only (each new floor ≤ the existing one;
 *                       slippage ≥ current). We compute the new floors by reading
 *                       the LIVE escrow's pinned `minOuts` and relaxing them by a
 *                       bounded percentage — never inventing absolute numbers.
 *
 * Both are deliberate recoveries, not silent retries.
 * ───────────────────────────────────────────────────────────────────────────
 */
import type { AgentConfig } from './config.js';
import type { DfmApiClient } from './api-client.js';
import { signBase64Transaction } from './signing.js';
import { submitSignedTx } from './submit.js';

const MAX_SLIPPAGE_BPS = 1_000; // MAX_ZAP_SLIPPAGE_BPS — the per-leg onchain cap.

/** Parse a raw-units decimal string to bigint, treating missing/garbage as 0. */
function safeBig(s: string | undefined | null): bigint {
  if (!s) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

export interface UpdateEnvelopeResult {
  ok: boolean;
  vault: string;
  signature: string;
  /** What we relaxed FROM → TO, so the operator can see the loosening applied. */
  loosening: {
    oldMinOuts: string[];
    newMinOuts: string[];
    oldSlippageBps: number;
    newSlippageBps: number;
    oldMinUsdcOut?: string;
    newMinUsdcOut?: string;
    extendSecs: number;
    loosenPct: number;
  };
  message: string;
}

/**
 * Compute SAFE loosened per-leg floors from the live pinned `minOuts` by relaxing
 * each by `loosenPct` percent (default 5%). Each result is `floor(old * (100 -
 * pct) / 100)`, clamped to ≥1 (the API rejects non-positive floors) and never
 * above the old value (on-chain monotonic-loosening rule). Returns the new floor
 * array in basket order.
 */
export function computeLoosenedMinOuts(oldMinOuts: string[], loosenPct: number): string[] {
  if (loosenPct < 0 || loosenPct > 50) {
    throw new Error(`loosenPct must be 0..50; got ${loosenPct}.`);
  }
  // Must be an INTEGER percent. `BigInt(Math.round(100 - loosenPct))` would
  // silently round a fractional pct (e.g. 0.5 → 100 → a no-op loosen), giving the
  // operator the false impression the floors were relaxed. Reject it loudly.
  if (!Number.isInteger(loosenPct)) {
    throw new Error(`loosenPct must be an integer percent (0..50); got ${loosenPct}.`);
  }
  const num = BigInt(100 - loosenPct);
  return oldMinOuts.map((s) => {
    const old = BigInt(s);
    if (old <= 0n) return '1'; // already a sentinel — keep it positive for the API.
    let relaxed = (old * num) / 100n;
    if (relaxed < 1n) relaxed = 1n; // floor at 1 raw unit (API rejects 0).
    if (relaxed > old) relaxed = old; // never tighten.
    return relaxed.toString();
  });
}

/**
 * Loosen a stalled escrow's pinned floors so the orchestrator can finish. The
 * new floors are DERIVED from the live escrow (`minOuts` relaxed by `loosenPct`),
 * never hand-supplied — the only knobs an operator turns are HOW MUCH to relax
 * (`loosenPct`), the new slippage, and an optional expiry extension.
 *
 * `newSlippageBps` is clamped to ≥ the current pinned slippage (the on-chain rule
 * forbids tightening) and ≤ the 1000-bps cap.
 */
export async function runUpdateEnvelope(
  config: AgentConfig,
  api: DfmApiClient,
  user: string,
  vault: string,
  opts: { loosenPct?: number; newSlippageBps?: number; extendSecs?: number },
): Promise<UpdateEnvelopeResult> {
  const live = await api.getZapV2Status(vault, user);
  if (!live) {
    throw new Error(
      `No open zap-v2 escrow for vault ${vault.slice(0, 8)}… and this wallet — nothing to update.`,
    );
  }
  // #64 — DEAD-LEG redeem recovery. A REDEEM can reach READY_TO_CLOSE with a leg
  // that was marked DEAD (unsellable → paid in-kind, `actualOut = 0`). Its pinned
  // `min_usdc_out` assumed EVERY leg sells, so realized USDC < floor and
  // `zap_out_close_v2` reverts `UsdcBelowMin` (6023) — a permanently-stuck redeem.
  // On-chain `update_slippage_envelope` EXPLICITLY accepts READY_TO_CLOSE precisely
  // so the owner can LOWER `min_usdc_out` here and then close. So the readyToClose
  // guard must NOT short-circuit a dead-legged redeem — that's the exact recovery
  // this function implements (previously unreachable → the #64 bug).
  // A leg reads `actualOut === 0` when it is DEAD *or* simply not-yet-cranked, so
  // it only means "dead" on a READY_TO_CLOSE escrow (every leg is terminal — sold
  // or dead). Gating on `readyToClose` is essential: on a mid-crank (PARTIAL_OUT)
  // stall — the ordinary update-envelope path — the still-unfilled legs also read
  // 0, and treating them as dead would over-subtract their floors and slash
  // `min_usdc_out` far below the intended pct loosen.
  const isRedeem = live.mode === 1;
  const deadLegIdxs: number[] =
    isRedeem && live.readyToClose
      ? (live.actualOuts ?? [])
          .map((o, i) => (safeBig(o) === 0n ? i : -1))
          .filter((i) => i >= 0)
      : [];
  if (live.readyToClose && deadLegIdxs.length === 0) {
    // Genuinely nothing to loosen: a deposit (no USDC floor), or a redeem whose
    // legs all sold (realized already ≥ floor). Close, don't update-envelope.
    throw new Error(
      `Escrow is already READY to close (${live.legsFilled}/${live.legsTotal} legs filled) — ` +
        `call the deposit/redeem close path, not update-envelope.`,
    );
  }

  const loosenPct = opts.loosenPct ?? 5;
  // computeLoosenedMinOuts validates loosenPct (integer, 0..50) and throws on a
  // bad value — so the same `loosenPct` is safe to reuse for the USDC floor below.
  const newMinOuts = computeLoosenedMinOuts(live.minOuts, loosenPct);

  // Slippage may only LOOSEN (≥ current pinned), capped at the on-chain max.
  const requested = opts.newSlippageBps ?? live.slippageBps;
  const newSlippageBps = Math.min(MAX_SLIPPAGE_BPS, Math.max(live.slippageBps, requested));

  // Redeem-only NET-USDC floor: relax it by the same pct (≤ current; ≥0 allowed).
  let newMinUsdcOut: string | undefined;
  if (live.mode === 1) {
    const oldUsdc = BigInt(live.minUsdcOut || '0');
    if (oldUsdc > 0n) {
      // loosenPct is already validated as an integer by computeLoosenedMinOuts
      // above — use it directly (no Math.round, which would silently no-op a
      // fractional pct).
      let relaxed = (oldUsdc * BigInt(100 - loosenPct)) / 100n;
      // #64 — DEAD-LEG exact reduction. A dead leg realizes 0 USDC (paid in-kind),
      // so the net floor must drop by its pinned per-leg USDC contribution
      // (`minOuts[i]`) for the close to clear. Reducing by exactly the dead legs'
      // floors leaves a floor equal to the SURVIVING legs' floors — which those
      // legs provably met (they cleared their own `min_out` to fill). Take the MORE
      // relaxed of the pct path and this exact reduction: lower is always safe (the
      // exit fee is still taken on gross realized USDC at close), and it guarantees
      // the reverting `UsdcBelowMin` floor is actually cleared, not just softened.
      if (deadLegIdxs.length > 0) {
        let deadSum = 0n;
        for (const i of deadLegIdxs) deadSum += safeBig((live.minOuts ?? [])[i]);
        const byDeadLeg = oldUsdc > deadSum ? oldUsdc - deadSum : 0n;
        if (byDeadLeg < relaxed) relaxed = byDeadLeg;
      }
      if (relaxed > oldUsdc) relaxed = oldUsdc;
      newMinUsdcOut = relaxed.toString();
    } else {
      newMinUsdcOut = '0';
    }
  }

  const extendSecs = opts.extendSecs ?? 0;

  const prepared = await api.prepareUpdateEnvelopeV2(vault, {
    newMinOuts,
    newSlippageBps,
    newMinUsdcOut,
    extendSecs,
  });
  const signed = signBase64Transaction(config, prepared.transaction);
  const signature = await submitSignedTx(
    config,
    signed,
    prepared.blockhash,
    prepared.lastValidBlockHeight,
    { api, preparedTxId: prepared.preparedTxId },
  );

  return {
    ok: true,
    vault,
    signature,
    loosening: {
      oldMinOuts: live.minOuts,
      newMinOuts,
      oldSlippageBps: live.slippageBps,
      newSlippageBps,
      oldMinUsdcOut: live.mode === 1 ? live.minUsdcOut : undefined,
      newMinUsdcOut,
      extendSecs,
      loosenPct,
    },
    message:
      `Loosened the escrow floors by ${loosenPct}% (slippage ${live.slippageBps}→${newSlippageBps} bps` +
      `${extendSecs ? `, +${extendSecs}s expiry` : ''}). The orchestrator will retry the stuck legs. ` +
      `Poll zap_status — if it still won't fill, cancel to recover the holdings.`,
  };
}
