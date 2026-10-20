/**
 * Transaction submission + confirmation for the WRITE path.
 *
 * Only used by the gated zap-v2 / create lifecycles. Reads `config.rpcUrl`
 * (Helius on mainnet — public RPC is refused for mainnet in config). The agent
 * submits the locally-signed base64 v0 transactions returned by the `/prepare`
 * endpoints.
 *
 * Robustness model:
 *   - One Connection per process (cached).
 *   - Each tx is resent while its blockhash is still valid; we poll the
 *     signature status ourselves rather than trusting a single
 *     `confirmTransaction`, so a dropped tx is rebroadcast inside the window.
 *   - On blockhash expiry we throw `BlockhashExpiredError` (a distinct,
 *     catchable type) so the caller can RE-PREPARE (the only correct recovery
 *     for an expired v0 tx — you cannot re-sign it with a new blockhash without
 *     re-fetching the instructions from the API).
 *   - On-chain failure throws with the decoded program error logs attached so an
 *     agent can act on the reason instead of an opaque `{"Custom":6040}`.
 *
 * REVIEW: real-money path — parent must review before enabling.
 */
import { Connection } from '@solana/web3.js';
import type { AgentConfig } from './config.js';

/**
 * Minimal structural interface for the backend-broadcast path (#18) so submit.ts
 * stays decoupled from the concrete DfmApiClient (no import cycle). The api
 * client satisfies this via its `submitSignedTx` method.
 */
export interface BackendSubmitter {
  submitSignedTx(
    preparedTxId: string,
    signedTxBase64: string,
  ): Promise<{ signature: string; confirmed: boolean }>;
}

let cachedConn: Connection | null = null;

/** Thrown when a tx could not confirm before its blockhash expired. */
export class BlockhashExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockhashExpiredError';
  }
}

/** Thrown when a tx landed but the program reverted. Carries decoded logs. */
export class OnChainRevertError extends Error {
  constructor(
    message: string,
    readonly signature: string,
    readonly logs: string[] | null,
  ) {
    super(message);
    this.name = 'OnChainRevertError';
  }
}

/**
 * Thrown when the backend broadcast a tx but it did NOT confirm within the API's
 * window (#16 Bug A — the "phantom signature"). The tx MAY still land, so the caller
 * must NOT blindly resubmit (a duplicate could double-apply). Carries the signature
 * so the agent can surface it for the human to verify on-chain.
 */
export class BroadcastUnconfirmedError extends Error {
  constructor(
    message: string,
    readonly signature: string,
  ) {
    super(message);
    this.name = 'BroadcastUnconfirmedError';
  }
}

function getConnection(config: AgentConfig): Connection {
  if (!config.rpcUrl) {
    throw new Error(
      'No RPC endpoint configured. Set HELIUS_RPC_URL (or DFM_RPC_URL) to submit ' +
        'signed transactions. The read tools do not need it.',
    );
  }
  if (!cachedConn) {
    cachedConn = new Connection(config.rpcUrl, 'confirmed');
  }
  return cachedConn;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Backend-broadcast submit that PRESERVES the `confirmed` flag (#18 ghost-vault
 * fix). The plain {@link submitSignedTx} discards `confirmed` and returns only the
 * signature — fine for fire-and-forget callers, but the CREATE flow MUST know
 * whether the tx actually landed before it records the Mongo vault doc (else a
 * broadcast-but-dropped create ghosts).
 *
 * Throws {@link BlockhashExpiredError} on a 410/expired (the prepared tx's
 * blockhash window closed) so the caller re-prepares — identical to the
 * direct-path expiry behavior.
 */
export async function submitViaBackendConfirmed(
  backend: { api: BackendSubmitter; preparedTxId: string },
  signedBase64: string,
): Promise<{ signature: string; confirmed: boolean }> {
  try {
    return await backend.api.submitSignedTx(backend.preparedTxId, signedBase64);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b410\b/.test(msg) || /expired/i.test(msg)) {
      throw new BlockhashExpiredError(
        `Backend submit: prepared tx expired (${msg}). Re-prepare and resubmit.`,
      );
    }
    throw e instanceof Error ? e : new Error(msg);
  }
}

