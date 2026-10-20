import assert from 'node:assert/strict';
import {
  buildWalletIdentity,
  resolveZapStatusWallet,
  withActingWalletAlias,
  withPortfolioWalletAlias,
} from './wallet-identity.js';

const signIn = '6VCH-sign-in';
const app = 'AppWa11et-internal';

const keylessIdentity = buildWalletIdentity(
  { wallet: signIn, operatingWalletAddress: app, status: 'active' },
  null,
);

assert.deepEqual(keylessIdentity, {
  signInWallet: signIn,
  appWalletAddress: app,
  appWalletStatus: 'active',
  actingWallet: app,
  portfolioWallet: app,
  primaryDfmWallet: app,
}, 'keyless identity must act and report positions through the app wallet');

assert.deepEqual(withActingWalletAlias(keylessIdentity), {
  wallet: app,
  ...keylessIdentity,
}, 'keyless whoami.wallet must be the app wallet');

assert.equal(
  resolveZapStatusWallet(keylessIdentity),
  app,
  'keyless zap_status must default to the app wallet',
);

assert.deepEqual(withPortfolioWalletAlias(keylessIdentity), {
  wallet: app,
  ...keylessIdentity,
}, 'keyless get_portfolio must report the app wallet');

const localIdentityWithOperatingProfile = buildWalletIdentity(
  { wallet: signIn, operatingWalletAddress: app, status: 'active' },
  signIn,
);

assert.deepEqual(localIdentityWithOperatingProfile, {
  signInWallet: signIn,
  appWalletAddress: app,
  appWalletStatus: 'active',
  actingWallet: app,
  portfolioWallet: app,
  primaryDfmWallet: app,
}, 'an external keypair must not replace the active app-wallet actor');

assert.deepEqual(withActingWalletAlias(localIdentityWithOperatingProfile), {
  wallet: app,
  ...localIdentityWithOperatingProfile,
}, 'whoami.wallet names the app wallet that executes fund operations');

assert.equal(
  resolveZapStatusWallet(localIdentityWithOperatingProfile),
  app,
  'zap_status inspects app-wallet escrows even with a local keypair',
);

assert.equal(
  resolveZapStatusWallet(localIdentityWithOperatingProfile, app),
  app,
  'zap_status must preserve an explicit wallet override',
);

assert.deepEqual(withPortfolioWalletAlias(localIdentityWithOperatingProfile), {
  wallet: app,
  ...localIdentityWithOperatingProfile,
}, 'local-keypair get_portfolio must label positions with the provisioned app wallet');

assert.deepEqual(
  buildWalletIdentity(null, signIn),
  {
    signInWallet: signIn,
    appWalletAddress: null,
    appWalletStatus: null,
    actingWallet: null,
    portfolioWallet: signIn,
    primaryDfmWallet: signIn,
  },
  'an external keypair with no app wallet has no fund-operation actor',
);

for (const status of ['pending', 'revoked', 'unknown']) {
  const identity = buildWalletIdentity({ wallet: signIn, operatingWalletAddress: app, status }, signIn);
  assert.equal(identity.actingWallet, null, `${status} grants never advertise external signing`);
  assert.equal(resolveZapStatusWallet(identity), app, `${status} grants still inspect existing app-wallet escrows`);
}
console.log('wallet identity tests passed');
