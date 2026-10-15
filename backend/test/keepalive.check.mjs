// Run: node test/keepalive.check.mjs  (no network: a local WebSocket server stands in for Deriv)
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 0 });
const port = wss.address().port;
process.env.DERIV_WS_URL = `ws://127.0.0.1:${port}`;
const pings = [];
wss.on('connection', sock => {
    sock.on('message', raw => {
        const m = JSON.parse(raw.toString());
        if (m.ping) {
            pings.push(m);
            sock.send(JSON.stringify({ msg_type: 'ping', ping: 'pong', echo_req: m }));
        }
    });
});

const { MarketFeed } = await import('../src/marketFeed.js');
const feed = new MarketFeed();
feed._startKeepAlive = function () {
    // same code path, 40ms instead of 25s so the check is fast
    this._stopKeepAlive();
    this._keepAliveTimer = setInterval(() => this.ws?.readyState === 1 && this._send({ ping: 1 }), 40);
};
feed.start();
await new Promise(r => setTimeout(r, 400));
assert.ok(pings.length >= 3, `expected several pings, got ${pings.length}`);
feed._stopKeepAlive();
const before = pings.length;
await new Promise(r => setTimeout(r, 150));
assert.equal(pings.length, before, 'pings stop when the keep-alive is stopped');
console.log('keepalive.check: ok,', before, 'pings');
feed.ws?.close();
wss.close();
process.exit(0);