/**
 * Submit ONE locally-signed base64 v0 transaction and wait for `confirmed`.
 * Returns the signature. Rebroadcasts while the blockhash is valid (durable
 * against dropped txs), then:
 *   - throws {@link BlockhashExpiredError} if the window closed un-confirmed,
 *   - throws {@link OnChainRevertError} (with logs) if the program reverted.
 *
 * `blockhash` + `lastValidBlockHeight` come from the `/prepare` response.
 */
export async function submitSignedTx(
  config: AgentConfig,
  signedBase64: string,
  blockhash: string,
  lastValidBlockHeight: number,
  backend?: { api: BackendSubmitter; preparedTxId?: string },
): Promise<string> {
  // Backend-broadcast path (#18): when no client RPC is configured, hand the
  // signed tx to the backend's premium RPC via POST /tx/submit. This is the
  // one-line-install path — no HELIUS_RPC_URL needed. Requires a preparedTxId
  // (the API stamps it on every /prepare response). A configured rpcUrl always
  // takes precedence (direct submit, below) so power users + the test harness
  // keep the original behavior.
  if (!config.rpcUrl) {
    if (backend?.api && backend.preparedTxId) {
      try {
        const { signature, confirmed } = await backend.api.submitSignedTx(
          backend.preparedTxId,
          signedBase64,
        );
        // #16 Bug A: the backend returns { confirmed:false } when the tx broadcast
        // but did not land inside the API's confirm window. The no-RPC path has no
        // way to keep polling, so trusting `signature` alone reported a PHANTOM
        // success (the tx silently never landed — seen live on agent rebalances).
        // Surface the uncertainty instead: the caller must verify on-chain (e.g.
        // zap_status / vault state) before any resubmit, since a blind retry could
        // double-apply if the original actually lands.
        if (!confirmed) {
          throw new BroadcastUnconfirmedError(
            `Transaction ${signature} was broadcast but did NOT confirm within the API window. ` +
              `It may still land — do NOT blindly resubmit (a duplicate could double-apply). ` +
              `Verify onchain (check the vault / zap_status) before retrying; if it truly ` +
              `dropped, re-prepare. A heavy tx (e.g. a Jupiter-CPI rebalance) can need a higher ` +
              `priority fee to land under load.`,
            signature,
          );
        }
        return signature;
      } catch (e) {
        if (e instanceof BroadcastUnconfirmedError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        // 410 Gone = the prepared tx expired (blockhash window) → re-prepare,
        // exactly like a direct-path BlockhashExpiredError.
        if (/\b410\b/.test(msg) || /expired/i.test(msg)) {
          throw new BlockhashExpiredError(
            `Backend submit: prepared tx expired (${msg}). Re-prepare and resubmit.`,
          );
        }
        throw e instanceof Error ? e : new Error(msg);
      }
    }
    throw new Error(
      'No way to broadcast this signed tx: set HELIUS_RPC_URL (or DFM_RPC_URL) for ' +
        'direct submit, or use an API build that returns preparedTxId (backend broadcast).',
    );
  }

  const conn = getConnection(config);
  // The signed base64 IS already the serialized wire-format tx — send its raw
  // bytes directly. (Previously this round-tripped through VersionedTransaction,
  // which mis-parsed LEGACY transactions from the manager endpoints and produced
  // "signature did not verify". Raw bytes work for both v0 and legacy.)
  const raw = Buffer.from(signedBase64, 'base64');

  // First broadcast. skipPreflight=false so a malformed/failing tx surfaces its
  // simulation error immediately rather than silently never landing.
  let signature: string;
  try {
    signature = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
  } catch (e) {
    throw enrichSendError(e);
  }

  // Poll-and-rebroadcast loop. We drive confirmation ourselves (instead of a
  // single `confirmTransaction`) so we can re-send the SAME signed tx while the
  // blockhash is valid — the RPC may drop the first broadcast under load.
  const POLL_MS = 2_000;
  const REBROADCAST_EVERY = 2; // re-send every ~4s
  let ticks = 0;
  for (;;) {
    const { value } = await conn.getSignatureStatus(signature, { searchTransactionHistory: false });
    if (value) {
      if (value.err) {
        const logs = await fetchLogs(conn, signature);
        throw new OnChainRevertError(
          `Transaction ${signature} reverted onchain: ${JSON.stringify(value.err)}` +
            (logs?.length ? `\nProgram logs:\n${logs.join('\n')}` : ''),
          signature,
          logs,
        );
      }
      if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') {
        return signature;
      }
    }

    // Has the blockhash expired? Once the cluster's block height passes
    // lastValidBlockHeight, the tx can never land — re-prepare is the only fix.
    const height = await conn.getBlockHeight('confirmed');
    if (height > lastValidBlockHeight) {
      // Final status check to avoid a race where it confirmed on the last tick.
      const final = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (final.value && !final.value.err) return signature;
      throw new BlockhashExpiredError(
        `Transaction ${signature} (blockhash ${blockhash.slice(0, 8)}…) did not confirm before ` +
          `its blockhash expired (block height ${height} > lastValid ${lastValidBlockHeight}). ` +
          `Re-prepare and resubmit — an expired v0 transaction cannot be re-signed with a new blockhash.`,
      );
    }

    ticks += 1;
    if (ticks % REBROADCAST_EVERY === 0) {
      // Best-effort rebroadcast; ignore send errors here (the poll loop owns the
      // success/expiry decision).
      try {
        await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
      } catch {
        /* transient — the next poll re-evaluates */
      }
    }
    await sleep(POLL_MS);
  }
}

