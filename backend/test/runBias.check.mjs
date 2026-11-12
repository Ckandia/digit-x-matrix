// Pure checks for the run-bias module: runs of 2 / 3+ ticks in a row in favour of a contract, analysed per level.
import assert from 'node:assert/strict';
import { PAIR_PATTERNS, replayPair, computeRunBias, computeRunSignals, favourFlags, runStats, settleAt, replayOutcomes, lastDigit, inferDecimals, LEVELS, FRESH_SLACK, ENTRY_DELAY } from '../src/runBias.js';

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
assert.deepEqual(row(px(pad(3, [2, 4, 6])), 'even').levels.map(l => l.min_run), [2, 3]);

// runStats counts only runs of >= minRun
const flags10 = [true, true, true, false, true, true, false, true, true, true, true, false];
let st = runStats(flags10, 3);
assert.deepEqual([st.runs, st.ticks_in_runs, st.longest, st.current], [2, 7, 4, 0]);
st = runStats(flags10, 2);
assert.deepEqual([st.runs, st.ticks_in_runs], [3, 9]);

// a run fires at 2 ticks AND at 3 ticks (two different run ids), never twice on the same level; an old run does not fire
const biasedEven = [];
for (let i = 0; i < 40; i++) biasedEven.push(2, 4, 6, 8, 0, 1); // long even runs (and 0 counts as even), a single odd between; Even wins after every replay
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

// Touch / No Touch are gone from the analysis
assert.ok(!computeRunBias(rising, 2).rows.some(r => /touch/.test(r.key)));
assert.equal(LEVELS.touch, undefined);

// Confluence: 2-tick AND 3-tick bias both favour the contract
const conf = computeRunSignals(computeRunBias(px([...biasedEven, 1, 2, 4, 6]), 2), 'T').filter(x => x.contract_type === 'DIGITEVEN');
for (const c of conf) assert.equal(typeof c.confluence, 'boolean');
assert.ok(computeRunSignals(computeRunBias(px([...biasedEven, 1, 2, 4, 6]), 2), 'T').every(x => 'confluence' in x));

// Trend gate: Rise / Only Ups fire only in a confirmed uptrend, Fall / Only Downs only in a downtrend; the signal carries the trend
const wavy = Array.from({ length: 120 }, (_, i) => 100 + i * 0.2 + Math.sin(i / 2) * 1.5); // higher highs and higher lows
const bullish = computeRunBias(wavy, 2, 5000);
assert.equal(bullish.trend, 'bullish');
const tsigs = computeRunSignals(bullish, 'R_T');
assert.ok(!tsigs.some(s => s.entry && (s.contract_type === 'PUT' || s.contract_type === 'RUNLOW')), 'no Fall / Only Downs entry in an uptrend');
for (const s of tsigs.filter(x => x.contract_type === 'CALL' || x.contract_type === 'RUNHIGH')) assert.equal(s.trend, 'bullish');
const sideways = Array.from({ length: 120 }, (_, i) => 100 + (i % 2) * 0.3);
assert.equal(computeRunBias(sideways, 2).trend, 'none');
assert.ok(!computeRunSignals(computeRunBias(sideways, 2), 'R_S').some(s => s.entry && ['CALL', 'PUT', 'RUNHIGH', 'RUNLOW'].includes(s.contract_type)), 'no trend contract fires without a trend');

// ---- Digit 0 and repeated digits
assert.equal(lastDigit(100.5, 2), 0, 'a price that prints 100.50 ends in 0, not 5');
assert.equal(lastDigit(1234.1, 2), 0);
assert.equal(lastDigit(1234.07, 2), 7);
const d0 = (v, key) => favourFlags([v, v], 2)[key][0];
assert.ok(d0(100.5, 'even') && d0(100.5, 'under5') && !d0(100.5, 'over4') && !d0(100.5, 'odd'), 'digit 0 is even and under 5, never over 4');
assert.ok(d0(100.09, 'over4') && d0(100.09, 'odd') && !d0(100.09, 'under5'), 'digit 9');
// the same digit twice in a row (a double) is two ticks in favour: a run of 2
assert.equal(row(px(pad(3, [4, 4])).map((v, i, a) => (i === a.length - 1 ? Number((a[i - 1] + 0.0).toFixed(2)) : v)), 'even').current >= 2, true);
const rep2 = [100.04, 100.04]; // an unchanged price
const fl = favourFlags(rep2, 2);
assert.ok(fl.even[1] && !fl.rise[1] && !fl.fall[1], 'a repeated price still counts as even, but is neither a rise nor a fall (it loses both)');

