import assert from 'node:assert/strict';
import { executeAppWalletWrite, shouldExecuteViaAppWallet, mayLaunchViaAppWallet } from './keyless.js';
import type { AgentConfig } from './config.js';

const config = {} as AgentConfig;
const names = ['DFM_API_KEY', 'DFM_AGENT_KEYPAIR_PATH', 'DFM_AGENT_FORCE_LOCAL_SIGNING'];
const saved = names.map((name) => process.env[name]);
try {
  delete process.env.DFM_API_KEY;
  process.env.DFM_AGENT_KEYPAIR_PATH = '/tmp/auth-only-wallet.json';
  process.env.DFM_AGENT_FORCE_LOCAL_SIGNING = 'true';
  let status: string | undefined = 'active';
  let executions = 0;
  const calls: string[] = [];
  const api = {
    getOperatingWallet: async () => status ? { status } : null,
    executeViaOperatingWallet: async (tool: string) => {
      executions++; calls.push(tool);
      return { signature: 'APP_WALLET_SIGNATURE', status: 'complete' };
    },
  };
  // Exercise the actual boundary used by MCP, including its retired override.
  for (const tool of ['launch_vault', 'deposit', 'redeem', 'rebalance_to_targets',
    'init_rebalancer', 'update_vault_assets', 'zap_v2_cancel', 'zap_v2_update_envelope']) {
    status = 'active';
    assert.equal(shouldExecuteViaAppWallet(config, status), true);
    assert.equal(mayLaunchViaAppWallet(config, status), true);
    assert.equal((await executeAppWalletWrite(config, api, tool, {})).signature, 'APP_WALLET_SIGNATURE');
    const before = executions;
    for (status of ['pending', 'revoked', undefined]) {
      await assert.rejects(executeAppWalletWrite(config, api, tool, {}), /OPERATING_WALLET_REQUIRED/);
      assert.equal(executions, before, 'an unavailable app wallet never reaches any signer');
    }
  }
  assert.equal(calls.length, 8);
  await assert.rejects(executeAppWalletWrite(config, {
    ...api, getOperatingWallet: async () => { throw new Error('lookup failed'); },
  }, 'deposit', {}), /lookup failed/);
  status = 'active';
  await assert.rejects(executeAppWalletWrite(config, {
    ...api, executeViaOperatingWallet: async () => { throw new Error('signature refused'); },
  }, 'redeem', {}), /signature refused/);
  process.env.DFM_API_KEY = 'dfm_test';
  delete process.env.DFM_AGENT_KEYPAIR_PATH;
  status = 'revoked';
  await assert.rejects(executeAppWalletWrite(config, {
    ...api, executeViaOperatingWallet: async () => { throw new Error('server: wallet revoked'); },
  }, 'deposit', {}), /wallet revoked/);
  console.log('✓ app-wallet-only: all 9 fund operations, unavailable wallets, local override, lookup and signing failures');
} finally {
  names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
}
