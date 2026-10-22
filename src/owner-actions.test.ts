import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { canonicalJson, DFM_PRIVY_APP_ID, loadOrCreateOwnerKey } from './app-wallet-owner.js';
import { checkOwnerRpcRequest, fetchOwnQuote, runOwnerAction, SOLANA_MAINNET_CAIP2, type OwnerRpcRequest } from './owner-actions.js';
import {
  ataOf, checkComputeBudget, decodeTx, STATIC_MASK, JUP_ROUTE, JUP_SHARED_ROUTE, JUPITER_V6, PROTOCOL_WALLET,
  verifyCloseIxs, verifySwapIxs, verifyWithdrawIxs,
} from './owner-tx-verify.js';

delete process.env.DFM_PRIVY_APP_ID;
const APP = Keypair.generate().publicKey.toBase58();
const SIGNIN = Keypair.generate().publicKey.toBase58();
const EVIL = Keypair.generate().publicKey.toBase58();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const pk = (s: string) => new PublicKey(s);
const k = (s: string, signer = false, writable = false) => ({ pubkey: pk(s), isSigner: signer, isWritable: writable });
const noAlt = async () => null;

// ── Real-shaped instruction builders (no @solana/spl-token in the agent) ──
const computeIx = () => new TransactionInstruction({ programId: pk('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from([2, 0x40, 0x0d, 0x03, 0x00]) });
const ataIx = (owner: string, mint: string) => new TransactionInstruction({
  programId: pk(ATA), data: Buffer.from([1]),
  keys: [k(APP, true, true), k(ataOf(owner, mint), false, true), k(owner), k(mint), k(SystemProgram.programId.toBase58()), k(TOKEN)],
});
function jupIx(o: { shared?: boolean; amount?: bigint; dest?: string; destMint?: string; fee?: string; slippage?: number; qout?: bigint; feeBps?: number } = {}) {
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(o.amount ?? 1_000_000n, 0);
  tail.writeBigUInt64LE(o.qout ?? 5_000n, 8);
  tail.writeUInt16LE(o.slippage ?? 50, 16);
  tail[18] = o.feeBps ?? 0;
  const disc = Buffer.from(o.shared ? JUP_SHARED_ROUTE : JUP_ROUTE, 'hex');
  const data = Buffer.concat([disc, o.shared ? Buffer.from([0]) : Buffer.alloc(0), Buffer.from([1, 0, 0, 0, 7, 100, 0, 1]), tail]);
  const dest = o.dest ?? ataOf(APP, BONK);
  const keys = o.shared
    ? [k(TOKEN), k(EVIL), k(APP, true), k(ataOf(APP, USDC), false, true), k(EVIL, false, true), k(EVIL, false, true), k(dest, false, true), k(USDC), k(o.destMint ?? BONK), k(o.fee ?? JUPITER_V6), k(JUPITER_V6)]
    : [k(TOKEN), k(APP, true), k(ataOf(APP, USDC), false, true), k(dest, false, true), k(JUPITER_V6), k(o.destMint ?? BONK), k(o.fee ?? JUPITER_V6)];
  return new TransactionInstruction({ programId: pk(JUPITER_V6), keys, data });
}
const solFee = (lamports: number, to = PROTOCOL_WALLET) => SystemProgram.transfer({ fromPubkey: pk(APP), toPubkey: pk(to), lamports });
const transferChecked = (src: string, mint: string, dst: string, amount: bigint) => {
  const d = Buffer.alloc(10); d[0] = 12; d.writeBigUInt64LE(amount, 1); d[9] = 5;
  return new TransactionInstruction({ programId: pk(TOKEN), data: d, keys: [k(src, false, true), k(mint), k(dst, false, true), k(APP, true)] });
};
const closeIx = (acct: string, dest: string) => new TransactionInstruction({ programId: pk(TOKEN), data: Buffer.from([9]), keys: [k(acct, false, true), k(dest, false, true), k(APP, true)] });
const b64 = (ixs: TransactionInstruction[], payer = APP) =>
  Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: pk(payer), recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message()).serialize()).toString('base64');
const decode = (ixs: TransactionInstruction[], payer = APP) => decodeTx(b64(ixs, payer), noAlt);

// ── swap: legit shapes pass (route + shared route, DFM token fee, DFM SOL fee) ──
const swapE = { appWallet: APP, inputMint: USDC, outputMint: BONK, amountRaw: '1000000', slippageBps: 50, ownOutAmount: 5_000n };
const cuLimit = (n: number) => { const d = Buffer.alloc(5); d[0] = 2; d.writeUInt32LE(n, 1); return new TransactionInstruction({ programId: pk('ComputeBudget111111111111111111111111111111'), keys: [], data: d }); };
const cuPrice = (micro: bigint) => { const d = Buffer.alloc(9); d[0] = 3; d.writeBigUInt64LE(micro, 1); return new TransactionInstruction({ programId: pk('ComputeBudget111111111111111111111111111111'), keys: [], data: d }); };
for (const ixs of [
  [computeIx(), ataIx(APP, BONK), jupIx()],
  [computeIx(), jupIx({ shared: true, fee: ataOf(PROTOCOL_WALLET, USDC) })],
  [computeIx(), jupIx(), solFee(1_000_000)],
  [cuLimit(1_400_000), cuPrice(71_428n), jupIx({ feeBps: 20, fee: ataOf(PROTOCOL_WALLET, USDC) })],
]) {
  const t = await decode(ixs);
  verifySwapIxs(t.payer, t.ixs, swapE);
}
// ── swap: every attack refused ──
const swapBad: Array<[string, TransactionInstruction[], RegExp]> = [
  ['extra transfer', [jupIx(), transferChecked(ataOf(APP, USDC), USDC, ataOf(EVIL, USDC), 1n)], /top-level token instruction/],
  ['foreign destination', [jupIx({ dest: ataOf(EVIL, BONK) })], /does not land in the app wallet/],
  ['different amount', [jupIx({ amount: 999_999n })], /input amount differs/],
  ['different output mint', [jupIx({ destMint: USDC })], /output mint differs/],
  ['unknown program', [jupIx(), new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) })], /unknown program/],
  ['SOL drain to attacker', [jupIx(), solFee(5_000, EVIL)], /SOL transfer to/],
  ['SOL fee above the cap', [jupIx(), solFee(50_000_001)], /SOL transfer to/],
  ['two SOL fees', [jupIx(), solFee(1_000), solFee(1_000)], /SOL transfer to/],
  ['foreign platform fee', [jupIx({ fee: ataOf(EVIL, USDC) })], /foreign platform fee/],
  ['slippage above 10%', [jupIx({ slippage: 1001 })], /slippage/],
  ['two routes', [jupIx(), jupIx()], /exactly one Jupiter route/],
  ['ATA for a foreign owner', [ataIx(EVIL, BONK), jupIx()], /foreign owner/],
  // S20: the route's min-out must clear the INDEPENDENT quote floor; slippage ≤ requested.
  ['quotedOut ≈ 0 (server-chosen pool)', [jupIx({ qout: 1n })], /below the independent quote floor/],
  ['quotedOut 2% low', [jupIx({ qout: 4_900n })], /below the independent quote floor/],
  ['slippage above requested', [jupIx({ slippage: 51 })], /above the requested 50/],
  // S21: compute budget bounds.
  ['priority fee burns SOL', [cuLimit(1_400_000), cuPrice(1_000_000_000n), jupIx()], /priority fee/],
  ['two unit limits', [cuLimit(200_000), cuLimit(200_000), jupIx()], /two compute unit limits/],
  ['limit above 1.4M', [cuLimit(1_400_001), jupIx()], /above 1\.4M/],
  ['unknown compute opcode', [new TransactionInstruction({ programId: pk('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from([4, 0, 0, 0, 1]) }), jupIx()], /unexpected ComputeBudget/],
  // S22: platform fee ≤ 20 bps; SOL fee only without a token fee.
  ['platform fee 21 bps', [jupIx({ feeBps: 21, fee: ataOf(PROTOCOL_WALLET, USDC) })], /platform fee of 21/],
  ['SOL fee on top of token fee', [jupIx({ feeBps: 20, fee: ataOf(PROTOCOL_WALLET, USDC) }), solFee(1_000)], /SOL fee on top of a token platform fee/],
];
for (const [name, ixs, re] of swapBad) {
  const t = await decode(ixs);
  assert.throws(() => verifySwapIxs(t.payer, t.ixs, swapE), re, name);
}
{
  // Another fee payer means a second required signer: refused before any check runs.
  await assert.rejects(decode([jupIx()], EVIL), /signer other than the app wallet/);
  const t = await decode([new TransactionInstruction({ programId: pk(JUPITER_V6), keys: [], data: Buffer.alloc(0) })], EVIL);
  assert.throws(() => verifySwapIxs(t.payer, t.ixs, swapE), /fee payer/);
}

// ── withdraw ──
const wE = { appWallet: APP, destination: SIGNIN, mint: BONK, amount: '42' };
{
  const t = await decode([ataIx(SIGNIN, BONK), transferChecked(ataOf(APP, BONK), BONK, ataOf(SIGNIN, BONK), 42n), closeIx(ataOf(APP, BONK), APP)]);
  verifyWithdrawIxs(t.payer, t.ixs, wE);
}
for (const [name, ixs, re] of [
  ['to attacker', [transferChecked(ataOf(APP, BONK), BONK, ataOf(EVIL, BONK), 42n)], /requested wallet/],
  ['other mint', [transferChecked(ataOf(APP, BONK), USDC, ataOf(SIGNIN, BONK), 42n)], /mint differs/],
  ['other amount', [transferChecked(ataOf(APP, BONK), BONK, ataOf(SIGNIN, BONK), 43n)], /amount differs/],
  ['two transfers', [transferChecked(ataOf(APP, BONK), BONK, ataOf(SIGNIN, BONK), 42n), transferChecked(ataOf(APP, BONK), BONK, ataOf(SIGNIN, BONK), 42n)], /exactly one/],
  ['rent to attacker', [closeIx(ataOf(APP, BONK), EVIL)], /unexpected account close/],
  ['sneaky SOL', [transferChecked(ataOf(APP, BONK), BONK, ataOf(SIGNIN, BONK), 42n), solFee(1, EVIL)], /unexpected instruction/],
] as Array<[string, TransactionInstruction[], RegExp]>) {
  const t = await decode(ixs);
  assert.throws(() => verifyWithdrawIxs(t.payer, t.ixs, wE), re, name);
}

// ── close_empty ──
{
  const t = await decode([closeIx(ataOf(APP, BONK), SIGNIN), closeIx(ataOf(APP, USDC), SIGNIN)]);
  verifyCloseIxs(t.payer, t.ixs, { appWallet: APP, destination: SIGNIN });
  assert.throws(() => verifyCloseIxs(t.payer, t.ixs, { appWallet: APP, destination: APP }), /unexpected destination/);
  const t2 = await decode([closeIx(ataOf(APP, BONK), SIGNIN), transferChecked(ataOf(APP, BONK), BONK, ataOf(EVIL, BONK), 1n)]);
  assert.throws(() => verifyCloseIxs(t2.payer, t2.ixs, { appWallet: APP, destination: SIGNIN }), /not a CloseAccount/);
}

// ── envelope + full roundtrip with a real P-256 owner key ──
const dir = mkdtempSync(join(tmpdir(), 'dfm-owner-act-'));
chmodSync(dir, 0o700);
const key = loadOrCreateOwnerKey(join(dir, 'owner.pem'));
const mkReq = (tx: string, over: Partial<{ url: string; method: string; appId: string; expiry: string; caip2: string }> = {}): OwnerRpcRequest => {
  const url = over.url ?? 'https://api.privy.io/v1/wallets/w-agent-1/rpc';
  const body = { method: over.method ?? 'signAndSendTransaction', caip2: over.caip2 ?? SOLANA_MAINNET_CAIP2, params: { transaction: tx, encoding: 'base64' } };
  const headers = { 'privy-app-id': over.appId ?? DFM_PRIVY_APP_ID, 'privy-request-expiry': over.expiry ?? String(Date.now() + 5 * 60_000) };
  return { status: 'awaiting_owner_signature', requestId: 'r1', walletId: 'w-agent-1', appWallet: APP, url, body, headers, payload: canonicalJson({ version: 1, method: 'POST', url, body, headers }) };
};
const goodSwap = b64([computeIx(), jupIx()]);
checkOwnerRpcRequest(mkReq(goodSwap));
for (const over of [{ appId: 'other-app' }, { url: 'https://api.privy.io/v1/wallets/other/rpc' }, { method: 'signTransaction' }, { caip2: 'solana:devnet' }, { expiry: String(Date.now() - 1) }, { expiry: String(Date.now() + 11 * 60_000) }]) {
  assert.throws(() => checkOwnerRpcRequest(mkReq(goodSwap, over)), /refusing to sign/, JSON.stringify(over));
}

const submitted: string[] = [];
const deps = (tx: string, app = APP) => ({
  key,
  signInWallet: SIGNIN,
  appWallet: async () => app,
  prepare: async () => mkReq(tx) as unknown as Record<string, unknown>,
  submit: async (_id: string, sig: string) => { submitted.push(sig); return { signature: 'HASH' }; },
  resolveAlt: noAlt,
  ownQuote: async () => 5_000n,
});
const ok = await runOwnerAction(deps(goodSwap), { kind: 'swap', inputMint: USDC, outputMint: BONK, amountRaw: '1000000' });
assert.equal(ok.signature, 'HASH');
const pub = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
// A malicious tx is NEVER signed:
await assert.rejects(runOwnerAction(deps(b64([jupIx({ dest: ataOf(EVIL, BONK) })])), { kind: 'swap', inputMint: USDC, outputMint: BONK, amountRaw: '1000000' }), /does not land/);
await assert.rejects(runOwnerAction(deps(goodSwap, EVIL), { kind: 'swap', inputMint: USDC, outputMint: BONK, amountRaw: '1000000' }), /different app wallet/);
assert.equal(submitted.length, 1, 'only the verified swap was signed');
// executed / nothing_to_do pass straight through without signing.
const passthrough = await runOwnerAction({ ...deps(goodSwap), prepare: async () => ({ status: 'nothing_to_do' }) }, { kind: 'close_empty' });
assert.equal(passthrough.status, 'nothing_to_do');
assert.equal(submitted.length, 1);

// #124 — withdraw_asset pays the SAVED wallet by default and the sign-in wallet only on `to: 'sign_in_wallet'`.
{
  const SAVED = EVIL; // any third wallet the owner saved; the verifier pins the tx to exactly it
  const toSaved = b64([transferChecked(ataOf(APP, BONK), BONK, ataOf(SAVED, BONK), 42n)]);
  const toSignIn = b64([transferChecked(ataOf(APP, BONK), BONK, ataOf(SIGNIN, BONK), 42n)]);
  // The saved wallet comes from a LOCAL pin (DFM_WITHDRAWAL_WALLET), never from the server.
  const w = (tx: string, saved: string | null) => ({ ...deps(tx), ...(saved ? { localSavedWallet: saved } : {}) });
  const before = submitted.length;
  assert.equal((await runOwnerAction(w(toSaved, SAVED), { kind: 'withdraw_asset', mint: BONK, amount: '42' })).signature, 'HASH');
  assert.equal((await runOwnerAction(w(toSignIn, SAVED), { kind: 'withdraw_asset', mint: BONK, amount: '42', to: 'sign_in_wallet' })).signature, 'HASH');
  // A server that pays the sign-in wallet when the saved one was asked for (or the reverse) is never signed.
  await assert.rejects(runOwnerAction(w(toSignIn, SAVED), { kind: 'withdraw_asset', mint: BONK, amount: '42' }), /requested wallet/);
  await assert.rejects(runOwnerAction(w(toSaved, SAVED), { kind: 'withdraw_asset', mint: BONK, amount: '42', to: 'sign_in_wallet' }), /requested wallet/);
  // No local pin → nothing trustworthy to check against → refused, never a silent sign-in fallback.
  await assert.rejects(runOwnerAction(w(toSaved, null), { kind: 'withdraw_asset', mint: BONK, amount: '42' }), /no locally pinned withdrawal wallet/);
  assert.equal(submitted.length, before + 2, 'only the two matching withdrawals were signed');
}

// Signature roundtrip: the submitted signature verifies over the payload the request carried.
{
  const req = mkReq(goodSwap);
  let sig = '';
  await runOwnerAction({ ...deps(goodSwap), prepare: async () => req as unknown as Record<string, unknown>, submit: async (_i, s) => { sig = s; return { signature: 'H' }; } },
    { kind: 'swap', inputMint: USDC, outputMint: BONK, amountRaw: '1000000' });
  assert.ok(verify('sha256', Buffer.from(req.payload), pub, Buffer.from(sig, 'base64')), 'owner signature verifies over the exact payload');
}

// S20 independent quote: no quote → refuse, never sign.
await assert.rejects(runOwnerAction({ ...deps(goodSwap), ownQuote: async () => { throw new Error('refusing to sign: no independent Jupiter quote (503)'); } },
  { kind: 'swap', inputMint: USDC, outputMint: BONK, amountRaw: '1000000' }), /no independent Jupiter quote/);
// fetchOwnQuote goes to Jupiter directly (not DFM), parses outAmount, fails closed.
{
  const urls: string[] = [];
  const out = await fetchOwnQuote({ inputMint: USDC, outputMint: BONK, amountRaw: '1000000', slippageBps: 50 },
    (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ outAmount: '12345' }), { status: 200 }); }) as unknown as typeof fetch);
  assert.equal(out, 12_345n);
  assert.ok(urls[0].startsWith('https://lite-api.jup.ag/swap/v1/quote?inputMint=' + USDC), urls[0]);
  for (const bad of [new Response('x', { status: 503 }), new Response('{}', { status: 200 }), new Response(JSON.stringify({ outAmount: '0' }), { status: 200 })]) {
    await assert.rejects(fetchOwnQuote({ inputMint: USDC, outputMint: BONK, amountRaw: '1', slippageBps: 50 }, (async () => bad) as unknown as typeof fetch), /refusing to sign/);
  }
}

