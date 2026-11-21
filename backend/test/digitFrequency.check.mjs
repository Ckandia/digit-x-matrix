// Pure checks for the digit-frequency module: ranking (1st / 2nd / 3rd most, least), ties, and the Even / Odd / Over 4 / Under 5 frequency logic.
import assert from 'node:assert/strict';
import { computeDigitFrequency, rankDigits, contractLogic, DIGIT_CONTRACTS, MIN_DIGIT_SAMPLE, DIGIT_WINDOW } from '../src/digitFrequency.js';
import { computeRunBias } from '../src/runBias.js';
import { MarketFeed } from '../src/marketFeed.js';

// prices whose last digit (2 decimals) is the given digit
const px = digits => digits.map((d, i) => Number((100 + i * 0.1 + d / 100).toFixed(2)));
// a digit list where digit d appears counts[d] times, shuffled deterministically
const build = counts => {
    const out = [];
    counts.forEach((c, d) => { for (let k = 0; k < c; k++) out.push(d); });
    let seed = 7;
    for (let i = out.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const j = seed % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};
const get = (counts) => computeDigitFrequency(px(build(counts)), 2);

// not enough ticks: nothing reported
const few = computeDigitFrequency(px(build([5, 5, 5, 5, 5, 5, 5, 5, 5, 5])), 2);
assert.equal(few.n, 50);
assert.deepEqual(few.ranking, []);
assert.ok(MIN_DIGIT_SAMPLE > 50);

// 1st, 2nd, 3rd most and least, with counts and percentages (100 ticks)
let r = get([8, 9, 10, 11, 12, 6, 7, 20, 15, 2]); // 100 ticks
assert.equal(r.n, 100);
assert.deepEqual([r.first.digit, r.second.digit, r.third.digit, r.least.digit], [7, 8, 4, 9]);
assert.deepEqual([r.first.count, r.first.pct], [20, 20]);
assert.deepEqual([r.second.count, r.third.count, r.least.count], [15, 12, 2]);
assert.equal(r.ranking.length, 10);
assert.equal(r.ranking.reduce((s, x) => s + x.count, 0), 100, 'every tick is counted once');
assert.ok(Math.abs(r.ranking.reduce((s, x) => s + x.pct, 0) - 100) < 0.2);
assert.equal(r.first.tied, 0);

// digit 0 counts (a price like 100.50 loses its 0 in JSON; the reader pads to the market's decimals)
r = get([30, 7, 7, 7, 7, 7, 7, 7, 7, 12]);
assert.equal(r.first.digit, 0, 'digit 0 is read as 0, not as the digit before it');

// ties: the digit seen more recently ranks higher; `tied` says a rank is a tie-break
const tieDigits = [...build([10, 10, 10, 10, 10, 10, 10, 10, 10, 10])];
r = computeDigitFrequency(px(tieDigits), 2);
assert.equal(r.first.tied, 9, 'all ten digits tied');
assert.equal(r.ranking[0].digit, tieDigits[tieDigits.length - 1], 'the most recently seen digit ranks first on a tie');
assert.equal(new Set(r.ranking.map(x => x.digit)).size, 10, 'ranking has each digit exactly once');

// THE LOGIC. top three = 8, 6, 2 (all even), least = 9 (odd): all four digits favour Even (agree 4); none favour Odd
r = get([6, 4, 14, 3, 5, 4, 16, 3, 20, 2]); // top: 8(20) 6(16) 2(14); least 9(2)
assert.deepEqual([r.first.digit, r.second.digit, r.third.digit, r.least.digit], [8, 6, 2, 9]);
let L = Object.fromEntries(r.logic.map(l => [l.key, l]));
assert.equal(L.even.agree, 4);
assert.equal(L.even.favoured, true);
assert.equal(L.even.verdict, 'favoured');
assert.equal(L.odd.agree, 0);
assert.equal(L.odd.favoured, false);
assert.equal(r.even_odd, 'even');
// Over 4 / Under 5 for the same data: top three 8, 6 (over 4) and 2 (under 5); the least digit 9 is Over 4, so it favours Under 5.
// Over 4: 2 top digits + 0 = 2. Under 5: 1 top digit + 1 = 2. A 2-2 split favours neither.
assert.equal(L.over4.agree, 2);
assert.equal(L.under5.agree, 2);
assert.equal(L.over4.favoured, false);
assert.equal(L.under5.favoured, false);
assert.equal(L.over4.verdict, 'split');
assert.equal(r.over_under, null, 'a 2-2 split favours neither side');

// NOT all four have to agree: 3 of 4 favour Over 4 here (top 9 and 7 are over 4, the least digit 0 is under 5)
r = get([2, 12, 3, 15, 4, 5, 6, 14, 9, 30]); // top: 9(30) 3(15) 7(14); least 0(2)
assert.deepEqual([r.first.digit, r.second.digit, r.third.digit, r.least.digit], [9, 3, 7, 0]);
L = Object.fromEntries(r.logic.map(l => [l.key, l]));
assert.equal(L.odd.agree, 4, 'three odd digits on top and an even least digit');
assert.equal(L.over4.agree, 3, '9 and 7 are over 4, and the least digit 0 is on the other side');
assert.equal(L.over4.favoured, true, '3 of 4 is enough');
assert.equal(L.under5.agree, 1);
assert.equal(L.under5.favoured, false);
assert.equal(r.even_odd, 'odd');
assert.equal(r.over_under, 'over4');

// exactly 2 of 4 is enough when ahead of the opposite: top 1, 3, 6 (two odd), least 8 (even) -> Odd agree 3; make it 2: top 1, 3, 6 and least 7 (odd)
r = get([8, 20, 6, 18, 7, 9, 16, 2, 7, 7]); // top: 1(20) 3(18) 6(16); least 7(2) -> wait 7 has 2
assert.deepEqual([r.first.digit, r.second.digit, r.third.digit, r.least.digit], [1, 3, 6, 7]);
L = Object.fromEntries(r.logic.map(l => [l.key, l]));
assert.equal(L.odd.agree, 2, 'two odd top digits, but the least digit is odd too');
assert.equal(L.even.agree, 2, 'one even top digit plus the odd least digit');
assert.equal(r.even_odd, null, 'level 2-2');

// complementary pairs: never both favoured, over many random markets
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let m = 0; m < 300; m++) {
    const len = 60 + Math.floor(rnd() * 500);
    const digs = Array.from({ length: len }, () => Math.floor(rnd() * 10));
    const out = computeDigitFrequency(px(digs), 2);
    const Lm = Object.fromEntries(out.logic.map(l => [l.key, l]));
    assert.ok(!(Lm.even.favoured && Lm.odd.favoured), 'Even and Odd are never both favoured');
    assert.ok(!(Lm.over4.favoured && Lm.under5.favoured), 'Over 4 and Under 5 are never both favoured');
    assert.equal(Lm.even.top3_votes + Lm.odd.top3_votes, 3);
    assert.equal(Lm.even.agree + Lm.odd.agree, 4, 'the four digits are split between Even and Odd');
    assert.equal(Lm.over4.agree + Lm.under5.agree, 4, 'the four digits are split between Over 4 and Under 5');
    for (const l of out.logic) assert.ok(!l.favoured || l.agree >= 2, 'favoured needs at least 2 of the 4 digits');
    assert.equal(Lm.over4.top3_votes + Lm.under5.top3_votes, 3);
    assert.ok(Math.abs(Lm.even.pct + Lm.odd.pct - 100) < 0.05);
    assert.ok(Math.abs(Lm.over4.pct + Lm.under5.pct - 100) < 0.05);
    assert.equal(out.n, Math.min(len, DIGIT_WINDOW));
    const ranks = out.ranking.map(x => x.count);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), 'ranking is sorted most to least');
    assert.equal(out.first.count, Math.max(...ranks));
    assert.equal(out.least.count, Math.min(...ranks));
}

