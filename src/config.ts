/**
 * Agent configuration — loaded from env vars set by the OPERATOR locally.
 *
 * SECURITY MODEL (read before changing anything here):
 *   - The agent operates with ITS OWN test-wallet keypair, loaded LOCALLY by the
 *     operator from a file path (`DFM_AGENT_KEYPAIR_PATH`) or an env-injected
 *     secret (`DFM_AGENT_KEYPAIR_JSON`). The keypair is NEVER passed through the
 *     MCP protocol, tool arguments, or tool results, and is NEVER logged.
 *   - The protocol wallet must NOT be used here. The agent signs with
 *     a throwaway test wallet funded with a few dollars of USDC.
 *   - All real-money WRITE tools (deposit / redeem) are GATED behind
 *     `DFM_AGENT_WRITE_ENABLED=true` and default OFF.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Zero-config convenience: if `DFM_AGENT_KEYPAIR_PATH` is unset, fall back to the
 * conventional `~/.config/dfm/agent-wallet.json` IF it exists. So a plugin user
 * can just drop their throwaway test keypair there and skip the env var entirely.
 * Returns undefined when neither is present (write tools then error clearly).
 */
export const DEFAULT_KEYPAIR_PATH = join(homedir(), '.config', 'dfm', 'agent-wallet.json');
function resolveKeypairPath(): string | undefined {
  const explicit = process.env.DFM_AGENT_KEYPAIR_PATH;
  if (explicit && explicit.trim().length > 0) return explicit;
  return existsSync(DEFAULT_KEYPAIR_PATH) ? DEFAULT_KEYPAIR_PATH : undefined;
}

export interface AgentConfig {
  /** DFM v2 backend API base, INCLUDING the `/api/v2` prefix. */
  apiUrl: string;
  /** Solana cluster (devnet | mainnet-beta). Mainnet is the live system. */
  cluster: 'devnet' | 'mainnet-beta';
  /**
   * Helius (or other dedicated) RPC endpoint. Used only by the WRITE path to
   * submit signed transactions. The read tools do not need it.
   */
  rpcUrl?: string;
  /**
   * Where to load the test-wallet keypair from. Exactly ONE of these should be
   * set by the operator when WRITE is enabled (path preferred). Format: the
   * standard Solana 64-byte secret-key JSON array (e.g. `solana-keygen` output).
   * Read lazily + only inside the signing module — never eagerly, never logged.
   */
  keypairPath?: string;
  keypairJsonEnvPresent: boolean;
  /**
   * Master kill-switch for the real-money WRITE tools (deposit/redeem). Default
   * OFF. When false, the write tools refuse with a clear message and never load
   * the keypair or touch the chain.
   */
  writeEnabled: boolean;
}

function parseCluster(raw: string | undefined): AgentConfig['cluster'] {
  return raw === 'mainnet-beta' ? 'mainnet-beta' : raw === 'devnet' ? 'devnet' : 'mainnet-beta';
}

/**
 * Normalize the API base so it always ends with the `/api/v2` global prefix and
 * has no trailing slash. Accepts either a bare origin
 * (`https://app.dfm.finance`) or a full base
 * (`https://app.dfm.finance/api/v2`).
 */
export function normalizeApiUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (!/\/api\/v2$/.test(url)) {
    url = `${url}/api/v2`;
  }
  return url;
}

export function loadConfig(): AgentConfig {
  // Default to the live closed-mainnet API so the read tools work out of the box.
  const apiUrl = normalizeApiUrl(process.env.DFM_API_URL ?? 'https://app.dfm.finance');
  const cluster = parseCluster(process.env.SOLANA_CLUSTER);

  // RPC is OPTIONAL. When set (HELIUS_RPC_URL / DFM_RPC_URL) the write path
  // broadcasts DIRECTLY through it. When UNSET on mainnet, writes fall back to
  // the backend-broadcast path (#18 — POST /tx/submit), so no client RPC key is
  // needed for a one-line write install. We still never use the rate-limited
  // public mainnet RPC (api.mainnet-beta.solana.com) — a missing RPC means
  // backend-submit, not a silent throttle. Devnet keeps the public default.
  let rpcUrl = process.env.HELIUS_RPC_URL ?? process.env.DFM_RPC_URL;
  if (!rpcUrl && cluster === 'devnet') {
    rpcUrl = 'https://api.devnet.solana.com';
  }

  const writeEnabled = process.env.DFM_AGENT_WRITE_ENABLED === 'true';

  return {
    apiUrl,
    cluster,
    rpcUrl,
    keypairPath: resolveKeypairPath(),
    keypairJsonEnvPresent: typeof process.env.DFM_AGENT_KEYPAIR_JSON === 'string'
      && process.env.DFM_AGENT_KEYPAIR_JSON.trim().length > 0,
    writeEnabled,
  };
}
