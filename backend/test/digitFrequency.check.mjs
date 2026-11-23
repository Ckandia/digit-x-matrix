// Pure checks for the digit frequency. Run: npm run check:digits
import assert from 'node:assert/strict';
import { preferredBase, digitFrequency, DIGIT_MIN_SUPPORT } from '../src/digitFrequency.js';
import { computeRunBias, computeRunSignals, classifyDirection, basketFor } from '../src/runBias.js';

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
assert.equal(two.contracts.even.favoured, true, 'an exact tie on support AND share goes to the side that holds the 1st (most frequent) digit: 2 is Even');
assert.equal(two.contracts.odd.favoured, false, 'and the AI still never leans both ways');
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
    return computeRunSignals(x, 'T').some(sg => sg.entry && sg.pair_key === 'even_under5' && !sg.single_basket);
};
assert.equal(forced(true, true), true, 'Even + Under 5 fires when the frequency favours both legs');
assert.equal(forced(true, false), false, 'Even + Under 5 needs the frequency to favour Under 5 as well');
assert.equal(forced(false, true), false, 'and Even');
// ---- the directional (third) contract: live trend + the last five NON-FLAT moves; no default, no last-tick guess
const walk = moves => { // builds prices from a list of 'u' / 'd' / 'f' steps
    const out = [100];
    for (const m of moves) out.push(Number((out[out.length - 1] + (m === 'u' ? 1 : m === 'd' ? -1 : 0)).toFixed(2)));
    return out;
};
const dir = (trend, steps) => classifyDirection(trend, walk(steps));
assert.equal(dir('bullish', 'ddduuuu').klass, 'strong_bullish', '3 up in a row + 4 of 5 up + bullish trend = Only Ups');
assert.equal(dir('bullish', 'dduuuu').klass, 'strong_bullish', 'last 3 up and 4 of the last 5 up');
assert.equal(dir('bearish', 'uuudddd').klass, 'strong_bearish');
assert.equal(dir('bullish', 'uuduuu').momentum, true);
assert.equal(dir('bullish', 'uduudu').klass, 'moderate_bullish', '3 of 5 up, not 3 in a row = Rise');
assert.equal(dir('bullish', 'duuddu').klass, 'moderate_bullish', '3 of 5 up, last move up');
assert.equal(dir('bullish', 'uuuuud').klass, 'moderate_bullish', '4 of 5 up but the LAST move is down: the last 3 are not all up, so it is Rise, not Only Ups');
assert.equal(dir('bullish', 'uuuudu').klass, 'moderate_bullish', '4 of 5 up without 3 in a row at the end = Rise');
assert.equal(dir('bearish', 'dudduu').klass, 'none', 'a bearish trend needs 3 of the last 5 moves DOWN');
assert.equal(dir('bearish', 'duddud').klass, 'moderate_bearish', '3 of 5 down = Fall');
assert.equal(dir('bullish', 'uuuudd').klass, 'none', 'a bullish trend whose last 2 moves are both down contradicts it (3 of 5 up but a reversal)');
assert.equal(dir('bullish', 'dddduu').klass, 'none', 'only 2 of 5 up with a bullish trend = conflict = no direction');
assert.equal(dir('bearish', 'uuuudd').klass, 'none');
assert.equal(dir('none', 'uuuuuu').klass, 'none', 'no confirmed trend = NO DIRECTION even if every move is up');
assert.equal(dir('none', 'uuuuuu').direction, null, 'and no invented direction: not bullish');
assert.match(dir('none', 'uuuuuu').reason, /no confirmed trend/);
assert.equal(dir('bullish', 'uuu').klass, 'none', 'fewer than 5 non-flat moves = insufficient data');
assert.match(dir('bullish', 'uuu').reason, /insufficient/);
assert.deepEqual(dir('bullish', 'uufufuuu').moves, ['u', 'u', 'u', 'u', 'u'].map(() => 'up'), 'flat ticks are ignored, never counted as up or down');
assert.equal(dir('bullish', 'uufufuuu').klass, 'strong_bullish');
assert.equal(dir('bullish', 'ufuffu').klass, 'none', 'flat ticks do not count: only 3 non-flat moves');
assert.equal(classifyDirection('bullish', []).klass, 'none', 'no prices = none');
for (const t of ['bullish', 'bearish', 'none']) for (const st of ['uuuuuu', 'dddddd', 'uduudu', 'dudduu', 'uuudud', 'dddudu']) {
    const r = dir(t, st);
    if (r.direction) assert.equal(r.direction, t, 'the direction is always the confirmed trend side: a bullish reading never picks a bearish contract');
    assert.equal(r.momentum, r.klass.startsWith('strong'), 'strong = momentum (Only Ups/Downs), moderate = drift (Rise/Fall)');
}
const withDir = (trend, steps, mutate = () => {}) => {
    const x = JSON.parse(JSON.stringify(pairScan));
    x.digits.contracts.even.favoured = true;
    x.digits.contracts.under5.favoured = true;
    x.trend = trend;
    x.direction_info = dir(trend, steps);
    x.direction = x.direction_info.direction;
    mutate(x);
    return computeRunSignals(x, 'T').find(sg => sg.entry && sg.pair_key === 'even_under5' && !sg.single_basket);
};
const noDir = withDir('none', 'uuuuuu');
assert.ok(noDir, 'the digit pair still fires with no confirmed trend');
assert.equal(noDir.basket_entry, false, 'but NO DIRECTION means no basket: the third contract is mandatory');
assert.equal(noDir.basket_setup, null);
assert.match(noDir.basket_reject, /^NO DIRECTION: no confirmed trend/);
assert.equal(noDir.basket_direction, undefined, 'no invented direction');
const strongB = withDir('bullish', 'ddduuuu');
assert.equal(strongB.basket_entry, true);
assert.equal(strongB.momentum, true);
assert.equal(strongB.basket.third, 'RUNHIGH', 'strong bullish momentum = Only Ups');
assert.equal(strongB.basket_setup, basketFor('even_under5', 'bullish', true).number);
assert.equal(strongB.audit.direction_class, 'strong_bullish');
assert.equal(strongB.audit.third, 'RUNHIGH');
assert.deepEqual(strongB.audit.last5_moves, dir('bullish', 'ddduuuu').moves);
const moderateB = withDir('bearish', 'duddud');
assert.equal(moderateB.basket.third, 'PUT', 'moderate bearish trend = Fall');
assert.equal(moderateB.momentum, false);
assert.equal(withDir('bullish', 'dddduu').basket_entry, false, 'conflicting trend and moves = no basket');
assert.equal(withDir('bearish', 'ddduuu')?.basket.third ?? null, null, 'a bearish trend with rising moves picks neither Fall nor Rise');
assert.equal(strongB.cover_digit, pairScan.digits.least.digit, 'the basket signal names the least frequent digit for the optional Differs cover');
assert.ok(Number.isInteger(strongB.cover_digit) && strongB.cover_digit >= 0 && strongB.cover_digit <= 9);

