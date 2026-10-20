/**
 * Zap-v2 deposit/redeem LIFECYCLE driver (the real-money WRITE path).
 *
 * ⚠️ GATED. Reachable only when DFM_AGENT_WRITE_ENABLED=true. Every method here
 * moves real funds on mainnet. The parent must review before enabling.
 * REVIEW: real-money path — parent must review before enabling.
 *
 * ─── Why a driver (not a single call) ──────────────────────────────────────
 * zap-v2 is a STATEFUL lifecycle, NOT a one-shot. The Jupiter swaps run as
 * PERMISSIONLESS per-leg cranks executed by the BACKEND orchestrator
 * (ZapSwapOrchestratorService) — the agent does NOT crank them. The agent only
 * signs the two user-side boundary transactions:
 *
 *   DEPOSIT (zap-in):
 *     1. POST zap-in-v2/open/prepare  → sign+submit  (pulls USDC, pins plan,
 *        creates escrow + per-asset ATAs)
 *     2. POLL  zap-v2/status/:user until `readyToClose` (orchestrator cranks the
 *        USDC→asset legs server-side; `filledMask` fills in)
 *     3. POST zap-in-v2/close/prepare → sign+submit  (CPI mint_in_kind_v2,
 *        forward shares, close escrow)
 *
 *   REDEEM (zap-out):
 *     1. POST zap-out-v2/open/prepare → sign+submit  (burn shares → escrow
 *        basket via finalize_redeem_in_kind, pin plan)
 *     2. POLL  zap-v2/status/:user until `readyToClose` (orchestrator cranks the
 *        asset→USDC legs)
 *     3. POST zap-out-v2/close/prepare → sign+submit (exit fee, pay net USDC)
 *
 * If a deposit/redeem STALLS mid-crank (a leg can't meet its pinned floor), the
 * recovery levers are `update-envelope` (loosen floors) or `cancel` (return
 * escrow holdings as-is). Those are EXPOSED as separate tools, not auto-driven
 * here — recovery is an operator decision, not something to silently retry.
 * ───────────────────────────────────────────────────────────────────────────
 */
import type { AgentConfig } from './config.js';
import type { DfmApiClient } from './api-client.js';
import type { ZapV2Status, ZapV2PrepareResponse } from './types.js';
import { signBase64Transaction } from './signing.js';
import {
  submitSignedTxsSequential,
  BlockhashExpiredError,
  BroadcastUnconfirmedError,
} from './submit.js';

export interface ZapFlowResult {
  ok: boolean;
  vault: string;
  /** 'deposit' | 'redeem' */
  kind: 'deposit' | 'redeem';
  /**
   * #61 — 'complete' = escrow closed/settled (shares minted / USDC paid).
   * 'pending' = the poll window elapsed but the escrow is STILL OPEN and
   * self-healing (the backend orchestrator keeps cranking) — this is NOT a
   * failure; call the same tool again (same args) to RESUME polling to close.
   */
  settlement: 'complete' | 'pending';
  openSignatures: string[];
  closeSignatures: string[];
  escrowPda: string;
  /** Final escrow status snapshot just before close (for diagnostics). */
  finalStatus?: ZapV2Status | null;
  /** Present only when settlement==='pending' — progress + why it's pending. */
  pending?: { reason: 'timeout' | 'expired' | 'gone'; legsFilled: number; legsTotal: number };
  message: string;
}

interface PollOptions {
  /** Max seconds to wait for the orchestrator to fill all legs. */
  timeoutSecs: number;
  /** Seconds between status polls. */
  intervalSecs: number;
}

// #61 — default poll window. Was 180s; a 10-asset redeem with a slow/retrying
// leg (e.g. ORCA→USDC) can take many minutes to self-heal, so a hard error at
// 180/300s misreported a still-settling redeem as failed. Raised to 600s, and on
// timeout we now return `pending` (resume-able) instead of throwing.
const DEFAULT_POLL: PollOptions = { timeoutSecs: 600, intervalSecs: 4 };

/** Outcome of {@link pollUntilReady} — ready, or a non-fatal reason to surface as pending. */
type PollResult =
  | { ready: true; status: ZapV2Status }
  | { ready: false; reason: 'timeout' | 'expired' | 'gone'; status: ZapV2Status | null };

