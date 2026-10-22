/**
 * INDEPENDENT decoding of an owner-signed transaction (agent-owned app
 * wallets). The DFM server builds the tx and hands the agent a Privy RPC
 * request to sign with its P-256 owner key; the owner key is ALL the authority
 * there is (no policy binds the owner), so this file — not the server — decides
 * whether it is safe to sign. It decodes `body.params.transaction` itself and
 * accepts ONLY the shapes below; anything else is refused.
 *
 *  swap      ComputeBudget · ATA create(-idempotent) owned by the app wallet ·
 *            wSOL wrap/unwrap on the app wallet's own wSOL ATA · exactly ONE
 *            Jupiter v6 `route` / `shared_accounts_route` whose authority is
 *            the app wallet, source = its input-mint ATA, destination = its
 *            output-mint ATA, input amount = the requested amount, slippage ≤
 *            the requested slippage, platform fee ≤ 20 bps to none or DFM's
 *            (PROTOCOL_WALLET) ATA of either mint, and a quoted output that — after its
 *            own slippage — is at least what an INDEPENDENT Jupiter quote
 *            (fetched by the MCP, never via DFM) gives after the requested
 *            slippage, minus 0.5% drift · at most one SOL transfer to PROTOCOL_WALLET ≤
 *            0.05 SOL, and only when the route carries no token fee ·
 *            ComputeBudget: ≤ 1 unit limit (≤ 1.4M), ≤ 1 unit price with a
 *            total priority fee ≤ 0.001 SOL, heap frame; nothing else.
 *  withdraw  ATA create-idempotent for the SIGN-IN wallet · ONE transferChecked
 *            of exactly that mint (and amount, when one was asked) from the app
 *            wallet's ATA to the sign-in wallet's ATA · optional close of the
 *            drained source ATA back to the app wallet.
 *  close     only CloseAccount, authority = the app wallet, rent to the chosen
 *            destination (app wallet or sign-in wallet).
 *
 * UNVERIFIED limits (fail closed): Jupiter `route_v2` / token-ledger variants
 * and exact-out routes are refused, not decoded.
 */
import { createHash, createPublicKey, verify as verifySig } from 'node:crypto';
import { AddressLookupTableAccount, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

export const PROTOCOL_WALLET = '9GjEBsZ1Cos2J6inmgwhBKv9pXGNtLSJ7xQ9xZb29bET';
export const MAX_SWAP_SOL_FEE_LAMPORTS = 50_000_000n;
export const MAX_SWAP_SLIPPAGE_BPS = 1000;
/** DFM's SWAP_PLATFORM_FEE_BPS — the only token platform fee a route may carry. */
export const MAX_PLATFORM_FEE_BPS = 20;
/** Price drift tolerated between the independent quote and the route's own quote. */
export const QUOTE_DRIFT_BPS = 100n;
export const MAX_COMPUTE_UNITS = 1_400_000n;
export const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n;
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const WSOL = 'So11111111111111111111111111111111111111112';

const disc = (n: string) => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8).toString('hex');
export const JUP_ROUTE = disc('route');
export const JUP_SHARED_ROUTE = disc('shared_accounts_route');

/** ATA under either token program (the verifier never trusts a server-claimed program). */
export function ataOf(owner: string, mint: string, program: string = TOKEN): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ATA_PROGRAM),
  )[0].toBase58();
}
export const atasOf = (owner: string, mint: string) => [ataOf(owner, mint, TOKEN), ataOf(owner, mint, TOKEN22)];

export type AltResolver = (key: PublicKey) => Promise<AddressLookupTableAccount | null>;

/**
 * Which account positions of each decoded instruction are STATIC keys (review
 * S24). A lookup table's contents are served by an RPC the agent does not
 * control, so an account the verifier CHECKS must not come from one — `key()`
 * refuses a non-static (or unknown) position. Exported so a test that copies
 * an instruction can carry the mask along.
 */
export const STATIC_MASK = new WeakMap<TransactionInstruction, boolean[]>();

/**
 * `legSigner` (rebalance sandwich only): the message may carry exactly ONE more
 * signer, static key #1, whose signature must ALREADY be on the wire and verify
 * over these exact message bytes (the server pre-signs the throwaway leg
 * wallet); the app wallet's slot #0 must still be empty. Everything that
 * signer may do is then checked by the rebalance verifier.
 */
