/**
 * `rebalance_to_targets` for an AGENT-owned app wallet (this machine holds the
 * P-256 owner key). The API plans ONE converge leg per call against live
 * balances and either
 *   • returns it as an owner request — the rebalance SANDWICH, leg wallet
 *     already signed by the server, app-wallet slot empty — which is decoded
 *     here (owner-rebalance-verify.ts), priced against an INDEPENDENT Jupiter
 *     quote, and only then signed with the owner key and relayed; or
 *   • executes it itself (a CPI leg through DFM's policy-bound signer); or
 *   • reports there is nothing left (converged / cleanup / pending).
 * The loop re-plans after every leg and waits out the 5 s on-chain cooldown.
 */
import { checkOwnerRpcRequest, type OwnerActionDeps, type OwnerRpcRequest } from './owner-actions.js';
import { QUOTE_DRIFT_BPS, decodeTx } from './owner-tx-verify.js';
import { verifyRebalanceLegIxs } from './owner-rebalance-verify.js';

export const MAX_REBALANCE_STEPS = 12;
export const LEG_COOLDOWN_MS = 6_000;
/** Default leg slippage the agent prices the server's `min_out` against (the tool caps it at 300). */
export const DEFAULT_REBALANCE_SLIPPAGE_BPS = 100;

export interface OwnerRebalanceDeps extends Pick<OwnerActionDeps, 'key' | 'appWallet' | 'prepare' | 'submit' | 'resolveAlt' | 'ownQuote'> {
  ownQuote: NonNullable<OwnerActionDeps['ownQuote']>;
  /**
   * Resolves once the signature is CONFIRMED without error, throws on a revert
   * or timeout. The next leg is re-planned from live balances, so planning on
   * top of an unconfirmed leg would size it against stale holdings.
   */
  awaitLanded(signature: string): Promise<void>;
  sleep?(ms: number): Promise<void>;
}

export interface OwnerRebalanceLeg { signature: string; via: 'sandwich (owner key)' | 'cpi (DFM signer)'; inputMint?: string; outputMint?: string; amountIn?: string; approvedDelegation?: boolean }

/** `min_out` must clear the independent quote after the requested slippage, minus the same drift a swap tolerates. */
export function minOutFloor(ownOut: bigint, slippageBps: number): bigint {
  return (ownOut * BigInt(10_000 - slippageBps) * (10_000n - QUOTE_DRIFT_BPS)) / 100_000_000n;
}

export async function runOwnerRebalance(
  deps: OwnerRebalanceDeps,
  input: { vault: string; slippageBps?: number },
): Promise<Record<string, unknown>> {
  const slippageBps = input.slippageBps ?? DEFAULT_REBALANCE_SLIPPAGE_BPS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const app = await deps.appWallet();
  if (!app) throw new Error('refusing to sign: no app wallet for this owner');
  const legs: OwnerRebalanceLeg[] = [];
  for (let step = 0; step < MAX_REBALANCE_STEPS; step++) {
    if (step > 0) await sleep(LEG_COOLDOWN_MS);
    const prepared = await deps.prepare({ kind: 'rebalance', vault: input.vault, ...(input.slippageBps !== undefined ? { slippageBps } : {}) });
    if (prepared.status === 'rebalance_done' || prepared.status === 'nothing_to_do') {
      return { status: 'complete', converged: true, legs, result: prepared.result ?? prepared.reason };
    }
    if (prepared.status === 'executed') {
      legs.push({ signature: String(prepared.signature), via: 'cpi (DFM signer)' });
      await deps.awaitLanded(String(prepared.signature));
      continue;
    }
    if (prepared.status !== 'awaiting_owner_signature') throw new Error(`unexpected rebalance step status ${String(prepared.status)}`);
    const r = prepared as unknown as OwnerRpcRequest;
    const payload = checkOwnerRpcRequest(r);
    if (r.appWallet !== app) throw new Error('refusing to sign: the request is for a different app wallet than this owner’s');
    const { payer, ixs, legWallet } = await decodeTx(r.body.params.transaction, deps.resolveAlt, { legSigner: true });
    if (!legWallet) throw new Error('refusing to sign: a rebalance leg without its leg wallet');
    const facts = verifyRebalanceLegIxs(payer, ixs, { appWallet: app, legWallet, vault: input.vault });
    const ownOut = await deps.ownQuote({
      inputMint: facts.inputMint, outputMint: facts.outputMint, amountRaw: facts.amountIn.toString(), slippageBps,
    });
    const floor = minOutFloor(ownOut, slippageBps);
    if (ownOut <= 0n || facts.minOut < floor) {
      throw new Error(`refusing to sign: the leg's min_out ${facts.minOut} is below the independent quote floor ${floor} (slippage ${slippageBps} bps)`);
    }
    const res = await deps.submit(r.requestId, deps.key.sign(payload));
    if (!res.signature) throw new Error('the owner-signed leg was relayed but Privy returned no signature');
    legs.push({
      signature: String(res.signature), via: 'sandwich (owner key)', inputMint: facts.inputMint, outputMint: facts.outputMint,
      amountIn: facts.amountIn.toString(), approvedDelegation: facts.approved,
    });
    await deps.awaitLanded(res.signature);
  }
  return {
    status: 'pending', converged: false, legs,
    note: `stopped after ${MAX_REBALANCE_STEPS} legs; re-run rebalance_to_targets to continue from the live balances`,
  };
}
