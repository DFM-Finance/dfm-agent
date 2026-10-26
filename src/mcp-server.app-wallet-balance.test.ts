/**
 * `app_wallet` balance regressions (runnable: `npx tsx src/mcp-server.app-wallet-balance.test.ts`).
 *
 * v.2222 (/propagate finding): when the whole `GET /agent/operating/float/balance`
 * call failed, `bal` was null and `(bal?.usdcMicros ?? 0)` reported
 * `balance: {usdc: 0, sol: 0}` next to "Balance unavailable" — a funded wallet
 * read as empty. A balance we could not read is UNKNOWN: null legs, never 0.
 *
 * Driven through the real registered server and a real MCP Client (in-memory
 * transport); only the two API client methods are stubbed, with the shapes the
 * API answers (`operating-wallet.controller.ts` float/balance, `/agent/operating`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DfmApiClient } from './api-client.js';
import { server } from './mcp-server.js';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failures++;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

const ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const OWNER = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
type FloatBalance = Awaited<ReturnType<DfmApiClient['getOperatingFloatBalance']>>;

const proto = DfmApiClient.prototype as unknown as {
  getOperatingWallet: () => Promise<unknown>;
  getOperatingFloatBalance: () => Promise<FloatBalance>;
};
proto.getOperatingWallet = async () => ({ wallet: OWNER, operatingWalletAddress: ADDRESS, status: 'active' });

const client = new Client({ name: 'app-wallet-balance-test', version: '0.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

async function appWallet(): Promise<Record<string, any>> {
  const res = (await client.callTool({ name: 'app_wallet', arguments: {} })) as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  assert(res.isError !== true, 'app_wallet answers (not an error) when only the balance is missing');
  return JSON.parse(res.content.find((c) => c.type === 'text')?.text ?? '{}');
}

// 1. The whole float call throws (5xx / network): null legs + "unavailable", never 0.
console.log('float call throws');
proto.getOperatingFloatBalance = async () => {
  throw new Error('DFM API 502: Bad Gateway');
};
let out = await appWallet();
assert(out.balance?.usdc === null, `balance.usdc === null (got ${JSON.stringify(out.balance?.usdc)})`);
assert(out.balance?.sol === null, `balance.sol === null (got ${JSON.stringify(out.balance?.sol)})`);
assert(out.balanceUnavailable === true, 'balanceUnavailable flag is set');
assert(/unavailable/i.test(out.nextStep) && /UNKNOWN, not 0/.test(out.nextStep), `nextStep says unavailable/UNKNOWN (got "${out.nextStep}")`);
assert(!/empty|NO SOL/.test(out.nextStep), 'nextStep reports no shortfall');
assert(out.withdrawable === undefined, 'no withdrawable block without a balance');

// 2. An older API that omits the legs and withdrawable fields: null, never 0 or NaN.
console.log('fields absent');
proto.getOperatingFloatBalance = async () =>
  ({ operatingWalletAddress: ADDRESS, status: 'active' }) as unknown as FloatBalance;
out = await appWallet();
assert(out.balance?.usdc === null && out.balance?.sol === null, 'absent legs read as null');
assert(out.withdrawable?.usdc === null && out.withdrawable?.sol === null, 'absent withdrawable reads as null');
assert(/UNKNOWN, not 0/.test(out.nextStep), 'absent legs give the unavailable nextStep');

// 3. Control: a real read still converts base units and reports the funded state.
console.log('real balance');
proto.getOperatingFloatBalance = async () => ({
  operatingWalletAddress: ADDRESS,
  status: 'active',
  solLamports: 110_000_000,
  usdcMicros: 12_500_000,
  reservedSolLamports: 2_039_280,
  withdrawableSolLamports: 107_960_720,
  withdrawableUsdcMicros: 12_500_000,
});
out = await appWallet();
assert(out.balance?.usdc === 12.5 && out.balance?.sol === 0.11, `balance {12.5, 0.11} (got ${JSON.stringify(out.balance)})`);
assert(out.balanceUnavailable === undefined, 'no unavailable flag on a real read');
assert(out.withdrawable?.sol === 0.10796072, 'withdrawable SOL converted');

await client.close();
if (failures > 0) {
  console.error(`\n${failures} app_wallet balance check(s) failed`);
  process.exit(1);
}
console.log('\napp_wallet balance: all checks passed');
process.exit(0);
