// End-to-end check of the server runner against a FAKE Deriv (no network, no real account, no money):
//   node test/runner.check.mjs
// It starts a fake Deriv (accounts + OTP over HTTP, trading over WebSocket), feeds the runner synthetic market snapshots, and
// checks that a run starts, trades, keeps its state, can only be read/stopped with its secret, and refreshes its login.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { MarketFeed } from '../src/marketFeed.js';
import { pushDigit } from '../src/digitAnalysis.js';
import { pushPrice } from '../src/contractAnalysis.js';
import { RunnerManager, decrypt, encrypt, validateConfig } from '../src/runner/runnerManager.js';

const assert = (c, m) => {
    if (!c) {
        console.error('FAIL', m);
        process.exit(1);
    }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- fake Deriv -----------------------------------------------------------------------------------------------------------
const seen = { accounts_auth: [], otp: 0, refresh: 0, buys: 0, proposals: 0 };
let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let price = 1000;
const nextPrice = () => Number((price += (rnd() - 0.5) * 2).toFixed(2));
const open = new Map(); // contract_id -> { req_id, stake, ask, payout, ws }
let cid = 1000;
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set();
wss.on('connection', ws => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', raw => {
        const m = JSON.parse(String(raw));
        const reply = body => ws.send(JSON.stringify({ req_id: m.req_id, echo_req: m, ...body }));
        if (m.ping) return reply({ ping: 'pong' });
        if (m.balance) return reply({ msg_type: 'balance', balance: { balance: 1000, currency: 'USD', loginid: 'CR1234' }, subscription: { id: 'bal' } });
        if (m.forget) return reply({ forget: 1 });
        if (m.ticks_history) {
            const prices = Array.from({ length: Number(m.count || 50) }, nextPrice);
            return reply({ history: { prices, times: prices.map((_, i) => i) }, pip_size: 2 });
        }
        if (m.ticks) {
            reply({ tick: { symbol: m.ticks, quote: nextPrice(), pip_size: 2, epoch: Math.floor(Date.now() / 1000) }, subscription: { id: `t${m.req_id}` } });
            const t = setInterval(() => {
                if (ws.readyState !== 1) return clearInterval(t);
                ws.send(JSON.stringify({ req_id: m.req_id, tick: { symbol: m.ticks, quote: nextPrice(), pip_size: 2, epoch: Math.floor(Date.now() / 1000) }, subscription: { id: `t${m.req_id}` } }));
            }, 300);
            return;
        }
        if (m.proposal) {
            seen.proposals += 1;
            const ask = Number(m.amount);
            return reply({ proposal: { id: `p${m.req_id}`, ask_price: ask, payout: Number((ask * 1.83).toFixed(2)), spot: price, display_value: String(ask) } });
        }
        if (m.buy) {
            seen.buys += 1;
            const id = ++cid;
            const ask = Number(m.price);
            reply({ buy: { contract_id: id, buy_price: ask, payout: ask * 1.83, start_time: Math.floor(Date.now() / 1000), longcode: 'fake', transaction_id: id } });
            return;
        }
        if (m.proposal_open_contract) {
            const id = Number(m.contract_id);
            const send = sold => {
                const win = rnd() < 0.5;
                ws.send(JSON.stringify({ req_id: m.req_id, msg_type: 'proposal_open_contract', subscription: { id: `c${id}` }, proposal_open_contract: { contract_id: id, is_sold: sold ? 1 : 0, status: sold ? (win ? 'won' : 'lost') : 'open', buy_price: 1, profit: sold ? (win ? 0.83 : -1) : 0, sell_price: sold && win ? 1.83 : 0, payout: 1.83, underlying: '1HZ10V', contract_type: 'DIGITEVEN', shortcode: 'DIGITEVEN_1HZ10V_1.0_1T', date_start: Math.floor(Date.now() / 1000), tick_count: 1 } }));
            };
            send(false);
            setTimeout(() => send(true), 150);
            return;
        }
        reply({ error: { code: 'Unsupported', message: `fake deriv: ${Object.keys(m)[0]}` } });
    });
});
const deriv = http.createServer(async (req, res) => {
    const json = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    if (req.url === '/options/accounts') {
        seen.accounts_auth.push(req.headers.authorization);
        if (req.headers.authorization === 'Bearer bad-token-bad-token') return json(401, {});
        return json(200, { data: [{ account_id: 'CR1234', balance: '1000', currency: 'USD', account_type: 'demo', group: 'x', status: 'active' }] });
    }
    if (req.url === '/options/accounts/CR1234/otp' && req.method === 'POST') {
        seen.otp += 1;
        return json(200, { data: { url: `ws://127.0.0.1:${deriv.address().port}/ws?otp=secret${seen.otp}` } });
    }
    if (req.url === '/oauth2/token' && req.method === 'POST') {
        seen.refresh += 1;
        let body = '';
        for await (const c of req) body += c;
        const p = new URLSearchParams(body);
        if (p.get('grant_type') !== 'refresh_token' || p.get('refresh_token') !== 'refresh-1' && p.get('refresh_token') !== 'refresh-2') return json(400, {});
        return json(200, { access_token: `fresh-token-${seen.refresh}-xxxxx`, refresh_token: 'refresh-2', expires_in: 3600 });
    }
    json(404, {});
});
deriv.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));
await new Promise(r => deriv.listen(0, '127.0.0.1', r));
const port = deriv.address().port;
process.env.DERIV_API_BASE = `http://127.0.0.1:${port}/options/`;
process.env.DERIV_AUTH_URL = `http://127.0.0.1:${port}/oauth2`;
process.env.DERIV_APP_ID = 'test-app';
process.env.RUNNER_ENABLED = 'true';

