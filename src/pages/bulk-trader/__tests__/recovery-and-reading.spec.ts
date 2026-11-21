import {
    AutoPilotEngine,
    ASSUMED_PAYOUT_RATIO,
    entryScore,
    MIN_STAKE,
    planMartingale,
    reachRatio,
    recoveryLadder,
    recoveryStake,
    TAutoPilotConfig,
    touchReading,
} from '../autoPilotEngine';
import type { TSnapshotMap } from '../analysis-types';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));

describe('recovery stake', () => {
    it('wins back everything lost in the ladder plus one base stake', () => {
        expect(recoveryStake(1, 1)).toBe(2.41); // (1 + 1) / 0.83
        const ladder = recoveryLadder(1, 5);
        let spent = 0;
        ladder.forEach((stake, i) => {
            if (i > 0) expect(stake * ASSUMED_PAYOUT_RATIO).toBeGreaterThanOrEqual(spent + 1 - 0.01);
            spent += stake;
        });
        expect(ladder[0]).toBe(1);
    });

    it('uses the payout the contract showed instead of the assumed one', () => {
        expect(recoveryStake(1, 1, 0.95)).toBe(2.11); // 2 / 0.95
        expect(recoveryStake(1, 1, NaN)).toBe(2.41);
    });

    it('sizes the base stake so a full failed ladder fits the stop-loss share', () => {
        const plan = planMartingale(1500, 5);
        expect(plan.worst_ladder).toBeLessThanOrEqual(1500 * 0.6 + 1);
        expect(plan.stake).toBeGreaterThan(MIN_STAKE);
        expect(plan.trimmed).toBe(false);
        expect(plan.ladder).toHaveLength(5);
    });

    it('a small account is held to the minimum stake', () => {
        const plan = planMartingale(15, 5);
        expect(plan.stake).toBe(MIN_STAKE);
        expect(plan.trimmed).toBe(true);
    });
});

describe('entry reading from the latest ticks', () => {
    const digits = (ds: number[]) => ds.map((d, i) => 100 + i * 0.1 - Math.floor(i * 0.1) + d / 100); // last digit of the 2-decimals price is d
    const prices = (lastDigits: number[]) => lastDigits.map((d, i) => Number((100 + i * 0.1 + d / 100).toFixed(2)));

    it('a run one tick short of the entry tick scores 1; a stale run scores 0', () => {
        const a = prices([1, 3, 5, 7, 9, 1, 3, 5, 7, 9, 2, 4]); // even, even at the end: run 2
        expect(entryScore('DIGITEVEN', undefined, a, 2, 3)).toBe(1);
        const stale = prices([1, 3, 5, 7, 9, 1, 3, 5, 2, 4, 6, 8]); // run 4: past the 3rd tick
        expect(entryScore('DIGITEVEN', undefined, stale, 2, 3)).toBe(0);
        expect(entryScore('DIGITODD', undefined, a, 2, 3)).toBe(0);
    });

    it('Only Ups reads rising ticks like Rise', () => {
        const up = [100, 100.1, 100.2, 100.3, 100.4, 100.5, 100.6, 100.7, 100.8, 100.9, 101, 101.1, 101.2];
        expect(entryScore('RUNHIGH', undefined, up, 2, 3)).toBe(0); // run 12: stale, waits for a fresh run
        const fresh = [...up.slice(0, 10), 101.5, 101.4, 101.5, 101.6];
        expect(entryScore('RUNHIGH', undefined, fresh, 2, 3)).toBe(1);
        expect(entryScore('RUNLOW', undefined, fresh, 2, 3)).toBe(0);
    });

    it('Touch wants a fast market (and an up tick), No Touch a calm one', () => {
        const fast = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 0.9) + i * 0.01); // ~0.9 a tick
        const calm = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 0.02));
        expect(reachRatio(fast)!).toBeGreaterThan(1);
        expect(reachRatio(calm)!).toBeLessThan(0.5);
        expect(touchReading('NOTOUCH', calm)).toBe(true);
        expect(touchReading('NOTOUCH', fast)).toBe(false);
        expect(touchReading('ONETOUCH', [...fast.slice(0, 24), 102])).toBe(true);
        expect(touchReading('ONETOUCH', calm)).toBe(false);
        expect(touchReading('ONETOUCH', [1, 2, 3])).toBe(false); // too few ticks to read
    });
});

