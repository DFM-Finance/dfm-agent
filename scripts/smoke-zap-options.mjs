#!/usr/bin/env node
/** Public MCP contract against a loopback API sink: no keys, RPC or chain writes. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const VAULT = '96garpVfmLBkvK33fh7f5edfe85UbhmZ6K67freykxsC';
const APP = 'E31DfA5jQppQFkzCUsh9NRiXqzic9bY6t2pdKt3MZXgj';
const OWNER = '4MJUCMQvn5fgkuH4m5oZatxfnmRBMP1EXLAtZii1Drb9';
const writes = [];
const unexpectedRequests = [];
const sink = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/api/v2/agent/operating') {
    res.end(JSON.stringify({ wallet: OWNER, operatingWalletAddress: APP, status: 'active' }));
  } else if (req.method === 'POST' && req.url === '/api/v2/agent/operating/execute') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    writes.push(payload);
    res.end(JSON.stringify({ status: 'pending', signature: `open-${payload.tool}`, note: 'OPEN landed; keeper active.' }));
  } else if (req.method === 'GET' && req.url === `/api/v2/vaults/${VAULT}/zap-v2/status/${APP}`) {
    res.end(JSON.stringify({ readyToClose: false, legsFilled: 1, legsTotal: 6 }));
  } else {
    unexpectedRequests.push(`${req.method} ${req.url}`);
    res.writeHead(404).end(JSON.stringify({ error: 'unexpected loopback request' }));
  }
});
await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
const client = new Client({ name: 'zap-options-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/mcp-server.js', import.meta.url))],
  env: {
    DFM_API_URL: `http://127.0.0.1:${sink.address().port}`,
    DFM_API_KEY: 'dfm_loopback_only_not_a_credential',
    DFM_AGENT_WRITE_ENABLED: 'true',
    DFM_AGENT_KEYPAIR_PATH: '',
    DFM_AGENT_KEYPAIR_JSON: '',
    // This smoke IS a non-interactive pipeline: there is no human who could
    // type a confirmation phrase, so it exercises the documented opt-in escape
    // (redteam F2). Interactive use must NOT copy this — leave the env unset
    // and relay confirmPhrase:"<tool>" from the human instead.
    DFM_MCP_NONINTERACTIVE_WRITES: '1',
  },
  stderr: 'pipe',
});
transport.stderr?.resume();
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
const payload = (result) => JSON.parse(result.content.find((item) => item.type === 'text').text);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.match(client.getInstructions(), /pending.*zap_status/s);
  for (const name of ['deposit', 'redeem']) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `${name} remains published`);
    const { properties } = tool.inputSchema;
    assert.equal(properties.expirySecs.minimum, 60);
    assert.equal(properties.expirySecs.maximum, 1800);
    assert.match(properties.expirySecs.description, /300/);
    assert.equal(properties.pollTimeoutSecs, undefined, 'do not advertise an unsupported polling control');
    assert.match(tool.description, /asynchron/);
    assert.match(tool.description, /zap_status/);
    assert.match(tool.description, /[Dd]o not repeat/);

    const amount = name === 'deposit' ? { usdcAmount: '12000000' } : { shares: '1000000' };
    const result = await call(name, { vault: VAULT, ...amount, expirySecs: 600 });
    assert.ok(!result.isError);
    assert.deepEqual(writes.at(-1), { tool: name, args: { vault: VAULT, ...amount, expirySecs: 600 } });
    const pending = payload(result);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.signature, `open-${name}`, 'preserve the OPEN receipt');
    assert.match(pending.note, /OPEN landed; keeper active/, 'preserve server context');
    assert.match(pending.note, /not.*settled/i);
    assert.match(pending.note, /zap_status/);
    assert.match(pending.note, /[Dd]o not repeat/);

    const beforeStatus = writes.length;
    const status = payload(await call('zap_status', { vault: VAULT }));
    assert.equal(status.legsFilled, 1, 'read the assigned app-wallet escrow');
    assert.equal(writes.length, beforeStatus, 'checking progress never repeats a financial write');

    // Old clients may still send the removed option. MCP strips unknown keys;
    // they remain compatible, but neither promise nor forward a polling budget.
    const legacy = await call(name, { vault: VAULT, ...amount, pollTimeoutSecs: 180 });
    assert.ok(!legacy.isError);
    assert.deepEqual(writes.at(-1), { tool: name, args: { vault: VAULT, ...amount } });
    assert.equal(payload(legacy).status, 'pending');
    for (const expirySecs of [59, 1801, 600.5, '600']) {
      const beforeInvalid = writes.length;
      const invalid = await call(name, { vault: VAULT, ...amount, expirySecs });
      assert.equal(invalid.isError, true, `reject invalid expiry ${expirySecs}`);
      assert.equal(writes.length, beforeInvalid, 'invalid expiry never reaches execution');
    }
  }
  assert.deepEqual(unexpectedRequests, []);
  console.log('✅ MCP zap options: both tools forward expiry, validate bounds, and expose asynchronous pending settlement.');
} finally {
  await client.close();
  await new Promise((resolve, reject) => sink.close((error) => error ? reject(error) : resolve()));
}