// ---- synthetic market ------------------------------------------------------------------------------------------------------
const feed = new MarketFeed();
for (const [symbol, win] of feed.windows) {
    const pw = feed.priceWindows.get(symbol);
    let p = 1000;
    for (let i = 0; i < 400; i++) {
        p = Number((p + (rnd() - 0.5) * 2).toFixed(2));
        pushPrice(pw, p);
        pushDigit(win, Math.round(p * 100) % 10);
    }
}
const snapshots = feed.getAllSnapshots();
assert(Object.keys(snapshots).length >= 5 && Object.values(snapshots).every(s => s && s.signals), 'synthetic snapshots');

// ---- unit checks ---------------------------------------------------------------------------------------------------------
const cfg = {
    recovery_mode: 'martingale', recover_losses: true, stake: 1, martingale_multiplier: 2, max_steps: 4, stop_loss: 20, take_profit: 30,
    virtual_hook: true, virtual_confirmations: 2, virtual_mode: 'hook', follow_stream: true, entry_tick: 3,
    contract_families: ['even_odd', 'over_under', 'rise_fall'], rotate_contracts: true, both_sides: false, max_trades_per_hour: 0,
};
assert(validateConfig(cfg) === null, 'good config');
assert(validateConfig({ ...cfg, stop_loss: 0 }), 'no stop loss refused');
assert(validateConfig({ ...cfg, stake: 0.1 }), 'tiny stake refused');
assert(validateConfig({ ...cfg, stake: 50 }), 'stake above stop loss refused');
assert(validateConfig({ ...cfg, max_steps: 99 }), 'too many steps refused');
const key = Buffer.alloc(32, 7);
assert(decrypt(encrypt({ a: 1, t: 'refresh-1' }, key), key).t === 'refresh-1', 'encrypt round trip');
let bad = false;
try {
    const blob = Buffer.from(encrypt({ a: 1 }, key), 'base64');
    blob[blob.length - 1] ^= 1;
    decrypt(blob.toString('base64'), key);
} catch {
    bad = true;
}
assert(bad, 'tampered ciphertext is rejected');

// ---- a real run against the fake Deriv ---------------------------------------------------------------------------------
const mgr = new RunnerManager({ getSnapshots: () => snapshots, loadEngine: () => import('../src/runner/engine.bundle.mjs') });
const tokens = { access_token: 'good-token-good-token', refresh_token: 'refresh-1', expires_at: Math.floor(Date.now() / 1000) + 30 }; // about to expire -> must refresh

const expectFail = async (p, status, why) => {
    try {
        await p;
    } catch (e) {
        assert(e.status === status, `${why}: expected ${status}, got ${e.status} ${e.message}`);
        return;
    }
    assert(false, `${why}: should have failed`);
};
await expectFail(mgr.start({ loginid: 'CR1234', auth: { access_token: 'bad-token-bad-token' }, config: cfg }), 401, 'a token Deriv rejects');
await expectFail(mgr.start({ loginid: 'CR9999', auth: tokens, config: cfg }), 403, 'someone else\'s account');
await expectFail(mgr.start({ loginid: 'CR1234', auth: tokens, config: { ...cfg, stop_loss: 0 } }), 400, 'no stop loss');

const { loginid, secret } = await mgr.start({ loginid: 'CR1234', auth: tokens, config: cfg, learnMode: 'learn' });
assert(secret.length >= 32 && !JSON.stringify(mgr.status(loginid, secret)).includes('good-token'), 'status never shows the token');
await expectFail(mgr.start({ loginid: 'CR1234', auth: tokens, config: cfg }), 409, 'a second run on the same account');
assert(mgr.status(loginid, 'wrong') === null && mgr.stop(loginid, 'wrong') === false, 'wrong secret cannot read or stop');

for (let i = 0; i < 160 && seen.buys < 2; i++) await sleep(500);
const st = mgr.status(loginid, secret);
console.log('activity:', JSON.stringify(st.activity.slice(0, 6).map(a => a.text)));
console.log('status:', st.status, 'ladder', st.ladder.length, 'paper rows', st.virtual.rows.length, 'profit', st.totalProfit, 'buys', seen.buys);
assert(st.running && st.status === 'running', 'run is running');
assert(st.virtual.rows.length >= 1, 'it paper-traded first (virtual hook)');
assert(seen.buys >= 1 && st.ladder.length >= 1, 'it placed live trades');
assert(st.history.length >= 1, 'trade history is kept');
assert(seen.refresh >= 1, 'a login about to expire is refreshed before use');

// the run survives a dropped Deriv socket
for (const s of sockets) s.terminate();
for (let i = 0; i < 40 && seen.otp < 2; i++) await sleep(500);
assert(seen.otp >= 2, 'reconnected with a fresh one-time URL after a drop');
assert(mgr.status(loginid, secret).running, 'still running after the drop');

assert(mgr.stop(loginid, secret) === true, 'stop with the secret');
await sleep(300);
const end = mgr.status(loginid, secret);
assert(!end.running && end.status === 'stopped', 'stopped');
console.log('stop reason:', end.stopReason);
console.log('ALL OK');
process.exit(0);
