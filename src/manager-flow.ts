/**
 * Vault manager lifecycle drivers for basket changes, rebalancing and admin
 * handoffs. (Policy edits are closed until Policy v2, #118.)
 *
 * ⚠️ GATED behind DFM_AGENT_WRITE_ENABLED. SECURITY MODEL:
 *   - Admin actions require the acting signer to administer the vault. Acceptance
 *     instead requires that signer to equal the pending new admin.
 *   - Basket limits are checked by this package, the API, and chain.
 *   - Admin handoffs and basket redirections are exposed as explicit-human-only
 *     MCP tools.
 * REVIEW: real-money / control path — parent must review before enabling.
 */
import type { AgentConfig } from './config.js';
import type { DfmApiClient } from './api-client.js';
import type {
  CreateAssetInput,
  ConvergeLegTx,
  ReconfigureTargetInput,
  ZapV2SingleTxResponse,
} from './types.js';
import { signBase64Transaction } from './signing.js';
import { submitSignedTx, BlockhashExpiredError } from './submit.js';

/** On-chain rebalance cooldown (5s) — keep a small margin so back-to-back legs
 *  never trip `HARD_MIN_REBALANCE_INTERVAL_SECS`. */
const REBALANCE_COOLDOWN_MS = 6_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MAX_ASSETS = 10; // mainnet basket cap (matches the API + create flow, #67)

export interface UpdateAssetsResult {
  ok: boolean;
  vault: string;
  signature: string;
  /** Set when /assets/confirm failed AFTER the tx landed (cache lag, not a loss). */
  confirmError?: string;
  message: string;
}

export interface TransferAdminResult {
  ok: boolean;
  vault: string;
  signature: string;
  newAdmin: string;
  message: string;
}

export interface AcceptAdminTransferResult {
  ok: true;
  reconciled: true;
  vault: string;
  signature: string;
  vaultAdmin: string;
  message: string;
}

export interface InitRebalancerResult {
  ok: boolean;
  vault: string;
  signature: string;
  rebalancerConfig?: string;
  message: string;
}

export interface RebalanceToTargetsResult {
  ok: boolean;
  vault: string;
  converged: boolean;
  legCount: number;
  /** One signature per submitted converge leg, in order. */
  signatures: string[];
  legs: Array<{
    inputMint: string;
    outputMint: string;
    amountIn: string;
    valueUsdc: number;
    signature?: string;
  }>;
  message: string;
}

export interface ReconfigureResult {
  ok: boolean;
  vault: string;
  /** Signatures of the DRAIN legs submitted (the removed assets → ~0). */
  drainSignatures: string[];
  diff: { add: string[]; remove: string[]; reweight: string[] };
  /** The full-replace target basket submitted via update_vault_assets. */
  newAssets: Array<{ mint: string; allocationBps: number }>;
  message: string;
}

/**
 * Validate a FULL-REPLACE product basket client-side: 2..10
 * assets, allocations sum to exactly 10000 bps, no duplicate mints, each weight
 * 1..10000. Fast, clear failures before the network round-trip.
 */
export function validateManagerBasket(assets: CreateAssetInput[]): void {
  if (!assets || assets.length < 2) {
    throw new Error('update_vault_assets needs at least 2 basket assets.');
  }
  if (assets.length > MAX_ASSETS) {
    throw new Error(
      `Basket has ${assets.length} assets — the mainnet cap is ${MAX_ASSETS}.`,
    );
  }
  const sum = assets.reduce((acc, a) => acc + a.mintBps, 0);
  if (sum !== 10_000) {
    throw new Error(
      `Basket allocations must sum to exactly 10000 bps; got ${sum}. ` +
        `(${assets.map((a) => `${a.symbol}=${a.mintBps}`).join(', ')})`,
    );
  }
  const seen = new Set<string>();
  for (const a of assets) {
    // 0 IS allowed (board #16): the staged "replace funded assets" migration keeps
    // an old asset at 0% target so it stays in the basket to be rebalanced down to
    // zero before final removal (update_vault_assets rejects removing a still-funded
    // asset). The on-chain + API path already accept 0 bps; the sum-10000 check above
    // guarantees at least one positive-weight asset.
    if (!Number.isInteger(a.mintBps) || a.mintBps < 0 || a.mintBps > 10_000) {
      throw new Error(`Asset ${a.symbol} has invalid mintBps ${a.mintBps} (must be 0..10000).`);
    }
    if (seen.has(a.mint)) {
      throw new Error(`Duplicate mint in the basket: ${a.mint}.`);
    }
    seen.add(a.mint);
  }
}

