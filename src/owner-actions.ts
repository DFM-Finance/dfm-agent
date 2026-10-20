/**
 * Owner-signed actions for an AGENT-owned app wallet (the MCP side). When the
 * API answers a swap / asset withdrawal with `ownerSignature` and this machine
 * holds the wallet's P-256 owner key, the MCP completes it itself:
 *   1. `owner-request` → the server builds + asserts the tx and returns the
 *      exact Privy `signAndSendTransaction` RPC request to sign;
 *   2. the request envelope is checked against PINNED values (Privy app id,
 *      RPC url for that wallet, method, caip2, expiry ≤ 10 min) and the
 *      payload is rebuilt locally;
 *   3. `body.params.transaction` is decoded HERE and checked against what the
 *      tool was asked to do (owner-tx-verify.ts) — a payload whose transaction
 *      was not decoded and approved is never signed;
 *   4. sign with the owner key, `owner-request/submit`.
 */
import { MAX_REQUEST_EXPIRY_AHEAD_MS, canonicalJson, lstatOrNull, loadOrCreateOwnerKey, ownerKeyPath, signerPins, type OwnerKey } from './app-wallet-owner.js';
import { decodeTx, JUPITER_V6, MAX_PLATFORM_FEE_BPS, verifyCloseIxs, verifySwapIxs, verifyWithdrawIxs, type AltResolver } from './owner-tx-verify.js';

export const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

export type OwnerActionInput =
  | { kind: 'swap'; inputMint: string; outputMint: string; amountRaw: string; slippageBps?: number }
  | { kind: 'withdraw_asset'; mint: string; amount?: string }
  | { kind: 'close_empty'; destination?: 'sign_in_wallet' | 'app_wallet' }
  | { kind: 'rebalance'; vault: string; slippageBps?: number };

export interface OwnerRpcRequest {
  status: 'awaiting_owner_signature';
  requestId: string;
  walletId: string;
  appWallet: string;
  url: string;
  body: { method: string; caip2: string; params: { transaction: string; encoding: string } };
  headers: Record<string, string>;
  payload: string;
  summary?: unknown;
}

const keysAre = (o: unknown, keys: string[]) =>
  !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === [...keys].sort().join();

/** The envelope: pinned app id, this wallet's RPC url, signAndSendTransaction on mainnet, fresh expiry. Returns the rebuilt payload. */
export function checkOwnerRpcRequest(r: OwnerRpcRequest, now: number = Date.now()): string {
  const pins = signerPins();
  const url = `https://api.privy.io/v1/wallets/${encodeURIComponent(r.walletId)}/rpc`;
  const exp = r.headers?.['privy-request-expiry'];
  const ok =
    typeof r.walletId === 'string' && r.walletId.length > 0 &&
    r.url === url &&
    keysAre(r.body, ['method', 'caip2', 'params']) &&
    r.body.method === 'signAndSendTransaction' &&
    r.body.caip2 === SOLANA_MAINNET_CAIP2 &&
    keysAre(r.body.params, ['transaction', 'encoding']) &&
    r.body.params.encoding === 'base64' &&
    typeof r.body.params.transaction === 'string' &&
    keysAre(r.headers, ['privy-app-id', 'privy-request-expiry']) &&
    r.headers['privy-app-id'] === pins.appId &&
    typeof exp === 'string' && /^\d{13}$/.test(exp) &&
    Number(exp) > now && Number(exp) <= now + MAX_REQUEST_EXPIRY_AHEAD_MS;
  if (!ok) throw new Error('refusing to sign: the owner request is not a signAndSendTransaction for this wallet on DFM’s Privy app, expiring within 10 min');
  const payload = canonicalJson({ version: 1, method: 'POST', url, body: r.body, headers: r.headers });
  if (payload !== r.payload) throw new Error('refusing to sign: the server payload differs from the request it describes');
  return payload;
}

/** The owner key, ONLY if it already exists on this machine (never created here). */
export function existingOwnerKey(path: string = ownerKeyPath()): OwnerKey | null {
  return lstatOrNull(path) ? loadOrCreateOwnerKey(path) : null;
}

export const DEFAULT_SWAP_SLIPPAGE_BPS = 50;

/**
 * The MCP's OWN Jupiter quote (review S20), straight from Jupiter — never via
 * DFM — so a compromised server cannot make the owner sign a route with a
 * near-zero minimum output. No key needed; `DFM_JUPITER_QUOTE_URL` overrides.
 * Any failure throws: no independent quote, no signature.
 */