export async function decodeTx(
  txB64: string,
  resolveAlt: AltResolver,
  opts: { legSigner?: boolean } = {},
): Promise<{ payer: string; ixs: TransactionInstruction[]; legWallet?: string }> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  const nSig = tx.message.header.numRequiredSignatures;
  let legWallet: string | undefined;
  if (opts.legSigner && nSig === 2) {
    const leg = tx.message.staticAccountKeys[1]!;
    const sig = tx.signatures[1];
    if (!sig || !ed25519Verifies(leg.toBytes(), tx.message.serialize(), sig)) {
      throw new Error('refusing to sign: the leg wallet signature is missing or does not verify over this transaction');
    }
    if (tx.signatures[0]?.some((b) => b !== 0)) throw new Error('refusing to sign: the app wallet slot is already signed');
    legWallet = leg.toBase58();
  } else if (nSig !== 1) {
    throw new Error('refusing to sign: the transaction needs a signer other than the app wallet');
  }
  const nStatic = tx.message.staticAccountKeys.length;
  const alts: AddressLookupTableAccount[] = [];
  for (const lu of tx.message.addressTableLookups ?? []) {
    const alt = await resolveAlt(lu.accountKey);
    if (!alt) throw new Error(`refusing to sign: lookup table ${lu.accountKey.toBase58()} could not be resolved`);
    alts.push(alt);
  }
  const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: alts });
  tx.message.compiledInstructions.forEach((c, i) => {
    if (c.programIdIndex >= nStatic) throw new Error('refusing to sign: a program loaded from a lookup table');
    STATIC_MASK.set(msg.instructions[i], c.accountKeyIndexes.map((idx) => idx < nStatic));
  });
  return { payer: msg.payerKey.toBase58(), ixs: msg.instructions, ...(legWallet ? { legWallet } : {}) };
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function ed25519Verifies(pub: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pub)]), format: 'der', type: 'spki' });
    return verifySig(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

export const refuse = (why: string): never => {
  throw new Error(`refusing to sign: ${why}`);
};
/** A CHECKED account: must exist and be a static key of the message (S24). */
export const key = (ix: TransactionInstruction, i: number): string => {
  const mask = STATIC_MASK.get(ix);
  if (!mask || mask[i] !== true || !ix.keys[i]) refuse(`a checked account (#${i} of ${ix.programId.toBase58()}) is not a static key of the transaction`);
  return ix.keys[i].pubkey.toBase58();
};
/**
 * A MINT position may come from a lookup table (real Jupiter shared routes put
 * the source mint there). Safe: every token account it pairs with is a STATIC
 * key compared to an ATA derived HERE from the requested mint, and the token
 * programs refuse an account whose mint differs — a lying ALT cannot make the
 * swap move another mint out of the wallet. The value is still compared.
 */
const mintKey = (ix: TransactionInstruction, i: number): string => {
  if (!STATIC_MASK.get(ix) || !ix.keys[i]) refuse(`a mint account (#${i}) of an instruction this decoder did not produce`);
  return ix.keys[i].pubkey.toBase58();
};
const isToken = (p: string) => p === TOKEN || p === TOKEN22;

/** ATA program create / create-idempotent, paid by the app wallet, for `owner`. */
function checkAta(ix: TransactionInstruction, app: string, owners: string[]): void {
  const d = ix.data;
  if (!(d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1)))) refuse('unexpected associated-token instruction');
  if (key(ix, 0) !== app) refuse('an account creation not paid by the app wallet');
  if (!owners.includes(key(ix, 2) as string)) refuse('creates a token account for a foreign owner');
}

export interface SwapExpect {
  appWallet: string;
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  /** Slippage the TOOL asked for (default 50). The route may not exceed it. */
  slippageBps: number;
  /** `outAmount` of the MCP's own Jupiter quote for the same input. */
  ownOutAmount: bigint;
}

/**
 * ComputeBudget (review S21): at most one SetComputeUnitLimit (≤ 1.4M), at most
 * one SetComputeUnitPrice, total priority fee ≤ 0.001 SOL, RequestHeapFrame
 * allowed; any other opcode refused. Without a limit ix the worst case (1.4M)
 * prices the fee.
 */
export function checkComputeBudget(ixs: Array<{ programId: PublicKey; data: Uint8Array }>): void {
  let limit: bigint | null = null;
  let price: bigint | null = null;
  for (const ix of ixs) {
    if (ix.programId.toBase58() !== COMPUTE) continue;
    const d = Buffer.from(ix.data);
    if (d[0] === 1 && d.length === 5) continue; // RequestHeapFrame
    if (d[0] === 2 && d.length === 5) {
      if (limit !== null) refuse('two compute unit limits');
      limit = BigInt(d.readUInt32LE(1));
      if (limit > MAX_COMPUTE_UNITS) refuse('a compute unit limit above 1.4M');
      continue;
    }
    if (d[0] === 3 && d.length === 9) {
      if (price !== null) refuse('two compute unit prices');
      price = d.readBigUInt64LE(1);
      continue;
    }
    refuse(`an unexpected ComputeBudget instruction (${d[0]})`);
  }
  const fee = ((limit ?? MAX_COMPUTE_UNITS) * (price ?? 0n)) / 1_000_000n;
  if (fee > MAX_PRIORITY_FEE_LAMPORTS) refuse(`a priority fee of ${fee} lamports (max 0.001 SOL)`);
}

