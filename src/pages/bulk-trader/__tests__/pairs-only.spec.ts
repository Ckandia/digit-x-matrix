import { AutoPilotEngine, TAutoPilotConfig, TRADE_PAIRS, ALL_PAIR_KEYS, buildConfigFromPreset } from '../autoPilotEngine';
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
const keyed = (key: string, types: [string, string], trend?: string) => ({ ...(pairSig(types) as object), pair_key: key, trend }) as never;
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

const buyTypes = (h: { conn: Conn }) => h.conn.buys_().map(b => b.parameters.contract_type).sort();
const pairsOnly: Partial<TAutoPilotConfig> = { pairs_only: true };

describe('pairs only: the five pairs fire both legs at the same time', () => {
    it('Only Ups + Only Downs: an Only Ups signal buys both legs together, with no payout check first', async () => {
        const h = make({ R_O1: [{ ...(sig({ type: 'RUNHIGH', label: 'Only Ups' }) as object), trend: 'bullish' } as never] }, pairsOnly);
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['RUNHIGH', 'RUNLOW']);
        expect(h.conn.log).not.toContain('proposal');
        h.engine.stop();
    });

    it('Even + Under 5', async () => {
        const h = make({ R_O2: [keyed('even_under5', ['DIGITEVEN', 'DIGITUNDER'])] }, pairsOnly);
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['DIGITEVEN', 'DIGITUNDER']);
        expect(h.conn.buys_().map(b => b.price)).toEqual([1, 1]);
        h.engine.stop();
    });

    it('Odd + Over 4', async () => {
        const h = make({ R_O3: [keyed('odd_over4', ['DIGITODD', 'DIGITOVER'])] }, pairsOnly);
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['DIGITODD', 'DIGITOVER']);
        h.engine.stop();
    });

    it('Rise + Odd (a rise and an odd digit together)', async () => {
        const h = make({ R_O4: [keyed('rise_odd', ['CALL', 'DIGITODD'], 'bullish')] }, pairsOnly);
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['CALL', 'DIGITODD']);
        h.engine.stop();
    });

    it('Fall + Even (a fall and an even digit together)', async () => {
        const h = make({ R_O5: [keyed('fall_even', ['PUT', 'DIGITEVEN'], 'bearish')] }, pairsOnly);
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['DIGITEVEN', 'PUT']);
        h.engine.stop();
    });

    it('a single contract is never bought in pairs-only mode', async () => {
        const h = make({ R_O6: [sig({ type: 'DIGITEVEN', label: 'Even' }), sig({ type: 'DIGITUNDER', label: 'Under 5' }), sig({ type: 'CALL', label: 'Rise' })] }, pairsOnly);
        h.engine.start();
        await wait(200);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('an unticked pair does not fire, a ticked one does', async () => {
        const h = make({ R_O7: [keyed('rise_odd', ['CALL', 'DIGITODD'], 'bullish')], R_O8: [keyed('even_under5', ['DIGITEVEN', 'DIGITUNDER'])] }, { ...pairsOnly, pair_keys: ['even_under5'] });
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['DIGITEVEN', 'DIGITUNDER']);
        h.engine.stop();
    });

    it('with pairs-only off the older behaviour is unchanged (a single Even is bought alone)', async () => {
        const h = make({ R_O9: [sig({ type: 'DIGITEVEN', label: 'Even' })] });
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['DIGITEVEN']);
        h.engine.stop();
    });

    it('a balance that cannot cover two stakes stops the run instead of buying one leg', async () => {
        const h = make({ R_O10: [keyed('even_under5', ['DIGITEVEN', 'DIGITUNDER'])] }, pairsOnly);
        h.conn.accountInfo.balance = 1.5;
        h.engine.start();
        await wait(200);
        expect(h.conn.buys_()).toHaveLength(0);
        expect(h.engine.isRunning).toBe(false);
    });

    it('the pair settles as ONE trade', async () => {
        const h = make({ R_O11: [keyed('even_under5', ['DIGITEVEN', 'DIGITUNDER'])] }, pairsOnly);
        h.engine.start();
        await wait(200);
        h.conn.settle(101, 0.95);
        h.conn.settle(102, -1);
        await wait(300);
        expect(h.logs.some(l => /Both sides closed: net -0.05/.test(l))).toBe(true);
        h.engine.stop();
    });

    it('the five pairs are the ones asked for', () => {
        expect(TRADE_PAIRS.map(p => p.label)).toEqual(['Only Ups + Only Downs', 'Even + Under 5', 'Odd + Over 4', 'Rise + Odd', 'Fall + Even']);
        const c = buildConfigFromPreset('moderate', 10000);
        expect(c.pairs_only).toBe(true);
        expect(c.pair_keys).toEqual(ALL_PAIR_KEYS);
    });
});

describe('entry quality gate', () => {
    it('a signal weaker than the minimum strength is not bought, the strongest goes first', async () => {
        const weak = { ...(keyed('even_under5', ['DIGITEVEN', 'DIGITUNDER']) as object), confidence: 10 } as never;
        const strong = { ...(keyed('odd_over4', ['DIGITODD', 'DIGITOVER']) as object), confidence: 60 } as never;
        const h = make({ R_Q1: [weak], R_Q2: [strong] }, { pairs_only: true, min_confidence: 20 });
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['DIGITODD', 'DIGITOVER']);
        h.engine.stop();
    });
});
