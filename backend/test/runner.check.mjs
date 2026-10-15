// Run: node test/runner.check.mjs   (no network, no Deriv: a fake connection and a fake market feed)
import assert from 'node:assert/strict';
import { RunnerService } from '../src/runner/runnerService.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const feed = {
    getAllSnapshots: () => ({
        R_10: { stats: {}, signals: [{ family: 'digits', contract_type: 'DIGITEVEN', label: 'Even', confidence: 60, basis: 'x' }] },
        R_25: null,
    }),
};

let buys = 0;
let closed = false;
const subs = {};
const makeConnection = async (token, account) => {
    assert.ok(token.length > 8);
    let id = 0;
    return {
        accountInfo: { loginid: account, balance: 1000, currency: 'USD' },
        balanceLive: true,
        refreshBalance: async () => 1000,
        onFatalError: null,
        close: () => {
            closed = true;
        },
        send: async r => {
            if (r.ticks_history) return { history: { prices: [], times: [] } };
            if (r.proposal) return { proposal: { ask_price: Number(r.amount ?? 1), payout: Number(r.amount ?? 1) * 1.83 } };
            if (r.buy) {
                buys += 1;
                const cid = ++id;
                setTimeout(() => subs[cid]?.({ proposal_open_contract: { is_sold: 1, profit: -r.price, buy_price: r.price, payout: 0, contract_id: cid } }, null), 5);
                return { buy: { contract_id: cid, buy_price: r.price } };
            }
            return {};
        },
        subscribe: (req, cb) => {
            if (req.contract_id) subs[req.contract_id] = cb;
            return 1;
        },
        unsubscribe: async () => {},
    };
};

const runner = new RunnerService({ marketFeed: feed, port: 59999, key: 'secret-key-123', connectionFactory: makeConnection, maxHours: 1 });
assert.equal(runner.enabled(), true);
assert.equal(runner.keyMatches('secret-key-123'), true);
assert.equal(runner.keyMatches('nope'), false);
assert.equal(new RunnerService({ marketFeed: feed, port: 1, key: '' }).enabled(), false);

// validation
await assert.rejects(() => runner.start({ token: 'x', account_id: 'A', config: {} }), /token/i);
await assert.rejects(() => runner.start({ token: 'tokentoken1', account_id: 'A', config: {} }), /stake/i);

const { buildConfigFromPreset } = await import('../src/runner/engine/autoPilotEngine.js');
const config = { ...buildConfigFromPreset('conservative', 1000), virtual_hook: false, follow_stream: false, protect_trades: 0, max_trades_per_hour: 0, read_entries: false };

await runner.start({ token: 'tokentoken1', account_id: 'CR1', config, learn_mode: 'learn' });
assert.equal(runner.status().state, 'running');
assert.equal(runner.token, 'tokentoken1'); // held in memory while running...
await assert.rejects(() => runner.start({ token: 'tokentoken1', account_id: 'CR1', config }), /already running/);
await wait(1500);
const st = runner.status(0);
assert.ok(st.items.some(i => i.kind === 'event' && i.data.phase === 'started'), 'started event');
assert.ok(buys > 0, 'the engine bought contracts on the fake connection');
assert.ok(st.items.some(i => i.kind === 'contract'), 'contract rows are collected');
assert.ok(!JSON.stringify(st).includes('tokentoken1'), 'the token is never in a status response');
const part = runner.status(st.seq);
assert.equal(part.items.length, 0, 'since=seq returns only what is new');

runner.stop('test stop');
await wait(50);
const end = runner.status(0);
assert.equal(end.state, 'stopped');
assert.equal(end.running, false);
assert.equal(runner.token, null, '...and forgotten when the run ends');
assert.equal(closed, true, 'the connection is closed');
assert.ok(end.items.some(i => i.kind === 'event' && i.data.phase === 'stopped'));

// wrong account is refused
const bad = new RunnerService({ marketFeed: feed, port: 59999, key: 'k', connectionFactory: async (t, a) => ({ ...(await makeConnection(t, 'OTHER')) }) });
await assert.rejects(() => bad.start({ token: 'tokentoken1', account_id: 'CR1', config }), /instead of CR1/);
assert.equal(bad.token, null);
console.log('runner checks passed: start, events, auth, token handling, stop, wrong-account refusal');
process.exit(0);
