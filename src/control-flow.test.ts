import type { AgentConfig } from './config.js';
import type { DfmApiClient } from './api-client.js';
import { runAcceptAdminTransfer } from './manager-flow.js';
import type { ZapV2SingleTxResponse } from './types.js';

let failures = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

async function expectReject(
  operation: () => Promise<unknown>,
  expected: RegExp,
  message: string,
): Promise<void> {
  try {
    await operation();
    assert(false, `${message} (did not reject)`);
  } catch (thrownObject) {
    const reason = thrownObject instanceof Error ? thrownObject.message : String(thrownObject);
    assert(expected.test(reason), `${message} (${reason})`);
  }
}

const config = {} as AgentConfig;
const vault = 'Vau1t1111111111111111111111111111111111111';
const signatureOne = '5'.repeat(88);
const prepared = (transaction: string): ZapV2SingleTxResponse => ({
  transaction,
  blockhash: `blockhash-${transaction}`,
  lastValidBlockHeight: 123,
  preparedTxId: `prepared-${transaction}`,
});
const signingDependencies = (signatures: Array<string>, sequence: Array<string>) => ({
  signBase64Transaction: (_config: AgentConfig, transaction: string): string => {
    sequence.push(`sign:${transaction}`);
    return `signed:${transaction}`;
  },
  submitSignedTx: async (
    _config: AgentConfig,
    signedTransaction: string,
  ): Promise<string> => {
    sequence.push(`submit:${signedTransaction}`);
    const signature = signatures.shift();
    if (!signature) throw new Error('missing test signature');
    return signature;
  },
});

console.log('case: local admin acceptance signs, lands, then confirms before success');
{
  const sequence: Array<string> = [];
  const api = {
    prepareAcceptAdminTransfer: async (): Promise<ZapV2SingleTxResponse> => {
      sequence.push('prepare');
      return prepared('accept');
    },
    confirmAcceptAdminTransfer: async (_vault: string, signature: string) => {
      sequence.push(`confirm:${signature}`);
      return { status: 'confirmed', signature, vaultAdmin: 'NewAdmin11111111111111111111111111111111111' };
    },
  } as unknown as DfmApiClient;
  const result = await runAcceptAdminTransfer(
    config,
    api,
    vault,
    undefined,
    signingDependencies([signatureOne], sequence),
  );
  assert(result.reconciled === true, 'success is marked reconciled');
  assert(
    sequence.join('|') ===
      `prepare|sign:accept|submit:signed:accept|confirm:${signatureOne}`,
    'post-chain confirm runs after submit',
  );
}

console.log('case: local admin acceptance never reports success when confirm fails');
{
  const api = {
    prepareAcceptAdminTransfer: async () => prepared('accept'),
    confirmAcceptAdminTransfer: async () => {
      throw new Error('indexer unavailable');
    },
  } as unknown as DfmApiClient;
  await expectReject(
    () =>
      runAcceptAdminTransfer(
        config,
        api,
        vault,
        undefined,
        signingDependencies([signatureOne], []),
      ),
    new RegExp(`transaction ${signatureOne} landed.*Do not submit another`, 'i'),
    'landed acceptance with failed reconciliation is an error with recovery guidance',
  );
}

console.log('case: landed admin signature retries confirm only');
{
  let prepareCalls = 0;
  let confirmedSignature = '';
  const api = {
    prepareAcceptAdminTransfer: async () => {
      prepareCalls++;
      return prepared('must-not-run');
    },
    confirmAcceptAdminTransfer: async (_vault: string, signature: string) => {
      confirmedSignature = signature;
      return { status: 'confirmed', signature, vaultAdmin: 'NewAdmin11111111111111111111111111111111111' };
    },
  } as unknown as DfmApiClient;
  await runAcceptAdminTransfer(config, api, vault, signatureOne);
  assert(prepareCalls === 0, 'recovery does not prepare or submit another acceptance');
  assert(confirmedSignature === signatureOne, 'recovery confirms the supplied landed signature');
}

if (failures > 0) {
  console.error(`\n${failures} control-flow assertion(s) FAILED`);
  process.exit(1);
}
console.log('\ncontrol-flow: all assertions passed');
