import { StrategyEngine } from '../strategyEngineClient';
import { TStrategyConfig } from '../types';

jest.mock('../tradeBus', () => ({ tradeBus: { log: jest.fn(), contract: jest.fn() } }));
jest.mock('uuid', () => ({ v4: () => 'test-id' }));

const cooldown = () => new Promise(r => setTimeout(r, 330)); // fast_execution pauses 250 ms between rounds
const flush = async (n = 8) => {
    for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0));
};

class FakeConnection {
    sent: any[] = [];
    buyAt: number[] = [];
    subs = new Map<number, { req: any; cb: (d: any, e: Error | null) => void }>();
    private next = 1;
    private buys = 0;
    accountInfo = { balance: 1000 };
    buyError: (req: any) => string | null = () => null;
    async send(req: any) {
        this.sent.push(req);
        if (req.buy) {
            this.buyAt.push(Number(process.hrtime.bigint() / 1000n)); // microseconds
            const err = this.buyError(req);
            if (err) throw new Error(err);
            this.buys += 1;
            return { buy: { contract_id: `c${this.buys}` } };
        }
        if (req.ticks_history) return { history: { prices: [], times: [] } };
        return {};
    }
    subscribe(req: any, cb: (d: any, e: Error | null) => void) {
        const id = this.next++;
        this.subs.set(id, { req, cb });
        return id;
    }
    async unsubscribe(id: number) {
        this.subs.delete(id);
    }
    settle(contract_id: string, profit: number) {
        for (const { req, cb } of this.subs.values()) {
            if (req.proposal_open_contract && req.contract_id === contract_id) cb({ proposal_open_contract: { contract_id, is_sold: 1, profit } }, null);
        }
    }
    buysSent = () => this.sent.filter(r => r.buy);
}

let n = 0;
const basket = (extra: Partial<TStrategyConfig> = {}) => {
    const conn = new FakeConnection();
    const sync_group = `g${++n}`;
    const base: TStrategyConfig = {
        client_id: 'x',
        label: 'T',
        symbol: '1HZ100V',
        contract_type: 'RUNHIGH',
        prediction: 5,
        stake: 1,
        duration_ticks: 1,
        money_management: 'flat',
        multiplier: 2,
        auto_flip: true, // must be ignored for a basket
        fast_execution: true,
        max_trades: 50,
        sync_group,
        ...extra,
    };
    const ups = new StrategyEngine(conn as never, { ...base, contract_type: 'RUNHIGH', label: 'Only Ups' }, 'USD');
    const downs = new StrategyEngine(conn as never, { ...base, contract_type: 'RUNLOW', label: 'Only Downs' }, 'USD');
    return { conn, ups, downs };
};

describe('Only Ups + Only Downs basket (Bulk Trades)', () => {
    it('fires both contracts together, 2 ticks, with no trend wait at all', async () => {
        const { conn, ups, downs } = basket();
        ups.start();
        downs.start();
        await flush();
        const buys = conn.buysSent();
        expect(buys).toHaveLength(2);
        expect(buys.map(b => b.parameters.contract_type).sort()).toEqual(['RUNHIGH', 'RUNLOW']);
        expect(buys[0].parameters).toMatchObject({ duration: 2, duration_unit: 't', underlying_symbol: '1HZ100V' });
        expect(buys[1].parameters).toMatchObject({ duration: 2, duration_unit: 't', underlying_symbol: '1HZ100V' });
        expect(Math.abs(conn.buyAt[1] - conn.buyAt[0])).toBeLessThan(5000); // within 5 ms: the same instant
        expect(conn.sent.filter(r => r.ticks_history)).toHaveLength(0); // never read the chart for a direction
        ups.stop();
        downs.stop();
    });

    it('never trades one leg alone: it waits until the other leg is ready', async () => {
        const { conn, ups, downs } = basket();
        ups.start();
        await flush();
        expect(conn.buysSent()).toHaveLength(0);
        downs.start();
        await flush();
        expect(conn.buysSent()).toHaveLength(2);
        ups.stop();
        downs.stop();
    });

    it('next round is also together, and Auto Flip is ignored (each leg keeps its own contract)', async () => {
        const { conn, ups, downs } = basket({ auto_flip: true });
        ups.start();
        downs.start();
        await flush();
        conn.settle('c1', -1);
        conn.settle('c2', 0.8);
        await cooldown();
        await flush();
        const buys = conn.buysSent();
        expect(buys).toHaveLength(4);
        expect(buys.slice(2).map(b => b.parameters.contract_type).sort()).toEqual(['RUNHIGH', 'RUNLOW']);
        ups.stop();
        downs.stop();
    });

    it('stop loss is judged on the two legs together', async () => {
        const { conn, ups, downs } = basket({ stop_loss: 1.5 });
        ups.start();
        downs.start();
        await flush();
        conn.settle('c1', -1);
        conn.settle('c2', 0.8); // net -0.2: well inside the 1.5 stop loss, so the basket keeps going
        await cooldown();
        await flush();
        expect(conn.buysSent()).toHaveLength(4);
        conn.settle('c3', -1);
        conn.settle('c4', -1); // net -2.2: past the stop loss
        await cooldown();
        await flush();
        expect(conn.buysSent()).toHaveLength(4); // no third round
        expect(ups.status).toBe('stopped');
        expect(downs.status).toBe('stopped');
        expect(ups.stop_reason).toBe('stop loss reached');
    });

    it('take profit is judged on the two legs together too', async () => {
        const { conn, ups, downs } = basket({ take_profit: 5 });
        ups.start();
        downs.start();
        await flush();
        conn.settle('c1', 9); // one leg pays out
        conn.settle('c2', -1);
        await cooldown();
        await flush();
        expect(conn.buysSent()).toHaveLength(2);
        expect(ups.status).toBe('stopped');
        expect(downs.status).toBe('stopped');
    });

    it('if one buy is refused, the other leg finishes its open contract (still tracked) and then the basket stops', async () => {
        const { conn, ups, downs } = basket();
        conn.buyError = req => (req.parameters.contract_type === 'RUNHIGH' ? 'Only Ups is not offered' : null);
        ups.start();
        downs.start();
        await flush();
        expect(ups.status).toBe('error');
        expect(downs.status).toBe('running'); // its contract is open: it is still being watched
        conn.settle('c1', -1);
        await flush();
        expect(downs.status).toBe('stopped');
        expect(conn.buysSent()).toHaveLength(2); // nothing bought after that
    });

    it('a plain single strategy (no basket) still waits for its trend, as before', async () => {
        const conn = new FakeConnection();
        const engine = new StrategyEngine(
            conn as never,
            { client_id: 'x', label: 'T', symbol: 'R_100', contract_type: 'RUNHIGH', prediction: 5, stake: 1, duration_ticks: 1, money_management: 'flat', multiplier: 2, auto_flip: false, fast_execution: true, max_trades: 5 },
            'USD'
        );
        engine.start();
        await flush();
        expect(conn.buysSent()).toHaveLength(0);
        engine.stop();
    });
});
