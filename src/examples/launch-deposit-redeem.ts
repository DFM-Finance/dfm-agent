/**
 * Example: the FULL DTF lifecycle a tester runs programmatically —
 *   launch (create a vault) → deposit USDC → redeem back to USDC.
 *
 * SAFE WHEN WRITE IS OFF: with DFM_AGENT_WRITE_ENABLED unset, this script does
 * the read-only parts (sign-in, list vaults) and then PRINTS the
 * exact launch/deposit/redeem calls it WOULD make, without moving any funds. Set
 * DFM_AGENT_WRITE_ENABLED=true (+ an RPC + a funded keypair) to
 * actually run the real-money flow.
 *
 * ⚠️ With write ON this MOVES REAL FUNDS on mainnet.
 * REVIEW: real-money path — parent must review before relying on this.
 *
 * Usage (dry-run, default):
 *   DFM_API_URL=https://app.dfm.finance \
 *   DFM_AGENT_KEYPAIR_PATH=/abs/path/test-wallet.json \
 *   npx tsx src/examples/launch-deposit-redeem.ts
 *
 * Usage (real-money, full loop):
 *   DFM_API_URL=https://app.dfm.finance \
 *   HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=… \
 *   DFM_AGENT_KEYPAIR_PATH=/abs/path/test-wallet.json \
 *   DFM_AGENT_WRITE_ENABLED=true \
 *   npx tsx src/examples/launch-deposit-redeem.ts
 *
 * Optional env:
 *   DEPOSIT_USDC_RAW   default "12000000" ($12 — clears the $10 first-mint floor)
 *   REDEEM_SHARES_RAW  if set, redeems exactly this many raw shares; if unset the
 *                      script reads the share balance from the portfolio and
 *                      redeems the full position.
 */
import { loadConfig } from '../config.js';
import { SiwsSession } from '../session.js';
import { DfmApiClient } from '../api-client.js';
import { runLaunchVault, type LaunchVaultParams } from '../create-flow.js';
import { runDeposit, runRedeem } from '../zap-v2-flow.js';

// A tiny 2-asset basket of established mints (open universe — no pre-registration
// or Pyth feed). Listing is validated inline against the live factory/fund-tier
// rules; freeze authority is a disclosed risk and not a v1 hard block. Weights sum to
// 10000 bps. Fees are read from the factory; callers cannot override them.
const ETH = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'; // Wormhole WETH
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'; // Jupiter

const DEMO_BASKET: LaunchVaultParams = {
  name: 'Agent Demo Fund',
  symbol: 'AGTDEMO',
  category: 255,
  assets: [
    { mint: ETH, symbol: 'ETH', mintBps: 5000 },
    { mint: JUP, symbol: 'JUP', mintBps: 5000 },
  ],
};

async function main(): Promise<void> {
  const config = loadConfig();
  const session = new SiwsSession(config);
  const api = new DfmApiClient(config, session);

  const depositRaw = process.env.DEPOSIT_USDC_RAW ?? '12000000';

  console.log(`API:    ${config.apiUrl} (${config.cluster})`);
  console.log(`Write:  ${config.writeEnabled ? 'ENABLED (real funds)' : 'OFF (dry-run)'}`);

  // Load the wallet pubkey (needs a keypair). In dry-run we tolerate its absence
  // so the plan still prints; the real-money path requires it.
  let wallet: string | null = null;
  try {
    wallet = session.walletAddress; // loads the keypair, surfaces pubkey only
    console.log(`Wallet: ${wallet}`);
  } catch (e) {
    if (config.writeEnabled) throw e;
    console.log(`Wallet: (no keypair configured — ${(e as Error).message})`);
  }

  // A read to prove the public API works (and show the current vault count).
  const list = await api.listVaults({ limit: 5 });
  console.log(`\nVaults visible: ${list.total}`);

  if (!config.writeEnabled) {
    console.log('\n── DRY-RUN (write OFF) — the real-money calls that WOULD run: ──');
    console.log(`1. launch_vault  ${JSON.stringify(DEMO_BASKET, null, 2)}`);
    console.log(`2. deposit       { vault: <new vault>, usdcAmount: "${depositRaw}" }`);
    console.log(`3. redeem        { vault: <new vault>, shares: "<full position>" }`);
    console.log('\nSet DFM_AGENT_WRITE_ENABLED=true (+ HELIUS_RPC_URL + funded keypair) to execute.');
    return;
  }
  if (!config.rpcUrl) {
    console.error('\nRefusing: write is ON but no RPC. Set HELIUS_RPC_URL to submit transactions.');
    process.exit(1);
  }
  if (!wallet) {
    // Unreachable (write-enabled loads the keypair above, which throws if absent)
    // — narrows the type for the deposit/redeem calls below.
    console.error('\nRefusing: no test wallet loaded.');
    process.exit(1);
  }

  // 1. LAUNCH.
  console.log('\n→ LAUNCH (create fund)…');
  const launch = await runLaunchVault(config, api, DEMO_BASKET);
  console.log(JSON.stringify(launch, null, 2));
  if (!launch.ok) {
    console.error('Launch did not fully complete — see message above. Stopping.');
    process.exit(1);
  }
  const vault = launch.vault;

  // 2. DEPOSIT.
  console.log(`\n→ DEPOSIT ${depositRaw} raw USDC into ${vault}…`);
  const dep = await runDeposit(config, api, wallet, vault, depositRaw);
  console.log(JSON.stringify(dep, null, 2));

  // Read the resulting position to size the redeem.
  console.log('\n→ position after deposit…');
  const positions = (await api.getPortfolioPositions()) as unknown;
  console.log(JSON.stringify(positions, null, 2));

  // 3. REDEEM. Prefer an explicit env; else try to read the share balance for
  //    this vault out of the portfolio payload (shape-tolerant).
  const sharesRaw = process.env.REDEEM_SHARES_RAW ?? extractShareBalance(positions, vault);
  if (!sharesRaw) {
    console.log(
      '\nCould not auto-determine the share balance to redeem. Set REDEEM_SHARES_RAW ' +
        '(raw 6dp) to the amount to redeem and re-run, or call redeem manually.',
    );
    return;
  }
  console.log(`\n→ REDEEM ${sharesRaw} raw shares from ${vault}…`);
  const red = await runRedeem(config, api, wallet, vault, sharesRaw);
  console.log(JSON.stringify(red, null, 2));
  console.log('\n✓ Full launch → deposit → redeem loop complete.');
}

/**
 * Best-effort extraction of a raw 6dp share balance for `vault` from the
 * /portfolio payload. The shape isn't strictly typed by the API, so we probe a
 * few likely fields and fall back to null (caller then asks for an explicit env).
 */
function extractShareBalance(positions: unknown, vault: string): string | null {
  const arr = Array.isArray(positions)
    ? positions
    : (positions as { positions?: unknown[] })?.positions;
  if (!Array.isArray(arr)) return null;
  for (const p of arr) {
    const row = p as Record<string, unknown>;
    const addr = row.vault ?? row.vaultAddress ?? row.address;
    if (addr !== vault) continue;
    const bal = row.sharesRaw ?? row.shareBalanceRaw ?? row.balanceRaw ?? row.shares ?? row.balance;
    if (typeof bal === 'string' && /^[1-9]\d*$/.test(bal)) return bal;
    if (typeof bal === 'number' && Number.isInteger(bal) && bal > 0) return String(bal);
  }
  return null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
