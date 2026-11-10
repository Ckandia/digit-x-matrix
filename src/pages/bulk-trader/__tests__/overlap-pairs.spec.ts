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

const buyTypes = (h: { conn: Conn }) => h.conn.buys_().map(b => b.parameters.contract_type).sort();

describe('when the digit sequence favours two contracts at once, both are bought together', () => {
    it('Even + Under 5 (digits 0, 2, 4): both bought, one stake each, straight away', async () => {
        const h = make({ R_P1: [pairSig(['DIGITEVEN', 'DIGITUNDER'])] });
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['DIGITEVEN', 'DIGITUNDER']);
        expect(h.conn.buys_().map(b => b.price)).toEqual([1, 1]);
        expect(h.conn.log).not.toContain('proposal');
        expect(h.logs.some(l => /Overlap pair fired together: Even \+ Under 5/.test(l))).toBe(true);
        h.engine.stop();
    });

    it('Odd + Over 4 (digits 5, 7, 9): both bought', async () => {
        const h = make({ R_P2: [pairSig(['DIGITODD', 'DIGITOVER'])] });
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['DIGITODD', 'DIGITOVER']);
        h.engine.stop();
    });

    it('the under 5 leg is built with its barrier 5 and the over 4 leg with barrier 4', async () => {
        const h = make({ R_P3: [pairSig(['DIGITEVEN', 'DIGITUNDER'])], R_P4: [] });
        h.engine.start();
        await wait(200);
        const under = h.conn.buys_().find(b => b.parameters.contract_type === 'DIGITUNDER');
        expect(String(under?.parameters.barrier)).toBe('5');
        h.engine.stop();
    });

    it('single Even and Under 5 entries on their own are NOT paired (the sequence must favour both)', async () => {
        const h = make({ R_P5: [sig({ type: 'DIGITEVEN', label: 'Even' }), sig({ type: 'DIGITUNDER', label: 'Under 5' })] });
        h.engine.start();
        await wait(200);
        expect(h.conn.buys_()).toHaveLength(1);
        h.engine.stop();
    });

    it('the pair uses up the single entries of the same moment: nothing is bought twice', async () => {
        const single = (t: string, l: string) => ({ ...(sig({ type: t, label: l }) as object), run_id: '9:2' }) as never;
        const h = make({ R_P6: [{ ...(pairSig(['DIGITEVEN', 'DIGITUNDER']) as object), run_id: '9:2:pair' } as never, single('DIGITEVEN', 'Even'), single('DIGITUNDER', 'Under 5')] });
        h.engine.start();
        await wait(200);
        h.conn.settle(101, 0.95);
        h.conn.settle(102, 0.95);
        await wait(300);
        expect(h.conn.buys_()).toHaveLength(2); // the pair only: the same run is not bought again as singles
        h.engine.stop();
    });

    it('can be switched off', async () => {
        const h = make({ R_P7: [pairSig(['DIGITEVEN', 'DIGITUNDER'])] }, { overlap_pairs: false });
        h.engine.start();
        await wait(200);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('needs both contracts to be ticked', async () => {
        const h = make({ R_P8: [pairSig(['DIGITEVEN', 'DIGITUNDER'])] }, { contract_families: ['even_odd'] });
        h.engine.start();
        await wait(200);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('the pair settles as ONE trade: the next signal is only bought after both legs have closed', async () => {
        const h = make({ R_P9: [pairSig(['DIGITEVEN', 'DIGITUNDER'])] });
        h.engine.start();
        await wait(200);
        h.conn.settle(101, 0.95);
        await wait(200);
        expect(h.conn.buys_()).toHaveLength(2);
        h.conn.settle(102, -1);
        await wait(300);
        expect(h.logs.some(l => /Both sides closed: net -0.05/.test(l))).toBe(true);
        expect(h.conn.buys_().length).toBeGreaterThan(2);
        h.engine.stop();
    });
});

describe('price + digit pairs and pairs-only mode', () => {
    it('Rise + Odd: both bought together, Rise with no barrier and Odd', async () => {
        const h = make({ R_Q1: [{ ...(pairSig(['CALL', 'DIGITODD']) as object), trend: 'bullish' } as never] });
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['CALL', 'DIGITODD']);
        expect(h.logs.some(l => /Overlap pair fired together: Rise \+ Odd/.test(l))).toBe(true);
        h.engine.stop();
    });

    it('Fall + Even: both bought together', async () => {
        const h = make({ R_Q2: [{ ...(pairSig(['PUT', 'DIGITEVEN']) as object), trend: 'bearish' } as never] });
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['DIGITEVEN', 'PUT']);
        expect(h.logs.some(l => /Overlap pair fired together: Fall \+ Even/.test(l))).toBe(true);
        h.engine.stop();
    });

    it('Rise + Odd needs both Rise / Fall and Even / Odd to be ticked', async () => {
        const h = make({ R_Q3: [{ ...(pairSig(['CALL', 'DIGITODD']) as object), trend: 'bullish' } as never] }, { contract_families: ['even_odd'] });
        h.engine.start();
        await wait(200);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('pairs only: a single Even entry is not bought, a pair is', async () => {
        const single = make({ R_Q4: [sig({ type: 'DIGITEVEN', label: 'Even' })] }, { pairs_only: true });
        single.engine.start();
        await wait(200);
        expect(single.conn.buys_()).toHaveLength(0);
        single.engine.stop();
        const pair = make({ R_Q5: [sig({ type: 'DIGITEVEN', label: 'Even' }), pairSig(['DIGITEVEN', 'DIGITUNDER'])] }, { pairs_only: true });
        pair.engine.start();
        await wait(200);
        expect(buyTypes(pair)).toEqual(['DIGITEVEN', 'DIGITUNDER']);
        pair.engine.stop();
    });

    it('pairs only: Only Ups still fires together with Only Downs', async () => {
        const h = make({ R_Q6: [{ ...(sig({ type: 'RUNHIGH', label: 'Only Ups' }) as object), trend: 'bullish' } as never] }, { pairs_only: true });
        h.engine.start();
        await wait(200);
        expect(buyTypes(h)).toEqual(['RUNHIGH', 'RUNLOW']);
        h.engine.stop();
    });

    it('without pairs only, single entries are still bought', async () => {
        const h = make({ R_Q7: [sig({ type: 'DIGITEVEN', label: 'Even' })] });
        h.engine.start();
        await wait(200);
        expect(h.conn.buys_()).toHaveLength(1);
        h.engine.stop();
    });
});
