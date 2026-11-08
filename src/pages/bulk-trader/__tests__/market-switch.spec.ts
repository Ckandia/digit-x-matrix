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

let rid = 0; // every read of a signal gets a fresh run id: each pick is a new run of ticks
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

const markets = (h: { conn: Conn }) => h.conn.buys_().map(b => b.parameters.underlying_symbol);

describe('the AI switches market whenever an entry appears on another one', () => {
    it('with entries on two markets at once it alternates, instead of staying on the one with the strongest bias', async () => {
        const h = make({
            R_AAA: [sig({ type: 'DIGITODD', label: 'Odd', confidence: 90 })], // the strongest bias, every time
            R_BBB: [sig({ type: 'DIGITEVEN', label: 'Even', confidence: 50 })],
        });
        h.engine.start();
        await wait(150);
        h.conn.settle(101, 0.9);
        await wait(250);
        h.conn.settle(102, 0.9);
        await wait(250);
        h.conn.settle(103, 0.9);
        await wait(250);
        expect(markets(h).slice(0, 4)).toEqual(['R_AAA', 'R_BBB', 'R_AAA', 'R_BBB']);
        expect(h.logs.some(l => /Switching market: R_AAA -> R_BBB/.test(l))).toBe(true);
        h.engine.stop();
    });

    it('an entry where the 2-tick AND the 3-tick bias agree (confluence) goes first, even on the market traded last', async () => {
        const h = make({
            R_CCC: [sig({ type: 'DIGITODD', label: 'Odd', confidence: 60, confluence: true })],
            R_DDD: [sig({ type: 'DIGITEVEN', label: 'Even', confidence: 95 })],
        });
        h.engine.start();
        await wait(150);
        expect(markets(h)).toEqual(['R_CCC']); // confluence beats the stronger plain entry
        h.conn.settle(101, 0.9);
        await wait(250);
        expect(markets(h)).toEqual(['R_CCC', 'R_CCC']); // and again: it still has confluence
        h.engine.stop();
    });

    it('with a single market it keeps trading that market', async () => {
        const h = make({ R_EEE: [sig({ type: 'DIGITUNDER', label: 'Under 5' })] });
        h.engine.start();
        await wait(150);
        h.conn.settle(101, 0.9);
        await wait(250);
        expect(markets(h)).toEqual(['R_EEE', 'R_EEE']);
        h.engine.stop();
    });

    it('an entry that appears later on another market is bought as soon as it shows', async () => {
        const h = make({ R_FFF: [{ ...(sig({ type: 'DIGITODD', label: 'Odd' }) as object), entry: false } as never] });
        h.engine.start();
        await wait(150);
        expect(markets(h)).toEqual([]);
        h.snapshots.R_GGG = { stats: {} as never, signals: [sig({ type: 'DIGITEVEN', label: 'Even' })] as never };
        h.engine.signalReceived();
        await wait(60);
        expect(markets(h)).toEqual(['R_GGG']);
        h.engine.stop();
    });
});
