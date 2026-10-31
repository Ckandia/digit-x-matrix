// Pure checks for the run-bias module: runs of 3+ ticks in favour of a contract.
import assert from 'node:assert/strict';
import { computeRunBias, computeRunSignals, favourFlags, runStats, MIN_RUN } from '../src/runBias.js';

// The owner's examples (decimals = 2, so the last digit is the 2nd decimal).
const px = digits => digits.map((d, i) => Number((100 + i * 0.1 + d / 100).toFixed(2)));
const row = (prices, key) => computeRunBias(prices, 2).rows.find(r => r.key === key);
const pad = (breaker, digits) => [...Array(60).fill(0).map((_, i) => (i % 2 ? 3 : 8)), breaker, ...digits]; // 60 mixed ticks, then one tick that breaks the run

// even 2,4,6 -> a run of 3 favouring Even, happening now
let r = row(px(pad(3, [2, 4, 6])), 'even');
assert.equal(r.current, 3, 'even 2,4,6 is a current run of 3');
// odd 1,3,7
r = row(px(pad(8, [1, 3, 7])), 'odd');
assert.equal(r.current, 3, 'odd 1,3,7');
// over 4: 5,8,9
r = row(px(pad(2, [5, 8, 9])), 'over4');
assert.equal(r.current, 3, 'over4 5,8,9');
// under 5: 2,1,4
r = row(px(pad(7, [2, 1, 4])), 'under5');
assert.equal(r.current, 3, 'under5 2,1,4');
// two ticks are not a run
assert.equal(row(px(pad(3, [2, 4])), 'even').current, 2, 'two even ticks are a run of 2, not a run');
assert.ok(row(px(pad(3, [2, 4])), 'even').current < MIN_RUN);

// runStats counts only runs of >= 3
const st = runStats([true, true, true, false, true, true, false, true, true, true, true, false], 3);
assert.deepEqual([st.runs, st.ticks_in_runs, st.longest, st.current], [2, 7, 4, 0]);

// rising prices: Rise has a run now, Fall does not; rise vs fall bias is high for Rise
const rising = Array.from({ length: 80 }, (_, i) => 100 + i * 0.3 + (i % 5 === 4 ? -0.1 : 0));
const flags = favourFlags(rising, 2);
assert.ok(flags.rise[10] && !flags.fall[10]);

// signals: entry only when the run is on now AND the bias is >= 55
const zig = Array.from({ length: 200 }, (_, i) => 100 + (i % 12 < 8 ? i * 0.2 : i * 0.2 - 3)); // long up-runs, short pullbacks
const scan = computeRunBias(zig, 2, 5000);
const sigs = computeRunSignals(scan, 'R_TEST');
for (const s of sigs) {
    assert.equal(s.family, 'run_bias');
    if (s.entry) assert.ok(s.run.current >= MIN_RUN && s.run.bias >= 55 && s.run_id !== undefined);
    else assert.equal(s.run_id, undefined);
}
// a run id is stable while the same run goes on (the window slides, the id does not)
const a = computeRunBias(rising.slice(0, 70), 2, 70).rows.find(x => x.key === 'rise');
const b = computeRunBias(rising.slice(0, 71), 2, 71).rows.find(x => x.key === 'rise');
if (a.current && b.current && b.current === a.current + 1) assert.equal(a.run_id, b.run_id, 'same run, same id');
console.log('runBias checks passed');
