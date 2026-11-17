// Pure checks for the digit frequency. Run: npm run check:digits
import assert from 'node:assert/strict';
import { digitFrequency, DIGIT_MIN_SUPPORT } from '../src/digitFrequency.js';
import { computeRunBias, computeRunSignals } from '../src/runBias.js';

const rep = (d, k) => new Array(k).fill(d);

// ---- ranking: 1st, 2nd, 3rd most frequent and the least frequent digit
const a = digitFrequency([...rep(2, 30), ...rep(4, 25), ...rep(6, 20), ...rep(1, 10), ...rep(3, 9), ...rep(5, 8), ...rep(7, 7), ...rep(8, 6), ...rep(9, 5), ...rep(0, 4)]);
assert.equal(a.n, 124);
assert.deepEqual([a.first.digit, a.second.digit, a.third.digit, a.least.digit], [2, 4, 6, 0]);
assert.equal(a.first.count, 30);
assert.equal(a.first.pct, 24.19);
assert.deepEqual(a.key_digits, [2, 4, 6, 0]);
assert.equal(a.counts.reduce((x, y) => x + y, 0), 124, 'counts add up to the window');

// ---- ties: the most recently seen digit ranks higher among the most frequent; the longest-unseen digit is the least frequent
const t = digitFrequency([5, 5, 7, 7, 3, 3, 1, 1, 9, 9, 8, 6, 4, 2, 0, 0]); // 5,7,3,1,9,0 twice; 8,6,4,2 once
assert.equal(t.first.digit, 0, 'ties on 2 appearances: 0 was seen last, so it ranks first');
assert.deepEqual([t.second.digit, t.third.digit], [9, 1]);
assert.equal(t.least.digit, 8, 'ties on 1 appearance: 8 has not been seen for the longest');

// ---- support for the contracts
// top 3 = 2, 4, 6 (all even, all under-5 except 6), least = 0 (even, under 5)
assert.equal(a.contracts.even.support, 3, 'three even top digits; the least digit is even too, so it does not add');
assert.deepEqual(a.contracts.even.supporting, [2, 4, 6]);
assert.equal(a.contracts.odd.support, 1, 'only the (even) least digit supports Odd');
assert.deepEqual(a.contracts.odd.supporting, [0]);
assert.equal(a.contracts.under5.support, 2, '2 and 4 are under 5; 6 is over 4; the least digit 0 is under 5 so it does not add');
assert.equal(a.contracts.over4.support, 2, '6 is over 4 and the least digit 0 is not over 4');
// even: 2,4,6,8,0 -> 30+25+20+6+4 = 85 of 124
assert.equal(a.contracts.even.share, 68.55);
assert.equal(a.contracts.even.favoured, true);
assert.equal(a.contracts.even.strength, Math.round(2 * 20 + (68.55 - 50) * 2), '3 supporting digits = 40, plus 2 points per % above half the window');
assert.equal(a.contracts.odd.favoured, false);
assert.equal(a.contracts.odd.strength, 0, 'no strength unless the frequency is in favour');
assert.equal(DIGIT_MIN_SUPPORT, 2, 'two of the four key digits already make a bias: the AI does not wait for all four');
// a 2-2 tie with the opposite contract goes to the one whose digits filled more of the window
assert.equal(a.contracts.under5.support, a.contracts.over4.support);
assert.equal(a.contracts.under5.favoured, true, 'Under 5 (2 digits, 63% of the window) beats Over 4 (2 digits, 37%)');
assert.equal(a.contracts.over4.favoured, false);
assert.equal(a.contracts.under5.strength, Math.round(1 * 20 + (62.9 - 50) * 2));
// two supporting digits are enough
const two = digitFrequency([...rep(2, 12), ...rep(4, 11), ...rep(0, 10), ...rep(6, 10), ...rep(8, 1), ...rep(1, 11), ...rep(3, 9), ...rep(5, 8), ...rep(7, 8), ...rep(9, 8)]);
assert.deepEqual(two.key_digits, [2, 1, 4, 8]);
assert.equal(two.contracts.even.support, 2);
assert.equal(two.contracts.odd.support, 2);
assert.equal(two.contracts.even.share, two.contracts.odd.share, 'even 44 vs odd 44 of 88');
assert.equal(two.contracts.even.favoured || two.contracts.odd.favoured, false, 'an exact tie favours neither: the AI never leans both ways');
const lean = digitFrequency([...rep(2, 12), ...rep(4, 11), ...rep(0, 10), ...rep(6, 10), ...rep(8, 3), ...rep(1, 11), ...rep(3, 9), ...rep(5, 8), ...rep(7, 8), ...rep(9, 8)]);
assert.equal(lean.contracts.even.support, 2);
assert.equal(lean.contracts.even.favoured, true, '2 supporting digits and a bigger share: Even is favoured');
assert.equal(lean.contracts.odd.favoured, false);
assert.equal(lean.contracts.even.strength >= 20, true, 'a favoured contract always clears the AI default minimum signal strength of 20');

