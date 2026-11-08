import { AutoPilotEngine, TAutoPilotConfig } from '../autoPilotEngine';
import type { TSnapshotMap } from '../analysis-types';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

const wait = (ms = 80) => new Promise(r => setTimeout(r, ms));

class Conn {
    sent: any[] = [];
    subs = new Map<number, { req: any; cb: any }>();
    history: Record<string, number[]> = {};
    payout = 3.8;
    pingDelay = 0;
    buyDelay = 0;
    log: string[] = []; // the order requests were sent in
    private n = 1;
    private buys = 0;
    accountInfo = { balance: 100000, loginid: 'VRTC1', currency: 'USD' };
    onFatalError: any;
    onReconnecting: any;
    onReconnect: any;
    async send(req: any) {
        this.sent.push(req);
        if (!req.ping) this.log.push(Object.keys(req).find(k => ['proposal', 'buy', 'ticks_history'].includes(k)) ?? 'other');
        if (req.ping) {
            if (this.pingDelay) await new Promise(r => setTimeout(r, this.pingDelay));
            return { ping: 'pong' };
        }
        if (req.proposal) return { proposal: { ask_price: 1, payout: this.payout } };
        if (req.buy) {
            if (this.buyDelay) await new Promise(r => setTimeout(r, this.buyDelay));
        }
        if (req.buy) return { buy: { contract_id: 100 + ++this.buys } };
        if (req.ticks_history) {
            const prices = this.history[req.ticks_history] ?? [];
            return { history: { prices, times: prices.map((_, i) => i + 1) }, pip_size: 2 };
        }
        return {};
    }
    subscribe(req: any, cb: any) {
        // Deriv validates contract_id as an integer: a string is rejected ("Input validation failed: contract_id").
        if (req.proposal_open_contract && typeof req.contract_id !== 'number') throw new Error('Input validation failed: contract_id');
        const id = this.n++;
        this.subs.set(id, { req, cb });
        return id;
    }
    unsubscribe(id: number) {
        this.subs.delete(id);
    }
    settle(contract_id: number, profit: number) {
        for (const { req, cb } of this.subs.values()) {
            if (req.proposal_open_contract && req.contract_id === contract_id) cb({ proposal_open_contract: { contract_id, is_sold: 1, profit, buy_price: 1 } }, null);
        }
    }
    buys_ = () => this.sent.filter(r => r.buy);
}

const sig = (o: { type: string; label: string; entry?: boolean; run_id?: number | string; trend?: string; confidence?: number }) =>
    ({ family: 'run_bias', strategy: 'run_bias', entry: o.entry ?? true, run_id: o.run_id, trend: o.trend, contract_type: o.type, label: o.label, confidence: o.confidence ?? 70, basis: '' }) as never;
const base: TAutoPilotConfig = { recovery_mode: 'flat', stake: 1, martingale_multiplier: 2, max_steps: 4, stop_loss: 1000, take_profit: 1000, protect_trades: 0 };
const make = (signals: Record<string, unknown[]>, cfg: Partial<TAutoPilotConfig> = {}, hooks: Record<string, unknown> = {}, tweak: (c: Conn) => void = () => undefined) => {
    const conn = new Conn();
    tweak(conn);
    const logs: string[] = [];
    const snapshots: TSnapshotMap = {};
    for (const [symbol, list] of Object.entries(signals)) snapshots[symbol] = { stats: {} as never, signals: list as never };
    const engine = new AutoPilotEngine(conn as never, 'USD', { ...base, ...cfg }, () => snapshots, () => undefined, undefined, { onLog: (_k: string, m: string) => logs.push(m), ...hooks } as never);
    return { conn, engine, snapshots, logs };
};


describe('slow internet: signals are never bought late', () => {
    const one = () => ({ R_SL: [sig({ type: 'DIGITEVEN', label: 'Even', run_id: 1 })] });

    it('a fast connection buys as usual (after its first ping)', async () => {
        const h = make(one(), { max_latency_ms: 400 });
        h.engine.start();
        await wait(250);
        expect(h.conn.buys_()).toHaveLength(1);
        h.engine.stop();
    });

    it('does not buy while the pings to Deriv are slower than the limit, and says why', async () => {
        const h = make(one(), { max_latency_ms: 200 }, {}, c => (c.pingDelay = 500));
        h.engine.start();
        await wait(1200);
        expect(h.conn.buys_()).toHaveLength(0);
        expect(h.logs.some(l => /slow|not answering|stalled|measuring/.test(l) || /not bought/.test(l))).toBe(true);
        h.engine.stop();
    });

    it('does not buy while the backend feed is arriving late', async () => {
        let lag = 900;
        const h = make(one(), { max_latency_ms: 400 }, { feedLagMs: () => lag });
        h.engine.start();
        await wait(300);
        expect(h.conn.buys_()).toHaveLength(0);
        expect(h.logs.some(l => /arriving 900 ms late/.test(l))).toBe(true);
        lag = 0;
        h.snapshots.R_SL.signals = [sig({ type: 'DIGITEVEN', label: 'Even', run_id: 2 })] as never; // a fresh run once the line is good again
        await wait(500);
        expect(h.conn.buys_()).toHaveLength(1);
        h.engine.stop();
    });

    it('a signal that arrived during a slow spell is dropped, not bought late when the line recovers', async () => {
        let lag = 900;
        const h = make(one(), { max_latency_ms: 400 }, { feedLagMs: () => lag });
        h.engine.start();
        await wait(300);
        lag = 0;
        await wait(500);
        expect(h.conn.buys_()).toHaveLength(0); // the old run id is gone for good
        h.engine.stop();
    });

    it('two buys confirmed late pause buying', async () => {
        const h = make({ R_LATE: [sig({ type: 'DIGITEVEN', label: 'Even', run_id: 1 })] }, { max_latency_ms: 100 }, {}, c => (c.buyDelay = 450));
        h.engine.start();
        await wait(800); // the first buy takes 450 ms to be confirmed: late
        h.snapshots.R_LATE.signals = [sig({ type: 'DIGITEVEN', label: 'Even', run_id: 2 })] as never; // the next run
        h.conn.settle(101, 0.9);
        await wait(1000); // the second buy is late too: two of the last ten
        expect(h.logs.some(l => /Pausing for 60s/.test(l))).toBe(true);
        h.engine.stop();
    });

    it('with the limit set to 0 the protection is off', async () => {
        const h = make(one(), { max_latency_ms: 0 }, { feedLagMs: () => 5000 }, c => (c.pingDelay = 2000));
        h.engine.start();
        await wait(250);
        expect(h.conn.buys_()).toHaveLength(1);
        h.engine.stop();
    });
});
