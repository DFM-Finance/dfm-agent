import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { canonicalJson, DFM_PRIVY_APP_ID, loadOrCreateOwnerKey } from './app-wallet-owner.js';
import { SOLANA_MAINNET_CAIP2, type OwnerRpcRequest } from './owner-actions.js';
import { ataOf, decodeTx, JUP_ROUTE, JUPITER_V6 } from './owner-tx-verify.js';
import {
  APPROVE_DISC, BEGIN_DISC, DEFAULT_REBALANCER_PROGRAM, DTF_VAULT_PROGRAM, END_DISC, PUMP_AMM_PROGRAM, rebalancerConfigOf, verifyRebalanceLegIxs,
} from './owner-rebalance-verify.js';
import { minOutFloor, runOwnerRebalance } from './owner-rebalance.js';

delete process.env.DFM_PRIVY_APP_ID;
delete process.env.DFM_REBALANCER_PROGRAM_ID;
const APP = Keypair.generate().publicKey.toBase58();
const EVIL = Keypair.generate().publicKey.toBase58();
const LEG = Keypair.generate();
const LEGK = LEG.publicKey.toBase58();
const VAULT = Keypair.generate().publicKey.toBase58();
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const REB = DEFAULT_REBALANCER_PROGRAM;
const CONFIG = rebalancerConfigOf(VAULT);
// Regression (2026-10-20, mainnet): the seed was 'rebalancer_config' and every real leg was refused.
// Pinned independently to dtf-rebalancer's REBALANCER_SEED = b"rebalancer" (constants.rs), not to the helper itself.
assert.equal(
  CONFIG,
  PublicKey.findProgramAddressSync([Buffer.from('rebalancer'), new PublicKey(VAULT).toBuffer()], new PublicKey(DEFAULT_REBALANCER_PROGRAM))[0].toBase58(),
  'rebalancer_config PDA uses the on-chain seed "rebalancer"',
);
const IN_ATA = ataOf(VAULT, USDC);
const OUT_ATA = ataOf(VAULT, BONK);
const AMOUNT = 10_000_000n;
const FLOAT = 2_000_000n;
const pk = (s: string) => new PublicKey(s);
const k = (s: string, signer = false, writable = false) => ({ pubkey: pk(s), isSigner: signer, isWritable: writable });
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };

