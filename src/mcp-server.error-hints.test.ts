/**
 * MCP error-hint regressions (runnable: `npx tsx src/mcp-server.error-hints.test.ts`).
 *
 * The server instructions tell an outside agent which onchain reverts it may see
 * and what each means. In the v1 build (`ENFORCE_DEPOSITOR_GUARDS = false`) the
 * admin-signed `rebalance_to_targets` path can still revert with:
 *   - RebalanceTooFrequent — the per-vault `config.min_rebalance_interval`
 *     (execute_rebalance.rs, unconditional; a creator can raise it above 5s);
 *   - SwapSlippageExceeded — the measured `min_out` floor;
 *   - InsufficientInputBalance — a leg whose input spends nothing.
 * It can NOT revert with ConfigTimelocked (the timelock `require!` is flag-gated
 * off in v1; dropped from the hints in 06eda239).
 *
 * Read through a real MCP Client over an in-memory transport, so this asserts the
 * text an outside agent actually receives at initialize.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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

const client = new Client({ name: 'error-hints-test', version: '0.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const instructions = client.getInstructions() ?? '';
const hintLine = instructions.split('\n').find((l) => l.includes('On a write error')) ?? '';
assert(hintLine.length > 0, 'instructions carry the write-error hint line');

for (const name of ['RebalanceTooFrequent', 'SwapSlippageExceeded', 'InsufficientInputBalance']) {
  assert(hintLine.includes(name), `error hints name ${name} (reachable on the admin rebalance path)`);
}
assert(!instructions.includes('ConfigTimelocked'), 'instructions do not cite ConfigTimelocked (unreachable in v1)');

await client.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll error-hint checks passed.');