// ---- property check on random digit windows: the bias never leans both ways, and it follows the key digits exactly
{
    let seed = 777;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    let favouredAny = 0;
    for (let w = 0; w < 3000; w++) {
        const digits = Array.from({ length: 300 }, () => Math.floor(rnd() * 10));
        const f = digitFrequency(digits);
        assert.equal(f.counts.reduce((x, y) => x + y, 0), 300);
        for (const [k, o] of [['even', 'odd'], ['odd', 'even'], ['over4', 'under5'], ['under5', 'over4']]) {
            const me = f.contracts[k];
            assert.equal(me.support + f.contracts[o].support, 4, 'each key digit supports exactly one of a pair of opposite contracts');
            assert.equal(me.favoured && f.contracts[o].favoured, false, 'a contract and its opposite are never both favoured');
            if (me.favoured) {
                favouredAny += 1;
                assert.ok(me.support >= 2, 'favoured needs at least 2 of the 4 key digits');
                assert.ok(me.strength >= 20, 'and clears the default minimum signal strength');
            } else assert.equal(me.strength, 0);
        }
        assert.equal(f.contracts.even.favoured || f.contracts.odd.favoured, true, 'one of Even / Odd is always favoured: no dead zone');
        assert.equal(f.contracts.over4.favoured || f.contracts.under5.favoured, true, 'one of Over 4 / Under 5 is always favoured: no dead zone');
        assert.ok(f.counts[f.first.digit] >= f.counts[f.second.digit] && f.counts[f.second.digit] >= f.counts[f.third.digit], 'ranking is by frequency');
        assert.ok(f.counts[f.least.digit] <= Math.min(...f.counts), 'the least digit has the fewest appearances');
    }
    assert.ok(favouredAny > 0);
}