// only the freshest 500 ticks count
const old = Array(200).fill(7);
const fresh = build([40, 40, 40, 40, 40, 40, 40, 40, 40, 100]).slice(0, 500);
r = computeDigitFrequency(px([...old, ...fresh]), 2);
assert.equal(r.n, 500);
assert.equal(r.ranking.reduce((s, x) => s + x.count, 0), 500);

// per-market decimals: a wrong reported pip size does not change the digits (same rule as the run bias)
const three = Array.from({ length: 200 }, (_, i) => Number((100 + i * 0.1 + ((i * 7) % 10) / 1000).toFixed(3)));
const a = computeDigitFrequency(three, 2); // reported 2dp, prices print 3dp
const b = computeDigitFrequency(three, 3);
assert.equal(a.decimals, 3);
assert.deepEqual(a.ranking, b.ranking);
assert.equal(a.decimals, computeRunBias(three, 2).decimals, 'reads the same decimals as the run bias');

// the logic table covers exactly the four contracts
assert.deepEqual(DIGIT_CONTRACTS.map(c => c.key), ['even', 'odd', 'over4', 'under5']);
for (const c of DIGIT_CONTRACTS) assert.equal(c.digits.length, 5);
assert.equal(typeof contractLogic, 'function');

// wired into the snapshot of the live feed class (no network: feed is not started)
const feed = new MarketFeed();
const prices = px(build([30, 20, 30, 20, 30, 20, 30, 20, 30, 20]).slice(0, 200));
feed._rebuildWindow('1HZ10V', prices);
const snap = feed.getSnapshot('1HZ10V');
{
    assert.ok(snap.digit_freq, 'snapshot carries digit_freq');
    assert.equal(snap.digit_freq.n, 200);
    assert.equal(snap.digit_freq.ranking.length, 10);
    assert.equal(snap.digit_freq.logic.length, 4);
    // the signal list is untouched: no digit_freq signals, the AI trades the same signals as before
    assert.ok(snap.signals.every(s => s.family !== 'digit_freq'));
}