/**
 * The route's economics (review S20/S22): amount, slippage ≤ requested,
 * platform fee ≤ 20 bps, and min-out (quoted × (1 − slippage)) ≥ the
 * independent quote × (1 − requested slippage) × (1 − 0.5%). Returns the
 * route's platform fee bps.
 */
export function checkJupiterEconomics(data: Uint8Array, e: Pick<SwapExpect, 'amountRaw' | 'slippageBps' | 'ownOutAmount'>): number {
  const d = Buffer.from(data);
  const tag = d.subarray(0, 8).toString('hex');
  if ((tag !== JUP_ROUTE && tag !== JUP_SHARED_ROUTE) || d.length < 27) refuse('an unsupported Jupiter instruction');
  const t = d.length - 19;
  if (d.readBigUInt64LE(t).toString() !== e.amountRaw) refuse('the swap input amount differs from the request');
  const quotedOut = d.readBigUInt64LE(t + 8);
  const slip = d.readUInt16LE(t + 16);
  const feeBps = d[t + 18];
  if (slip > Math.min(e.slippageBps, MAX_SWAP_SLIPPAGE_BPS)) refuse(`route slippage ${slip} bps above the requested ${e.slippageBps}`);
  if (feeBps > MAX_PLATFORM_FEE_BPS) refuse(`a platform fee of ${feeBps} bps`);
  const routeMin = (quotedOut * BigInt(10_000 - slip)) / 10_000n;
  const floor = (e.ownOutAmount * BigInt(10_000 - e.slippageBps) * (10_000n - QUOTE_DRIFT_BPS)) / 100_000_000n;
  if (e.ownOutAmount <= 0n || routeMin < floor) {
    refuse(`the route's minimum output ${routeMin} is below the independent quote floor ${floor}`);
  }
  return feeBps;
}

export function verifySwapIxs(payer: string, ixs: TransactionInstruction[], e: SwapExpect): void {
  const app = e.appWallet;
  if (payer !== app) refuse('fee payer is not the app wallet');
  const wsolAtas = atasOf(app, WSOL);
  const feeAtas = [...atasOf(PROTOCOL_WALLET, e.inputMint), ...atasOf(PROTOCOL_WALLET, e.outputMint)];
  checkComputeBudget(ixs);
  let routes = 0;
  let solFees = 0;
  let tokenFeeBps = 0;
  for (const ix of ixs) {
    const p = ix.programId.toBase58();
    const d = Buffer.from(ix.data);
    if (p === COMPUTE) continue;
    if (p === ATA_PROGRAM) { checkAta(ix, app, [app]); continue; }
    if (p === SYSTEM) {
      if (d.length !== 12 || d.readUInt32LE(0) !== 2) refuse('a system instruction other than a transfer');
      if (key(ix, 0) !== app) refuse('a SOL transfer not from the app wallet');
      const to = key(ix, 1) as string;
      const lamports = d.readBigUInt64LE(4);
      if (wsolAtas.includes(to)) {
        // Wrap into its own wSOL account: only a SOL-input swap, and exactly the swapped amount.
        if (e.inputMint !== WSOL || lamports.toString() !== e.amountRaw) refuse('a wSOL wrap that is not exactly the swap input');
        continue;
      }
      if (to === PROTOCOL_WALLET && lamports <= MAX_SWAP_SOL_FEE_LAMPORTS && ++solFees === 1) continue;
      refuse(`a SOL transfer to ${to}`);
    }
    if (isToken(p)) {
      if (d[0] === 17 && wsolAtas.includes(key(ix, 0) as string)) continue; // syncNative own wSOL
      if (d[0] === 9 && wsolAtas.includes(key(ix, 0) as string) && key(ix, 1) === app && key(ix, 2) === app) continue; // unwrap
      refuse(`a top-level token instruction (${d[0]})`);
    }
    if (p === JUPITER_V6) {
      routes += 1;
      tokenFeeBps = checkJupiterEconomics(d, e);
      checkJupiter(ix, d, e, feeAtas);
      continue;
    }
    refuse(`unknown program ${p}`);
  }
  if (routes !== 1) refuse(`expected exactly one Jupiter route, found ${routes}`);
  // The server takes EITHER the token platform fee or the SOL fee, never both (S22).
  if (solFees > 0 && tokenFeeBps > 0) refuse('a SOL fee on top of a token platform fee');
}

