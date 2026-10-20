import assert from 'node:assert/strict';
import { leanTokenRows } from './token-search.js';

// Real shape: one row of GET /api/v2/assets/search?q=JUP (2026-10-20), repeated to 100.
const JUP = {
  mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter', decimals: 6,
  logoUri: 'https://static.jup.ag/jup/icon.png', isActive: true, isVerified: true, assetClass: 'crypto',
  usdPrice: 0.3156713217031141, liquidityUsd: 5506514.938764817, mcap: 1047829663.9640923, holderCount: 839648,
  organicScore: 98.01470292997661, organicScoreLabel: 'high', createdAt: '2024-06-07T10:56:42.584Z',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', isToken2022: false, freezeAuthority: null,
  mintAuthority: null, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 15.5, devMints: 1 },
  tags: ['birdeye-trending', 'community', 'moonshot-verified', 'strict', 'verified', 'defi'],
  basketEligibility: 'eligible', eligibilityReason: 'legacy SPL with no freeze authority', eligibilityVerified: true,
  volume24hUsd: 8700653.762473749, priceChange24hPct: 7.599012317114623,
};
const rows = Array.from({ length: 100 }, () => JUP);
const full = JSON.stringify(rows).length;

const lean = leanTokenRows(rows) as { results: Record<string, unknown>[]; shown: number; total: number };
assert.equal(lean.shown, 10, 'default limit is 10');
assert.equal(lean.total, 100, 'says how many the search found');
assert.deepEqual(Object.keys(lean.results[0]!).sort(), [
  'assetClass', 'basketEligibility', 'decimals', 'eligibilityReason', 'isToken2022', 'isVerified',
  'liquidityUsd', 'mcap', 'mint', 'name', 'organicScoreLabel', 'symbol',
]);
assert.ok(JSON.stringify(lean).length < full / 20, `lean output is a small fraction of the raw ${full} bytes`);
assert.equal((leanTokenRows(rows, 500) as { shown: number }).shown, 50, 'limit is capped at 50');
assert.equal((leanTokenRows(rows, 0) as { shown: number }).shown, 1, 'limit is at least 1');
assert.deepEqual(leanTokenRows({ error: 'x' }), { error: 'x' }, 'a non-array answer passes through');
console.log('token-search: ok');
