/**
 * #47 regression (runnable: `npx tsx agent/src/create-flow.metadata.test.ts`).
 *
 * THE BUG: a vault launched via the MCP shipped with NO share-mint metadata
 * ("SPL Token", no name/ticker). Root cause: the metadata attach called
 * `submitSignedTx` directly, which THROWS when `config.rpcUrl` is unset — and the
 * MCP's DEFAULT is backend-broadcast mode (no RPC) — and the throw was swallowed.
 * So in backend mode the metadata tx could NEVER be submitted.
 *
 * This locks the fix: with no client RPC, `attachShareMintMetadata` must submit via
 * the BACKEND path (the `preparedTxId`), NOT `submitSignedTx`; it must surface a
 * missing-preparedTxId as an error (not silently lose it); and an "already in use"
 * revert is idempotent (treated as already-attached, no error). sign/submit are
 * injected so no real keypair/RPC is needed.
 */
import { attachShareMintMetadata } from './create-flow.js';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failures++;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

const VAULT = 'Vau1t1111111111111111111111111111111111111';
const sign = (_c: unknown, t: string) => t; // no real keypair

async function caseBackendPath(): Promise<void> {
  console.log('case: no client RPC → backend-submit via preparedTxId (NOT submitSignedTx)');
  let directCalled = 0;
  let backendCalled = 0;
  const api = {
    prepareCreateVaultMetadata: async () => ({
      transaction: 'BASE64TX',
      blockhash: 'bh',
      lastValidBlockHeight: 1,
      preparedTxId: 'pid-123',
    }),
  };
  const res = await attachShareMintMetadata(
    { rpcUrl: undefined } as never,
    api as never,
    VAULT,
    {
      signBase64Transaction: sign as never,
      submitViaBackendConfirmed: (async (opts: { preparedTxId: string }) => {
        backendCalled++;
        assert(opts.preparedTxId === 'pid-123', 'backend got the preparedTxId');
        return { signature: 'metaSig', confirmed: true };
      }) as never,
      submitSignedTx: (async () => {
        directCalled++;
        throw new Error('submitSignedTx must NOT be called in backend mode (the old bug)');
      }) as never,
    },
  );
  assert(res.signature === 'metaSig', `returns the metadata signature (got '${res.signature}')`);
  assert(res.error === undefined, 'no error');
  assert(backendCalled === 1, 'backend submit called once');
  assert(directCalled === 0, 'submitSignedTx was NOT called');
}

async function caseNoPreparedTxId(): Promise<void> {
  console.log('case: no RPC + no preparedTxId → surfaced error, not a silent loss');
  const api = {
    prepareCreateVaultMetadata: async () => ({
      transaction: 'BASE64TX',
      blockhash: 'bh',
      lastValidBlockHeight: 1,
      // preparedTxId missing
    }),
  };
  const res = await attachShareMintMetadata(
    { rpcUrl: undefined } as never,
    api as never,
    VAULT,
    { signBase64Transaction: sign as never },
  );
  assert(res.signature === undefined, 'no signature');
  assert(!!res.error && /preparedTxId/i.test(res.error), `error mentions preparedTxId (got '${res.error}')`);
}

async function caseIdempotent(): Promise<void> {
  console.log('case: "already in use" revert → treated as already-attached (no error)');
  const api = {
    prepareCreateVaultMetadata: async () => ({
      transaction: 'BASE64TX',
      blockhash: 'bh',
      lastValidBlockHeight: 1,
      preparedTxId: 'pid-123',
    }),
  };
  const res = await attachShareMintMetadata(
    { rpcUrl: undefined } as never,
    api as never,
    VAULT,
    {
      signBase64Transaction: sign as never,
      submitViaBackendConfirmed: (async () => {
        throw new Error('Allocate: account Address already in use');
      }) as never,
    },
  );
  assert(res.error === undefined, `idempotent revert cleared the error (got '${res.error}')`);
}

(async () => {
  await caseBackendPath();
  await caseNoPreparedTxId();
  await caseIdempotent();
  if (failures > 0) {
    console.error(`\n#47 regression FAILED (${failures} assertion(s))`);
    process.exit(1);
  }
  console.log('\n#47 regression PASSED');
})();
