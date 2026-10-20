/**
 * KEYLESS WRITE LANE — let an external agent move funds with only a `dfm_` API
 * key, no Solana keypair anywhere on the machine.
 *
 * THE GAP THIS CLOSES. Reads already worked keyless: `DFM_API_KEY` resolves
 * server-side to its owner wallet. Writes did not — every write flow ended at
 * `signBase64Transaction`, which loads a local keypair, so "install the MCP with
 * a key and let Claude run my wallet" fell over at the first deposit. That made
 * the credential strictly worse than it looks: you still needed the keypair, and
 * a leaked keypair IS the wallet, permanently, with no revoke.
 *
 * HOW. Instead of prepare-then-sign-locally, the tool asks the SERVER to execute:
 * `POST /agent/operating/execute` signs with the user's own Privy operating
 * wallet, behind both cap layers (the owner's policy AND the credential's,
 * ANDed) and the K5 tx-assert simulation. The MCP never touches a private key.
 *
 * WHEN IT ENGAGES — two different questions, do not conflate them:
 *   • `isKeylessMode` is about the CREDENTIAL: an API key is set and no local
 *     keypair is configured. It identifies the API-key authentication mode.
 *   • `shouldExecuteViaAppWallet` is about WHO PAYS, and it is the one that
 *     decides who signs a WRITE. An ACTIVE app wallet wins even when a local
 *     keypair exists.
 *
 * This doc used to promise that "if a keypair IS present, nothing changes" —
 * that the local path ran byte-identically, keeping the 6VCH mainnet proofs on
 * the code they were proven against. That is retired, deliberately: the app
 * wallet is where the user's money is and it OWNS the escrows it opens, so a
 * locally-signed cancel or policy update is rejected by the chain rather than
 * being a harmless no-op. Gating a write on the credential question produced
 * exactly that failure twice (#77 recovery, `update_vault_policy`).
 *
 * WHAT IT DOES NOT DO. It does not silently fall back to local signing, and it
 * does not swallow a refusal. If the server declines — no active operating
 * wallet, a read-only key, an op outside the owner's scope — the error surfaces
 * verbatim with the fix, because the alternative (a write that quietly did
 * nothing while reporting success) is the worst possible outcome here.
 */
import type { AgentConfig } from './config.js';

/**
 * True when the operator EXPLICITLY pointed this process at a keypair.
 *
 * Deliberately env-only, and deliberately NOT `config.keypairPath`: that field
 * is silently populated from a default path (`~/.config/dfm/agent-wallet.json`)
 * when the file merely happens to exist. Keying the keyless decision off it was
 * a real bug — on any machine carrying that file, keyless never engaged and
 * writes were signed by an unrelated local wallet, with no warning. That is the
 * precise failure the credential model exists to prevent, so intent wins over
 * incidental file presence: a stray default keypair must never hijack a run the
 * operator set up with an API key.
 */
export function hasExplicitKeypair(): boolean {
  const p = process.env.DFM_AGENT_KEYPAIR_PATH?.trim();
  const j = process.env.DFM_AGENT_KEYPAIR_JSON?.trim();
  return Boolean(p) || Boolean(j);
}

/** True when this process has SOME local keypair available (explicit or default). */
export function hasLocalKeypair(config: AgentConfig): boolean {
  return Boolean(config.keypairPath) || config.keypairJsonEnvPresent;
}

/** True when writes must go through the server-side operating wallet. */
export function isKeylessMode(_config?: AgentConfig): boolean {
  const apiKey = process.env.DFM_API_KEY?.trim();
  return Boolean(apiKey) && !hasExplicitKeypair();
}

/** App-wallet readiness; a local signing override never selects the payer. */
export function shouldExecuteViaAppWallet(
  config: AgentConfig,
  appWalletStatus: string | null | undefined,
): boolean {
  if (isKeylessMode(config)) return true;
  return appWalletStatus === 'active';
}

export const mayLaunchViaAppWallet = shouldExecuteViaAppWallet;

/** All MCP fund operations use this boundary; missing/revoked wallets fail closed. */
export async function executeAppWalletWrite(
  config: AgentConfig,
  api: {
    getOperatingWallet(): Promise<{ status?: string } | null>;
    executeViaOperatingWallet(tool: string, args: Record<string, unknown>): Promise<KeylessExecResult>;
  },
  tool: string,
  args: Record<string, unknown>,
): Promise<KeylessExecResult> {
  const wallet = await api.getOperatingWallet();
  if (!shouldExecuteViaAppWallet(config, wallet?.status)) {
    throw new Error('OPERATING_WALLET_REQUIRED: an active DFM app wallet is required. Local signing is disabled for fund operations.');
  }
  const result = await api.executeViaOperatingWallet(tool, args);
  if (!result) throw new Error('App-wallet execution returned no result. Inspect operation status before retrying.');
  return result;
}

/** Shape returned by `POST /agent/operating/execute`. */
export interface KeylessExecResult {
  /** Absent only for a successful already-satisfied no-op. */
  signature?: string;
  status: string;
  note?: string;
  /** Present for launch_vault so callers can manage/fund the created DTF. */
  vaultAddress?: string;
}



/**
 * The hint shown when a keyless write is refused. Every branch is actionable —
 * a bare "not executable" would leave the operator guessing which of four
 * independent preconditions failed.
 */
export const KEYLESS_SETUP_HINT =
  // Deliberately does NOT claim "this MCP is running KEYLESS". It is shown in
  // the mixed setup too — API key + local keypair + an ACTIVE app wallet — where
  // that sentence is false and sends the reader off to diagnose the wrong mode.
  'This write is routed through your app wallet on the server, which signs it. ' +
  'Set it up at ' +
  'https://app.dfm.finance/account — sign in with the same wallet the key belongs ' +
  'to, then: (1) "Create app wallet"; (2) "Activate" it; (3) "Fund" it (you sign ' +
  'that ONE top-up from your own wallet — send some SOL too, it pays its own ' +
  'fees). Also check the key allows writes: a fresh key is read-only by default, ' +
  'so mint one with "Allow writes" in the API KEYS panel.';