/**
 * Submit a batch of signed base64 txs IN ORDER, confirming each before the next.
 * The zap-v2 open/close `/prepare` endpoints can return more than one tx (large
 * baskets / split-VAA); they share one blockhash and MUST land sequentially.
 *
 * Propagates {@link BlockhashExpiredError} / {@link OnChainRevertError} from the
 * first failing tx with the index annotated.
 */
export async function submitSignedTxsSequential(
  config: AgentConfig,
  signedBase64Txs: string[],
  blockhash: string,
  lastValidBlockHeight: number,
  backend?: { api: BackendSubmitter; preparedTxIds?: string[] },
): Promise<string[]> {
  const sigs: string[] = [];
  for (let i = 0; i < signedBase64Txs.length; i++) {
    const perTx = backend?.api
      ? { api: backend.api, preparedTxId: backend.preparedTxIds?.[i] }
      : undefined;
    try {
      sigs.push(
        await submitSignedTx(config, signedBase64Txs[i], blockhash, lastValidBlockHeight, perTx),
      );
    } catch (e) {
      const prefix = signedBase64Txs.length > 1 ? `tx ${i + 1}/${signedBase64Txs.length}: ` : '';
      if (e instanceof Error) e.message = prefix + e.message;
      throw e;
    }
  }
  return sigs;
}

/** Attach simulation logs to a send-time failure when the RPC provides them. */
function enrichSendError(e: unknown): Error {
  const err = e as Error & { logs?: string[] };
  if (Array.isArray(err.logs) && err.logs.length > 0) {
    return new Error(`${err.message}\nProgram logs:\n${err.logs.join('\n')}`);
  }
  return err instanceof Error ? err : new Error(String(e));
}

/** Best-effort fetch of the confirmed tx's program logs for diagnostics. */
async function fetchLogs(conn: Connection, signature: string): Promise<string[] | null> {
  try {
    const tx = await conn.getTransaction(signature, {
      maxSupportedTransactionVersion: 1, // C1 — diagnostics must not go blind on a v1 tx
      commitment: 'confirmed',
    });
    return tx?.meta?.logMessages ?? null;
  } catch {
    return null;
  }
}