async function sleep(secs: number): Promise<void> {
  await new Promise((r) => setTimeout(r, secs * 1000));
}

/** Sign every tx in a prepare response locally, submit them in order. When no
 *  client RPC is configured, submit via the backend (#18) using the API-stamped
 *  preparedTxIds; a configured HELIUS_RPC_URL still does a direct submit. */
async function signAndSubmit(
  config: AgentConfig,
  prepared: ZapV2PrepareResponse,
  api: DfmApiClient,
): Promise<string[]> {
  const signed = prepared.transactions.map((t) => signBase64Transaction(config, t));
  return submitSignedTxsSequential(
    config,
    signed,
    prepared.blockhash,
    prepared.lastValidBlockHeight,
    { api, preparedTxIds: prepared.preparedTxIds },
  );
}

/**
 * Submit the OPEN side. On blockhash expiry we DON'T auto-retry (the open pulls
 * funds + creates the escrow — re-running blindly could double-open), but we
 * rewrite the error into an actionable hint: check zap_status to see whether an
 * escrow was created (poll → close) or not (safe to re-run the deposit/redeem).
 */
async function submitOpen(
  config: AgentConfig,
  prepared: ZapV2PrepareResponse,
  kind: 'deposit' | 'redeem',
  api: DfmApiClient,
): Promise<string[]> {
  try {
    return await signAndSubmit(config, prepared, api);
  } catch (e) {
    if (e instanceof BlockhashExpiredError) {
      throw new Error(
        `The ${kind} OPEN tx did not confirm before its blockhash expired. Check zap_status: ` +
          `if an escrow now EXISTS, the open landed — poll it then close (re-run this ${kind} call ` +
          `once an escrow is open will resume it); if NO escrow exists, nothing happened and it is ` +
          `safe to re-run the ${kind}. Original: ${e.message}`,
      );
    }
    // Backend broadcast the OPEN but it did NOT confirm inside the API window. The
    // open pulls funds + Anchor-`init`s the escrow, so it MAY still land — a blind
    // re-run could double-pull before the escrow becomes visible. Do NOT re-run
    // immediately: verify the broadcast signature on-chain first, THEN use
    // zap_status (the deposit/redeem resume-guard keys off an existing escrow, so a
    // re-run is only safe once that escrow is visible OR the open is confirmed dead).
    if (e instanceof BroadcastUnconfirmedError) {
      throw new Error(
        `The ${kind} OPEN tx ${e.signature} was broadcast but did NOT confirm in time — it may ` +
          `still land. Do NOT blindly re-run (the open pulls funds + creates the escrow; a duplicate ` +
          `could double-pull). First verify ${e.signature} onchain: if it LANDED, an escrow now ` +
          `exists — re-run this ${kind} to resume (poll → close); if it truly DROPPED (sig not found), ` +
          `it is safe to re-run the ${kind}. Original: ${e.message}`,
      );
    }
    throw e;
  }
}

/** A transient server-side close error (5xx) — safe to re-prepare after a wait. */
const CLOSE_RETRYABLE_5XX = /DFM API 5\d\d /;

/**
 * Run the CLOSE side with a retry. The escrow is already READY_TO_CLOSE here, so
 * re-preparing + re-signing the close is safe and idempotent (it does NOT re-pull
 * funds; the oracle-free close mints/pays pro-rata against the already-filled
 * escrow). We retry three transient classes; an on-chain revert / 4xx is surfaced
 * immediately:
 *   - blockhash expiry → re-prepare straight away (escrow stays ready);
 *   - a transient 5xx → WAIT `retryDelaySecs`, then re-prepare. This rides out a
 *     momentary backend/RPC hiccup so the deposit/redeem-close doesn't force a
 *     manual re-run;
 *   - a broadcast-but-unconfirmed close → the close MAY have landed (escrow then
 *     gone). Probe `confirmClosed()` first: if the escrow is gone the close
 *     succeeded (return that signature); otherwise the escrow is still READY, so
 *     re-prepare + retry (idempotent — no double-mint/double-pay).
 */
