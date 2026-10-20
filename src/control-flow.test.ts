import type { AgentConfig } from './config.js';
import type { DfmApiClient } from './api-client.js';
import {
  runAcceptAdminTransfer,
  reconcileKeylessUpdateVaultPolicy,
  runUpdateVaultPolicy,
  validateVaultPolicy,
} from './manager-flow.js';
import type { VaultPolicyInput, ZapV2SingleTxResponse } from './types.js';

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

function expectValidationReject(
  policy: VaultPolicyInput,
  expected: RegExp,
  message: string,
): void {
  try {
    validateVaultPolicy(policy);
    assert(false, `${message} (did not reject)`);
  } catch (thrownObject) {
    const reason = thrownObject instanceof Error ? thrownObject.message : String(thrownObject);
    assert(expected.test(reason), `${message} (${reason})`);
  }
}

const config = {} as AgentConfig;
const vault = 'Vau1t1111111111111111111111111111111111111';
const signatureOne = '5'.repeat(88);
const signatureTwo = '6'.repeat(88);
const prepared = (transaction: string): ZapV2SingleTxResponse => ({
  transaction,
  blockhash: `blockhash-${transaction}`,
  lastValidBlockHeight: 123,
  preparedTxId: `prepared-${transaction}`,
});
const policy: VaultPolicyInput = {
  assetMode: 0,
  maxAssetBps: 6_000,
  minAssetBps: 500,
  maxRebalanceBps: 2_000,
  minRebalanceIntervalSecs: 300,
  maxRebalancesPerDay: 5,
  maxRebalancesPerWeek: 15,
  launchBlackoutSecs: 3_600,
  minAssets: 2,
  maxAssets: 10,
};

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

console.log('case: policy bounds reject every out-of-range integer and invalid relation');
validateVaultPolicy(policy);
const invalidPolicies: Array<[VaultPolicyInput, RegExp, string]> = [
  [{ ...policy, assetMode: 4 as VaultPolicyInput['assetMode'] }, /assetMode/, 'assetMode > 3'],
  [{ ...policy, maxAssetBps: 10_001 }, /maxAssetBps/, 'maxAssetBps > 10000'],
  [{ ...policy, minAssetBps: -1 }, /minAssetBps/, 'minAssetBps < 0'],
  [{ ...policy, maxRebalanceBps: 0.5 }, /maxRebalanceBps/, 'fractional maxRebalanceBps'],
  [
    { ...policy, minRebalanceIntervalSecs: Number.MAX_SAFE_INTEGER + 1 },
    /minRebalanceIntervalSecs/,
    'unsafe minRebalanceIntervalSecs',
  ],
  [{ ...policy, maxRebalancesPerDay: 11 }, /maxRebalancesPerDay/, 'daily cap > 10'],
  [{ ...policy, maxRebalancesPerWeek: 31 }, /maxRebalancesPerWeek/, 'weekly cap > 30'],
  [{ ...policy, launchBlackoutSecs: 2_592_001 }, /launchBlackoutSecs/, 'blackout > 30d'],
  [{ ...policy, minAssets: 11 }, /minAssets/, 'minAssets > product cap 10'],
  [{ ...policy, maxAssets: 11 }, /maxAssets/, 'maxAssets > product cap 10'],
  [
    { ...policy, minAssetBps: 6_001, maxAssetBps: 6_000 },
    /minAssetBps cannot exceed/,
    'minimum weight exceeds maximum',
  ],
  [
    { ...policy, minAssets: 8, maxAssets: 7 },
    /minAssets cannot exceed/,
    'minimum asset count exceeds maximum',
  ],
];
for (const [invalidPolicy, expected, message] of invalidPolicies) {
  expectValidationReject(invalidPolicy, expected, message);
}

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

console.log('case: legacy policy creates one transaction and reconciles it');
{
  const sequence: Array<string> = [];
  const api = {
    getOnchainPolicy: async () => null,
    prepareCreateVaultPolicy: async () => {
      sequence.push('prepare:create');
      return prepared('create');
    },
    confirmVaultPolicy: async (_vault: string, signature: string) => {
      sequence.push(`confirm:${signature}`);
      return { onChain: true as const };
    },
  } as unknown as DfmApiClient;
  const result = await runUpdateVaultPolicy(
    config,
    api,
    vault,
    policy,
    undefined,
    signingDependencies([signatureOne], sequence),
  );
  assert(result.mode === 'create' && result.reconciled, 'legacy policy returns reconciled create');
  assert(sequence.at(-1) === `confirm:${signatureOne}`, 'create is reconciled after landing');
}