// ---- Every market prints its own number of decimals; the digits come from the market's real precision, even when the reported one is wrong
// 2dp (like most 1s indices), 3dp, 4dp: random walks, then check digit 0 is counted at the right place
const walk = (dp, seed) => {
    let v = 1000;
    let x = seed;
    const out = [];
    for (let i = 0; i < 400; i++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        v += ((x % 2001) - 1000) / 10 ** (dp + 1) * 8;
        out.push(Number(v.toFixed(dp))); // JSON numbers lose trailing zeros, exactly like Deriv's quotes
    }
    return out;
};
for (const dp of [2, 3, 4]) {
    const prices = walk(dp, 7 + dp);
    assert.equal(inferDecimals(prices), dp, `a ${dp}dp market is read as ${dp}dp`);
    const truth = prices.map(p => Number(p.toFixed(dp).slice(-1)));
    const zeros = truth.filter(d => d === 0).length;
    assert.ok(zeros > 10, `the ${dp}dp walk has digit 0 ticks`);
    // wrong reported pip sizes (fallback 2 for a 4dp market, 4 for a 2dp market) must not change the answer
    for (const reported of [2, 3, 4, undefined]) {
        const scan = computeRunBias(prices, reported, 400);
        assert.equal(scan.decimals, dp, `reported ${reported} dp, prices say ${dp}`);
    }
    // digit 0 counted as an even / under-5 tick at the real place, in every market
    const f = favourFlags(prices, dp);
    prices.forEach((p, i) => {
        const d = truth[i];
        assert.equal(f.even[i], d % 2 === 0);
        assert.equal(f.under5[i], d < 5);
        assert.equal(f.over4[i], d > 4);
    });
    // the digit 0 ticks are even AND under 5, never over 4
    prices.forEach((p, i) => { if (truth[i] === 0) assert.ok(f.even[i] && f.under5[i] && !f.over4[i] && !f.odd[i]); });
}
// a 4dp price whose quote lost its zeros: 1234.5000 arrives as 1234.5
assert.equal(lastDigit(1234.5, 4), 0);
// reading it with the 2dp fallback would have given 0 as well, but 1234.55 (really 1234.5500) must read 0, not 5
assert.equal(lastDigit(1234.55, 4), 0);
assert.equal(lastDigit(1234.5567, 4), 7);

// ---- Entry and exit ticks: a pattern ends on tick i, the entry is tick i+1, the exit tick decides
assert.equal(ENTRY_DELAY, 1);
// even: ticks ... 2,4,[entry 7],[exit 6]  -> exit digit 6 is even: WIN
const seq = [100.02, 100.14, 100.27, 100.36]; // digits 2,4,7,6
assert.equal(settleAt('even', seq, 1, 2), true);
assert.equal(settleAt('odd', seq, 1, 2), false);
// exit digit 0 counts: 100.40 -> even and under 5
const zero = [100.02, 100.14, 100.27, 100.40];
assert.equal(settleAt('even', zero, 1, 2), true);
assert.equal(settleAt('under5', zero, 1, 2), true);
assert.equal(settleAt('over4', zero, 1, 2), false);
// rise: entry 100.27, exit 100.36 -> rise wins, fall loses; a flat exit loses both
assert.equal(settleAt('rise', seq, 1, 2), true);
assert.equal(settleAt('fall', seq, 1, 2), false);
assert.equal(settleAt('rise', [1, 2, 3, 3], 1, 2), false);
assert.equal(settleAt('fall', [1, 2, 3, 3], 1, 2), false);
// only ups needs EVERY tick after the entry to rise (2 ticks): entry 3, then 4, 5
assert.equal(settleAt('only_up', [0, 1, 3, 4, 5], 1, 2), true);
assert.equal(settleAt('only_up', [0, 1, 3, 4, 4], 1, 2), false);
assert.equal(settleAt('even', [1, 2], 1, 2), null, 'history ends before the exit tick');
// replay: even runs of 2 followed by an even exit digit on every repeat
const rpt = [];
for (let k = 0; k < 20; k++) rpt.push(2, 4, 1, 6, 3); // run of 2 (2,4) then entry digit 1, exit digit 6 (even): always a win
const rflag = favourFlags(px(rpt), 2).even;
const rp = replayOutcomes('even', rflag, px(rpt), 2, 2);
assert.ok(rp.n >= 15 && rp.wins === rp.n && rp.hit === 100, 'every replay of 2,4 -> entry -> exit 6 wins');
assert.ok(computeRunBias(px(rpt.concat(rpt, rpt)), 2).rows.find(r => r.key === 'even').levels[0].hit !== undefined);