// ---- the least digit counts FOR the opposite contract
const b = digitFrequency([...rep(1, 20), ...rep(3, 18), ...rep(5, 16), ...rep(0, 12), ...rep(2, 11), ...rep(4, 10), ...rep(6, 9), ...rep(8, 8), ...rep(9, 7), ...rep(7, 3)]);
assert.deepEqual([b.first.digit, b.second.digit, b.third.digit, b.least.digit], [1, 3, 5, 7]);
assert.equal(b.contracts.odd.support, 3, 'top 1,3,5 are odd; the odd least digit 7 does not add');
assert.equal(b.contracts.even.support, 1, 'only the odd least digit points away from odd, i.e. towards Even');
const c = digitFrequency([...rep(2, 20), ...rep(4, 18), ...rep(1, 16), ...rep(0, 12), ...rep(6, 11), ...rep(8, 10), ...rep(3, 9), ...rep(5, 8), ...rep(9, 7), ...rep(7, 4)]);
assert.deepEqual([c.first.digit, c.second.digit, c.third.digit, c.least.digit], [2, 4, 1, 7]);
assert.equal(c.contracts.even.support, 3, '2 and 4 are even, and the rare odd digit 7 leaves the even digits to appear: 3 of 4');
assert.equal(c.contracts.even.supporting.includes(7), true);
assert.equal(digitFrequency([]), null);

// ---- the scan carries it, and the gate follows it
const price = (cents, d) => Math.floor(cents / 10) * 10 + d; // a price whose last cent-digit is d
const series = digits => {
    let base = 10000;
    return digits.map(d => { base += 10; return price(base, d) / 100; });
};
// 90 ticks, mostly even digits, ending on a run of three even ticks
const evenish = [];
for (let i = 0; i < 90; i++) evenish.push(i % 6 === 0 ? 3 : [2, 4, 6, 0, 8][i % 5]);
evenish.push(2, 4, 6);
const scan = computeRunBias(series(evenish), 2);
assert.ok(scan.digits && scan.digits.n === scan.n, 'digit frequency is part of the scan');
assert.equal(scan.digits.contracts.even.favoured, true);
const evenSig = computeRunSignals(scan, 'T').find(x => x.contract_type === 'DIGITEVEN' && x.run && x.run.min_run === 3);
assert.ok(evenSig && evenSig.digit_freq && evenSig.digit_freq.favoured, 'Even carries its digit frequency');
// the same scan with the digit frequency turned against Even blocks the entry
const against = JSON.parse(JSON.stringify(scan));
against.digits.contracts.even.favoured = false;
against.digits.contracts.even.strength = 0;
assert.equal(computeRunSignals(against, 'T').some(x => x.entry && x.contract_type === 'DIGITEVEN' && !x.pair_types), false, 'no single Even entry when the frequency is not in its favour');
// a pair needs BOTH legs in favour: a history that ends on three digits inside 0, 2, 4 (a pair run), with the frequency set by hand
const pairDigits = [];
for (let i = 0; i < 90; i++) pairDigits.push([2, 4, 0, 4, 2, 0, 1, 3][i % 8]);
pairDigits.push(1, 2, 4, 0); // a breaker first, so the run is exactly 3 and fresh
const pairScan = computeRunBias(series(pairDigits), 2);
const forced = (even, under5) => {
    const x = JSON.parse(JSON.stringify(pairScan));
    x.digits.contracts.even.favoured = even;
    x.digits.contracts.under5.favoured = under5;
    return computeRunSignals(x, 'T').some(sg => sg.entry && sg.pair_key === 'even_under5');
};
assert.equal(forced(true, true), true, 'Even + Under 5 fires when the frequency favours both legs');
assert.equal(forced(true, false), false, 'Even + Under 5 needs the frequency to favour Under 5 as well');
assert.equal(forced(false, true), false, 'and Even');
console.log('digitFrequency checks passed');
