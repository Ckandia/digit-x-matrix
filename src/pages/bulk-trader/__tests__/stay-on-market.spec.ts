import { AutoPilotEngine, TAutoPilotConfig, buildConfigFromPreset } from '../autoPilotEngine';
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

const markets = (h: { conn: Conn }) => h.conn.buys_().map(b => b.parameters.underlying_symbol);
const stay: Partial<TAutoPilotConfig> = { stay_on_market: true, switch_after_losses: 2, switch_wait_seconds: 45, recovery_mode: 'flat' };
const two = () => ({
    R_A: [sig({ type: 'DIGITEVEN', label: 'Even', confidence: 80 })],
    R_B: [sig({ type: 'DIGITEVEN', label: 'Even', confidence: 60 })],
});

describe('recovery stays on the same market until a switch condition is met', () => {
    it('without it the AI moves to the other market after a loss (the old behaviour)', async () => {
        const h = make(two(), { recovery_mode: 'flat' });
        h.engine.start();
        await wait(120);
        h.conn.settle(101, -1);
        await wait(200);
        expect(markets(h)).toEqual(['R_A', 'R_B']);
        h.engine.stop();
    });

    it('with it a loss is recovered on the same market and contract', async () => {
        const h = make(two(), stay);
        h.engine.start();
        await wait(120);
        h.conn.settle(101, -1);
        await wait(200);
        expect(markets(h)).toEqual(['R_A', 'R_A']);
        h.engine.stop();
    });

    it('after switch_after_losses losses in a row on that market the AI may switch', async () => {
        const h = make(two(), stay);
        h.engine.start();
        await wait(120);
        h.conn.settle(101, -1);
        await wait(200);
        h.conn.settle(102, -1);
        await wait(200);
        expect(markets(h)).toEqual(['R_A', 'R_A', 'R_B']);
        h.engine.stop();
    });

    it('a win frees the AI to pick the best entry on any market (the idlest first)', async () => {
        const h = make(two(), stay);
        h.engine.start();
        await wait(120);
        h.conn.settle(101, -1);
        await wait(200);
        h.conn.settle(102, 0.9);
        await wait(200);
        expect(markets(h)).toEqual(['R_A', 'R_A', 'R_B']);
        h.engine.stop();
    });

    it('the same market gives no entry within switch_wait_seconds: the AI switches', async () => {
        const h = make(two(), { ...stay, switch_wait_seconds: 0.25 });
        h.engine.start();
        await wait(120);
        h.snapshots.R_A.signals = [] as never; // the market it is recovering on goes quiet
        h.conn.settle(101, -1);
        await wait(150);
        expect(markets(h)).toEqual(['R_A']); // still holding on R_A
        await wait(300);
        expect(markets(h)).toEqual(['R_A', 'R_B']);
        h.engine.stop();
    });

    it('it recovers with the same pair, not another contract on the same market', async () => {
        const h = make({ R_A: [{ ...(pairSig(['DIGITEVEN', 'DIGITUNDER']) as object), pair_key: 'even_under5', confidence: 90 } as never, { ...(pairSig(['DIGITODD', 'DIGITOVER']) as object), pair_key: 'odd_over4', confidence: 50 } as never] }, { ...stay, pairs_only: true });
        h.engine.start();
        await wait(150);
        h.snapshots.R_A.signals = [{ ...(pairSig(['DIGITODD', 'DIGITOVER']) as object), pair_key: 'odd_over4', confidence: 50 } as never];
        h.conn.settle(101, -1);
        h.conn.settle(102, -1);
        await wait(250);
        expect(h.conn.buys_()).toHaveLength(2); // the Odd + Over 4 entry is another pair: not bought while recovering
        h.engine.stop();
    });

    it('presets turn it on with 2 losses / 45 seconds', () => {
        const c = buildConfigFromPreset('moderate', 10000);
        expect(c.stay_on_market).toBe(true);
        expect(c.switch_after_losses).toBe(2);
        expect(c.switch_wait_seconds).toBe(45);
    });
});
