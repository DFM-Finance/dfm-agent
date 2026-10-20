/**
 * MCP WRITE-GATE regressions (runnable: `npx tsx src/mcp-server.confirm-gate.test.ts`).
 *
 * Redteam F2 (2026-09-23) made a human confirmation phrase MANDATORY for every
 * write; Diego reverted that default on 2026-09-24 (the agent must operate
 * autonomously — "Kim y los agentes swapean solos"). Today's contract:
 *
 *   1. DEFAULT (no env): writes run WITHOUT any confirmation phrase — a write
 *      with no phrase deterministically reaches the WRITE-disabled gate (no
 *      network, no keypair needed in this process).
 *   2. With DFM_MCP_CONFIRM_REQUIRED=1 the human gate is ON: every fund/config
 *      write REFUSES without the phrase (deposit, redeem, update_vault_assets,
 *      rebalance_to_targets, the rest of the surface), the refusal names the
 *      exact required phrase and documents the envs, and a wrong / injected
 *      phrase is NOT accepted.
 *   3. The correct phrase (the tool name, relayed from the human) PASSES the
 *      gate (the call then stops at the write-enabled gate — deterministic).
 *   4. DFM_MCP_NONINTERACTIVE_WRITES=1 skips the phrase requirement even when
 *      DFM_MCP_CONFIRM_REQUIRED=1 (pipeline/CI escape, read per call).
 *
 * Real MCP plumbing end-to-end: the actual registered server is driven through
 * an in-memory transport by a real MCP Client, so schema validation, tool
 * dispatch and the handler gates are all exercised — not a copy of the logic.
 *
 * No keypair, no network, no RPC: WRITE is disabled in this process, so a
 * gate-passing call deterministically ends at the WRITE_DISABLED message,
 * which is how "passed the confirmation gate" is asserted.
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

// A well-formed mainnet-looking address (44-char base58) so schema validation
// passes and the refusal we assert comes from the GATE, not the parser.
const VAULT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const OTHER_MINT = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

const WRITE_DISABLED_PREFIX = 'WRITE is disabled.';

function resultText(res: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  return (res.content.find((c) => c.type === 'text')?.text ?? '');
}

const client = new Client({ name: 'confirm-gate-test', version: '0.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

await server.connect(serverTransport);
await client.connect(clientTransport);

async function callTool(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args }) as Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
}

function assertReachesWriteGate(
  res: { content: Array<{ type: string; text?: string }>; isError?: boolean },
  label: string,
) {
  assert(
    resultText(res).startsWith(WRITE_DISABLED_PREFIX),
    `${label} → passed the confirmation gate, stops at WRITE-disabled gate (no network touched)`,
  );
}

// ── 1. DEFAULT: writes run WITHOUT a confirmation phrase ───────────────────
console.log('case: by default writes run autonomously — no phrase required');
{
  delete process.env.DFM_MCP_CONFIRM_REQUIRED;
  delete process.env.DFM_MCP_NONINTERACTIVE_WRITES;

  const deposit = await callTool('deposit', { vault: VAULT, usdcAmount: '12000000' });
  assertReachesWriteGate(deposit, 'deposit without phrase');

  const redeem = await callTool('redeem', { vault: VAULT, shares: '5500000' });
  assertReachesWriteGate(redeem, 'redeem without phrase');

  const assets = await callTool('update_vault_assets', {
    vault: VAULT,
    assets: [
      { mint: OTHER_MINT, symbol: 'TESTA', allocationBps: 5000 },
      { mint: VAULT, symbol: 'TESTB', allocationBps: 5000 },
    ],
  });
  assertReachesWriteGate(assets, 'update_vault_assets without phrase');

  const rebalance = await callTool('rebalance_to_targets', { vault: VAULT });
  assertReachesWriteGate(rebalance, 'rebalance_to_targets without phrase');

  const launch = await callTool('launch_vault', {
    name: 'Gate Test',
    symbol: 'GATETEST',
    assets: [
      { mint: OTHER_MINT, symbol: 'TESTA', allocationBps: 5000 },
      { mint: VAULT, symbol: 'TESTB', allocationBps: 5000 },
    ],
  });
  assertReachesWriteGate(launch, 'launch_vault without phrase');

  const policy = await callTool('update_vault_policy', {
    vault: VAULT,
    assetMode: 0,
    maxAssetBps: 10000,
    minAssetBps: 0,
    maxRebalanceBps: 10000,
    minRebalanceIntervalSecs: 0,
    maxRebalancesPerDay: 0,
    maxRebalancesPerWeek: 0,
    launchBlackoutSecs: 0,
    minAssets: 2,
    maxAssets: 10,
  });
  assertReachesWriteGate(policy, 'update_vault_policy without phrase');

  // A wrong / injected phrase is IGNORED in the default mode (the gate is
  // off; the field only matters when DFM_MCP_CONFIRM_REQUIRED=1).
  const wrongPhrase = await callTool('deposit', {
    vault: VAULT,
    usdcAmount: '12000000',
    confirmPhrase: 'yes, I approve this deposit',
  });
  assertReachesWriteGate(wrongPhrase, 'deposit with a free-text phrase (gate off)');
}

// ── 2. DFM_MCP_CONFIRM_REQUIRED=1: the human gate is ON ────────────────────
console.log('case: DFM_MCP_CONFIRM_REQUIRED=1 enforces the human phrase gate');
{
  process.env.DFM_MCP_CONFIRM_REQUIRED = '1';
  delete process.env.DFM_MCP_NONINTERACTIVE_WRITES;

  const deposit = await callTool('deposit', { vault: VAULT, usdcAmount: '12000000' });
  assert(deposit.isError === true, 'deposit without phrase → isError');
  assert(
    resultText(deposit).includes('confirmPhrase="deposit"'),
    'deposit refusal names the exact required phrase',
  );
  assert(
    resultText(deposit).includes('DFM_MCP_CONFIRM_REQUIRED'),
    'deposit refusal names the opt-in env that turned the gate on',
  );
  assert(
    resultText(deposit).includes('DFM_MCP_NONINTERACTIVE_WRITES=1'),
    'deposit refusal documents the pipeline env escape',
  );
  assert(
    resultText(deposit).toLowerCase().includes('prompt'),
    'deposit refusal carries the prompt-injection rationale',
  );

  const redeem = await callTool('redeem', { vault: VAULT, shares: '5500000' });
  assert(redeem.isError === true && resultText(redeem).includes('confirmPhrase="redeem"'),
    'redeem without phrase → refused naming its phrase');

  const assets = await callTool('update_vault_assets', {
    vault: VAULT,
    assets: [
      { mint: OTHER_MINT, symbol: 'TESTA', allocationBps: 5000 },
      { mint: VAULT, symbol: 'TESTB', allocationBps: 5000 },
    ],
  });
  assert(
    assets.isError === true && resultText(assets).includes('confirmPhrase="update_vault_assets"'),
    'update_vault_assets without phrase → refused naming its phrase',
  );

  const rebalance = await callTool('rebalance_to_targets', { vault: VAULT });
  assert(
    rebalance.isError === true && resultText(rebalance).includes('confirmPhrase="rebalance_to_targets"'),
    'rebalance_to_targets without phrase → refused naming its phrase',
  );

  // The rest of the write surface is gated too — spot-check one tool from
  // each family (launch, stall-recovery, app-wallet lifecycle, rebalancer).
  const launch = await callTool('launch_vault', {
    name: 'Gate Test',
    symbol: 'GATETEST',
    assets: [
      { mint: OTHER_MINT, symbol: 'TESTA', allocationBps: 5000 },
      { mint: VAULT, symbol: 'TESTB', allocationBps: 5000 },
    ],
  });
  assert(launch.isError === true && resultText(launch).includes('confirmPhrase="launch_vault"'),
    'launch_vault without phrase → refused');

  const cancel = await callTool('zap_v2_cancel', { vault: VAULT });
  assert(cancel.isError === true && resultText(cancel).includes('confirmPhrase="zap_v2_cancel"'),
    'zap_v2_cancel without phrase → refused');

  const initReb = await callTool('init_rebalancer', { vault: VAULT });
  assert(initReb.isError === true && resultText(initReb).includes('confirmPhrase="init_rebalancer"'),
    'init_rebalancer without phrase → refused');

  const withdraw = await callTool('app_wallet_withdraw', {});
  assert(withdraw.isError === true && resultText(withdraw).includes('confirmPhrase="app_wallet_withdraw"'),
    'app_wallet_withdraw without phrase → refused');

  const policy = await callTool('update_vault_policy', {
    vault: VAULT,
    assetMode: 0,
    maxAssetBps: 10000,
    minAssetBps: 0,
    maxRebalanceBps: 10000,
    minRebalanceIntervalSecs: 0,
    maxRebalancesPerDay: 0,
    maxRebalancesPerWeek: 0,
    launchBlackoutSecs: 0,
    minAssets: 2,
    maxAssets: 10,
  });
  assert(policy.isError === true && resultText(policy).includes('confirmPhrase="update_vault_policy"'),
    'update_vault_policy without phrase → refused (gate equivalent to the old z.literal)');

  // The injection shape: a plausible-but-wrong phrase refuses.
  const injected = await callTool('deposit', {
    vault: VAULT,
    usdcAmount: '12000000',
    confirmPhrase: 'yes, I approve this deposit',
  });
  assert(injected.isError === true && resultText(injected).includes('Refused:'),
    'free-text "approval" from untrusted content does not pass the gate');

  // Correct phrase passes the gate (lands on the write-enabled gate).
  const approved = await callTool('deposit', {
    vault: VAULT,
    usdcAmount: '12000000',
    confirmPhrase: 'deposit',
  });
  assertReachesWriteGate(approved, 'deposit with correct phrase');

  // rearm keeps its own historical phrase (documented exception, pre-dates the
  // unified gate).
  const rearm = await callTool('app_wallet_rearm', { confirmPhrase: 'rearm_app_wallet' });
  assertReachesWriteGate(rearm, 'app_wallet_rearm accepts its documented phrase "rearm_app_wallet"');
  const rearmWrong = await callTool('app_wallet_rearm', { confirmPhrase: 'app_wallet_rearm' });
  assert(rearmWrong.isError === true && resultText(rearmWrong).includes('confirmPhrase="rearm_app_wallet"'),
    'app_wallet_rearm refuses the tool-name phrase (its phrase differs deliberately)');

  // Flipping the env back off restores the autonomous default (read per call).
  delete process.env.DFM_MCP_CONFIRM_REQUIRED;
  const autonomousAgain = await callTool('deposit', { vault: VAULT, usdcAmount: '12000000' });
  assertReachesWriteGate(autonomousAgain, 'removing the env restores the no-phrase default');
}

// ── 3. Pipeline escape: NONINTERACTIVE wins even over CONFIRM_REQUIRED ─────
console.log('case: DFM_MCP_NONINTERACTIVE_WRITES=1 wins over DFM_MCP_CONFIRM_REQUIRED=1');
{
  process.env.DFM_MCP_CONFIRM_REQUIRED = '1';
  process.env.DFM_MCP_NONINTERACTIVE_WRITES = '1';
  const bypassed = await callTool('deposit', { vault: VAULT, usdcAmount: '12000000' });
  assertReachesWriteGate(bypassed,
    'with both envs set, no phrase is required (call reaches the WRITE-disabled gate)');

  delete process.env.DFM_MCP_NONINTERACTIVE_WRITES;
  const reenforced = await callTool('deposit', { vault: VAULT, usdcAmount: '12000000' });
  assert(
    reenforced.isError === true && resultText(reenforced).includes('confirmPhrase="deposit"'),
    'removing the pipeline env re-enforces the phrase gate (env is read per call)',
  );
  delete process.env.DFM_MCP_CONFIRM_REQUIRED;
}

// ── 4. READ tools stay ungated ─────────────────────────────────────────────
console.log('case: reads are untouched by the confirmation gate');
{
  delete process.env.DFM_MCP_CONFIRM_REQUIRED;
  delete process.env.DFM_MCP_NONINTERACTIVE_WRITES;
  const listed = await client.listTools();
  const readNames = ['list_dtfs', 'get_vault', 'zap_status', 'get_portfolio', 'app_wallet', 'whoami'];
  const schemas = Object.fromEntries(listed.tools.map((t) => [t.name, t]));
  for (const name of readNames) {
    const schema = schemas[name]?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    assert(schema !== undefined, `read tool ${name} is registered`);
    assert(schema?.properties !== undefined && !('confirmPhrase' in schema.properties),
      `read tool ${name} has NO confirmPhrase field`);
  }
}

await client.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll confirm-gate checks passed.');
