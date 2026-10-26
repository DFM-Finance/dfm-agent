/**
 * Vault LAUNCH (create DTF) lifecycle driver — a real-money WRITE path.
 *
 * ⚠️ GATED. Reachable only when DFM_AGENT_WRITE_ENABLED=true. Creating a vault
 * pulls the on-chain creation fee (USDC) from the test wallet and writes a vault
 * the operator then owns/administers. The parent must review before enabling.
 * REVIEW: real-money path — parent must review before enabling.
 *
 * ─── Flow (prepare → sign → submit → confirm) ──────────────────────────────
 *   1. POST /vaults/create/prepare  → ONE unsigned v0 tx + the vaultAddress PDA
 *      + a server-built per-create ALT. The creator is the SESSION wallet.
 *   2. sign the tx LOCALLY with the test keypair.
 *
 * ⚠️ THIS IS THE LEGACY LOCAL-KEYPAIR LANE, and it is NO LONGER a lane for a
 * LAUNCH. `launch_vault` refuses to reach here without an active app wallet
 * (`mayLaunchViaAppWallet`), because a vault's creator is fixed on-chain forever
 * and the API will not register one created by anything else — so a locally
 * signed create is an orphan the creator paid for and can never claim.
 *   3. submit + confirm via RPC.
 *   4. POST /vaults/create/confirm { signature, vaultAddress } → records the
 *      vault doc (reads economic params from the prepare-cache, so they cannot
 *      be tampered after prepare). MUST land inside the ~15-min cache TTL.
 *
 * If confirm fails AFTER the tx confirmed on-chain, the vault EXISTS on-chain
 * but has no Mongo doc ("ghost vault"). We surface the signature + vaultAddress
 * so the operator can retry confirm (within TTL) or reconcile — we never hide it.
 * ───────────────────────────────────────────────────────────────────────────
 */
import type { AgentConfig } from './config.js';
import type { DfmApiClient } from './api-client.js';
import type { CreateAssetInput } from './types.js';
import { signBase64Transaction } from './signing.js';
import { submitSignedTx, submitViaBackendConfirmed } from './submit.js';

export interface LaunchVaultParams {
  name: string;
  symbol: string;
  assets: CreateAssetInput[];
  /** Category enum (0-7, 255). Defaults to 255 (uncategorized/other). */
  category?: number;
  description?: string;
  /** Let DFM announce this fund publicly on X/Telegram/Moltbook (default false). */
  announceOptIn?: boolean;
}

export interface LaunchVaultResult {
  ok: boolean;
  vault: string;
  signature: string;
  vaultMint: string;
  vaultIndex: number;
  /** Set when /create/confirm failed after the tx confirmed (ghost-vault risk). */
  confirmError?: string;
  /** board #47: tx sig of the share-mint Metaplex metadata attach (undefined if it was skipped/failed — non-fatal). */
  metadataSignature?: string;
  /** board #47: the reason the metadata attach failed (surfaced, not swallowed) so the operator can retry. */
  metadataError?: string;
  message: string;
}

/**
 * #47 — attach Metaplex name/symbol/uri to a vault's share mint so explorers/
 * wallets show the DTF instead of "SPL Token". Uses the SAME dual submit path as
 * the create tx (backend-confirmed when no client RPC, else direct).
 *
 * 🐛 THE BUG this fixes: the prior inline version called `submitSignedTx` directly,
 * which THROWS when `config.rpcUrl` is unset — but the MCP's DEFAULT is backend
 * mode (no RPC) — and the throw was swallowed, so EVERY agent-launched vault's
 * share token shipped with no name/ticker. Now it backend-submits via the
 * `preparedTxId`, retries transient failures, and SURFACES the error. Idempotent
 * (a re-attach reverts "already in use" = already attached). Non-fatal to launch.
 * `_deps` injects sign/submit for tests; real defaults → production unchanged.
 */