console.log('case: existing policy proposes then accepts in order and confirms final signature');
{
  const sequence: Array<string> = [];
  let proposedEffectiveAt = 0;
  let acceptedEffectiveAt = 0;
  const api = {
    getOnchainPolicy: async () => ({ pendingProposedAt: 0, pendingEffectiveAt: 0 }),
    prepareProposeVaultPolicy: async (
      _vault: string,
      amendment: VaultPolicyInput & { effectiveAt: number },
    ) => {
      proposedEffectiveAt = amendment.effectiveAt;
      sequence.push('prepare:propose');
      return prepared('propose');
    },
    prepareAcceptVaultPolicy: async (
      _vault: string,
      amendment: VaultPolicyInput & { effectiveAt: number },
    ) => {
      acceptedEffectiveAt = amendment.effectiveAt;
      sequence.push('prepare:accept');
      return prepared('accept');
    },
    confirmVaultPolicy: async (_vault: string, signature: string) => {
      sequence.push(`confirm:${signature}`);
      return { onChain: true as const };
    },
  } as unknown as DfmApiClient;
  const result = await runUpdateVaultPolicy(
    config,
    api,
    vault,
    policy,
    undefined,
    signingDependencies([signatureOne, signatureTwo], sequence),
  );
  assert(result.mode === 'amend', 'existing policy chooses amendment mode');
  assert(
    proposedEffectiveAt > 0 && proposedEffectiveAt === acceptedEffectiveAt,
    'proposal and acceptance commit the same effectiveAt',
  );
  assert(
    sequence.join('|') ===
      `prepare:propose|prepare:accept|sign:propose|submit:signed:propose|sign:accept|submit:signed:accept|confirm:${signatureTwo}`,
    'ordered proposal and acceptance reconcile only after the final signature',
  );
}

console.log('case: pending policy prepares only acceptance with chain-pinned effectiveAt');
{
  let proposeCalls = 0;
  let acceptedEffectiveAt = 0;
  const api = {
    getOnchainPolicy: async () => ({ pendingProposedAt: 99, pendingEffectiveAt: 123_456 }),
    prepareProposeVaultPolicy: async () => {
      proposeCalls++;
      return prepared('must-not-run');
    },
    prepareAcceptVaultPolicy: async (
      _vault: string,
      amendment: VaultPolicyInput & { effectiveAt: number },
    ) => {
      acceptedEffectiveAt = amendment.effectiveAt;
      return prepared('accept');
    },
    confirmVaultPolicy: async () => ({ onChain: true as const }),
  } as unknown as DfmApiClient;
  const result = await runUpdateVaultPolicy(
    config,
    api,
    vault,
    policy,
    undefined,
    signingDependencies([signatureTwo], []),
  );
  assert(result.mode === 'accept', 'pending proposal chooses accept mode');
  assert(proposeCalls === 0, 'pending recovery never proposes a second policy');
  assert(acceptedEffectiveAt === 123_456, 'acceptance uses chain-pinned effectiveAt');
}

console.log('case: partial amendment reports landed proposal and does not confirm');
{
  let submitCalls = 0;
  let confirmCalls = 0;
  const api = {
    getOnchainPolicy: async () => ({ pendingProposedAt: 0, pendingEffectiveAt: 0 }),
    prepareProposeVaultPolicy: async () => prepared('propose'),
    prepareAcceptVaultPolicy: async () => prepared('accept'),
    confirmVaultPolicy: async () => {
      confirmCalls++;
      return { onChain: true as const };
    },
  } as unknown as DfmApiClient;
  await expectReject(
    () =>
      runUpdateVaultPolicy(config, api, vault, policy, undefined, {
        signBase64Transaction: (_config, transaction) => transaction,
        submitSignedTx: async () => {
          submitCalls++;
          if (submitCalls === 1) return signatureOne;
          throw new Error('second transaction rejected');
        },
      }),
    new RegExp(`proposal ${signatureOne} landed.*exact same policy values`, 'i'),
    'partial amendment cannot be mistaken for no change',
  );
  assert(confirmCalls === 0, 'a partial proposal is not reported as reconciled completion');
}

console.log('case: keyless policy confirms complete writes and preserves pending status');
{
  let confirmCalls = 0;
  const completeApi = {
    confirmVaultPolicy: async () => {
      confirmCalls++;
      return { onChain: true as const };
    },
  } as unknown as DfmApiClient;
  const complete = await reconcileKeylessUpdateVaultPolicy(
    completeApi,
    vault,
    policy,
    { signature: signatureTwo, status: 'complete' },
  );
  assert(complete.reconciled && confirmCalls === 1, 'keyless completion is independently reconciled');

  const pendingApi = {
    confirmVaultPolicy: async () => {
      throw new Error('must not report a partial proposal as complete');
    },
  } as unknown as DfmApiClient;
  const pending = await reconcileKeylessUpdateVaultPolicy(
    pendingApi,
    vault,
    policy,
    { signature: signatureOne, status: 'pending', note: 'proposal landed' },
  );
  assert(
    pending.status === 'pending' && pending.reconciled === false,
    'keyless partial proposal remains pending and unreconciled',
  );
}

if (failures > 0) {
  console.error(`\n${failures} control-flow assertion(s) FAILED`);
  process.exit(1);
}
console.log('\ncontrol-flow: all assertions passed');
