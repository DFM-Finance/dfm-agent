/**
 * INDEPENDENT decoding of an owner-signed REBALANCE SANDWICH leg (agent-owned
 * app wallets). The owner key is all the authority there is, so this file —
 * not DFM's server — decides whether the leg is safe to sign. Accepted, and
 * nothing else (fail closed):
 *
 *   ComputeBudget (same bounds as a swap) · ATA create(-idempotent) paid by the
 *   app wallet for the LEG WALLET only · ONE SOL float app → leg wallet, equal
 *   to BEGIN's declared float and ≤ 0.005 SOL · at most ONE dtf_vault
 *   `approve_token_delegate` before BEGIN (authority = app wallet, this vault,
 *   the vault's input-mint ATA, delegate = rebalancer_config PDA of this vault,
 *   amount == BEGIN's amount_in) · dtf_rebalancer BEGIN → Jupiter → END,
 *   contiguous, exactly once, manager lane (no session key), this vault, END
 *   pairing BEGIN's accounts · Jupiter `route` / `shared_accounts_route` whose
 *   authority is the leg wallet, source/destination the leg wallet's ATAs of
 *   BEGIN's mints, input == amount_in, no platform fee · after END only the
 *   Pump volume-account close (leg wallet) + its rent back to the app wallet
 *   (≤ 2,000,000 lamports).
 *
 * The app wallet may appear ONLY as the payer/authority slot of those
 * instructions (and as the destination of the rent reclaim): anywhere else its
 * signature would be lent to a program this file did not vet.
 *
 * Vault-side accounts (vault, config, vault ATAs) may come from the vault's
 * lookup table — the RPC serves those, so they are compared but NOT relied on
 * alone: every one is re-derived on-chain (approve pins delegate = the config
 * PDA of DTF_REBALANCER_PROGRAM_ID and token_account = the vault's canonical
 * ATA; BEGIN/END re-derive the config seeds and the canonical ATAs; both
 * require vault.vault_admin == the app wallet). Program ids and every signer
 * position are static keys (`key()`), so a lying RPC cannot move authority.
 */
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { createHash } from 'node:crypto';

import { atasOf, checkComputeBudget, JUP_ROUTE, JUP_SHARED_ROUTE, JUPITER_V6, key, PROTOCOL_WALLET, refuse } from './owner-tx-verify.js';

export const DTF_VAULT_PROGRAM = '96garpVfmLBkvK33fh7f5edfe85UbhmZ6K67freykxsC';
/** The LIVE dtf_rebalancer id (rotates on a self-funded redeploy → `DFM_REBALANCER_PROGRAM_ID` overrides; a stale pin fails closed). */
export const DEFAULT_REBALANCER_PROGRAM = 'CpaZpZrugfc4MC4h3hoFRYrSZgd7G3puzqVZ8a4KMpGH';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const MAX_LEG_FLOAT_LAMPORTS = 5_000_000n;
export const MAX_SPEND_ALLOWANCE = 2_000_000n;
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const disc = (n: string) => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8);
export const APPROVE_DISC = disc('approve_token_delegate');
export const BEGIN_DISC = disc('rebalance_leg_begin_owner');
export const END_DISC = disc('rebalance_leg_end_owner');

export function rebalancerProgramId(): string {
  return process.env.DFM_REBALANCER_PROGRAM_ID?.trim() || DEFAULT_REBALANCER_PROGRAM;
}
export const rebalancerConfigOf = (vault: string, program: string = rebalancerProgramId()) =>
  PublicKey.findProgramAddressSync([Buffer.from('rebalancer'), new PublicKey(vault).toBuffer()], new PublicKey(program))[0].toBase58();

const at = (ix: TransactionInstruction, i: number): string => ix.keys[i]?.pubkey.toBase58() ?? refuse(`missing account #${i}`);
const hasDisc = (ix: TransactionInstruction | undefined, d: Buffer) => !!ix && Buffer.from(ix.data).subarray(0, 8).equals(d);