export async function attachShareMintMetadata(
  config: AgentConfig,
  api: DfmApiClient,
  vaultAddress: string,
  _deps?: {
    signBase64Transaction?: typeof signBase64Transaction;
    submitViaBackendConfirmed?: typeof submitViaBackendConfirmed;
    submitSignedTx?: typeof submitSignedTx;
  },
): Promise<{ signature?: string; error?: string }> {
  const sign = _deps?.signBase64Transaction ?? signBase64Transaction;
  const backendSubmit = _deps?.submitViaBackendConfirmed ?? submitViaBackendConfirmed;
  const directSubmit = _deps?.submitSignedTx ?? submitSignedTx;
  let signature: string | undefined;
  let error: string | undefined;
  for (let attempt = 1; attempt <= 3 && !signature; attempt++) {
    try {
      const metaPrepared = await api.prepareCreateVaultMetadata(vaultAddress);
      const metaSigned = sign(config, metaPrepared.transaction);
      if (!config.rpcUrl) {
        if (!metaPrepared.preparedTxId) {
          throw new Error(
            'No preparedTxId on metadata/prepare — cannot backend-submit (set HELIUS_RPC_URL for direct submit).',
          );
        }
        const { signature: sig, confirmed } = await backendSubmit(
          { api, preparedTxId: metaPrepared.preparedTxId },
          metaSigned,
        );
        if (!confirmed) throw new Error(`metadata tx ${sig} broadcast but did not confirm`);
        signature = sig;
      } else {
        signature = await directSubmit(
          config,
          metaSigned,
          metaPrepared.blockhash,
          metaPrepared.lastValidBlockHeight,
        );
      }
      error = undefined;
    } catch (e) {
      error = (e as Error).message;
      // Idempotent: a re-attach onto an existing metadata account reverts "already
      // in use" — treat that as already-attached (clear the error, stop).
      if (/already in use|already initialized|0x0\b|custom program error: 0x0/i.test(error)) {
        error = undefined;
        break;
      }
    }
  }
  return { signature, error };
}

const MAX_ASSETS = 10; // mainnet basket cap (product cap below the zap-v2 tx-size ceiling, #67)

/**
 * Validate the basket client-side BEFORE hitting the network — fast, clear
 * failures the agent can fix without a round-trip. (The API re-validates
 * everything; this is a courtesy layer.)
 */
export function validateLaunchParams(params: LaunchVaultParams): void {
  if (!params.assets || params.assets.length < 2) {
    throw new Error('launch_vault needs at least 2 basket assets.');
  }
  if (params.assets.length > MAX_ASSETS) {
    throw new Error(
      `Basket has ${params.assets.length} assets — the mainnet cap is ${MAX_ASSETS} ` +
        `(a product cap below the zap-v2 tx-size ceiling).`,
    );
  }
  const sum = params.assets.reduce((acc, a) => acc + a.mintBps, 0);
  if (sum !== 10_000) {
    throw new Error(
      `Basket allocations must sum to exactly 10000 bps; got ${sum}. ` +
        `(${params.assets.map((a) => `${a.symbol}=${a.mintBps}`).join(', ')})`,
    );
  }
  for (const a of params.assets) {
    if (!Number.isInteger(a.mintBps) || a.mintBps <= 0 || a.mintBps > 10_000) {
      throw new Error(`Asset ${a.symbol} has invalid mintBps ${a.mintBps} (must be 1..10000).`);
    }
  }
}

/**
 * Drive a full vault LAUNCH (create DTF). Returns when the vault doc is recorded
 * (confirm succeeded) — or, if confirm fails after the on-chain tx confirmed,
 * returns `ok:false` WITH the signature + vaultAddress so the operator can
 * recover (the on-chain vault exists either way).
 */