/**
 * Rebalance the vault's basket — a FULL REPLACE with the new target weights.
 * Only works on a vault the test wallet admins, in MANUAL rebalance mode, outside
 * the 24h config timelock (the API returns a clear 4xx otherwise). prepare → sign
 * → submit → confirm (confirm is bookkeeping: on failure the on-chain change still
 * stands, surfaced as confirmError so it's never silently lost).
 */
export async function runUpdateVaultAssets(
  config: AgentConfig,
  api: DfmApiClient,
  vault: string,
  assets: CreateAssetInput[],
): Promise<UpdateAssetsResult> {
  validateManagerBasket(assets);

  const prepared = await api.prepareUpdateAssets(vault, assets);
  const signed = signBase64Transaction(config, prepared.transaction);
  const signature = await submitSignedTx(
    config,
    signed,
    prepared.blockhash,
    prepared.lastValidBlockHeight,
    { api, preparedTxId: prepared.preparedTxId },
  );

  try {
    await api.confirmUpdateAssets(vault, signature);
  } catch (e) {
    return {
      ok: true, // the onchain change LANDED; only the cache refresh failed.
      vault,
      signature,
      confirmError: (e as Error).message,
      message:
        `Basket replaced onchain (tx ${signature.slice(0, 16)}…) but /assets/confirm ` +
        `failed: ${(e as Error).message}. The change IS live onchain; the API cache ` +
        `will reconcile shortly (or retry confirm).`,
    };
  }

  return {
    ok: true,
    vault,
    signature,
    message:
      `Vault ${vault.slice(0, 8)}… basket replaced with ${assets.length} asset(s) ` +
      `(${assets.map((a) => `${a.symbol}=${a.mintBps}`).join(', ')}). Tx ${signature.slice(0, 16)}….`,
  };
}

type ControlFlowDependencies = {
  signBase64Transaction?: typeof signBase64Transaction;
  submitSignedTx?: typeof submitSignedTx;
};

const LANDED_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

function requireLandedSignature(signature: string): void {
  if (!LANDED_SIGNATURE.test(signature)) {
    throw new Error('landedSignature must be a 64-96 character base58 transaction signature.');
  }
}

async function signAndSubmitControlTransaction(
  config: AgentConfig,
  api: DfmApiClient,
  prepared: ZapV2SingleTxResponse,
  dependencies?: ControlFlowDependencies,
): Promise<string> {
  const sign = dependencies?.signBase64Transaction ?? signBase64Transaction;
  const submit = dependencies?.submitSignedTx ?? submitSignedTx;
  const signed = sign(config, prepared.transaction);
  return submit(
    config,
    signed,
    prepared.blockhash,
    prepared.lastValidBlockHeight,
    { api, preparedTxId: prepared.preparedTxId },
  );
}

/**
 * Complete a pending admin handoff and reconcile the new authority from chain.
 * A previously landed signature can be supplied to retry only reconciliation.
 */
export async function runAcceptAdminTransfer(
  config: AgentConfig,
  api: DfmApiClient,
  vault: string,
  landedSignature?: string,
  dependencies?: ControlFlowDependencies,
): Promise<AcceptAdminTransferResult> {
  let signature = landedSignature;
  if (signature) {
    requireLandedSignature(signature);
  } else {
    const prepared = await api.prepareAcceptAdminTransfer(vault);
    signature = await signAndSubmitControlTransaction(config, api, prepared, dependencies);
  }

  let confirmed: Awaited<ReturnType<DfmApiClient['confirmAcceptAdminTransfer']>>;
  try {
    confirmed = await api.confirmAcceptAdminTransfer(vault, signature);
  } catch (thrownObject) {
    const reason = thrownObject instanceof Error ? thrownObject.message : String(thrownObject);
    throw new Error(
      `Admin acceptance transaction ${signature} landed, but post-chain confirmation failed: ${reason}. ` +
        `Do not submit another acceptance. Retry accept_admin_transfer with landedSignature=${signature}.`,
    );
  }

  return {
    ok: true,
    reconciled: true,
    vault,
    signature,
    vaultAdmin: confirmed.vaultAdmin,
    message:
      `Admin transfer accepted onchain and reconciled. Vault ${vault.slice(0, 8)}… ` +
      `is now administered by ${confirmed.vaultAdmin.slice(0, 8)}….`,
  };
}