export interface RebalanceLegExpect { appWallet: string; legWallet: string; vault: string }
/** What the leg does, read from the bytes — the caller prices it against its own quote. */
export interface RebalanceLegFacts { inputMint: string; outputMint: string; amountIn: bigint; minOut: bigint; approved: boolean }

export function verifyRebalanceLegIxs(payer: string, ixs: TransactionInstruction[], e: RebalanceLegExpect): RebalanceLegFacts {
  const app = e.appWallet;
  const leg = e.legWallet;
  const REB = rebalancerProgramId();
  if (payer !== app) refuse('fee payer is not the app wallet');
  if (leg === app || leg === PROTOCOL_WALLET) refuse('the second signer is not a throwaway leg wallet');
  checkComputeBudget(ixs);

  const b = ixs.findIndex((ix) => ix.programId.toBase58() === REB && hasDisc(ix, BEGIN_DISC));
  if (b < 0) refuse('no rebalance_leg_begin_owner of the pinned dtf_rebalancer');
  const begin = ixs[b]!;
  const jup = ixs[b + 1];
  const end = ixs[b + 2];
  if (!jup || jup.programId.toBase58() !== JUPITER_V6) refuse('BEGIN is not followed by Jupiter');
  if (!end || end.programId.toBase58() !== REB || !hasDisc(end, END_DISC)) refuse('Jupiter is not followed by END');

  // BEGIN — accounts (IDL): authority, factory, vault, config, session_key(opt), input ATA, output ATA,
  // src_mint, dst_mint, leg_wallet, wallet_src, wallet_dst, token_program, token_program_2022(opt), sysvar.
  const config = rebalancerConfigOf(e.vault, REB);
  if (key(begin, 0) !== app) refuse('BEGIN authority is not the app wallet');
  if (at(begin, 2) !== e.vault) refuse('BEGIN names another vault');
  if (at(begin, 3) !== config) refuse('BEGIN config is not this vault’s rebalancer_config');
  if (at(begin, 4) !== REB) refuse('a session key on the owner lane');
  const inputMint = at(begin, 7);
  const outputMint = at(begin, 8);
  const inAta = at(begin, 5);
  const outAta = at(begin, 6);
  if (!atasOf(e.vault, inputMint).includes(inAta) || !atasOf(e.vault, outputMint).includes(outAta)) refuse('BEGIN does not use the vault’s canonical ATAs');
  if (key(begin, 9) !== leg) refuse('BEGIN leg wallet is not the second signer');
  if (!atasOf(leg, inputMint).includes(at(begin, 10)) || !atasOf(leg, outputMint).includes(at(begin, 11))) refuse('BEGIN wallet_src/wallet_dst are not the leg wallet’s canonical accounts');
  const bd = Buffer.from(begin.data);
  if (bd.length !== 50) refuse('BEGIN params have an unexpected size');
  const amountIn = bd.readBigUInt64LE(8);
  const minOut = bd.readBigUInt64LE(16);
  const float = bd.readBigUInt64LE(34);
  const allowance = bd.readBigUInt64LE(42);
  if (amountIn <= 0n) refuse('BEGIN amount_in is zero');
  if (float > MAX_LEG_FLOAT_LAMPORTS) refuse(`a leg float of ${float} lamports`);
  if (allowance > MAX_SPEND_ALLOWANCE) refuse(`a spend allowance of ${allowance} lamports`);

  // END — authority, vault, config, session_key(opt), input ATA, output ATA, dst_mint, leg_wallet, …
  if (key(end, 0) !== app || at(end, 1) !== e.vault || at(end, 2) !== config || at(end, 3) !== REB) refuse('END does not pair with BEGIN');
  if (at(end, 4) !== inAta || at(end, 5) !== outAta || at(end, 6) !== outputMint || key(end, 7) !== leg) refuse('END does not pair with BEGIN');

  checkLegJupiter(jup, { leg, inputMint, outputMint, amountIn });

  let floats = 0;
  let approved = false;
  let pumpClosed = false;
  ixs.forEach((ix, i) => {
    const p = ix.programId.toBase58();
    const d = Buffer.from(ix.data);
    const appAt = ix.keys.flatMap((m, j) => (m.pubkey.toBase58() === app ? [j] : []));
    const appOnlyAt = (...ok: number[]) => { if (appAt.some((j) => !ok.includes(j))) refuse(`the app wallet is lent to instruction ${i} (${p})`); };
    if (i === b || i === b + 2) return appOnlyAt(0);
    if (i === b + 1) return appOnlyAt();
    if (p === COMPUTE) return appOnlyAt();
    if (p === ATA_PROGRAM) {
      if (!(d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1)))) refuse('unexpected associated-token instruction');
      if (key(ix, 0) !== app) refuse('an account creation not paid by the app wallet');
      if (at(ix, 2) !== leg) refuse('creates a token account for someone other than the leg wallet');
      return appOnlyAt(0);
    }
    if (p === SYSTEM) {
      if (d.length !== 12 || d.readUInt32LE(0) !== 2) refuse('a system instruction other than a transfer');
      const lamports = d.readBigUInt64LE(4);
      if (i < b && key(ix, 0) === app && key(ix, 1) === leg && lamports === float && ++floats === 1) return appOnlyAt(0);
      if (i > b + 2 && pumpClosed && key(ix, 0) === leg && key(ix, 1) === app && lamports <= MAX_SPEND_ALLOWANCE) return appOnlyAt(1);
      refuse(`an unexpected SOL transfer (instruction ${i})`);
    }
    if (p === DTF_VAULT_PROGRAM) {
      if (i > b || approved || !hasDisc(ix, APPROVE_DISC) || d.length !== 16) refuse('an unexpected dtf_vault instruction');
      if (key(ix, 0) !== app || at(ix, 2) !== e.vault || at(ix, 3) !== inAta) refuse('the approve is not the vault admin on this vault’s input ATA');
      if (at(ix, 4) !== config) refuse('the approve delegate is not this vault’s rebalancer_config');
      if (d.readBigUInt64LE(8) !== amountIn) refuse('the approve amount differs from BEGIN’s amount_in');
      approved = true;
      return appOnlyAt(0);
    }
    if (p === PUMP_AMM_PROGRAM && i > b + 2 && !pumpClosed) {
      // close_user_volume_accumulator: [wallet(signer), accumulator(w), eventAuthority, program] — same shape the server asserts.
      if (ix.keys.length !== 4 || key(ix, 0) !== leg || !ix.keys[0]!.isSigner) refuse('a malformed Pump volume-account close');
      pumpClosed = true;
      return appOnlyAt();
    }
    refuse(`unexpected instruction ${i} (${p})`);
  });
  if (float > 0n && floats !== 1) refuse('the leg float transfer is missing');
  return { inputMint, outputMint, amountIn, minOut, approved };
}

