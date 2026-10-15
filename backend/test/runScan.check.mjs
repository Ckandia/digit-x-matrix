// Run: node test/runScan.check.mjs   (pure; no network)
import { computeRunFrequencies, scanFlags, windowMoments, RUN_MIN, FAVOURED_Z } from '../src/runScan.js';

const assert = (c, m) => {
    if (!c) {
        console.error('FAIL', m);
        process.exit(1);
    }
};
const row = (r, k) => r.rows.find(x => x.key === k);

// ---- hand-checked streams (2 decimals: the last digit is the 2nd decimal)
// the owner's examples: Even 2,4,6 / Odd 1,3,7 / Over 4: 5,8,9 / Under 5: 2,1,4
const stream = digits => [100.0, ...digits.map(d => Number((100 + d / 100).toFixed(2)))];
let r = computeRunFrequencies(stream([2, 4, 6]), 2);
assert(row(r, 'even').runs === 1 && row(r, 'even').triples === 1 && row(r, 'even').current_run === 3 && row(r, 'even').longest === 3, 'even 2,4,6 is one run of 3');
assert(row(r, 'odd').runs === 0 && row(r, 'odd').current_run === 0, 'odd: none');
r = computeRunFrequencies(stream([1, 3, 7]), 2);
assert(row(r, 'odd').runs === 1 && row(r, 'even').runs === 0, 'odd 1,3,7');
r = computeRunFrequencies(stream([5, 8, 9]), 2);
assert(row(r, 'over4').runs === 1 && row(r, 'under5').runs === 0, 'over 4: 5,8,9');
r = computeRunFrequencies(stream([2, 1, 4]), 2);
assert(row(r, 'under5').runs === 1 && row(r, 'over4').runs === 0, 'under 5: 2,1,4');
// two ticks are not enough
r = computeRunFrequencies(stream([2, 4]), 2);
assert(row(r, 'even').runs === 0 && row(r, 'even').current_run === 2, 'two ticks: no run yet, but the run in progress is 2 (the next even makes three)');
// a long run counts once; two runs count twice
let f = scanFlags([true, true, true, true, true, true, false, true, true, true]);
assert(f.runs === 2 && f.longest === 6 && f.current === 3 && f.runs4 === 1 && f.runs5 === 1, 'maximal runs');
assert(f.triples === 5, 'a run of 6 holds four 3-windows, a run of 3 holds one: 5');
f = scanFlags([true, true, false, true, true]);
assert(f.runs === 0 && f.current === 2, 'runs of two do not count');
// price runs
r = computeRunFrequencies([100, 100.1, 100.2, 100.3], 2);
assert(row(r, 'rise').runs === 1 && row(r, 'fall').runs === 0, 'three rising ticks');
r = computeRunFrequencies([100, 99.9, 99.8, 99.7, 99.8], 2);
assert(row(r, 'fall').runs === 1 && row(r, 'fall').longest === 3 && row(r, 'rise').current_run === 1, 'three falling ticks, then a rise');
r = computeRunFrequencies([100, 100, 100, 100], 2);
assert(row(r, 'rise').runs === 0 && row(r, 'fall').runs === 0, 'equal ticks are neither');
// trailing-zero precision: 100.1 at 2dp is digit 0 (even), not 1
r = computeRunFrequencies([100, 100.1, 100.2, 100.3], 2); // digits 0,0,0 -> even
assert(row(r, 'even').runs === 1, 'padded precision: 100.10 100.20 100.30 end in 0');

// ---- the chance formula (mean AND variance of overlapping windows) against a simulation
let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (const p of [0.5, 0.3, 0.7]) {
    const n = 500;
    const trials = 4000;
    let sum = 0;
    let sumsq = 0;
    for (let t = 0; t < trials; t++) {
        const flags = Array.from({ length: n }, () => rnd() < p);
        const c = scanFlags(flags, RUN_MIN).triples;
        sum += c;
        sumsq += c * c;
    }
    const mean = sum / trials;
    const variance = sumsq / trials - mean * mean;
    const m = windowMoments(n - RUN_MIN + 1, p, RUN_MIN);
    console.log(`p=${p}, n=${n}: windows simulated mean ${mean.toFixed(2)} vs ${m.mean.toFixed(2)}; variance ${variance.toFixed(1)} vs ${m.variance.toFixed(1)}`);
    assert(Math.abs(mean - m.mean) / m.mean < 0.03, `mean matches (p=${p})`);
    assert(Math.abs(variance - m.variance) / m.variance < 0.1, `variance matches (p=${p})`);
}

// ---- random markets: z is centred and sane for all six contracts
let zs = [];
for (let m = 0; m < 60; m++) {
    let p = 1000;
    const prices = [];
    for (let i = 0; i < 500; i++) {
        p += (rnd() - 0.5) * 1.2;
        prices.push(Number(p.toFixed(2)));
    }
    const rr = computeRunFrequencies(prices, 2);
    assert(rr.n === 499, 'n');
    for (const x of rr.rows) {
        assert(x.z !== null && Math.abs(x.z) < 6, 'z sane on random data');
        assert(x.bias >= 0 && x.bias <= 100, 'bias range');
        zs.push(x.z);
    }
}
const zmean = zs.reduce((a, b) => a + b, 0) / zs.length;
const zsd = Math.sqrt(zs.reduce((a, b) => a + (b - zmean) ** 2, 0) / zs.length);
const favoured_share = zs.filter(z => z >= FAVOURED_Z).length / zs.length;
console.log(`random markets: mean z ${zmean.toFixed(2)}, sd ${zsd.toFixed(2)}, ${(favoured_share * 100).toFixed(1)}% of cells flagged favoured (pure chance)`);
assert(Math.abs(zmean) < 0.3, 'z is centred near 0 on random data');
assert(zsd > 0.8 && zsd < 1.25, 'z has a standard deviation near 1 on random data (so z >= 1.5 really is a 1.5-sigma gap)');

// ---- a rigged market where Even clusters: far above chance, favoured, ranked first
const rigged = [100];
for (let i = 0; i < 400; i++) {
    const even = i % 12 < 9; // 9 even ticks then 3 odd ticks, repeating
    const d = even ? 2 * Math.floor(rnd() * 5) : 2 * Math.floor(rnd() * 5) + 1;
    rigged.push(Number((100 + d / 100 + (i % 7) * 0).toFixed(2)));
}
const rg = computeRunFrequencies(rigged, 2);
assert(row(rg, 'even').favoured && row(rg, 'even').z > 5, 'rigged even is favoured');
assert(row(rg, 'odd').z < 0, 'and Odd is below chance');
assert(rg.ranked[0] === 'even', 'ranked first');
// too few ticks: no z
assert(computeRunFrequencies(rigged.slice(0, 40), 2).rows.every(x => x.z === null && x.bias === 0), 'no bias before enough ticks');
console.table(rg.rows.map(x => ({ contract: x.label, pct: x.pct, chance: x.expected_pct, z: x.z, bias: x.bias, runs: x.runs, now: x.current_run })));
console.log('ALL OK');
