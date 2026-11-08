import { AutoPilotEngine, TAutoPilotConfig } from '../autoPilotEngine';
import type { TSnapshotMap } from '../analysis-types';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

const wait = (ms = 80) => new Promise(r => setTimeout(r, ms));

class Conn {
    sent: any[] = [];
    subs = new Map<number, { req: any; cb: any }>();
    history: Record<string, number[]> = {};
    payout = 3.8;
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
        if (req.proposal) return { proposal: { ask_price: 1, payout: this.payout } };
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
const make = (signals: Record<string, unknown[]>, cfg: Partial<TAutoPilotConfig> = {}) => {
    const conn = new Conn();
    const snapshots: TSnapshotMap = {};
    for (const [symbol, list] of Object.entries(signals)) snapshots[symbol] = { stats: {} as never, signals: list as never };
    const engine = new AutoPilotEngine(conn as never, 'USD', { ...base, ...cfg }, () => snapshots, () => undefined);
    return { conn, engine, snapshots };
};

describe('the buy right after the signal is as fast as it can be', () => {
    it('a single contract is bought with ONE request: no price check, no chart request first', async () => {
        const h = make({ R_F1: [sig({ type: 'DIGITEVEN', label: 'Even', run_id: '9:2' })] });
        h.engine.start();
        await wait(150);
        expect(h.conn.buys_()).toHaveLength(1);
        expect(h.conn.log.filter(k => k === 'proposal' || k === 'ticks_history')).toHaveLength(0);
        h.engine.stop();
    });

    it('Rise whose trend the backend already confirmed is bought without asking for the chart', async () => {
        const h = make({ R_F2: [sig({ type: 'CALL', label: 'Rise', run_id: '9:2', trend: 'bullish' })] });
        h.engine.start();
        await wait(150);
        expect(h.conn.buys_()).toHaveLength(1);
        expect(h.conn.log).not.toContain('ticks_history');
        h.engine.stop();
    });

    it('Rise without a backend trend confirmation still checks the chart, and a sideways chart is not bought', async () => {
        const h = make({ R_F3: [sig({ type: 'CALL', label: 'Rise', run_id: '9:2' })] });
        h.conn.history.R_F3 = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 0 : 0.5));
        h.engine.start();
        await wait(250);
        expect(h.conn.log).toContain('ticks_history');
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('Only Ups and Only Downs are priced together, then BOTH are bought together (the second leg is not waiting for the first)', async () => {
        const h = make({ R_F4: [sig({ type: 'RUNHIGH', label: 'Only Ups', run_id: '9:2', trend: 'bullish' })] });
        h.engine.start();
        await wait(250);
        expect(h.conn.log).toEqual(['proposal', 'proposal', 'buy', 'buy']);
        expect(h.conn.buys_().map(b => b.parameters.contract_type).sort()).toEqual(['RUNHIGH', 'RUNLOW']);
        h.engine.stop();
    });

    it('the pair is not bought when a winning side pays less than both stakes', async () => {
        const h = make({ R_F5: [sig({ type: 'RUNHIGH', label: 'Only Ups', run_id: '9:2', trend: 'bullish' })] });
        h.conn.payout = 1.9;
        h.engine.start();
        await wait(250);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('a waiting AI buys the moment signalReceived() is called, not at its next poll', async () => {
        const h = make({ R_F6: [sig({ type: 'DIGITODD', label: 'Odd', entry: false })] });
        h.engine.start();
        await wait(120);
        expect(h.conn.buys_()).toHaveLength(0);
        h.snapshots.R_F6.signals = [sig({ type: 'DIGITODD', label: 'Odd', run_id: '1:2' })] as never;
        h.engine.signalReceived();
        await wait(15);
        expect(h.conn.buys_()).toHaveLength(1);
        h.engine.stop();
    });

    it('no pacing by default: after a result the next signal is bought at once (no one-trade-a-minute wait)', async () => {
        const h = make({ R_F7: [sig({ type: 'DIGITEVEN', label: 'Even', run_id: 1 })] });
        h.engine.start();
        await wait(100);
        h.snapshots.R_F7.signals = [sig({ type: 'DIGITEVEN', label: 'Even', run_id: 2 })] as never;
        h.conn.settle(101, 0.9);
        await wait(300);
        expect(h.conn.buys_()).toHaveLength(2);
        h.engine.stop();
    });
});

describe('open contracts are followed by their numeric id', () => {
    it('a single contract and both legs of a pair are watched with the integer contract id Deriv sent', async () => {
        const h = make({ R_F10: [sig({ type: 'RUNHIGH', label: 'Only Ups', run_id: '9:2', trend: 'bullish' })] });
        h.engine.start();
        await wait(250);
        const watched = [...h.conn.subs.values()].map(x => x.req).filter(r => r.proposal_open_contract);
        expect(watched).toHaveLength(2);
        for (const r of watched) expect(typeof r.contract_id).toBe('number');
        h.engine.stop();
    });

    it('a run is not stopped by "lost track of an open contract"', async () => {
        const events: string[] = [];
        const conn = new Conn();
        const snapshots: TSnapshotMap = { R_F11: { stats: {} as never, signals: [sig({ type: 'DIGITEVEN', label: 'Even', run_id: 1 })] as never } };
        const engine = new AutoPilotEngine(conn as never, 'USD', base, () => snapshots, e => events.push(`${e.phase}${e.reason ? ':' + e.reason : ''}`));
        engine.start();
        await wait(200);
        conn.settle(101, 0.9);
        await wait(200);
        expect(events.some(e => e.includes('lost track'))).toBe(false);
        expect(events.some(e => e.startsWith('settled'))).toBe(true);
        engine.stop();
    });
});

describe('Touch / No Touch are not traded by the AI', () => {
    it('a Touch or No Touch signal is ignored even if the backend sends one', async () => {
        const h = make({ R_F8: [sig({ type: 'NOTOUCH', label: 'No Touch', run_id: 1, confidence: 99 }), sig({ type: 'ONETOUCH', label: 'Touch', run_id: 1, confidence: 98 })] });
        h.engine.start();
        await wait(300);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });
});

describe('no recovery ladder', () => {
    it('after a loss the stake is the base stake again, even for the old martingale settings', async () => {
        const h = make({ R_F9: [sig({ type: 'DIGITEVEN', label: 'Even', run_id: 1 })] }, { recovery_mode: 'martingale' });
        h.engine.start();
        await wait(100);
        h.snapshots.R_F9.signals = [sig({ type: 'DIGITEVEN', label: 'Even', run_id: 2 })] as never;
        h.conn.settle(101, -1);
        await wait(300);
        expect(h.conn.buys_().map(b => b.price)).toEqual([1, 1]);
        h.engine.stop();
    });
});
