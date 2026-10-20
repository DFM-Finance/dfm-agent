/**
 * #57 reconfigure-drain resilience regression
 * (runnable: `npx tsx agent/src/manager-flow.reconfigure.test.ts`).
 *
 * The agent package has no jest runner — this is a self-contained assertion
 * script (exit 1 on failure), same pattern as `zap-v2-flow.pending.test.ts`.
 *
 * Locks the #57 (commit f99b870) `runReconfigure` drain control flow that shipped
 * WITHOUT a named regression test. The fix makes the removed-asset DRAIN phase
 * resilient to a mid-sequence blockhash expiry:
 *
 *   CASE A (TRANSIENT → re-prep): a `BlockhashExpiredError` from `submitConvergeLegs`
 *     mid-sequence is RECOVERABLE — `update_vault_assets` (the basket drop) has NOT
 *     run yet, so holdings are consistent and `prepareReconfigure` is idempotent.
 *     The driver re-calls `prepareReconfigure` for the REMAINING drains (≤4 rounds)
 *     and continues. `update_vault_assets` runs exactly ONCE, only AFTER all drains.
 *
 *   CASE B (NON-TRANSIENT → NO retry): a real revert (e.g. `0x1793`) is NOT retried
 *     — `prepareReconfigure` is called exactly ONCE (no double-drain), `runReconfigure`
 *     rejects, and the error message contains "RESUMABLE" guidance.
 *
 * To drive `submitConvergeLegs`'s outcome without the real signing/RPC stack, the
 * test uses the minimal `_deps` seam added to `runReconfigure` (injectable
 * `submitConvergeLegs` + `runUpdateVaultAssets`, both defaulting to the real fns so
 * production is byte-identical).
 */
import { runReconfigure } from './manager-flow.js';
import { BlockhashExpiredError } from './submit.js';
import type { ReconfigureResponse, ReconfigureTargetInput, ConvergeLegTx } from './types.js';

const VAULT = 'Vau1t1111111111111111111111111111111111111';
// Two real-ish mints; allocations must sum to 10000 (validateManagerBasket).
const MINT_KEEP = 'So11111111111111111111111111111111111111112';
const MINT_ADD = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TARGETS: ReconfigureTargetInput[] = [
  { mint: MINT_KEEP, symbol: 'SOL', allocationBps: 6000 },
  { mint: MINT_ADD, symbol: 'USDC', allocationBps: 4000 },
];

function drainLeg(i: number): ConvergeLegTx {
  return {
    kind: 'drain',
    inputMint: `Drain${i}1111111111111111111111111111111111111`.slice(0, 43),
    outputMint: MINT_ADD,
    amountIn: '1000000',
    minOut: '0',
    valueUsdc: 1,
    slippageBps: 300,
    transaction: 'AA==',
    blockhash: '11111111111111111111111111111111',
    lastValidBlockHeight: 1,
  };
}