class Conn {
    sent: any[] = [];
    subs = new Map<number, { req: any; cb: any }>();
    history: Record<string, number[]> = {};
    private n = 1;
    private buys = 0;
    accountInfo = { balance: 100000, loginid: 'VRTC1', currency: 'USD' };
    onFatalError: any;
    onReconnecting: any;
    onReconnect: any;
    async send(req: any) {
        this.sent.push(req);
        if (req.proposal) return { proposal: { ask_price: 1, payout: 1.9 } };
        if (req.buy) return { buy: { contract_id: `c${++this.buys}` } };
        if (req.ticks_history) {
            const prices = this.history[req.ticks_history] ?? [];
            return { history: { prices, times: prices.map((_, i) => i + 1) }, pip_size: 2 };
        }
        return {};
    }
    subscribe(req: any, cb: any) {
        const id = this.n++;
        this.subs.set(id, { req, cb });
        return id;
    }
    unsubscribe(id: number) {
        this.subs.delete(id);
    }
    settle(contract_id: string, profit: number) {
        for (const { req, cb } of this.subs.values()) {
            if (req.proposal_open_contract && req.contract_id === contract_id) cb({ proposal_open_contract: { contract_id, is_sold: 1, profit, buy_price: 1 } }, null);
        }
    }
    buys_ = () => this.sent.filter(r => r.buy);
}

const even = (confidence: number) => ({ family: 'digits', contract_type: 'DIGITEVEN', label: 'Even', confidence, basis: '' }) as never;

describe('recovery in the engine (martingale + recover_losses)', () => {
    const make = (cfg: Partial<TAutoPilotConfig> = {}, symbol = 'R_REC') => {
        const snapshots: TSnapshotMap = { [symbol]: { stats: {} as never, signals: [even(90)] } };
        const conn = new Conn();
        const events: string[] = [];
        const config: TAutoPilotConfig = { recovery_mode: 'martingale', recover_losses: true, stake: 1, martingale_multiplier: 2, max_steps: 4, stop_loss: 1000, take_profit: 1000, auto_flip: false, protect_trades: 0, virtual_hook: false, follow_stream: false, ...cfg };
        const engine = new AutoPilotEngine(conn as never, 'USD', config, () => snapshots, e => events.push(e.phase + (e.reason ? `:${e.reason}` : '')));
        return { conn, engine, events };
    };

    it('each loss is followed by a stake that wins the ladder back, and a win returns to the base stake', async () => {
        const h = make();
        h.engine.start();
        await wait();
        expect(h.conn.buys_().map(b => b.price)).toEqual([1]);
        h.conn.settle('c1', -1);
        await wait();
        expect(h.conn.buys_().map(b => b.price)).toEqual([1, 2.41]);
        h.conn.settle('c2', -2.41);
        await wait();
        expect(h.conn.buys_().map(b => b.price)).toEqual([1, 2.41, 5.32]); // (1 + 2.41 + 1) / 0.83
        h.conn.settle('c3', 4.5); // the recovery step wins
        await wait();
        expect(h.conn.buys_()[3].price).toBe(1);
        h.engine.stop();
    });

    it('when the ladder runs out of steps the loss is accepted and trading goes on at the base stake (no stop)', async () => {
        const h = make({ max_steps: 2 }, 'R_REC2');
        h.engine.start();
        await wait();
        h.conn.settle('c1', -1);
        await wait();
        h.conn.settle('c2', -2.41); // step 2 of 2 lost
        await wait();
        expect(h.conn.buys_().map(b => b.price)).toEqual([1, 2.41, 1]);
        expect(h.events.some(e => e.startsWith('stopped'))).toBe(false);
        h.engine.stop();
    });

    it('without recover_losses the old multiplier rule is unchanged', async () => {
        const h = make({ recover_losses: false }, 'R_REC3');
        h.engine.start();
        await wait();
        h.conn.settle('c1', -1);
        await wait();
        expect(h.conn.buys_().map(b => b.price)).toEqual([1, 2]);
        h.engine.stop();
    });
});

describe('entry reader in the engine', () => {
    it('picks the contract and market from the latest ticks, not from the signal with the highest confidence', async () => {
        const conn = new Conn();
        // A carries the 99% signal but its last digits alternate; B ends on two even digits (Even is one tick short of firing).
        conn.history.R_READA = Array.from({ length: 30 }, (_, i) => Number((100 + i * 0.1 + (i % 2 === 0 ? 0.01 : 0.02)).toFixed(2)));
        conn.history.R_READB = Array.from({ length: 30 }, (_, i) => Number((100 + i * 0.1 + (i >= 28 ? 0.04 : i % 2 === 0 ? 0.01 : 0.03)).toFixed(2)));
        const snapshots: TSnapshotMap = { R_READA: { stats: {} as never, signals: [even(99)] }, R_READB: { stats: {} as never, signals: [] } };
        const config: TAutoPilotConfig = { recovery_mode: 'flat', stake: 1, martingale_multiplier: 2, max_steps: 4, stop_loss: 1000, take_profit: 1000, auto_flip: false, protect_trades: 0, virtual_hook: false, follow_stream: false, contract_families: ['even_odd'], read_entries: true };
        const engine = new AutoPilotEngine(conn as never, 'USD', config, () => snapshots, () => undefined);
        engine.start();
        await wait(150);
        expect(conn.buys_()).toHaveLength(1);
        expect(conn.buys_()[0].parameters).toMatchObject({ contract_type: 'DIGITEVEN', underlying_symbol: 'R_READB' });
        engine.stop();
    });
});
