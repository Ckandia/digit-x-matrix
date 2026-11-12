import { AutoPilotEngine, TAutoPilotConfig, buildConfigFromPreset, stakeMode } from '../autoPilotEngine';
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

let rid = 0; // every read of a signal gets a fresh run id: each pick is a new run of ticks
const pairSig = (types: [string, string], o: { confluence?: boolean } = {}) =>
    ({ family: 'run_bias', strategy: 'run_bias', entry: true, confluence: o.confluence ?? false, pair_types: types, get run_id() { return `${++rid}:2:pair`; }, contract_type: types[0], label: 'pair', confidence: 70, basis: '' }) as never;
const sig = (o: { type: string; label: string; confidence?: number; confluence?: boolean }) =>
    ({ family: 'run_bias', strategy: 'run_bias', entry: true, confluence: o.confluence ?? false, get run_id() { return `${++rid}:2`; }, contract_type: o.type, label: o.label, confidence: o.confidence ?? 70, basis: '' }) as never;
const base: TAutoPilotConfig = { recovery_mode: 'flat', stake: 1, martingale_multiplier: 2, max_steps: 4, stop_loss: 1000, take_profit: 1000, protect_trades: 0 };
const make = (signals: Record<string, unknown[]>, cfg: Partial<TAutoPilotConfig> = {}) => {
    const conn = new Conn();
    const logs: string[] = [];
    const snapshots: TSnapshotMap = {};
    for (const [symbol, list] of Object.entries(signals)) snapshots[symbol] = { stats: {} as never, signals: list as never };
    const engine = new AutoPilotEngine(conn as never, 'USD', { ...base, ...cfg }, () => snapshots, () => undefined, undefined, { onLog: (_k: string, m: string) => logs.push(m) } as never);
    return { conn, engine, snapshots, logs };
};

const stakes = (h: { conn: Conn }) => h.conn.buys_().map(b => b.price);
const mart: Partial<TAutoPilotConfig> = { recovery_mode: 'martingale', martingale_multiplier: 1.5, max_steps: 4, stake: 1 };

describe('martingale: the stake grows only after a LOSS (x1.5), never after a win', () => {
    it('loss, loss, win: 1 -> 1.5 -> 2.25 -> back to 1', async () => {
        const h = make({ R_M1: [sig({ type: 'DIGITEVEN', label: 'Even' })] }, mart);
        h.engine.start();
        await wait(120);
        h.conn.settle(101, -1);
        await wait(200);
        h.conn.settle(102, -1.5);
        await wait(200);
        h.conn.settle(103, 2.1);
        await wait(200);
        expect(stakes(h)).toEqual([1, 1.5, 2.25, 1]);
        h.engine.stop();
    });

    it('a win never raises the stake: win, win, win stays at the base stake', async () => {
        const h = make({ R_M2: [sig({ type: 'DIGITEVEN', label: 'Even' })] }, mart);
        h.engine.start();
        await wait(120);
        h.conn.settle(101, 0.9);
        await wait(200);
        h.conn.settle(102, 0.9);
        await wait(200);
        expect(stakes(h)).toEqual([1, 1, 1]);
        h.engine.stop();
    });

    it('after max_steps losses in a row the stake goes back to the base stake', async () => {
        const h = make({ R_M3: [sig({ type: 'DIGITEVEN', label: 'Even' })] }, { ...mart, max_steps: 2 });
        h.engine.start();
        await wait(120);
        h.conn.settle(101, -1);
        await wait(200);
        h.conn.settle(102, -1.5);
        await wait(200);
        expect(stakes(h)).toEqual([1, 1.5, 1]);
        h.engine.stop();
    });

    it('a pair uses the per-leg stake: both legs go up x1.5 after a losing pair', async () => {
        const h = make({ R_M4: [{ ...(pairSig(['DIGITEVEN', 'DIGITUNDER']) as object) } as never] }, { ...mart, pairs_only: true });
        (h.snapshots.R_M4.signals[0] as { pair_key?: string }).pair_key = 'even_under5';
        h.engine.start();
        await wait(150);
        h.snapshots.R_M4.signals = [{ ...(h.snapshots.R_M4.signals[0] as object), run_id: 'next:2:pair' } as never]; // a fresh run, so the next pair may fire
        h.conn.settle(101, -1);
        h.conn.settle(102, -1);
        await wait(250);
        expect(stakes(h)).toEqual([1, 1, 1.5, 1.5]);
        h.engine.stop();
    });

    it('a next stake the stop loss no longer allows goes back to the base stake', async () => {
        const h = make({ R_M5: [sig({ type: 'DIGITEVEN', label: 'Even' })] }, { ...mart, stake: 5, stop_loss: 8 });
        h.engine.start();
        await wait(120);
        h.conn.settle(101, -5);
        await wait(200);
        expect(stakes(h)).toEqual([5, 5]); // 7.5 would pass the 3 left before the stop loss
        h.engine.stop();
    });

    it('presets use the martingale at 1.5, and old saved settings keep working', () => {
        for (const level of ['conservative', 'moderate', 'aggressive'] as const) {
            const c = buildConfigFromPreset(level, 10000);
            expect(c.recovery_mode).toBe('martingale');
            expect(c.martingale_multiplier).toBe(1.5);
        }
        expect(stakeMode('martingale')).toBe('martingale');
        expect(stakeMode('flip')).toBe('martingale');
        expect(stakeMode('reverse')).toBe('reverse');
        expect(stakeMode('flat')).toBe('flat');
        expect(stakeMode(undefined)).toBe('reverse');
    });
});