// REAL Jupiter /swap txs (2026-10-19, the server's own options) + their lookup tables read once from
// mainnet: the FULL decoder (accounts + economics + compute budget) runs offline on all five, and every
// mutation a compromised server could make is refused.
/** An instruction appended by a mutation, marked as if its accounts were static keys (worst case for the checker). */
const asStatic = (ix: TransactionInstruction) => { STATIC_MASK.set(ix, ix.keys.map(() => true)); return ix; };
const realCases = ['usdc-jup-route', 'usdc-jup-shared', 'usdc-pyusd-token2022', 'sol-usdc-wrap', 'usdc-sol-unwrap'];
for (const name of realCases) {
  const fx = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as {
    swapTransaction: string;
    lookupTables: Array<{ key: string; addresses: string[] }>;
    expected: { appWallet: string; inputMint: string; outputMint: string; amountRaw: string; maxSlippageBps: number };
  };
  const tables = new Map(fx.lookupTables.map((t) => [t.key, t.addresses]));
  const resolve = async (k: PublicKey) => {
    const a = tables.get(k.toBase58());
    return a ? new AddressLookupTableAccount({ key: k, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: a.map((x) => new PublicKey(x)) } }) : null;
  };
  const { payer, ixs } = await decodeTx(fx.swapTransaction, resolve);
  const jupAt = ixs.findIndex((x) => x.programId.toBase58() === JUPITER_V6);
  const jup = ixs[jupAt];
  const t = jup.data.length - 19;
  const qout = Buffer.from(jup.data).readBigUInt64LE(t + 8);
  const shared = Buffer.from(jup.data).subarray(0, 8).toString('hex') === JUP_SHARED_ROUTE;
  const e = { ...fx.expected, slippageBps: fx.expected.maxSlippageBps, ownOutAmount: qout };
  verifySwapIxs(payer, ixs, e); // the legit tx passes the full check
  checkComputeBudget(ixs);

  const withJup = (mut: (ix: TransactionInstruction) => TransactionInstruction) =>
    ixs.map((x, i) => {
      if (i !== jupAt) return x;
      const copy = new TransactionInstruction({ programId: x.programId, keys: x.keys.map((k2) => ({ ...k2 })), data: Buffer.from(x.data) });
      STATIC_MASK.set(copy, STATIC_MASK.get(x) as boolean[]); // same positions, same static-ness
      return mut(copy);
    });
  const setKey = (i: number, v: string) => (ix: TransactionInstruction) => { ix.keys[i] = { ...ix.keys[i], pubkey: pk(v) }; return ix; };
  const setU64 = (off: number, v: bigint) => (ix: TransactionInstruction) => { ix.data.writeBigUInt64LE(v, off); return ix; };
  const mutations: Array<[string, TransactionInstruction[], RegExp]> = [
    ['destination → stranger ATA', withJup(setKey(shared ? 6 : 3, ataOf(EVIL, e.outputMint))), /does not land in the app wallet|redirected/],
    ['fee account → stranger', withJup(setKey(shared ? 9 : 6, ataOf(EVIL, e.inputMint))), /foreign platform fee/],
    ['authority → stranger', withJup(setKey(shared ? 2 : 1, EVIL)), /authority is not the app wallet/],
    ['amount changed', withJup(setU64(t, BigInt(e.amountRaw) + 1n)), /input amount differs/],
    ['quotedOut lowered', withJup(setU64(t + 8, 1n)), /below the independent quote floor/],
    ['extra transfer', [...ixs, asStatic(transferChecked(ataOf(e.appWallet, e.inputMint), e.inputMint, ataOf(EVIL, e.inputMint), 1n))], /top-level token instruction/],
    ['SOL drain', [...ixs, asStatic(SystemProgram.transfer({ fromPubkey: pk(e.appWallet), toPubkey: pk(EVIL), lamports: 1 }))], /SOL transfer to/],
    ['unmasked extra ix (not from this decode)', [...ixs, SystemProgram.transfer({ fromPubkey: pk(e.appWallet), toPubkey: pk(EVIL), lamports: 1 })], /not a static key/],
  ];
  if (!shared) mutations.push(['output redirect (destination_token_account)', withJup(setKey(4, ataOf(EVIL, e.outputMint))), /redirected/]);
  for (const [what, mutated, re] of mutations) {
    assert.throws(() => verifySwapIxs(payer, mutated, e), re, `${name}: ${what}`);
  }
  // Drift budget (100 bps, quote priced WITH the route's fee): our own quote 0.6% better still passes, 1.5% better refuses.
  verifySwapIxs(payer, ixs, { ...e, ownOutAmount: (qout * 1006n) / 1000n });
  assert.throws(() => verifySwapIxs(payer, ixs, { ...e, ownOutAmount: (qout * 1015n) / 1000n }), /below the independent quote floor/, name);
  // A wrap must be exactly the swap input.
  const wrapAt = ixs.findIndex((x) => x.programId.equals(SystemProgram.programId));
  if (wrapAt >= 0) {
    const w = ixs[wrapAt];
    const bumped = new TransactionInstruction({ programId: w.programId, keys: w.keys, data: Buffer.from(w.data) });
    bumped.data.writeBigUInt64LE(BigInt(e.amountRaw) + 1n, 4);
    STATIC_MASK.set(bumped, STATIC_MASK.get(w) as boolean[]);
    assert.throws(() => verifySwapIxs(payer, ixs.map((x, i) => (i === wrapAt ? bumped : x)), e), /wSOL wrap that is not exactly/, name);
  }
}