// ---- ONE confirmed contract starts a basket: the basket it belongs to, the legs need not agree
{
    const x = JSON.parse(JSON.stringify(pairScan));
    // only Even is favoured (Under 5 is NOT, Over 4 is): the pair entry needs both digit legs, so only the single path can fire
    x.digits.contracts.even.favoured = true;
    x.digits.contracts.odd.favoured = false;
    x.digits.contracts.under5.favoured = false;
    x.digits.contracts.over4.favoured = true;
    x.digits.contracts.under5.strength = 0;
    x.trend = 'bullish';
    x.direction_info = dir('bullish', 'duuddu'); // a moderate bullish trend = Rise (drift)
    x.direction = 'bullish';
    const sigs = computeRunSignals(x, 'T');
    assert.equal(sigs.some(sg => sg.entry && sg.pair_key && !sg.single_basket), false, 'no full-pair entry: Under 5 is not favoured');
    const one = sigs.filter(sg => sg.single_basket);
    assert.equal(one.length, 1, 'exactly one single-contract basket per market per look');
    const sb = one[0];
    assert.equal(sb.entry && sb.basket_entry, true);
    assert.ok(['even_over4', 'odd_over4'].includes(sb.pair_key), `the partner is the FAVOURED contract of the other class (Over 4), got ${sb.pair_key}`);
    assert.equal(sb.pair_key, 'even_over4', 'Even belongs to Even + Over 4 here');
    assert.equal(sb.trigger_contract, 'DIGITEVEN');
    assert.deepEqual(sb.pair_types, ['DIGITEVEN', 'DIGITOVER']);
    assert.equal(sb.basket_direction, 'bullish');
    assert.equal(sb.basket_setup, basketFor('even_over4', 'bullish', false).number);
    assert.ok(sb.run_id.endsWith(':single'));
    assert.ok(Number.isInteger(sb.cover_digit));
    // NO DIRECTION: the single contract is still seen, but it is rejected with a clear reason and nothing can be bought
    const nd = JSON.parse(JSON.stringify(x));
    nd.trend = 'none';
    nd.direction_info = dir('none', 'uuuuuu');
    nd.direction = null;
    const rej = computeRunSignals(nd, 'T').filter(sg => sg.single_basket);
    assert.equal(rej.length, 1);
    assert.equal(rej[0].basket_entry, false);
    assert.equal(rej[0].basket_setup, null);
    assert.match(rej[0].basket_reject, /^NO DIRECTION/);
    // with a full pair basket on the same market, the single one is not added (no double buy on the same ticks)
    const both = computeRunSignals(JSON.parse(JSON.stringify(pairScan)), 'T');
    const y = JSON.parse(JSON.stringify(pairScan));
    y.digits.contracts.even.favoured = true; y.digits.contracts.under5.favoured = true;
    y.digits.contracts.odd.favoured = false; y.digits.contracts.over4.favoured = false;
    const withPair = computeRunSignals(y, 'T');
    if (withPair.some(sg => sg.pair_key && !sg.single_basket && sg.basket_entry)) assert.equal(withPair.some(sg => sg.single_basket), false, 'a full pair basket already buys these ticks');
    // nothing favoured, nothing fires
    const z = JSON.parse(JSON.stringify(pairScan));
    for (const k of ['even', 'odd', 'over4', 'under5']) z.digits.contracts[k].favoured = false;
    assert.equal(computeRunSignals(z, 'T').some(sg => sg.single_basket), false, 'no favoured contract, no basket');
}

