/**
 * The remote server is read-only and holds no credential. If the process was
 * started with anything that looks like a key, a secret, an RPC url or a write
 * switch in its environment it refuses to run, so a copied unit file cannot
 * turn it into a signer (or leak a keyed URL) by accident.
 *
 * This is a refusal by shape, not a list of today's names: a denylist of exact
 * names missed `DFM_APP_WALLET_OWNER_KEY_PATH` and `HELIUS_RPC_URL`. A name is
 * refused when it matches SENSITIVE (or starts with a prefix we own: DFM_,
 * HELIUS_, PRIVY_, which also covers switches like DFM_AGENT_WRITE_ENABLED)
 * unless it is in the small ALLOWED set the server itself reads.
 */
const SENSITIVE = /KEY|SECRET|TOKEN|PRIVATE|KEYPAIR|RPC_URL|OWNER/i;
const OWNED_PREFIX = /^(?:DFM_|HELIUS_|PRIVY_)/i;
const ALLOWED = new Set(['PORT', 'DFM_API_URL', 'NODE_ENV', 'PATH']);

export function assertRemoteEnv(env: NodeJS.ProcessEnv): void {
  const bad = Object.keys(env).filter((k) => env[k] !== undefined && env[k] !== '' && !ALLOWED.has(k) && (SENSITIVE.test(k) || OWNED_PREFIX.test(k)));
  if (bad.length) {
    throw new Error(`remote MCP server refuses to start: ${bad.join(', ')} must not be set (read-only, no credential)`);
  }
}
