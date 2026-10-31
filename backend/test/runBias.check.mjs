// Pure checks for the run-bias module: runs of 2 / 3+ ticks in a row in favour of a contract, analysed per level.
import assert from 'node:assert/strict';
import { computeRunBias, computeRunSignals, favourFlags, runStats, LEVELS, FRESH_SLACK } from '../src/runBias.js';

const px = digits => digits.map((d, i) => Number((100 + i * 0.1 + d / 100).toFixed(2)));
const row = (prices, key) => computeRunBias(prices, 2).rows.find(r => r.key === key);
const pad = (breaker, digits) => [...Array(60).fill(0).map((_, i) => (i % 2 ? 3 : 8)), breaker, ...digits]; // 60 mixed ticks, then one tick that breaks the run

// the owner's examples: a run of 3
assert.equal(row(px(pad(3, [2, 4, 6])), 'even').current, 3, 'even 2,4,6');
assert.equal(row(px(pad(8, [1, 3, 7])), 'odd').current, 3, 'odd 1,3,7');
assert.equal(row(px(pad(2, [5, 8, 9])), 'over4').current, 3, 'over4 5,8,9');
assert.equal(row(px(pad(7, [2, 1, 4])), 'under5').current, 3, 'under5 2,1,4');
assert.equal(row(px(pad(3, [2, 4])), 'even').current, 2, 'two even ticks are a run of 2');

// every contract is analysed on its own levels: digits on 2 AND 3, the rest from 2
assert.deepEqual(LEVELS.even, [2, 3]);
assert.deepEqual(LEVELS.under5, [2, 3]);
assert.deepEqual(LEVELS.only_up, [2]);
assert.deepEqual(LEVELS.touch, [2]);
assert.deepEqual(row(px(pad(3, [2, 4, 6])), 'even').levels.map(l => l.min_run), [2, 3]);

// runStats counts only runs of >= minRun
const flags10 = [true, true, true, false, true, true, false, true, true, true, true, false];
let st = runStats(flags10, 3);
assert.deepEqual([st.runs, st.ticks_in_runs, st.longest, st.current], [2, 7, 4, 0]);
st = runStats(flags10, 2);
assert.deepEqual([st.runs, st.ticks_in_runs], [3, 9]);

// a run fires at 2 ticks AND at 3 ticks (two different run ids), never twice on the same level; an old run does not fire
const biasedEven = [];
for (let i = 0; i < 40; i++) biasedEven.push(2, 4, 6, 1); // many even runs of 3, short odd ones
const at = (breaker, digits) => computeRunSignals(computeRunBias(px([...biasedEven, breaker, ...digits]), 2), 'T');
const entries = sigs => sigs.filter(s => s.entry && s.contract_type === 'DIGITEVEN');
const two = entries(at(1, [2, 4]));
assert.equal(two.length, 1, 'level 2 fires on the second tick of the run');
assert.equal(two[0].run.min_run, 2);
const three = entries(at(1, [2, 4, 6]));
const levelsFiring = three.map(s => s.run.min_run).sort();
assert.ok(levelsFiring.includes(3), 'level 3 fires on the third tick');
assert.equal(new Set(three.map(s => s.run_id)).size, three.length, 'one run id per level');
const stale = entries(at(1, [2, 4, 6, 8, 0, 2]));
assert.equal(stale.length, 0, 'a run that is long past its levels no longer fires');
for (const s of three) assert.ok(s.run.current <= s.run.min_run + FRESH_SLACK);

// price runs: rising prices make Rise / Only Ups runs; Fall / Only Downs have none now
const rising = Array.from({ length: 80 }, (_, i) => 100 + i * 0.3 + (i % 5 === 4 ? -0.1 : 0));
const f = favourFlags(rising, 2);
assert.ok(f.rise[10] && !f.fall[10]);

// signals shape
const scan = computeRunBias(rising, 2, 5000);
for (const s of computeRunSignals(scan, 'R_TEST')) {
    assert.equal(s.family, 'run_bias');
    if (s.entry) assert.ok(s.run_id !== undefined && s.run.bias >= 55);
    else assert.equal(s.run_id, undefined);
}
console.log('runBias checks passed');
