/**
 * Example (READ-ONLY): list vaults, read one vault's detail, and check the
 * signed-in test wallet's zap-v2 escrow status + portfolio. Proves the live
 * read path end-to-end without moving any funds.
 *
 * Usage:
 *   DFM_API_URL=https://app.dfm.finance \
 *   DFM_AGENT_KEYPAIR_PATH=/abs/path/test-wallet.json \
 *   npx tsx src/examples/list-and-status.ts
 *
 * The keypair is only used to SIWS-sign in (so /portfolio + /zap-v2/status
 * resolve). It is never logged. The public /vaults reads work without it.
 */
import { loadConfig } from '../config.js';
import { SiwsSession } from '../session.js';
import { DfmApiClient } from '../api-client.js';

async function main() {
  const config = loadConfig();
  const session = new SiwsSession(config);
  const api = new DfmApiClient(config, session);

  console.log(`API: ${config.apiUrl} | cluster: ${config.cluster}`);

  // 1. Public: list vaults.
  const list = await api.listVaults({ limit: 10 });
  console.log(`\n${list.total} vault(s):`);
  for (const v of list.vaults) {
    console.log(
      `  ${v.address}  ${v.vaultSymbol ?? '?'}  tvl=${v.tvl ?? '0'}  price=${v.sharePrice ?? '?'}  ${
        v.status ?? (v.closed ? 'closed' : v.paused ? 'paused' : 'active')
      }`,
    );
  }
  if (list.vaults.length === 0) {
    console.log('No vaults — nothing more to show.');
    return;
  }

  const target = list.vaults[0].address;

  // 2. Public: vault detail.
  const detail = await api.getVault(target);
  console.log(`\nDetail for ${target}:`);
  console.log(JSON.stringify(detail.feeStructure ?? {}, null, 2));

  // 3. Authed reads — require SIWS sign-in (loads the test keypair).
  let wallet: string;
  try {
    wallet = session.walletAddress;
  } catch (e) {
    console.log(`\n(skipping authed reads — no test keypair configured: ${(e as Error).message})`);
    return;
  }
  console.log(`\nSigned-in test wallet: ${wallet}`);

  try {
    const status = await api.getZapV2Status(target, wallet);
    console.log(`zap-v2 escrow on ${target}:`, status ? JSON.stringify(status, null, 2) : 'none');
  } catch (e) {
    console.log(`zap_status error: ${(e as Error).message}`);
  }

  try {
    const positions = await api.getPortfolioPositions();
    console.log('Portfolio positions:', JSON.stringify(positions, null, 2));
  } catch (e) {
    console.log(`portfolio error: ${(e as Error).message}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