async function closeWithRetry(
  config: AgentConfig,
  api: DfmApiClient,
  prepareClose: () => Promise<ZapV2PrepareResponse>,
  confirmClosed?: () => Promise<boolean>,
  attempts = 6,
  retryDelaySecs = 10,
): Promise<string[]> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const close = await prepareClose();
      return await signAndSubmit(config, close, api);
    } catch (e) {
      if (e instanceof BlockhashExpiredError) {
        lastErr = e;
        continue; // re-prepare with a fresh blockhash; escrow stays ready.
      }
      if (e instanceof BroadcastUnconfirmedError) {
        lastErr = e;
        // The broadcast may have actually landed. If the escrow is now gone, the
        // close succeeded — return the broadcast signature instead of retrying
        // (a retry would clean-fail "escrow not found" and mask the success).
        if (confirmClosed && (await confirmClosed())) {
          return [e.signature];
        }
        if (i < attempts - 1) {
          await sleep(retryDelaySecs); // escrow still READY → re-prepare + retry
          continue;
        }
        throw e;
      }
      if (e instanceof Error && CLOSE_RETRYABLE_5XX.test(e.message) && i < attempts - 1) {
        lastErr = e;
        await sleep(retryDelaySecs); // ride out the transient
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `Close did not confirm within ${attempts} attempts (last: ${lastErr?.message}). ` +
      `The escrow is still READY — re-run the same deposit/redeem call to retry the close, ` +
      `or inspect with zap_status.`,
  );
}

/**
 * Poll `zap-v2/status` until the escrow is `readyToClose`, it expires, it
 * disappears (settled/cancelled), or we time out. #61: returns a structured
 * {@link PollResult} — it NO LONGER throws on timeout/expiry, so the caller can
 * surface a resume-able `pending` instead of a misleading hard error (a redeem
 * that out-runs the poll window is still self-healing, not failed).
 */
async function pollUntilReady(
  api: DfmApiClient,
  vault: string,
  user: string,
  poll: PollOptions,
): Promise<PollResult> {
  const deadline = Date.now() + poll.timeoutSecs * 1000;
  let last: ZapV2Status | null = null;
  let sawOpen = false; // have we observed the escrow OPEN at least once this poll?
  while (Date.now() < deadline) {
    last = await api.getZapV2Status(vault, user);
    if (!last) {
      // A null read is ambiguous: (a) the escrow SETTLED + closed (the backend
      // keeper finished it — the #61 success case), OR (b) a freshly-opened escrow
      // hasn't propagated to this RPC node yet (create→use race, failure-class ⑥).
      // Only conclude 'gone/settled' once we've ACTUALLY seen it open this poll;
      // otherwise it's still propagating — keep waiting (falls through to 'timeout'
      // if it truly never appears). This stops a just-opened deposit from being
      // mis-reported as "settled automatically" while the funds sit in escrow.
      if (sawOpen) return { ready: false, reason: 'gone', status: null };
      await sleep(poll.intervalSecs);
      continue;
    }
    sawOpen = true;
    if (last.readyToClose) return { ready: true, status: last };
    if (last.isExpired) return { ready: false, reason: 'expired', status: last };
    await sleep(poll.intervalSecs);
  }
  return { ready: false, reason: 'timeout', status: last };
}