function checkJupiter(ix: TransactionInstruction, d: Buffer, e: SwapExpect, feeAtas: string[]): void {
  const app = e.appWallet;
  const tag = d.subarray(0, 8).toString('hex');
  if ((tag !== JUP_ROUTE && tag !== JUP_SHARED_ROUTE) || d.length < 27) refuse('an unsupported Jupiter instruction');
  const ins = atasOf(app, e.inputMint);
  const outs = atasOf(app, e.outputMint);
  const feeOk = (f?: string) => f === JUPITER_V6 || (f !== undefined && feeAtas.includes(f));
  if (tag === JUP_ROUTE) {
    if (key(ix, 1) !== app) refuse('the swap authority is not the app wallet');
    if (!ins.includes(key(ix, 2) as string)) refuse('the swap source is not the app wallet input account');
    if (!outs.includes(key(ix, 3) as string)) refuse('the swap output does not land in the app wallet');
    if (key(ix, 4) !== JUPITER_V6 && key(ix, 4) !== key(ix, 3)) refuse('the swap output is redirected');
    if (mintKey(ix, 5) !== e.outputMint) refuse('the output mint differs from the request');
    if (!feeOk(key(ix, 6))) refuse('a foreign platform fee account');
  } else {
    if (key(ix, 2) !== app) refuse('the swap authority is not the app wallet');
    if (!ins.includes(key(ix, 3) as string)) refuse('the swap source is not the app wallet input account');
    if (!outs.includes(key(ix, 6) as string)) refuse('the swap output does not land in the app wallet');
    if (mintKey(ix, 7) !== e.inputMint) refuse('the input mint differs from the request');
    if (mintKey(ix, 8) !== e.outputMint) refuse('the output mint differs from the request');
    if (!feeOk(key(ix, 9))) refuse('a foreign platform fee account');
  }
}

/** `destination` = the ONE owner wallet the request asked for: the sign-in wallet or the saved withdrawal wallet (#124). */
export interface WithdrawExpect { appWallet: string; destination: string; mint: string; amount?: string }

export function verifyWithdrawIxs(payer: string, ixs: TransactionInstruction[], e: WithdrawExpect): void {
  if (payer !== e.appWallet) refuse('fee payer is not the app wallet');
  const src = atasOf(e.appWallet, e.mint);
  const dst = atasOf(e.destination, e.mint);
  let transfers = 0;
  let closes = 0;
  for (const ix of ixs) {
    const p = ix.programId.toBase58();
    const d = Buffer.from(ix.data);
    if (p === COMPUTE) continue;
    if (p === ATA_PROGRAM) {
      checkAta(ix, e.appWallet, [e.destination]);
      if (mintKey(ix, 3) !== e.mint) refuse('creates an account for another mint');
      continue;
    }
    if (isToken(p) && d[0] === 12) {
      transfers += 1;
      if (!src.includes(key(ix, 0) as string)) refuse('the withdrawal source is not the app wallet');
      if (mintKey(ix, 1) !== e.mint) refuse('the withdrawal mint differs from the request');
      if (!dst.includes(key(ix, 2) as string)) refuse('the withdrawal does not go to the requested wallet');
      if (key(ix, 3) !== e.appWallet) refuse('the withdrawal authority is not the app wallet');
      const amount = d.readBigUInt64LE(1).toString();
      if (e.amount !== undefined && amount !== e.amount) refuse('the withdrawal amount differs from the request');
      continue;
    }
    if (isToken(p) && d[0] === 9) {
      closes += 1;
      if (!src.includes(key(ix, 0) as string) || key(ix, 1) !== e.appWallet || key(ix, 2) !== e.appWallet) refuse('an unexpected account close');
      continue;
    }
    refuse(`unexpected instruction (${p})`);
  }
  if (transfers > 1 || closes > 1 || transfers + closes === 0) refuse('not exactly one withdrawal');
}

export interface CloseExpect { appWallet: string; destination: string }

export function verifyCloseIxs(payer: string, ixs: TransactionInstruction[], e: CloseExpect): void {
  if (payer !== e.appWallet) refuse('fee payer is not the app wallet');
  let closes = 0;
  for (const ix of ixs) {
    const p = ix.programId.toBase58();
    if (p === COMPUTE) continue;
    const d = Buffer.from(ix.data);
    if (!isToken(p) || d[0] !== 9 || d.length !== 1) refuse(`not a CloseAccount (${p})`);
    if (key(ix, 1) !== e.destination) refuse('rent goes to an unexpected destination');
    if (key(ix, 2) !== e.appWallet) refuse('closes an account the app wallet does not own');
    closes += 1;
  }
  if (closes === 0) refuse('no accounts to close');
}
