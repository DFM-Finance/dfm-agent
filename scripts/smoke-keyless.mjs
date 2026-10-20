#!/usr/bin/env node
/**
 * Post-build KEYLESS-lane smoke.
 *
 * The keyless lane lets an agent write with only a `dfm_` API key — the server
 * signs with the user's operating wallet. Two properties are load-bearing and
 * both fail SILENTLY if they regress, which is why they get a build-blocking
 * check rather than a code comment:
 *
 *   1. WHO PAYS decides — an ACTIVE app wallet WINS, even when a local keypair
 *      exists. This header used to assert the opposite ("a local keypair WINS"),
 *      from when every on-chain proof we had ran through local signing. It is
 *      retired: the app wallet is where the user's money is and it OWNS the
 *      escrows it opens, so a locally-signed cancel or policy update is rejected
 *      by the chain. Gating on "does this process lack a keypair?" produced that
 *      exact failure twice (#77 recovery, update_vault_policy).
 *   2. `isKeylessMode` still means what it says — a key AND no keypair — and
 *      still gates the tools with no server-side path at all. It just does not
 *      decide WHO SIGNS a write. Engaging with neither would send
 *      unauthenticated writes; nothing in the type system encodes that.
 *
 * Exits non-zero on failure so it blocks the publish (wired into `npm test`).
 */
import { isKeylessMode, hasLocalKeypair, hasExplicitKeypair, shouldExecuteViaAppWallet } from '../dist/keyless.js';

let failures = 0;
const check = (name, cond) => {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
};

// Restore whatever the operator actually has set when we're done.
const originalKey = process.env.DFM_API_KEY;
const setKey = (v) => {
  if (v === undefined) delete process.env.DFM_API_KEY;
  else process.env.DFM_API_KEY = v;
};

const WITH_KEYPAIR = { keypairPath: '/tmp/some-wallet.json', keypairJsonEnvPresent: false };
const INLINE_KEYPAIR = { keypairPath: undefined, keypairJsonEnvPresent: true };
const NO_KEYPAIR = { keypairPath: undefined, keypairJsonEnvPresent: false };

console.log('keyless-lane smoke:');

check('a keypair path counts as a local keypair', hasLocalKeypair(WITH_KEYPAIR) === true);
check('an inline keypair env counts too', hasLocalKeypair(INLINE_KEYPAIR) === true);
check('neither ⇒ no local keypair', hasLocalKeypair(NO_KEYPAIR) === false);

// Explicit-vs-incidental. `config.keypairPath` is silently populated from a
// DEFAULT path when that file merely exists, so keying the decision off it made
// keyless silently never engage on such a machine — and writes were signed by an
// unrelated local wallet. Intent must win; this is the regression lock.
const origPath = process.env.DFM_AGENT_KEYPAIR_PATH;
const origJson = process.env.DFM_AGENT_KEYPAIR_JSON;
delete process.env.DFM_AGENT_KEYPAIR_PATH;
delete process.env.DFM_AGENT_KEYPAIR_JSON;
setKey('dfm_testkey');
check('no explicit keypair env ⇒ hasExplicitKeypair false', hasExplicitKeypair() === false);
check(
  'DEFAULT-path keypair present but NOT explicit ⇒ still KEYLESS (the v.904 bug)',
  isKeylessMode(WITH_KEYPAIR) === true,
);
process.env.DFM_AGENT_KEYPAIR_PATH = '/tmp/some-wallet.json';
check('EXPLICIT keypair env ⇒ NOT keyless (local signing wins)', isKeylessMode(WITH_KEYPAIR) === false);
check('hasExplicitKeypair true when env set', hasExplicitKeypair() === true);
delete process.env.DFM_AGENT_KEYPAIR_PATH;

check('key + no keypair ⇒ KEYLESS', isKeylessMode(NO_KEYPAIR) === true);
process.env.DFM_AGENT_KEYPAIR_JSON = '[1,2,3]';
check('key + inline keypair env ⇒ NOT keyless', isKeylessMode(INLINE_KEYPAIR) === false);
delete process.env.DFM_AGENT_KEYPAIR_JSON;

setKey(undefined);
check('no key ⇒ NOT keyless (nothing can sign; fail loudly later)',
  isKeylessMode(NO_KEYPAIR) === false);

// A blank/whitespace key must not count — an empty env var is "unset", and
// treating it as set would route writes to a request that 401s.
setKey('   ');
check('a whitespace-only key does NOT enable keyless', isKeylessMode(NO_KEYPAIR) === false);

// WHO PAYS — the rule that actually governs a money write. The retired
// `tryKeylessExecute` asked "does this process lack a keypair?", which answered
// the wrong question: an ACTIVE app wallet owns the escrow it opened, so it must
// sign even when a local keypair exists.
setKey('dfm_testkey');
let called = 0;
const api = {
  executeViaOperatingWallet: async () => {
    called++;
    return { signature: 'SIG_SERVER', status: 'complete' };
  },
};

process.env.DFM_AGENT_KEYPAIR_PATH = '/tmp/some-wallet.json';
check(
  'ACTIVE app wallet WINS over a local keypair (the mixed case that broke recovery)',
  shouldExecuteViaAppWallet(WITH_KEYPAIR, 'active') === true,
);
check(
  'no app wallet + local keypair ⇒ sign locally',
  shouldExecuteViaAppWallet(WITH_KEYPAIR, null) === false,
);
check(
  'a PENDING app wallet does NOT route to the server (it would be refused)',
  shouldExecuteViaAppWallet(WITH_KEYPAIR, 'pending') === false,
);
delete process.env.DFM_AGENT_KEYPAIR_PATH;

check(
  'keyless process routes to the server whatever the wallet status',
  shouldExecuteViaAppWallet(NO_KEYPAIR, null) === true,
);
const used = await api.executeViaOperatingWallet('deposit', { vault: 'V' });
check(
  'the operating-wallet executor returns the server signature',
  called === 1 && used?.signature === 'SIG_SERVER',
);

setKey(originalKey);
if (origPath !== undefined) process.env.DFM_AGENT_KEYPAIR_PATH = origPath;
if (origJson !== undefined) process.env.DFM_AGENT_KEYPAIR_JSON = origJson;

if (failures > 0) {
  console.error(`\nkeyless smoke FAILED (${failures} check${failures === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('keyless smoke passed');