// ---- the supplied backend snapshot, rebuilt as 300-tick digit windows (counts per digit 0-9, no ties among the key digits): supports, shares,
// strengths and the live-selected base must match. These are VALIDATION windows only: the bot calculates every market live and hard-codes nothing.
{
    const windows = {
        V10: { counts: [23, 31, 16, 27, 36, 20, 37, 39, 41, 30], even: [2, 51], odd: [2, 49], over4: [4, 56], under5: [0, 44], strength: { over4: 71 }, base: 'even_over4' },
        V25: { counts: [30, 30, 28, 30, 34, 33, 24, 28, 31, 32], even: [1, 49], odd: [3, 51], over4: [2, 49], under5: [2, 51], strength: { odd: 42, under5: 21 }, base: 'odd_under5' },
        V50: { counts: [31, 28, 36, 27, 31, 32, 18, 25, 30, 42], even: [1, 49], odd: [3, 51], over4: [2, 49], under5: [2, 51], strength: { odd: 43, under5: 22 }, base: 'odd_under5' },
        V75: { counts: [25, 30, 36, 26, 29, 27, 27, 35, 42, 23], even: [3, 53], odd: [1, 47], over4: [2, 51], under5: [2, 49], strength: { even: 46, over4: 23 }, base: 'even_over4' },
        V100: { counts: [26, 30, 40, 37, 28, 24, 28, 25, 33, 29], even: [3, 52], odd: [1, 48], over4: [1, 46], under5: [3, 54], strength: { even: 43, under5: 47 }, base: 'even_under5' },
    };
    for (const [m, w] of Object.entries(windows)) {
        assert.equal(w.counts.reduce((a, b) => a + b, 0), 300, `${m}: 300 ticks`);
        const digits = [];
        w.counts.forEach((c, d) => { for (let k = 0; k < c; k++) digits.push(d); });
        for (let i = digits.length - 1; i > 0; i--) { const j = (i * 7919 + 13) % (i + 1); [digits[i], digits[j]] = [digits[j], digits[i]]; } // any order: no ties, so order does not matter
        const f = digitFrequency(digits);
        for (const k of ['even', 'odd', 'over4', 'under5']) {
            assert.equal(f.contracts[k].support, w[k][0], `${m} ${k} support`);
            assert.equal(Math.round(f.contracts[k].share), w[k][1], `${m} ${k} share`);
        }
        for (const [k, v] of Object.entries(w.strength)) assert.equal(f.contracts[k].strength, v, `${m} ${k} strength`);
        const base = preferredBase(f);
        assert.equal(base.key, w.base, `${m}: the live favoured contracts select ${w.base}`);
        assert.equal(f.contracts.even.favoured !== f.contracts.odd.favoured, true, `${m}: exactly one of Even / Odd`);
        assert.equal(f.contracts.over4.favoured !== f.contracts.under5.favoured, true, `${m}: exactly one of Over 4 / Under 5`);
        assert.equal(f.n, 300);
    }
    // the base follows the live data: change the window and the base changes with it (nothing is permanent)
    const flip = [];
    [60, 5, 50, 5, 55, 5, 50, 5, 55, 10].forEach((c, d) => { for (let k = 0; k < c; k++) flip.push(d); }); // evens dominate, 8 and 9 are rare
    assert.equal(preferredBase(digitFrequency(flip)).parity, 'even');
    assert.equal(preferredBase(null), null);
    // the window is the freshest 300 ticks
    const long = Array.from({ length: 450 }, (_, i) => (i < 150 ? 0 : i % 10));
    assert.equal(computeRunBias(series(long), 2).digits.n, 300, 'the window stays at the freshest 300 ticks');
}
console.log('digitFrequency checks passed');