// a pattern the market keeps punishing is vetoed: 2,4 followed by an odd exit every time
const bad = [];
for (let k = 0; k < 40; k++) bad.push(2, 4, 1, 3, 5); // exit digit 3: odd, Even always loses
const badScan = computeRunBias(px(bad), 2);
const badEven = badScan.rows.find(r => r.key === 'even').levels[0];
assert.ok(badEven.outcomes >= 10 && badEven.hit === 0);
assert.ok(!computeRunSignals(badScan, 'T').some(x => x.entry && x.contract_type === 'DIGITEVEN' && x.run.min_run === 2), 'Even is not an entry when its replays all lost');

// ---- Pair patterns: the sequence favours TWO contracts at once
assert.deepEqual(PAIR_PATTERNS[0].digits, [0, 2, 4]);
assert.deepEqual(PAIR_PATTERNS[1].digits, [5, 7, 9]);
// digits 2,4,0 are all even AND under 5; 5,7,9 are all odd AND over 4
const pairRow = (digits, key) => computeRunBias(px(digits), 2).pairs.find(r => r.key === key);
assert.equal(pairRow(pad(8, [2, 4, 0]), 'even_under5').current, 3);
assert.equal(pairRow(pad(3, [5, 7, 9]), 'odd_over4').current, 3);
assert.equal(pairRow(pad(8, [2, 4, 6]), 'even_under5').current, 0, '6 is even but not under 5: the pair run is broken'); // pad ends with 8; 6 not in the set
assert.equal(pairRow(pad(8, [2, 4]), 'even_under5').current, 2);
// the pair is judged on its net result: Even and Under 5 both win on digit 4 (net +1.9)
const pairSeq = [];
for (let k = 0; k < 30; k++) pairSeq.push(2, 4, 1, 4, 5, 8, 9); // run 2,4 -> entry 1 -> exit 4 (both win)
const ps = computeRunBias(px(pairSeq), 2).pairs.find(r => r.key === 'even_under5').levels[0];
assert.ok(ps.outcomes >= 10 && ps.avg_net > 1.5, 'both legs won after every replay');
// a pair that keeps losing both legs is vetoed: exit digit 7 loses Even and Under 5
const badPair = [];
for (let k = 0; k < 30; k++) badPair.push(2, 4, 1, 7, 5, 8, 9);
const bp = computeRunBias(px(badPair), 2);
assert.ok(bp.pairs.find(r => r.key === 'even_under5').levels[0].avg_net < 0);
assert.ok(!computeRunSignals(bp, 'T').some(x => x.entry && x.pair_types && x.pair_types[0] === 'DIGITEVEN' && x.run.min_run === 2), 'a losing pair is not an entry');
// a pair signal carries both contract types and its own run id
const pairSigs = computeRunSignals(computeRunBias(px([...pairSeq, 8, 2, 4]), 2), 'T').filter(x => x.pair_types);
assert.ok(pairSigs.length > 0 && pairSigs.every(x => x.pair_types.length === 2 && x.family === 'run_bias'));
for (const x of pairSigs.filter(y => y.entry)) assert.ok(String(x.run_id).endsWith(':pair'));

