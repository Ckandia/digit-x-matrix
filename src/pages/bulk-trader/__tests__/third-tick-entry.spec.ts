import { AutoPilotEngine, tickAgrees, trailingRun, TAutoPilotConfig } from '../autoPilotEngine';
import type { TSnapshotMap } from '../analysis-types';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const px = (d: number) => 100 + d / 100; // pip 2: last digit = d

class Conn {
    sent: any[] = [];
    subs = new Map<number, { req: any; cb: any }>();
    history: number[] = [];
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
        if (req.ticks_history) return { history: { prices: this.history, times: [] }, pip_size: 2 };
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
    tick(symbol: string, digit: number) {
        for (const { req, cb } of [...this.subs.values()]) if (req.ticks === symbol) cb({ tick: { quote: px(digit), pip_size: 2 } }, null);
    }
    buys_ = () => this.sent.filter(r => r.buy);
}

const make = (signal: string, cfg: Partial<TAutoPilotConfig> = {}, seed: number[] = []) => {
    const snapshots: TSnapshotMap = { R_T3: { stats: {} as never, signals: [{ family: 'digits', contract_type: signal, label: signal, confidence: 80, basis: '' } as never] } };
    const conn = new Conn();
    conn.history = seed.map(px);
    const config: TAutoPilotConfig = { recovery_mode: 'flat', stake: 1, martingale_multiplier: 1.2, max_steps: 5, stop_loss: 10000, take_profit: 10000, auto_flip: false, protect_trades: 0, virtual_hook: false, follow_stream: true, entry_tick: 3, ...cfg };
    const engine = new AutoPilotEngine(conn as never, 'USD', config, () => snapshots, () => undefined);
    return { conn, engine };
};

describe('tick helpers', () => {
    it('tickAgrees tests one tick', () => {
        expect(tickAgrees('DIGITEVEN', undefined, px(6), undefined, 2)).toBe(true);
        expect(tickAgrees('DIGITOVER', 4, px(4), undefined, 2)).toBe(false);
        expect(tickAgrees('CALL', undefined, 101, 100, 2)).toBe(true);
        expect(tickAgrees('ONETOUCH', undefined, 1, 1, 2)).toBeNull();
    });
    it('trailingRun counts the matching ticks at the end', () => {
        expect(trailingRun('DIGITEVEN', undefined, [5, 7, 8, 9, 2, 4, 6].map(px), 2)).toBe(3);
        expect(trailingRun('DIGITOVER', 4, [5, 7, 8].map(px), 2)).toBe(3);
        expect(trailingRun('DIGITOVER', 4, [5, 7, 8, 9].map(px), 2)).toBe(4);
    });
});

describe('two-tick entry: buy on the third matching tick', () => {
    it('Even: 5,7,8,9,2,4,6 buys Even exactly on the 6, not before', async () => {
        const h = make('DIGITEVEN');
        h.engine.start();
        await wait();
        for (const d of [5, 7, 8, 9, 2, 4]) {
            h.conn.tick('R_T3', d);
            await wait(5);
        }
        expect(h.conn.buys_()).toHaveLength(0); // 8 and 2,4 are runs of 1 and 2: no buy yet
        h.conn.tick('R_T3', 6);
        await wait();
        expect(h.conn.buys_()).toHaveLength(1);
        expect(h.conn.buys_()[0].parameters.contract_type).toBe('DIGITEVEN');
        h.engine.stop();
    });

    it('Over 4: 5,7,8 buys on the 8', async () => {
        const h = make('DIGITOVER');
        h.engine.start();
        await wait();
        h.conn.tick('R_T3', 5);
        await wait(5);
        h.conn.tick('R_T3', 7);
        await wait(5);
        expect(h.conn.buys_()).toHaveLength(0);
        h.conn.tick('R_T3', 8);
        await wait();
        expect(h.conn.buys_()).toHaveLength(1);
        expect(h.conn.buys_()[0].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '4' });
        h.engine.stop();
    });

    it('never buys on the 4th or 5th tick of a run that was already past the third', async () => {
        const h = make('DIGITOVER', {}, [5, 6, 7, 8]); // a run of 4 is already under way
        h.engine.start();
        await wait();
        h.conn.tick('R_T3', 9); // 5th
        await wait(10);
        h.conn.tick('R_T3', 6); // 6th
        await wait(10);
        expect(h.conn.buys_()).toHaveLength(0);
        h.conn.tick('R_T3', 2); // run broken
        h.conn.tick('R_T3', 5);
        h.conn.tick('R_T3', 9);
        await wait(10);
        expect(h.conn.buys_()).toHaveLength(0); // a new run is only 2 long
        h.conn.tick('R_T3', 7); // third of the new run
        await wait();
        expect(h.conn.buys_()).toHaveLength(1);
        h.engine.stop();
    });

    it('uses setup ticks that printed before the wait began (history seeds the run)', async () => {
        const h = make('DIGITEVEN', {}, [3, 4, 8]); // two evens already in
        h.engine.start();
        await wait();
        expect(h.conn.buys_()).toHaveLength(0);
        h.conn.tick('R_T3', 2); // third even
        await wait();
        expect(h.conn.buys_()).toHaveLength(1);
        h.engine.stop();
    });

    it('a non-matching third tick buys nothing', async () => {
        const h = make('DIGITEVEN');
        h.engine.start();
        await wait();
        for (const d of [2, 4, 7]) {
            h.conn.tick('R_T3', d);
            await wait(5);
        }
        await wait();
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });
});