function reconfigureResponse(drainTxs: ConvergeLegTx[]): ReconfigureResponse {
  return {
    vaultAddress: VAULT,
    gavUsdc: 100,
    plan: {
      diff: { reweight: [], add: [MINT_ADD], remove: ['DriX'], isCompositionChange: true },
      steps: [],
      reweight: [],
      maxSlippageBps: 300,
      gavUsdc: 100,
    },
    drainTxs,
    transactions: drainTxs.map((d) => d.transaction),
    preparedTxIds: drainTxs.map((_, i) => `prep-${i}`),
    note: '',
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

async function caseTransient(): Promise<void> {
  console.log('case A: TRANSIENT blockhash expiry mid-drain → re-prep remaining + continue');

  let prepareCalls = 0;
  // Round 1: two drain legs. Round 2 (after the transient): one remaining leg.
  const api = {
    prepareReconfigure: async () => {
      prepareCalls++;
      return prepareCalls === 1
        ? reconfigureResponse([drainLeg(1), drainLeg(2)])
        : reconfigureResponse([drainLeg(2)]); // one leg left
    },
  };

  let submitCalls = 0;
  let updateCalls = 0;
  const submitConvergeLegs = async (
    _c: unknown,
    _a: unknown,
    legs: ConvergeLegTx[],
  ): Promise<string[]> => {
    submitCalls++;
    if (submitCalls === 1) {
      // First call: expire mid-sequence (a transient, recoverable failure).
      throw new BlockhashExpiredError('Blockhash not found / window expired');
    }
    // Second call (round 2): the remaining drains land.
    return legs.map((_, i) => `drainSig-${submitCalls}-${i}`);
  };
  const runUpdateVaultAssets = async (): Promise<{
    ok: boolean;
    vault: string;
    signature: string;
    message: string;
  }> => {
    updateCalls++;
    return { ok: true, vault: VAULT, signature: 'updateSig111', message: 'updated' };
  };

  const res = await runReconfigure(
    {} as never,
    api as never,
    VAULT,
    TARGETS,
    300,
    { submitConvergeLegs: submitConvergeLegs as never, runUpdateVaultAssets: runUpdateVaultAssets as never },
  );

  assert(prepareCalls === 2, `prepareReconfigure called 2× (re-prepped remaining drains) — got ${prepareCalls}`);
  assert(submitCalls === 2, `submitConvergeLegs called 2× (retry after transient) — got ${submitCalls}`);
  assert(updateCalls === 1, `update_vault_assets ran exactly 1× — got ${updateCalls}`);
  assert(res.ok === true, `result.ok === true — got ${res.ok}`);
  // The basket drop ran AFTER the drains completed (1 update, both drain rounds done).
  assert(res.drainSignatures.length === 1, `drain signatures from the successful round — got ${res.drainSignatures.length}`);
}

async function caseNonTransient(): Promise<void> {
  console.log('case B: NON-TRANSIENT revert mid-drain → NO retry, reject with RESUMABLE guidance');

  let prepareCalls = 0;
  const api = {
    prepareReconfigure: async () => {
      prepareCalls++;
      return reconfigureResponse([drainLeg(1), drainLeg(2)]);
    },
  };

  let updateCalls = 0;
  const submitConvergeLegs = async (): Promise<string[]> => {
    // A real on-chain revert — NOT transient. Must NOT be retried.
    throw new Error('custom program error: 0x1793');
  };
  const runUpdateVaultAssets = async (): Promise<never> => {
    updateCalls++;
    throw new Error('update_vault_assets MUST NOT run after a failed drain');
  };

  let caught: Error | undefined;
  try {
    await runReconfigure(
      {} as never,
      api as never,
      VAULT,
      TARGETS,
      300,
      { submitConvergeLegs: submitConvergeLegs as never, runUpdateVaultAssets: runUpdateVaultAssets as never },
    );
  } catch (e) {
    caught = e as Error;
  }

  assert(caught !== undefined, 'runReconfigure rejected (did not silently succeed)');
  assert(prepareCalls === 1, `prepareReconfigure called exactly 1× (NO retry → no double-drain) — got ${prepareCalls}`);
  assert(updateCalls === 0, `update_vault_assets did NOT run (basket config unchanged) — got ${updateCalls}`);
  assert(
    !!caught && /RESUMABLE/.test(caught.message),
    `error message carries "RESUMABLE" guidance — got: ${caught?.message?.slice(0, 60)}…`,
  );
  assert(
    !!caught && /0x1793/.test(caught.message),
    'error message preserves the original on-chain revert',
  );
}

async function caseStagedUsdc(): Promise<void> {
  console.log('case C (#71): staged USDC-drop → update_vault_assets uses the PLAN newAssets (USDC@0% kept), not raw targets');
  const JITO = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
  const MSOL_M = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
  const USDC_M = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  // Reconfigure to [jitoSOL 50, mSOL 50] — USDC dropped from targets. The planner
  // STAGES it: keeps USDC as a declared 0% member in the plan's updateAssets step.
  const stagedTargets: ReconfigureTargetInput[] = [
    { mint: JITO, symbol: 'JITOSOL', allocationBps: 5000 },
    { mint: MSOL_M, symbol: 'MSOL', allocationBps: 5000 },
  ];
  const api = {
    prepareReconfigure: async () =>
      (({
        vaultAddress: VAULT,
        gavUsdc: 100,
        plan: {
          diff: { reweight: [JITO, USDC_M], add: [MSOL_M], remove: [], isCompositionChange: true },
          steps: [
            {
              kind: 'updateAssets',
              newAssets: [
                { mint: JITO, allocationBps: 5000 },
                { mint: MSOL_M, allocationBps: 5000 },
                { mint: USDC_M, allocationBps: 0 }, // ← the kept sleeve (#71)
              ],
              removedMints: [],
              addedMints: [MSOL_M],
              removedAssetVaultAtas: [],
            },
          ],
          reweight: [],
          maxSlippageBps: 300,
          gavUsdc: 100,
          usdcSleeveDeferredDrop: true,
        },
        drainTxs: [],
        transactions: [],
        preparedTxIds: [],
        note: '',
      }) as unknown as ReconfigureResponse),
  };
  let captured: Array<{ mint: string; mintBps: number }> = [];
  const submitConvergeLegs = async (): Promise<string[]> => []; // no drains (nothing removed)
  const runUpdateVaultAssets = async (
    _c: unknown,
    _a: unknown,
    _v: unknown,
    newAssets: Array<{ mint: string; mintBps: number }>,
  ) => {
    captured = newAssets;
    return { ok: true, vault: VAULT, signature: 'updateSigStaged', message: 'updated' };
  };
  const res = await runReconfigure({} as never, api as never, VAULT, stagedTargets, 300, {
    submitConvergeLegs: submitConvergeLegs as never,
    runUpdateVaultAssets: runUpdateVaultAssets as never,
  });
  assert(res.ok === true, 'reconfigure ok');
  assert(captured.length === 3, `update_vault_assets got 3 assets incl. the kept sleeve — got ${captured.length}`);
  const usdc = captured.find((a) => a.mint === USDC_M);
  assert(
    !!usdc && usdc.mintBps === 0,
    `USDC kept as a DECLARED 0% member (not dropped) — got ${JSON.stringify(usdc)}`,
  );
}

(async () => {
  await caseTransient();
  await caseNonTransient();
  await caseStagedUsdc();
  if (failures > 0) {
    console.error(`\n#57 reconfigure-drain regression FAILED (${failures} assertion(s))`);
    process.exit(1);
  }
  console.log('\n#57 reconfigure-drain regression PASSED');
})();
