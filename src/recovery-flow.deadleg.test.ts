/**
 * #64 regression (runnable: `npx tsx agent/src/recovery-flow.deadleg.test.ts`).
 *
 * A dead-legged REDEEM reaches READY_TO_CLOSE with an unsellable leg paid in-kind
 * (`actualOut = 0`). Its pinned `min_usdc_out` assumed EVERY leg sells, so the
 * realized USDC is below the floor and `zap_out_close_v2` reverts `UsdcBelowMin`
 * (6023). Before the fix, `runUpdateEnvelope` short-circuited on `readyToClose`
 * and refused the exact recovery it implements (lower `min_usdc_out`, then close).
 *
 * This asserts the NEW contract:
 *   1. a dead-legged redeem REACHES the update-envelope prepare (guard no longer
 *      blocks it);
 *   2. the new `min_usdc_out` is the DETERMINISTIC dead-leg reduction
 *      (`old − Σ dead-leg minOuts`), not a blind pct — and is low enough to clear;
 *   3. a CLEANLY-sold readyToClose redeem STILL throws "already ready" (nothing to
 *      loosen);
 *   4. a readyToClose DEPOSIT STILL throws "already ready".
 */
import { runUpdateEnvelope } from './recovery-flow.js';
import type { ZapV2Status } from './types.js';

const VAULT = 'Vau1t1111111111111111111111111111111111111';
const USER = 'User1111111111111111111111111111111111111111';
const ESCROW = 'Escrow11111111111111111111111111111111111111';

/** A 3-leg REDEEM at READY_TO_CLOSE; leg `deadIdx` was marked dead (actualOut 0). */
function deadLeggedRedeem(deadIdx: number | null): ZapV2Status {
  const minOuts = ['10000000', '7500000', '2079179']; // per-leg gross USDC floors
  const actualOuts =
    deadIdx === null
      ? ['10100000', '7600000', '2100000'] // all sold
      : minOuts.map((v, i) => (i === deadIdx ? '0' : String(Number(v) + 100_000)));
  return {
    escrowPda: ESCROW,
    vault: VAULT,
    user: USER,
    mode: 1, // redeem
    state: 5, // READY_TO_CLOSE
    nAssets: 3,
    assetMints: [],
    filledMask: 0x7, // 3/3 (sold or dead)
    legProgress: [],
    legsFilled: 3,
    legsTotal: 3,
    readyToClose: true,
    legFailures: [],
    openedAt: 0,
    expiresAt: 1_000,
    isExpired: true,
    slippageBps: 300,
    plannedAmountIn: [],
    minOuts,
    actualOuts,
    inputAmount: '0',
    sharesIn: '1000000',
    minSharesOut: '0',
    minUsdcOut: '19496890', // pinned assuming ALL legs sell
  };
}

function readyDeposit(): ZapV2Status {
  const s = deadLeggedRedeem(null);
  return { ...s, mode: 0, minUsdcOut: '0' };
}

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failures++;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

const STOP = '__STOP_BEFORE_SIGN__';

/** Run runUpdateEnvelope with a mock API that captures the prepare opts, then
 *  throws STOP so we never reach real signing/submit. Returns capture or the
 *  guard error message. */
async function driveCapture(
  status: ZapV2Status,
  opts: Parameters<typeof runUpdateEnvelope>[4] = {},
): Promise<{ captured?: { newMinUsdcOut?: string; newMinOuts: string[] }; err?: string }> {
  let captured: { newMinUsdcOut?: string; newMinOuts: string[] } | undefined;
  const mockApi = {
    getZapV2Status: async () => status,
    prepareUpdateEnvelopeV2: async (_v: string, o: { newMinUsdcOut?: string; newMinOuts: string[] }) => {
      captured = o;
      throw new Error(STOP);
    },
  };
  try {
    await runUpdateEnvelope({} as never, mockApi as never, USER, VAULT, opts);
    return { err: '(no throw — unexpected)' };
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === STOP) return { captured };
    return { err: msg };
  }
}

async function caseDeadLegRecovers(): Promise<void> {
  console.log('case: dead-legged redeem → guard passes, min_usdc_out reduced by dead leg');
  const { captured, err } = await driveCapture(deadLeggedRedeem(2));
  assert(!err, `reached prepare, no guard throw (got err='${err ?? ''}')`);
  // old 19,496,890 − dead-leg minOuts[2] 2,079,179 = 17,417,711 (more relaxed than
  // the 5% pct path 18,522,045, so it dominates).
  assert(
    captured?.newMinUsdcOut === '17417711',
    `newMinUsdcOut === '17417711' (deterministic dead-leg reduction) — got '${captured?.newMinUsdcOut}'`,
  );
  // The reduced floor must be ≤ realized net USDC (17,433,306 in the live #64 repro)
  // so zap_out_close_v2 clears instead of reverting UsdcBelowMin.
  assert(
    BigInt(captured?.newMinUsdcOut ?? '0') <= 17_433_306n,
    'reduced floor ≤ live realized USDC (17,433,306) → close clears',
  );
}

async function caseCleanRedeemStillBlocked(): Promise<void> {
  console.log('case: cleanly-sold readyToClose redeem → still blocked (nothing to loosen)');
  const { captured, err } = await driveCapture(deadLeggedRedeem(null));
  assert(captured === undefined, 'did NOT reach prepare');
  assert(!!err && /already READY to close/i.test(err), `threw "already ready" (got '${err}')`);
}

async function caseDepositStillBlocked(): Promise<void> {
  console.log('case: readyToClose deposit → still blocked');
  const { captured, err } = await driveCapture(readyDeposit());
  assert(captured === undefined, 'did NOT reach prepare');
  assert(!!err && /already READY to close/i.test(err), `threw "already ready" (got '${err}')`);
}

async function caseMidCrankNoDeadLegReduction(): Promise<void> {
  // C3 guard: a MID-CRANK (PARTIAL_OUT, not readyToClose) redeem with unfilled
  // legs (actualOut 0) must NOT be treated as dead-legged — only the pct loosen
  // applies. Otherwise the still-pending legs' floors get subtracted and
  // min_usdc_out is slashed far below the intended 5%.
  console.log('case: mid-crank redeem with unfilled legs → pct loosen only (no dead-leg reduction)');
  const mid = deadLeggedRedeem(2); // has an actualOut-0 leg…
  mid.readyToClose = false; // …but it's NOT ready → those 0s are "pending", not "dead"
  mid.state = 4; // PARTIAL_OUT
  const { captured, err } = await driveCapture(mid);
  assert(!err, `reached prepare (mid-crank loosen allowed) — got err='${err ?? ''}'`);
  // Pure 5% pct path: floor(19,496,890 * 95 / 100) = 18,522,045. The dead-leg
  // reduction (→17,417,711) must NOT have been applied.
  assert(
    captured?.newMinUsdcOut === '18522045',
    `newMinUsdcOut === '18522045' (pct-only, NOT dead-leg-reduced) — got '${captured?.newMinUsdcOut}'`,
  );
}

(async () => {
  await caseDeadLegRecovers();
  await caseCleanRedeemStillBlocked();
  await caseDepositStillBlocked();
  await caseMidCrankNoDeadLegReduction();
  if (failures > 0) {
    console.error(`\n#64 regression FAILED (${failures} assertion(s))`);
    process.exit(1);
  }
  console.log('\n#64 regression PASSED');
})();