/** Jupiter on the leg wallet: authority, source and destination are the leg wallet's; input == amount_in; no platform fee. */
function checkLegJupiter(ix: TransactionInstruction, e: { leg: string; inputMint: string; outputMint: string; amountIn: bigint }): void {
  const d = Buffer.from(ix.data);
  const tag = d.subarray(0, 8).toString('hex');
  if ((tag !== JUP_ROUTE && tag !== JUP_SHARED_ROUTE) || d.length < 27) refuse('an unsupported Jupiter instruction');
  const t = d.length - 19;
  if (d.readBigUInt64LE(t) !== e.amountIn) refuse('the route input differs from BEGIN’s amount_in');
  if (d[t + 18] !== 0) refuse('a platform fee on a rebalance leg');
  const [auth, src, dst] = tag === JUP_ROUTE ? [1, 2, 3] : [2, 3, 6];
  if (key(ix, auth) !== e.leg) refuse('the route authority is not the leg wallet');
  if (!atasOf(e.leg, e.inputMint).includes(at(ix, src))) refuse('the route source is not the leg wallet’s input account');
  if (!atasOf(e.leg, e.outputMint).includes(at(ix, dst))) refuse('the route output does not land in the leg wallet');
  if (ix.keys.some((m) => m.isSigner && m.pubkey.toBase58() !== e.leg)) refuse('a foreign signer inside the route');
}
