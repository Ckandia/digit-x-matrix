import { computePairFrequencies, computePairSignals, lastDigit } from '../src/pairScan.js';
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
// hand-checked window: 100.00 100.12 100.24 100.36 (digits 0,2,4,6)
let r = computePairFrequencies([100.00, 100.12, 100.24, 100.36], 2);
const row = k => r.rows.find(x => x.key === k);
assert(r.n === 2, 'n');
assert(row('even').hits === 2 && row('even').pct === 100, 'even pairs (2,4) and (4,6)');
assert(row('odd').hits === 0, 'odd');
assert(row('over4').hits === 0 && row('under5').hits === 1, 'under5: (2,4) yes, (4,6) no'); // digits 2,4 <5; 4,6 no
assert(row('rise').hits === 2 && row('only_up').hits === 2 && row('fall').hits === 0, 'rising');
assert(row('touch').hits === 0 && row('no_touch').hits === 2, 'touch needs +0.5: (0.12,0.24) no; (0.24,0.36) no');
r = computePairFrequencies([100, 100.3, 100.6], 2);
assert(row('touch').hits === 1 && row('no_touch').hits === 0, 'touch at +0.6');
// tie loses both rise and fall
r = computePairFrequencies([100, 100, 100], 2);
assert(row('rise').hits === 0 && row('fall').hits === 0 && row('only_up').hits === 0, 'ties');
// trailing zero precision: 100.1 with 2dp is digit 0, not 1
assert(lastDigit(100.1, 2) === 0 && lastDigit(100.15, 2) === 5, 'pip padding');
// random walk: all pcts sane, z roughly centred, rows sum checks (even+odd pairs <= 100, rise+fall<=100, touch+no_touch=100)
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let p = 1000, prices = [];
for (let i = 0; i < 500; i++) { p += (rnd() - 0.5) * 1.2; prices.push(Number(p.toFixed(2))); }
r = computePairFrequencies(prices, 2);
assert(r.n === 498, 'n 498');
assert(Math.abs(row('touch').pct + row('no_touch').pct - 100) < 0.02, 'touch+no touch=100');
assert(row('even').pct + row('odd').pct <= 100, 'even+odd');
assert(row('rise').pct + row('fall').pct <= 100, 'rise+fall');
assert(r.rows.every(x => x.z !== null && Math.abs(x.z) < 6), 'z sane on random data');
const sigs = computePairSignals(r, 'X');
assert(sigs.length <= 3 && sigs.every(s => s.family === 'pairs' && s.confidence >= 15), 'signals');
// a rigged market where Even repeats: every digit even -> even pct 100, signal exists with high confidence
const rig = Array.from({ length: 300 }, (_, i) => Number((100 + (i % 2 ? 0.02 : 0.04) * 0).toFixed(2)) + (i % 5) * 0.02 * 0);
const rigged = []; for (let i = 0; i < 300; i++) rigged.push(Number((100 + (rnd() < 0.5 ? 0.02 : 0.04) + Math.floor(rnd()*5)*0.1).toFixed(2)));
const rr = computePairFrequencies(rigged, 2); assert(rr.rows.find(x => x.key === 'even').pct === 100, 'rigged even 100%');
console.log('window of 500 random-walk ticks:'); console.table(r.rows.map(x => ({ c: x.label, pct: x.pct, chance: x.expected_pct, z: x.z })));
console.log('signals', sigs.map(s => `${s.label}:${s.confidence}`).join(' '));
console.log('ALL OK');