// ── Real-shaped instructions (IDL account orders, Anchor discriminators, Borsh params) ──
const computeIx = () => new TransactionInstruction({ programId: pk('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from([2, 0x80, 0x1a, 0x06, 0x00]) });
const ataIx = (owner: string, mint: string, payer = APP) => new TransactionInstruction({
  programId: pk(ATA), data: Buffer.from([1]),
  keys: [k(payer, true, true), k(ataOf(owner, mint), false, true), k(owner), k(mint), k(SystemProgram.programId.toBase58()), k(TOKEN)],
});
const floatIx = (to = LEGK, lamports = FLOAT) => SystemProgram.transfer({ fromPubkey: pk(APP), toPubkey: pk(to), lamports: Number(lamports) });
const approveIx = (o: { amount?: bigint; delegate?: string; account?: string } = {}) => new TransactionInstruction({
  programId: pk(DTF_VAULT_PROGRAM), data: Buffer.concat([APPROVE_DISC, u64(o.amount ?? AMOUNT)]),
  keys: [k(APP, true), k(Keypair.generate().publicKey.toBase58()), k(VAULT), k(o.account ?? IN_ATA, false, true), k(o.delegate ?? CONFIG), k(USDC), k(TOKEN), k(DTF_VAULT_PROGRAM)],
});
function beginIx(o: { minOut?: bigint; vault?: string; session?: string; float?: bigint } = {}) {
  const p = Buffer.concat([u64(AMOUNT), u64(o.minOut ?? 9_850_000n), u64(9_950_000n), Buffer.from([25, 0]), u64(o.float ?? FLOAT), u64(0n)]);
  return new TransactionInstruction({
    programId: pk(REB), data: Buffer.concat([BEGIN_DISC, p]),
    keys: [k(APP, true, true), k(Keypair.generate().publicKey.toBase58()), k(o.vault ?? VAULT), k(CONFIG), k(o.session ?? REB, false, true), k(IN_ATA, false, true), k(OUT_ATA),
      k(USDC), k(BONK), k(LEGK, true), k(ataOf(LEGK, USDC), false, true), k(ataOf(LEGK, BONK)), k(TOKEN), k(REB), k(SYSVAR_INSTRUCTIONS_PUBKEY.toBase58())],
  });
}
const endIx = () => new TransactionInstruction({
  programId: pk(REB), data: Buffer.from(END_DISC),
  keys: [k(APP, true, true), k(VAULT, false, true), k(CONFIG, false, true), k(REB, false, true), k(IN_ATA, false, true), k(OUT_ATA, false, true), k(BONK),
    k(LEGK, true, true), k(ataOf(LEGK, USDC), false, true), k(ataOf(LEGK, BONK), false, true), k(TOKEN), k(REB), k(SystemProgram.programId.toBase58()),
    k(SYSVAR_INSTRUCTIONS_PUBKEY.toBase58()), k(REB), k(REB), k(REB)],
});
function jupIx(o: { auth?: string; dest?: string; feeBps?: number; amount?: bigint; extra?: string } = {}) {
  const tail = Buffer.concat([u64(o.amount ?? AMOUNT), u64(9_950_000n), Buffer.from([50, 0, o.feeBps ?? 0])]);
  return new TransactionInstruction({
    programId: pk(JUPITER_V6), data: Buffer.concat([Buffer.from(JUP_ROUTE, 'hex'), Buffer.from([1, 0, 0, 0, 7, 100, 0, 1]), tail]),
    keys: [k(TOKEN), k(o.auth ?? LEGK, true), k(ataOf(LEGK, USDC), false, true), k(o.dest ?? ataOf(LEGK, BONK), false, true), k(JUPITER_V6), k(BONK), k(JUPITER_V6),
      ...(o.extra ? [k(o.extra, false, true)] : [])],
  });
}
const sandwich = (o: { before?: TransactionInstruction[]; jup?: TransactionInstruction; begin?: TransactionInstruction; after?: TransactionInstruction[] } = {}) => [
  computeIx(), ataIx(LEGK, USDC), ataIx(LEGK, BONK), floatIx(), ...(o.before ?? [approveIx()]), o.begin ?? beginIx(), o.jup ?? jupIx(), endIx(), ...(o.after ?? []),
];
function wire(ixs: TransactionInstruction[], signLeg = true): string {
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: pk(APP), recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());
  if (signLeg) tx.sign([LEG]);
  return Buffer.from(tx.serialize()).toString('base64');
}
const noAlt = async () => null;
const verifyWire = async (b64: string, vault = VAULT) => {
  const d = await decodeTx(b64, noAlt, { legSigner: true });
  return verifyRebalanceLegIxs(d.payer, d.ixs, { appWallet: APP, legWallet: d.legWallet!, vault });
};

// ── 1. The exact owner-lane shape is accepted and its facts read from the bytes ──
{
  const f = await verifyWire(wire(sandwich()));
  assert.deepEqual(f, { inputMint: USDC, outputMint: BONK, amountIn: AMOUNT, minOut: 9_850_000n, approved: true });
  // Standing delegation already there → no approve, still fine.
  assert.equal((await verifyWire(wire(sandwich({ before: [] })))).approved, false);
  // Pump BUY tail: close (leg wallet) + rent back to the app wallet.
  const pumpClose = new TransactionInstruction({ programId: pk(PUMP_AMM_PROGRAM), data: Buffer.alloc(8), keys: [k(LEGK, true, true), k(Keypair.generate().publicKey.toBase58(), false, true), k(EVIL), k(PUMP_AMM_PROGRAM)] });
  const reclaim = SystemProgram.transfer({ fromPubkey: LEG.publicKey, toPubkey: pk(APP), lamports: 1_346_200 });
  await verifyWire(wire(sandwich({ after: [pumpClose, reclaim] })));
}

// ── 2. Every deviation is refused (fail closed) ──
const refusals: Array<[string, () => Promise<unknown>, RegExp]> = [
  ['leg signature missing', () => verifyWire(wire(sandwich(), false)), /leg wallet signature/],
  ['appended drain', () => verifyWire(wire(sandwich({ after: [SystemProgram.transfer({ fromPubkey: pk(APP), toPubkey: pk(EVIL), lamports: 1 })] }))), /unexpected SOL transfer/],
  ['approve > amount_in', () => verifyWire(wire(sandwich({ before: [approveIx({ amount: AMOUNT + 1n })] }))), /approve amount/],
  ['approve to a foreign delegate', () => verifyWire(wire(sandwich({ before: [approveIx({ delegate: EVIL })] }))), /delegate is not/],
  ['approve on the wrong account', () => verifyWire(wire(sandwich({ before: [approveIx({ account: OUT_ATA })] }))), /input ATA/],
  ['two approves', () => verifyWire(wire(sandwich({ before: [approveIx(), approveIx()] }))), /unexpected dtf_vault/],
  ['another vault', () => verifyWire(wire(sandwich()), Keypair.generate().publicKey.toBase58()), /another vault/],
  ['session key lane', () => verifyWire(wire(sandwich({ begin: beginIx({ session: EVIL }) }))), /session key/],
  ['route authority = app wallet', () => verifyWire(wire(sandwich({ jup: jupIx({ auth: APP }) }))), /lent to instruction|authority is not the leg/],
  ['route output elsewhere', () => verifyWire(wire(sandwich({ jup: jupIx({ dest: ataOf(EVIL, BONK) }) }))), /does not land/],
  ['platform fee on a leg', () => verifyWire(wire(sandwich({ jup: jupIx({ feeBps: 20 }) }))), /platform fee/],
  ['app wallet passed into the route', () => verifyWire(wire(sandwich({ jup: jupIx({ extra: APP }) }))), /foreign signer inside the route|lent to instruction/],
  ['oversized float', () => verifyWire(wire([computeIx(), floatIx(LEGK, 9_000_000n), approveIx(), beginIx({ float: 9_000_000n }), jupIx(), endIx()])), /leg float/],
  ['unknown program', () => verifyWire(wire(sandwich({ after: [new TransactionInstruction({ programId: pk(EVIL), keys: [], data: Buffer.alloc(0) })] }))), /unexpected instruction/],
  ['ATA for a foreign owner', () => verifyWire(wire(sandwich({ before: [ataIx(EVIL, BONK)] }))), /someone other than the leg/],
];
for (const [name, run, re] of refusals) await assert.rejects(run, re, name);

// ── 3. The loop: owner leg signed after verify + independent price, CPI leg passes, stops when converged ──
const dir = mkdtempSync(join(tmpdir(), 'dfm-owner-reb-'));
chmodSync(dir, 0o700);
const key = loadOrCreateOwnerKey(join(dir, 'owner.pem'));
const mkReq = (tx: string): OwnerRpcRequest => {
  const url = 'https://api.privy.io/v1/wallets/w-agent-1/rpc';
  const body = { method: 'signAndSendTransaction', caip2: SOLANA_MAINNET_CAIP2, params: { transaction: tx, encoding: 'base64' } };
  const headers = { 'privy-app-id': DFM_PRIVY_APP_ID, 'privy-request-expiry': String(Date.now() + 5 * 60_000) };
  return { status: 'awaiting_owner_signature', requestId: 'r1', walletId: 'w-agent-1', appWallet: APP, url, body, headers, payload: canonicalJson({ version: 1, method: 'POST', url, body, headers }) };
};
function loop(steps: Record<string, unknown>[], quote = 10_000_000n) {
  const calls = { submitted: 0, landed: [] as string[], slept: 0, prepared: [] as unknown[] };
  const deps = {
    key,
    appWallet: async () => APP,
    prepare: async (i: unknown) => { calls.prepared.push(i); return steps.shift() ?? { status: 'rebalance_done', result: { status: 'complete' } }; },
    submit: async () => { calls.submitted += 1; return { signature: 'LEG_SIG' }; },
    resolveAlt: noAlt,
    ownQuote: async () => quote,
    awaitLanded: async (s: string) => { calls.landed.push(s); },
    sleep: async () => { calls.slept += 1; },
  };
  return { deps, calls };
}
{
  const { deps, calls } = loop([mkReq(wire(sandwich())) as unknown as Record<string, unknown>, { status: 'executed', signature: 'CPI_SIG', legsLeft: 1 }]);
  const res = await runOwnerRebalance(deps, { vault: VAULT });
  assert.equal(res.status, 'complete');
  assert.equal(calls.submitted, 1);
  assert.deepEqual(calls.landed, ['LEG_SIG', 'CPI_SIG']);
  assert.equal(calls.slept, 2);
  assert.deepEqual(calls.prepared[0], { kind: 'rebalance', vault: VAULT });
  assert.equal((res.legs as Array<{ approvedDelegation?: boolean }>)[0]!.approvedDelegation, true);
}
{
  // min_out under the independent quote floor → nothing is signed.
  assert.equal(minOutFloor(10_000_000n, 100), 9_801_000n);
  const { deps, calls } = loop([mkReq(wire(sandwich())) as unknown as Record<string, unknown>], 11_000_000n);
  await assert.rejects(runOwnerRebalance(deps, { vault: VAULT }), /below the independent quote floor/);
  assert.equal(calls.submitted, 0);
}
{
  // A request for a different app wallet is refused before decoding.
  const r = { ...mkReq(wire(sandwich())), appWallet: EVIL };
  const { deps, calls } = loop([r as unknown as Record<string, unknown>]);
  await assert.rejects(runOwnerRebalance(deps, { vault: VAULT }), /different app wallet/);
  assert.equal(calls.submitted, 0);
}
console.log('owner-rebalance: all assertions passed');
