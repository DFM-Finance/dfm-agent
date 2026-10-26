import assert from 'node:assert/strict';
import { presentFees, withFeesNote, FEES_UNAVAILABLE_NOTE } from './fees.js';

// Live numbers present → passed through unchanged (75/75 is the live factory, 2026-10).
assert.deepEqual(presentFees(75, 75), { entryBps: 75, exitBps: 75 });
// A real 0 stays 0 — only an unknown becomes "unavailable".
assert.deepEqual(presentFees(0, 0, false), { entryBps: 0, exitBps: 0 });

// v.2150 shape: null + feesUnavailable → never 0.
for (const [e, x, u] of [[null, null, true], [null, null, undefined], [75, null, undefined], [undefined, undefined, undefined], [75, 75, true]] as const) {
  const p = presentFees(e, x, u);
  assert.equal(p.entryBps, null);
  assert.equal(p.exitBps, null);
  assert.equal(p.feesUnavailable, true);
  assert.equal(p.note, FEES_UNAVAILABLE_NOTE);
  assert.ok(!JSON.stringify(p).includes(':0'), 'an unknown fee must not serialize as 0');
}

// get_vault: the real v.2150 failed-read shape gets the note; a healthy one does not.
const failed = {
  vault: { address: 'x', entryFeeBps: null, exitFeeBps: null },
  feeStructure: { entryFeeBps: null, exitFeeBps: null, managementFeeBps: 0, creatorFeeRatioBps: null, platformFeeRatioBps: null, feesUnavailable: true },
};
assert.equal(withFeesNote(failed).feesNote, FEES_UNAVAILABLE_NOTE);
const ok = {
  vault: { address: 'x', entryFeeBps: 75, exitFeeBps: 75 },
  feeStructure: { entryFeeBps: 75, exitFeeBps: 75, managementFeeBps: 0, creatorFeeRatioBps: 5000, platformFeeRatioBps: 5000, feesUnavailable: false },
};
assert.equal(withFeesNote(ok).feesNote, undefined);
assert.equal(withFeesNote(ok), ok);

console.log('fees.test: ok');