export async function fetchOwnQuote(
  q: { inputMint: string; outputMint: string; amountRaw: string; slippageBps: number; platformFeeBps?: number },
  doFetch: typeof fetch = fetch,
): Promise<bigint> {
  const base = process.env.DFM_JUPITER_QUOTE_URL?.trim() || 'https://lite-api.jup.ag/swap/v1/quote';
  const url = `${base}?inputMint=${encodeURIComponent(q.inputMint)}&outputMint=${encodeURIComponent(q.outputMint)}` +
    `&amount=${encodeURIComponent(q.amountRaw)}&slippageBps=${q.slippageBps}` +
    // Same platform fee as the route, so the two outputs are comparable (S24 alignment with the web).
    (q.platformFeeBps ? `&platformFeeBps=${q.platformFeeBps}` : '');
  let out: unknown;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    out = ((await res.json()) as { outAmount?: unknown }).outAmount;
  } catch (e) {
    throw new Error(`refusing to sign: no independent Jupiter quote (${(e as Error).message})`);
  }
  if (typeof out !== 'string' || !/^\d+$/.test(out) || BigInt(out) <= 0n) throw new Error('refusing to sign: the independent Jupiter quote has no outAmount');
  return BigInt(out);
}

export interface OwnerActionDeps {
  key: OwnerKey;
  signInWallet: string;
  /**
   * The app wallet as GET /agent/operating reports it. NOT a security control
   * (both values come from DFM's server — review S23): it only catches a
   * confused request early. What binds the signature is the walletId inside
   * the signed URL (Privy signs with exactly that wallet) plus the locally
   * checked destinations (the app wallet's own ATAs, the local sign-in wallet).
   */
  appWallet(): Promise<string | undefined>;
  /** Independent Jupiter quote (swap only). */
  ownQuote?(q: { inputMint: string; outputMint: string; amountRaw: string; slippageBps: number; platformFeeBps?: number }): Promise<bigint>;
  prepare(input: OwnerActionInput): Promise<Record<string, unknown>>;
  submit(requestId: string, signature: string): Promise<{ signature?: string }>;
  resolveAlt: AltResolver;
}

export async function runOwnerAction(deps: OwnerActionDeps, input: OwnerActionInput): Promise<Record<string, unknown>> {
  const prepared = await deps.prepare(input);
  if (prepared.status !== 'awaiting_owner_signature') return prepared; // executed by DFM's signer / nothing to do
  const r = prepared as unknown as OwnerRpcRequest;
  const payload = checkOwnerRpcRequest(r);
  const app = await deps.appWallet();
  if (!app || app !== r.appWallet) throw new Error('refusing to sign: the request is for a different app wallet than this owner’s');
  const { payer, ixs } = await decodeTx(r.body.params.transaction, deps.resolveAlt);
  if (input.kind === 'swap') {
    const slippageBps = input.slippageBps ?? DEFAULT_SWAP_SLIPPAGE_BPS;
    const q = { inputMint: input.inputMint, outputMint: input.outputMint, amountRaw: input.amountRaw, slippageBps };
    // The route's own platform fee (bounded ≤ 20 bps by the verifier) prices the independent quote.
    const jup = ixs.find((x) => x.programId.toBase58() === JUPITER_V6);
    const platformFeeBps = jup && jup.data.length >= 27 ? jup.data[jup.data.length - 1] : 0;
    if (platformFeeBps > MAX_PLATFORM_FEE_BPS) throw new Error(`refusing to sign: a platform fee of ${platformFeeBps} bps`);
    const ownOutAmount = await (deps.ownQuote ?? fetchOwnQuote)({ ...q, platformFeeBps });
    verifySwapIxs(payer, ixs, { appWallet: app, ...q, ownOutAmount });
  } else if (input.kind === 'withdraw_asset') {
    verifyWithdrawIxs(payer, ixs, { appWallet: app, signInWallet: deps.signInWallet, mint: input.mint, ...(input.amount ? { amount: input.amount } : {}) });
  } else if (input.kind === 'close_empty') {
    verifyCloseIxs(payer, ixs, { appWallet: app, destination: input.destination === 'sign_in_wallet' ? deps.signInWallet : app });
  } else {
    throw new Error('refusing to sign: a rebalance leg goes through runOwnerRebalance (owner-rebalance.ts)');
  }
  const res = await deps.submit(r.requestId, deps.key.sign(payload));
  return {
    status: 'complete',
    kind: input.kind,
    signature: res.signature,
    signedBy: 'agent owner key (decoded and verified locally before signing)',
  };
}