/** Build the non-fatal `pending` ZapFlowResult (#61) — escrow still open / self-healing. */
function pendingResult(
  kind: 'deposit' | 'redeem',
  vault: string,
  escrowPda: string,
  openSignatures: string[],
  pr: Extract<PollResult, { ready: false }>,
): ZapFlowResult {
  const legsFilled = pr.status?.legsFilled ?? 0;
  const legsTotal = pr.status?.legsTotal ?? 0;
  const verb = kind === 'redeem' ? 'redeem' : 'deposit';
  const why =
    pr.reason === 'gone'
      ? `The escrow is no longer open — most likely it SETTLED (the backend keeper closed it ` +
        `after cranking the legs) or was cancelled. Verify with get_portfolio / your balances ` +
        `before assuming completion.`
      : pr.reason === 'expired'
        ? `The escrow passed its expiry with ${legsFilled}/${legsTotal} legs filled. The backend ` +
          `stall-recovery may STILL settle it automatically (it loosens floors + extends expiry) — ` +
          `call ${verb} again (same args) to resume polling. If it stays stuck, use ` +
          `zap_v2_update_envelope (loosen floors) or zap_v2_cancel (recover holdings).`
        : `Still cranking: ${legsFilled}/${legsTotal} legs filled. The escrow is OPEN and ` +
          `self-healing — this is NOT a failure. Call ${verb} again (same args) to RESUME polling ` +
          `to completion (consider a larger pollTimeoutSecs), or inspect with zap_status.`;
  return {
    ok: true,
    vault,
    kind,
    settlement: 'pending',
    openSignatures,
    closeSignatures: [],
    escrowPda,
    finalStatus: pr.status ?? null,
    pending: { reason: pr.reason, legsFilled, legsTotal },
    message: `${verb.toUpperCase()} PENDING (not failed). ${why}`,
  };
}

/**
 * Drive a full DEPOSIT (USDC → basket → shares). `usdcAmountRaw` is 6-dp raw
 * units (e.g. "12000000" = $12). Returns when shares are minted (close confirmed)
 * or throws with a recovery hint.
 */
export async function runDeposit(
  config: AgentConfig,
  api: DfmApiClient,
  user: string,
  vault: string,
  usdcAmountRaw: string,
  opts?: { slippageBps?: number; expirySecs?: number; poll?: Partial<PollOptions> },
): Promise<ZapFlowResult> {
  const poll = { ...DEFAULT_POLL, ...(opts?.poll ?? {}) };

  // 0. RESUME GUARD — if an escrow is ALREADY open for this (vault, user), don't
  //    re-open (the escrow PDA is Anchor-`init` → a second open reverts, and we'd
  //    risk double-pulling USDC). Resume it: poll → close. This makes the deposit
  //    call idempotent against a prior open whose close never landed.
  const existing = await api.getZapV2Status(vault, user);
  let openSignatures: string[] = [];
  let escrowPda: string;
  // Set when resuming an open escrow whose pinned input amount differs from the
  // amount this call requested (the requested amount is NOT honored on resume).
  let resumedPinnedAmount: string | null = null;
  if (existing) {
    if (existing.mode !== 0) {
      throw new Error(
        `An open REDEEM escrow already exists for this vault+wallet — cancel or finish it ` +
          `(zap_v2_cancel / redeem) before depositing.`,
      );
    }
    escrowPda = existing.escrowPda;
    // The existing escrow's input amount was PINNED at its open; resuming
    // completes THAT amount and ignores the `usdcAmountRaw` just requested.
    // Surface the mismatch loudly so a caller acting on the requested size
    // isn't misled into thinking a different amount was deposited.
    if (existing.inputAmount && existing.inputAmount !== usdcAmountRaw) {
      resumedPinnedAmount = existing.inputAmount;
    }
  } else {
    // 1. OPEN — pull USDC into escrow, pin the plan.
    const open = await api.prepareZapInOpenV2(vault, usdcAmountRaw, {
      slippageBps: opts?.slippageBps,
      expirySecs: opts?.expirySecs,
    });
    openSignatures = await submitOpen(config, open, 'deposit', api);
    escrowPda = open.escrowPda;
  }

  // 2. POLL — wait for the backend orchestrator to crank every USDC→asset leg.
  //    #61: on timeout/expiry/auto-settle, return a resume-able `pending` rather
  //    than throwing — the escrow keeps self-healing.
  const pr = await pollUntilReady(api, vault, user, poll);
  if (!pr.ready) return pendingResult('deposit', vault, escrowPda, openSignatures, pr);
  const ready = pr.status;

  // 3. CLOSE — mint_in_kind_v2, forward shares, close escrow. Retries on
  //    blockhash expiry (escrow stays READY between attempts).
  const closeSignatures = await closeWithRetry(
    config,
    api,
    () => api.prepareZapInCloseV2(vault),
    async () => !(await api.getZapV2Status(vault, user)),
  );

  return {
    ok: true,
    vault,
    kind: 'deposit',
    settlement: 'complete',
    openSignatures,
    closeSignatures,
    escrowPda,
    finalStatus: ready,
    message:
      (existing ? 'Resumed an already-open deposit escrow. ' : '') +
      (resumedPinnedAmount
        ? `NOTE: the requested ${usdcAmountRaw} raw USDC was NOT used — the resumed escrow ` +
          `was pinned at ${resumedPinnedAmount} raw USDC at its open, and that is the amount ` +
          `deposited. Cancel first (zap_v2_cancel) to deposit a different amount. `
        : '') +
      `Deposit complete: ${resumedPinnedAmount ?? usdcAmountRaw} raw USDC → vault ${vault.slice(0, 8)}…. Shares minted.`,
  };
}