export async function runLaunchVault(
  config: AgentConfig,
  api: DfmApiClient,
  params: LaunchVaultParams,
): Promise<LaunchVaultResult> {
  validateLaunchParams(params);

  // 1. PREPARE — build the create tx. Fees are FACTORY-GLOBAL: there is no
  // per-vault fee to send. The API's ValidationPipe runs `forbidNonWhitelisted`,
  // so a leftover `entryFeeBps`/`exitFeeBps` here is not merely ignored — it is a
  // 400 on every launch. Do not re-add them.
  const prepared = await api.prepareCreateVault({
    name: params.name,
    symbol: params.symbol,
    dtfType: 'index',
    category: params.category ?? 255,
    assets: params.assets,
    description: params.description,
    ...(params.announceOptIn === true && { announceOptIn: true }),
  });

  // 2. SIGN locally + 3. SUBMIT.
  const signed = signBase64Transaction(config, prepared.transaction);
  let signature: string;
  if (!config.rpcUrl) {
    // Backend-broadcast path (#18): no client RPC → hand the signed tx to the
    // backend's premium RPC. CRITICAL (ghost-vault fix): we MUST know whether the
    // create tx actually CONFIRMED before recording the Mongo doc — a broadcast
    // that drops would otherwise leave an on-chain vault with no record. The
    // backend now re-broadcasts each poll tick, but if it still can't confirm in
    // the bounded window we refuse to record + tell the operator to retry (or set
    // an RPC for the durable direct path).
    if (!prepared.preparedTxId) {
      throw new Error(
        'No preparedTxId on the create/prepare response — cannot backend-submit. ' +
          'Set HELIUS_RPC_URL (or DFM_RPC_URL) for direct submit, or use an API build that returns preparedTxId.',
      );
    }
    const { signature: sig, confirmed } = await submitViaBackendConfirmed(
      { api, preparedTxId: prepared.preparedTxId },
      signed,
    );
    if (!confirmed) {
      throw new Error(
        `Create tx ${sig} was broadcast but did NOT confirm in the backend window — ` +
          `the vault was NOT recorded. Re-run launch_vault to retry; set HELIUS_RPC_URL ` +
          `(or DFM_RPC_URL) for direct submit with durable poll-and-rebroadcast.`,
      );
    }
    signature = sig;
  } else {
    // Direct path: the configured RPC drives confirmation + poll-and-rebroadcast.
    signature = await submitSignedTx(
      config,
      signed,
      prepared.blockhash,
      prepared.lastValidBlockHeight,
    );
  }

  // 4. CONFIRM — record the vault doc. If this fails the on-chain vault already
  // exists (the tx confirmed in step 3), so we DON'T throw it away — we return
  // the recovery info. The operator can retry confirm inside the cache TTL.
  try {
    await api.confirmCreateVault(signature, prepared.vaultAddress);
  } catch (e) {
    return {
      ok: false,
      vault: prepared.vaultAddress,
      signature,
      vaultMint: prepared.vaultMint,
      vaultIndex: prepared.vaultIndex,
      confirmError: (e as Error).message,
      message:
        `Create tx CONFIRMED onchain (vault ${prepared.vaultAddress}) but /create/confirm ` +
        `failed: ${(e as Error).message}. The onchain vault EXISTS. Retry confirm within the ` +
        `~15-min prepare-cache TTL (POST /vaults/create/confirm { signature, vaultAddress }), ` +
        `or it will need a chain reconcile.`,
    };
  }

  // 5. METADATA (board #47) — attach Metaplex name/symbol/uri to the share mint
  // (the dual-submit fix lives in attachShareMintMetadata; non-fatal + surfaced).
  const meta = await attachShareMintMetadata(config, api, prepared.vaultAddress);
  const metadataSignature = meta.signature;
  const metadataError = meta.error;

  return {
    ok: true,
    vault: prepared.vaultAddress,
    signature,
    vaultMint: prepared.vaultMint,
    vaultIndex: prepared.vaultIndex,
    metadataSignature,
    metadataError,
    message:
      `Vault "${params.name}" (${params.symbol}) launched: ${prepared.vaultAddress} ` +
      `(index ${prepared.vaultIndex}). Recorded. ` +
      (metadataSignature
        ? `Share-mint metadata attached (#47, tx ${metadataSignature.slice(0, 16)}…). `
        : `⚠️ Share-mint metadata NOT attached${metadataError ? ` (${metadataError})` : ''} — ` +
          `the share token will show no name/ticker. Retry by calling launch_vault's metadata step ` +
          `again or POST /vaults/${prepared.vaultAddress}/metadata/prepare. `) +
      `Next: the first deposit (minimum $1 = "1000000" raw USDC).`,
  };
}