/**
 * #57 — RECONFIGURE: set NEW targets then converge, one admin-signed order-aware
 * flow. The API returns the ordered plan + pre-prepared DRAIN txs (sells removed
 * assets to ~0 WHILE still in-basket). This driver: (1) submits the drains in
 * order, then (2) submits the full-replace `update_vault_assets` (drops the
 * drained mints, registers added ones), then (3) leaves the caller to call
 * `runRebalanceToTargets` to fund the added / under-weight assets toward the new
 * config. Removals are drained-before-dropped so the on-chain decommission proof
 * passes (`VaultAssetsNotDecommissioned`/`MintNotInBasket` avoided). A config
 * change ALWAYS converges — never config-only.
 */
export async function runReconfigure(
  config: AgentConfig,
  api: DfmApiClient,
  vault: string,
  targets: ReconfigureTargetInput[],
  maxSlippageBps?: number,
  // TEST SEAM (production-unaffected): the two sub-steps that touch the real
  // signing/RPC stack are injectable so the resumable-drain control flow can be
  // unit-tested without a wallet or a validator. Both default to the real
  // functions, so every production caller is byte-identical.
  _deps?: {
    submitConvergeLegs?: typeof submitConvergeLegs;
    runUpdateVaultAssets?: typeof runUpdateVaultAssets;
  },
): Promise<ReconfigureResult> {
  const submitLegs = _deps?.submitConvergeLegs ?? submitConvergeLegs;
  const updateAssets = _deps?.runUpdateVaultAssets ?? runUpdateVaultAssets;

  // Client-side guard mirrors the product/API cap (Σ bps == 10000, ≤10, no dupes).
  validateManagerBasket(
    targets.map((t) => ({ mint: t.mint, symbol: t.symbol, mintBps: t.allocationBps })),
  );

  const prepared = await api.prepareReconfigure(vault, targets, maxSlippageBps);

  // #57 — HARD BLOCK: if any drain leg was skipped (no route), the removed asset
  // cannot reach ~0 and update_vault_assets would revert its decommission proof.
  // Never proceed to the config update on an incomplete drain plan.
  if ((prepared as { drainsIncomplete?: boolean }).drainsIncomplete) {
    throw new Error(
      'Reconfigure BLOCKED: one or more drain legs have no viable route right now, so the ' +
        'removed asset cannot be fully drained and the basket update would revert onchain. ' +
        'Nothing was changed. Retry later (routes vary) or adjust the target basket. ' +
        `Details: ${(prepared as { note?: string }).note ?? ''}`,
    );
  }

  // (1) Drain the removed assets to ~0, RESILIENT to mid-sequence blockhash expiry
  //     (#57 repro 3). The drain legs are pre-prepared with blockhashes from the
  //     same instant, but submit sequentially over ~50s+, so late legs could expire
  //     ("Blockhash not found") leaving a PARTIAL drain. That partial state is
  //     CONSISTENT + RESUMABLE — `update_vault_assets` (step 2) hasn't run, so the
  //     config is still the OLD basket — and `prepareReconfigure` is IDEMPOTENT
  //     (it recomputes drains from CURRENT holdings, skipping already-drained ~0
  //     legs). So on a transient expiry we re-prepare the REMAINING drains afresh
  //     and continue, instead of throwing a half-done reconfigure. A non-transient
  //     error (a real revert) is NOT retried — it surfaces the resumable guidance.
  const drainSignatures: string[] = [];
  let drainTxs = prepared.drainTxs;
  let drainTxIds = prepared.preparedTxIds;
  const MAX_DRAIN_ROUNDS = 4;
  for (let round = 1; drainTxs.length > 0; round++) {
    try {
      const sigs = await submitLegs(config, api, drainTxs, drainTxIds);
      drainSignatures.push(...sigs);
      break; // all remaining drains landed
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const transient =
        e instanceof BlockhashExpiredError ||
        /blockhash.*not found|block height exceeded|was not confirmed|expired/i.test(msg);
      if (!transient || round >= MAX_DRAIN_ROUNDS) {
        throw new Error(
          `${msg}\nReconfigure drain did not finish — but the basket CONFIG was NOT changed ` +
            `(update_vault_assets runs only AFTER all drains), so holdings are consistent and this ` +
            `is RESUMABLE: call reconfigure again (same targets) to drain the remainder, then it ` +
            `proceeds. No rollback needed; no value left the basket.`,
        );
      }
      // Transient expiry mid-sequence — re-prepare the REMAINING drains (fresh
      // blockhashes) from current holdings and retry. Already-drained legs are ~0
      // now, so the recomputed plan skips them.
      const reprepared = await api.prepareReconfigure(vault, targets, maxSlippageBps);
      drainTxs = reprepared.drainTxs;
      drainTxIds = reprepared.preparedTxIds;
    }
  }

  // (2) Full-replace the basket targets. After the drains confirm, the removed
  // mints hold ~0 so update_vault_assets accepts dropping them. Reuse the
  // existing assets-prepare → sign → submit → confirm path.
  //
  // #71 — submit the PLAN's updateAssets.newAssets, NOT the raw `targets`. During
  // a staged USDC-sleeve drop the planner KEEPS the sleeve as a declared 0% member
  // (so its value drains via the converge instead of a wasteful fan-out). Re-
  // deriving the basket from the raw targets omits that 0% USDC entry, so on-chain
  // update_vault_assets treats USDC as REMOVED while its ATA still holds value →
  // VaultAssetsNotDecommissioned (6046). Honour the plan the API already computed.
  const updateStep = (prepared.plan?.steps ?? []).find(
    (s): s is typeof s & { kind: 'updateAssets'; newAssets: Array<{ mint: string; allocationBps: number }> } =>
      (s as { kind?: string }).kind === 'updateAssets',
  );
  const symbolByMint = new Map(targets.map((t) => [t.mint, t.symbol]));
  const newAssets: CreateAssetInput[] =
    updateStep && updateStep.newAssets.length > 0
      ? updateStep.newAssets.map((a) => ({
          mint: a.mint,
          symbol: symbolByMint.get(a.mint) ?? a.mint.slice(0, 6),
          mintBps: a.allocationBps,
        }))
      : targets.map((t) => ({ mint: t.mint, symbol: t.symbol, mintBps: t.allocationBps }));
  const updateRes = await updateAssets(config, api, vault, newAssets);

  return {
    ok: true,
    vault,
    drainSignatures,
    diff: {
      add: prepared.plan.diff.add,
      remove: prepared.plan.diff.remove,
      reweight: prepared.plan.diff.reweight,
    },
    newAssets: newAssets.map((a) => ({ mint: a.mint, allocationBps: a.mintBps })),
    message:
      `Reconfigured vault ${vault.slice(0, 8)}…: drained ${prepared.plan.diff.remove.length} removed ` +
      `asset(s) in ${drainSignatures.length} leg(s), then set the new ${targets.length}-asset target ` +
      `(update tx ${updateRes.signature.slice(0, 16)}…). NEXT: call rebalance_to_targets to fund the ` +
      `added/under-weight assets toward the new config (config is now the source of truth).`,
  };
}