/**
 * Drive a full REDEEM (shares → basket → USDC). `sharesRaw` is 6-dp raw units.
 * Returns when net USDC is paid (close confirmed) or throws with a recovery hint.
 */
export async function runRedeem(
  config: AgentConfig,
  api: DfmApiClient,
  user: string,
  vault: string,
  sharesRaw: string,
  opts?: { slippageBps?: number; expirySecs?: number; poll?: Partial<PollOptions> },
): Promise<ZapFlowResult> {
  const poll = { ...DEFAULT_POLL, ...(opts?.poll ?? {}) };

  // 0. RESUME GUARD — mirror the deposit path: if a redeem escrow is already
  //    open, resume it rather than re-burning shares into a second escrow.
  const existing = await api.getZapV2Status(vault, user);
  let openSignatures: string[] = [];
  let escrowPda: string;
  // Set when resuming an open escrow whose pinned share amount differs from
  // this call. The existing escrow wins; opening it already burned shares and
  // fixed `sharesIn`, so the new request cannot resize the in-flight redeem.
  let resumedPinnedShares: string | null = null;
  if (existing) {
    if (existing.mode !== 1) {
      throw new Error(
        `An open DEPOSIT escrow already exists for this vault+wallet — finish or cancel it ` +
          `(deposit / zap_v2_cancel) before redeeming.`,
      );
    }
    escrowPda = existing.escrowPda;
    if (existing.sharesIn && existing.sharesIn !== sharesRaw) {
      resumedPinnedShares = existing.sharesIn;
    }
  } else {
    // 1. OPEN — burn shares → escrow basket (oracle-free pro-rata), pin the plan.
    const open = await api.prepareZapOutOpenV2(vault, sharesRaw, {
      slippageBps: opts?.slippageBps,
      expirySecs: opts?.expirySecs,
    });
    openSignatures = await submitOpen(config, open, 'redeem', api);
    escrowPda = open.escrowPda;
  }

  // 2. POLL — wait for the orchestrator to crank every asset→USDC leg.
  //    #61: a slow/retrying leg (e.g. ORCA→USDC) can self-heal over many minutes;
  //    on timeout/expiry/auto-settle return a resume-able `pending`, not an error.
  const pr = await pollUntilReady(api, vault, user, poll);
  if (!pr.ready) return pendingResult('redeem', vault, escrowPda, openSignatures, pr);
  const ready = pr.status;

  // 3. CLOSE — apply exit fee, pay net USDC, close escrow. Retries on blockhash
  //    expiry (escrow stays READY between attempts).
  const closeSignatures = await closeWithRetry(
    config,
    api,
    () => api.prepareZapOutCloseV2(vault),
    async () => !(await api.getZapV2Status(vault, user)),
  );

  return {
    ok: true,
    vault,
    kind: 'redeem',
    settlement: 'complete',
    openSignatures,
    closeSignatures,
    escrowPda,
    finalStatus: ready,
    message:
      (existing ? 'Resumed an already-open redeem escrow. ' : '') +
      (resumedPinnedShares
        ? `NOTE: the requested ${sharesRaw} raw shares were NOT used — the resumed escrow ` +
          `was pinned at ${resumedPinnedShares} raw shares at its open, and that is the amount ` +
          `redeemed. Cancel first (zap_v2_cancel) to redeem a different amount. `
        : '') +
      `Redeem complete: ${resumedPinnedShares ?? sharesRaw} raw shares from vault ${vault.slice(0, 8)}…. Net USDC paid.`,
  };
}