// BOOST + CONFLUENCE: when at least 2 of the four digits favour Even / Odd / Over 4 / Under 5 the confidence is boosted (+5 / +10 / +15 for 2 / 3 / 4);
// the digits never touch `entry`, and never touch Rise / Fall
import { computeRunSignals, DIGIT_BOOST } from '../src/runBias.js';
assert.deepEqual(DIGIT_BOOST, { 2: 5, 3: 10, 4: 15 });
const biasedEven = [];
for (let i = 0; i < 40; i++) biasedEven.push(2, 4, 6, 8, 0, 1);
const evenPx = px([...biasedEven, 1, 2, 4]);
const scan = computeRunBias(evenPx, 2);
const mk = (even_agree, under_agree) => ({
    logic: [
        { key: 'even', favoured: even_agree >= 2 && even_agree > 4 - even_agree, agree: even_agree, top3_votes: 3, least_inside: false, pct: 80, verdict: 'x' },
        { key: 'odd', favoured: false, agree: 4 - even_agree, top3_votes: 0, least_inside: true, pct: 20, verdict: 'none' },
        { key: 'over4', favoured: false, agree: 4 - under_agree, top3_votes: 1, least_inside: false, pct: 50, verdict: 'none' },
        { key: 'under5', favoured: under_agree >= 2 && under_agree > 4 - under_agree, agree: under_agree, top3_votes: 2, least_inside: false, pct: 50, verdict: 'x' },
    ],
});
const evenSig = sigs => sigs.filter(s => s.contract_type === 'DIGITEVEN' && !s.pair_types);
const none = evenSig(computeRunSignals(scan, 'T'));
assert.ok(none.length, 'the fixture produces Even signals');
for (const s of none) { assert.equal(s.digit_boost, undefined); assert.equal(s.confluence, s.levels_confluence, 'no digit data: behaves as before'); }
const sameEntries = (a, b) => assert.deepEqual(a.map(s => `${s.contract_type}|${s.run.min_run}|${s.entry}`), b.map(s => `${s.contract_type}|${s.run.min_run}|${s.entry}`));
for (const [agree, boost] of [[4, 15], [3, 10], [2, 0]]) {
    // 2 of 4 against 2 of 4 is a split: favoured needs to be ahead, so no boost; 3 and 4 are ahead
    const sigs = evenSig(computeRunSignals(scan, 'T', mk(agree, 2)));
    sameEntries(sigs, none);
    for (const [i, s] of sigs.entries()) {
        assert.equal(s.digit_boost, boost, `agree ${agree}`);
        assert.equal(s.base_confidence, none[i].confidence, 'base confidence is the confidence without the digits');
        assert.equal(s.confidence, Math.min(100, none[i].confidence + boost));
        assert.equal(s.digit_confluence, boost > 0);
        assert.equal(s.confluence, s.levels_confluence && boost > 0);
    }
}
// the weakest digit support: 1 of 4 gives nothing
for (const s of evenSig(computeRunSignals(scan, 'T', mk(1, 2)))) assert.equal(s.digit_boost, 0);
// favoured with exactly 2 (ahead of the opposite 1)... 2 vs 2 is a split; build 2 vs 1 by hand
const twoOfFour = { logic: mk(4, 2).logic.map(l => (l.key === 'even' ? { ...l, agree: 2, favoured: true } : l.key === 'odd' ? { ...l, agree: 1 } : l)) };
for (const s of evenSig(computeRunSignals(scan, 'T', twoOfFour))) { assert.equal(s.digit_boost, 5, '2 of the 4 digits is enough'); assert.equal(s.digit_confluence, true); }
// the confidence never passes 100
const capped = evenSig(computeRunSignals(scan, 'T', mk(4, 2)));
assert.ok(capped.every(s => s.confidence <= 100));
// price contracts are never touched by the digits
assert.ok(computeRunSignals(scan, 'T', mk(4, 2)).filter(s => ['CALL', 'PUT', 'RUNHIGH', 'RUNLOW'].includes(s.contract_type)).every(s => s.digit_boost === undefined));
// a pair needs BOTH digit legs favoured and takes the weaker leg's boost: Even (4 of 4) + Under 5 (3 of 4)
const pairSigs = sigs => sigs.filter(s => s.pair_key === 'even_under5');
const pairDigits = [];
for (let i = 0; i < 30; i++) pairDigits.push(0, 2, 4, 7, 0, 2, 5, 9, 1, 3); // digits 0 2 4 are Even AND Under 5: the pair runs
const pairScan = computeRunBias(px([...pairDigits, 7, 0, 2, 4]), 2);
const pairBase = pairSigs(computeRunSignals(pairScan, 'T'));
const both = pairSigs(computeRunSignals(pairScan, 'T', mk(4, 3)));
assert.ok(both.length === pairBase.length && both.length > 0);
for (const [i, s] of both.entries()) { assert.equal(s.digit_confluence, true); assert.equal(s.digit_boost, 10, 'the weaker leg (3 of 4) sets the boost'); assert.equal(s.confidence, Math.min(100, pairBase[i].confidence + 10)); assert.equal(s.entry, pairBase[i].entry); }
for (const s of pairSigs(computeRunSignals(pairScan, 'T', mk(4, 1)))) { assert.equal(s.digit_confluence, false); assert.equal(s.digit_boost, 0, 'Under 5 is not favoured: no pair boost'); }

console.log('digitFrequency checks passed');