// S24 static keys: a checked account served from a lookup table is refused, even when the served
// contents claim it is the app wallet's own ATA (an RPC the agent does not control serves ALTs).
{
  const altKey = Keypair.generate().publicKey;
  const altAccount = new AddressLookupTableAccount({ key: altKey, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [pk(ataOf(APP, BONK))] } });
  const msg = new TransactionMessage({ payerKey: pk(APP), recentBlockhash: '11111111111111111111111111111111', instructions: [jupIx()] }).compileToV0Message([altAccount]);
  assert.equal(msg.addressTableLookups.length, 1, 'the destination really sits in the lookup table');
  const altTx = Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
  const d = await decodeTx(altTx, async () => altAccount);
  assert.throws(() => verifySwapIxs(d.payer, d.ixs, swapE), /not a static key/);
  // A tx needing a second signer is refused at decode.
  const two = new TransactionMessage({ payerKey: pk(APP), recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: pk(EVIL), toPubkey: pk(APP), lamports: 1 })] }).compileToV0Message();
  await assert.rejects(decodeTx(Buffer.from(new VersionedTransaction(two).serialize()).toString('base64'), noAlt), /signer other than the app wallet/);
  // The independent quote is priced with the route's platform fee.
  const urls: string[] = [];
  await fetchOwnQuote({ inputMint: USDC, outputMint: BONK, amountRaw: '1', slippageBps: 50, platformFeeBps: 20 },
    (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ outAmount: '1' }), { status: 200 }); }) as unknown as typeof fetch);
  assert.match(urls[0], /&platformFeeBps=20$/);
}

console.log('owner-actions: ok');