/**
 * Sign + submit a list of pre-prepared converge legs (each its OWN blockhash)
 * IN ORDER, sleeping the 5s on-chain rebalance cooldown between legs. Each leg is
 * an admin-signed `execute_rebalance` (on-chain velocity-ceiling + min_out guarded, oracle-free).
 */
async function submitConvergeLegs(
  config: AgentConfig,
  api: DfmApiClient,
  legs: ConvergeLegTx[],
  preparedTxIds?: string[],
): Promise<string[]> {
  const signatures: string[] = [];
  for (let i = 0; i < legs.length; i++) {
    if (i > 0) await sleep(REBALANCE_COOLDOWN_MS);
    const leg = legs[i];
    const signed = signBase64Transaction(config, leg.transaction);
    try {
      const sig = await submitSignedTx(
        config,
        signed,
        leg.blockhash,
        leg.lastValidBlockHeight,
        { api, preparedTxId: preparedTxIds?.[i] },
      );
      signatures.push(sig);
    } catch (e) {
      const prefix =
        legs.length > 1
          ? `leg ${i + 1}/${legs.length} (${leg.inputMint.slice(0, 4)}→${leg.outputMint.slice(0, 4)}): `
          : '';
      if (e instanceof Error) e.message = prefix + e.message;
      throw e;
    }
  }
  return signatures;
}