// ---- Cross pairs: Rise + Odd (price up AND odd digit) and Fall + Even (price down AND even digit)
assert.deepEqual(PAIR_PATTERNS.map(x => x.key), ['even_under5', 'odd_over4', 'rise_odd', 'fall_even']);
assert.deepEqual(PAIR_PATTERNS[2].types, ['CALL', 'DIGITODD']);
assert.deepEqual(PAIR_PATTERNS[3].types, ['PUT', 'DIGITEVEN']);
// a steady climb of +0.02 from x.01: every tick is a rise AND ends in an odd digit
const climb = Array.from({ length: 80 }, (_, i) => Number((100.01 + i * 0.02).toFixed(2)));
const climbScan = computeRunBias(climb, 2);
const ro = climbScan.pairs.find(r => r.key === 'rise_odd');
assert.ok(ro.current >= 3, 'rising ticks with odd digits form a Rise + Odd run');
assert.equal(climbScan.pairs.find(r => r.key === 'fall_even').current, 0);
// a steady fall of -0.02 from x.00: every tick is a fall AND ends in an even digit
const drop = Array.from({ length: 80 }, (_, i) => Number((120 - i * 0.02).toFixed(2)));
const dropScan = computeRunBias(drop, 2);
assert.ok(dropScan.pairs.find(r => r.key === 'fall_even').current >= 3, 'falling ticks with even digits form a Fall + Even run');
// a rise that ends on an EVEN digit does not count for Rise + Odd
const evenClimb = Array.from({ length: 80 }, (_, i) => Number((100 + i * 0.02).toFixed(2)));
assert.equal(computeRunBias(evenClimb, 2).pairs.find(r => r.key === 'rise_odd').current, 0);
// cross pair signals carry both types, the pair key and the trend; they are only entries in the matching trend
// a zig-zag with higher highs (bullish), ending on a run of rising ticks that all end in an odd digit
const nextWith = (last, odd) => { let v = Math.round(last * 100) + 1; while ((v % 10 % 2 === 1) !== odd) v += 1; return v / 100; };
const zig = [];
let zp = 100;
for (let k = 0; k < 17; k++) { for (let j = 0; j < 3; j++) { zp = Number((zp + 0.04).toFixed(2)); zig.push(zp); } zp = Number((zp - 0.09).toFixed(2)); zig.push(zp); }
for (let j = 0; j < 3; j++) { zp = nextWith(zp, true); zig.push(zp); }
const zigScan = computeRunBias(zig, 2);
assert.equal(zigScan.trend, 'bullish');
assert.ok(zigScan.pairs.find(r => r.key === 'rise_odd').current >= 3);
const crossSigs = computeRunSignals(zigScan, 'T').filter(x => x.pair_key === 'rise_odd');
assert.ok(crossSigs.length > 0 && crossSigs.every(x => x.pair_types[0] === 'CALL' && x.pair_types[1] === 'DIGITODD' && x.trend === 'bullish'));
assert.ok(computeRunSignals(zigScan, 'T').filter(x => x.pair_key === 'fall_even').every(x => !x.entry), 'no Fall + Even entry in a bullish market');
// without the bullish trend (a straight climb has no swing highs) Rise + Odd is never an entry
assert.equal(climbScan.trend, 'none');
assert.ok(computeRunSignals(climbScan, 'T').filter(x => x.pair_key === 'rise_odd').every(x => !x.entry), 'no trend, no Rise + Odd entry');
// every pair signal carries its key
for (const x of computeRunSignals(zigScan, 'T').filter(y => y.pair_types)) assert.ok(typeof x.pair_key === 'string');

// signals shape
const scan = computeRunBias(rising, 2, 5000);
for (const s of computeRunSignals(scan, 'R_TEST')) {
    assert.equal(s.family, 'run_bias');
    if (s.entry) assert.ok(s.run_id !== undefined && s.run.bias >= 55);
    else assert.equal(s.run_id, undefined);
}
console.log('runBias checks passed');
