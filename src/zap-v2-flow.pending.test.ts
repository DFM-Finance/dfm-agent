/**
 * #61 regression (runnable: `npx tsx agent/src/zap-v2-flow.pending.test.ts`).
 *
 * The agent package has no jest runner — this is a self-contained assertion
 * script (exit 1 on failure) covering the #61 contract: when the poll window
 * elapses with the escrow STILL OPEN (or it auto-settled / disappeared), the
 * redeem flow must return `settlement:"pending"` (ok:true) WITHOUT calling the
 * close builder — NOT throw a hard error. On the OLD code `pollUntilReady` threw,
 * so `runRedeem` rejected and `prepareZapOutCloseV2` was never reached either;
 * here we assert the NEW resume-able contract: a resolved pending result + no
 * close attempt.
 */
import { runRedeem } from './zap-v2-flow.js';
import type { ZapV2Status } from './types.js';

const VAULT = 'Vau1t1111111111111111111111111111111111111';
const USER = 'User1111111111111111111111111111111111111111';
const ESCROW = 'Escrow11111111111111111111111111111111111111';

function openRedeemStatus(): ZapV2Status {
  return {
    escrowPda: ESCROW,
    vault: VAULT,
    user: USER,
    mode: 1, // redeem
    state: 4, // PARTIAL_OUT
    nAssets: 10,
    assetMints: [],
    filledMask: 0x1ff, // 9/10
    legProgress: [],
    legsFilled: 9,
    legsTotal: 10,
    readyToClose: false, // never ready within the window
    legFailures: [],
    openedAt: 0,
    expiresAt: 9_999_999_999,
    isExpired: false,
    slippageBps: 300,
    plannedAmountIn: [],
    minOuts: [],
    actualOuts: [],
    inputAmount: '0',
    sharesIn: '1000000',
    minSharesOut: '0',
    minUsdcOut: '0',
  };
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

async function caseTimeout(): Promise<void> {
  console.log('case: poll TIMEOUT with escrow still open → pending (no close)');
  let closeCalled = 0;
  const mockApi = {
    getZapV2Status: async () => openRedeemStatus(),
    prepareZapOutCloseV2: async () => {
      closeCalled++;
      return { transactions: [], blockhash: '', lastValidBlockHeight: 0, escrowPda: ESCROW };
    },
  };
  const res = await runRedeem(
    {} as never, // config — unused on the pending path
    mockApi as never,
    USER,
    VAULT,
    '1000000',
    { poll: { timeoutSecs: 0.3, intervalSecs: 0.1 } },
  );
  assert(res.ok === true, 'result.ok === true (not an error)');
  assert(res.settlement === 'pending', `settlement === 'pending' (got '${res.settlement}')`);
  assert(res.closeSignatures.length === 0, 'no close signatures');
  assert(closeCalled === 0, 'prepareZapOutCloseV2 was NOT called');
  assert(res.pending?.reason === 'timeout', `pending.reason === 'timeout' (got '${res.pending?.reason}')`);
  assert(res.pending?.legsFilled === 9 && res.pending?.legsTotal === 10, 'pending carries 9/10 legs');
}

async function caseGone(): Promise<void> {
  console.log('case: escrow GONE during poll (auto-settled) → pending/gone (no throw)');
  let calls = 0;
  const mockApi = {
    // resume guard (call 0) + first poll (call 1) see the escrow OPEN, then it
    // disappears (call 2+) = a genuine mid-poll settle. The guard requires having
    // seen it open before concluding 'gone' (so a not-yet-propagated fresh escrow
    // isn't mis-reported) — realistic settle must show it open first.
    getZapV2Status: async () => (calls++ < 2 ? openRedeemStatus() : null),
    prepareZapOutCloseV2: async () => {
      throw new Error('close must not be called on gone');
    },
  };
  const res = await runRedeem(
    {} as never,
    mockApi as never,
    USER,
    VAULT,
    '1000000',
    { poll: { timeoutSecs: 5, intervalSecs: 0.1 } },
  );
  assert(res.ok === true, 'result.ok === true');
  assert(res.settlement === 'pending', `settlement === 'pending' (got '${res.settlement}')`);
  assert(res.pending?.reason === 'gone', `pending.reason === 'gone' (got '${res.pending?.reason}')`);
}

async function caseFreshNullNotGone(): Promise<void> {
  console.log('case: null reads WITHOUT ever seeing the escrow open → timeout, NOT gone (race ⑥ guard)');
  let calls = 0;
  const mockApi = {
    // resume guard (call 0) sees it open; every poll read after is null BEFORE the
    // poll loop ever observes it open itself (propagation blip / not-yet-visible).
    // The fix must NOT declare 'gone' here — it keeps waiting → 'timeout'. The OLD
    // code returned 'gone' on the first null, mis-reporting a live escrow as settled.
    getZapV2Status: async () => (calls++ === 0 ? openRedeemStatus() : null),
    prepareZapOutCloseV2: async () => {
      throw new Error('close must not be called');
    },
  };
  const res = await runRedeem(
    {} as never,
    mockApi as never,
    USER,
    VAULT,
    '1000000',
    { poll: { timeoutSecs: 0.3, intervalSecs: 0.1 } },
  );
  assert(res.settlement === 'pending', `settlement === 'pending' (got '${res.settlement}')`);
  assert(res.pending?.reason === 'timeout', `reason === 'timeout' not 'gone' (got '${res.pending?.reason}')`);
}

async function caseRedeemResumeUsesPinnedShares(): Promise<void> {
  console.log('case: resumed redeem reports escrow-pinned shares, not the new request');
  const pinnedShares = '2000000';
  const status = { ...openRedeemStatus(), sharesIn: pinnedShares, readyToClose: true };
  let openCalled = 0;
  const mockApi = {
    getZapV2Status: async () => status,
    prepareZapOutOpenV2: async () => {
      openCalled++;
      throw new Error('resume must not open a second redeem escrow');
    },
    // No transactions keeps this assertion script offline while still driving
    // the complete-result message path after the ready escrow is resumed.
    prepareZapOutCloseV2: async () => ({
      transactions: [],
      blockhash: '',
      lastValidBlockHeight: 0,
      escrowPda: ESCROW,
    }),
  };
  const res = await runRedeem(
    {} as never,
    mockApi as never,
    USER,
    VAULT,
    '1000000',
    { poll: { timeoutSecs: 1, intervalSecs: 0.1 } },
  );
  assert(res.settlement === 'complete', `settlement === 'complete' (got '${res.settlement}')`);
  assert(openCalled === 0, 'prepareZapOutOpenV2 was NOT called');
  assert(res.message.includes('requested 1000000 raw shares were NOT used'), 'message rejects the new requested amount');
  assert(res.message.includes(`pinned at ${pinnedShares} raw shares`), 'message names the escrow-pinned amount');
  assert(res.message.includes(`Redeem complete: ${pinnedShares} raw shares`), 'completion reports the pinned amount');
}

(async () => {
  await caseTimeout();
  await caseGone();
  await caseFreshNullNotGone();
  await caseRedeemResumeUsesPinnedShares();
  if (failures > 0) {
    console.error(`\n#61 regression FAILED (${failures} assertion(s))`);
    process.exit(1);
  }
  console.log('\n#61 regression PASSED');
})();
