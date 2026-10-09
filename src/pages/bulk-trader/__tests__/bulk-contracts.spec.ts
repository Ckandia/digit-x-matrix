import { nextAfterLoss, pickMultiplier, relativeBarrier, SPECS, SWITCH_PARTNER, tickCandidates } from '../contractSpecs';
import { StrategyEngine } from '../strategyEngineClient';
import { detectTrend } from '../trendFilter';
import { TBulkContractType, TStrategyConfig } from '../types';

jest.mock('../tradeBus', () => ({ tradeBus: { log: jest.fn(), contract: jest.fn() } }));
jest.mock('uuid', () => ({ v4: () => 'test-id' }));

const cooldown = () => new Promise(r => setTimeout(r, 300)); // the engine pauses 250 ms between trades
const flush = async (n = 6) => {
    for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0));
};

class FakeConnection {
    sent: any[] = [];
    subs = new Map<number, { req: any; cb: (d: any, e: Error | null) => void }>();
    private next = 1;
    private buys = 0;
    accountInfo = { balance: 1000 };
    contractsFor: any = {};
    buyError: (req: any) => string | null = () => null;

    async send(req: any) {
        this.sent.push(req);
        if (req.buy) {
            const err = this.buyError(req);
            if (err) throw new Error(err);
            this.buys += 1;
            return { buy: { contract_id: `c${this.buys}` } };
        }
        if (req.ticks_history) return { history: { prices: [], times: [] } };
        if (req.contracts_for) return this.contractsFor;
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
    tick(quote: number, epoch: number) {
        for (const { req, cb } of this.subs.values()) if (req.ticks) cb({ tick: { quote, epoch } }, null);
    }
    settle(contract_id: string, profit: number) {
        for (const { req, cb } of this.subs.values()) {
            if (req.proposal_open_contract && req.contract_id === contract_id) {
                cb({ proposal_open_contract: { contract_id, is_sold: 1, profit } }, null);
            }
        }
    }
    buysSent = () => this.sent.filter(r => r.buy);
}

const make = (contract_type: TBulkContractType, extra: Partial<TStrategyConfig> = {}) => {
    const conn = new FakeConnection();
    const config: TStrategyConfig = {
        client_id: 'x',
        label: 'T',
        symbol: 'R_100',
        contract_type,
        prediction: 5,
        stake: 1,
        duration_ticks: 1,
        money_management: 'flat',
        multiplier: 2,
        auto_flip: false,
        fast_execution: true,
        max_trades: 50,
        ...extra,
    };
    const engine = new StrategyEngine(conn as never, config, 'USD');
    return { conn, engine };
};

// Bullish: two rising swing highs, one swing low. Bearish is the mirror image.
const BULL = [1, 2, 3, 2, 1, 2, 3, 4, 3, 2];
const BEAR = [9, 8, 7, 8, 9, 8, 7, 6, 7, 8];
const feed = (conn: FakeConnection, prices: number[], from = 1000) => prices.forEach((p, i) => conn.tick(p, from + i));

describe('switch map', () => {
    it.each([
        ['DIGITEVEN', 'OVER4'],
        ['DIGITODD', 'UNDER5'],
        ['ONETOUCH', 'UNDER5'],
        ['NOTOUCH', 'OVER4'],
        ['CALL', 'UNDER5'],
        ['PUT', 'OVER4'],
        ['HIGHER', 'UNDER5'],
        ['LOWER', 'OVER4'],
    ] as const)('%s switches with %s and back', (start, partner) => {
        expect(SWITCH_PARTNER[start]).toBe(partner);
        expect(nextAfterLoss(start, start)).toBe(partner);
        expect(nextAfterLoss(start, partner)).toBe(start);
    });
});

describe('contract specs', () => {
    it('Over 4 / Under 5 are digit Over/Under with a fixed barrier', () => {
        expect(SPECS.OVER4).toMatchObject({ api_type: 'DIGITOVER', barrier_digit: 4 });
        expect(SPECS.UNDER5).toMatchObject({ api_type: 'DIGITUNDER', barrier_digit: 5 });
    });
    it('Higher/Lower use 5 ticks and a 0.1 barrier; Touch/No Touch try 5 then 10 ticks with 0.5', () => {
        expect(tickCandidates(SPECS.HIGHER, 1)).toEqual([5]);
        expect(relativeBarrier(SPECS.HIGHER)).toBe('+0.1');
        expect(relativeBarrier(SPECS.LOWER)).toBe('-0.1');
        expect(tickCandidates(SPECS.ONETOUCH, 1)).toEqual([5, 10]);
        expect(relativeBarrier(SPECS.NOTOUCH)).toBe('+0.5');
    });
    it('Rise/Fall, Higher/Lower, Only Ups/Downs and Multipliers are trend contracts; the rest are not', () => {
        const trend = Object.values(SPECS).filter(s => s.trend).map(s => s.key).sort();
        expect(trend).toEqual(['CALL', 'HIGHER', 'LOWER', 'MULTDOWN', 'MULTUP', 'PUT', 'RUNHIGH', 'RUNLOW']);
    });
    it('picks the multiplier closest to 100x from contracts_for', () => {
        const reply = { contracts_for: { available: [{ contract_type: 'MULTUP', multiplier_range: [40, 200, 500] }] } };
        expect(pickMultiplier(reply)).toBe(40);
        expect(pickMultiplier({ contracts_for: { available: [] } })).toBeUndefined();
    });
});

describe('trend detection (1-tick chart)', () => {
    it('bullish on a higher high, bearish on a lower low, none otherwise', () => {
        expect(detectTrend(BULL)).toBe('bullish');
        expect(detectTrend(BEAR)).toBe('bearish');
        expect(detectTrend([5, 5, 5, 5, 5, 5, 5, 5])).toBe('none');
        expect(detectTrend([1, 2])).toBe('none');
    });
});

describe('StrategyEngine', () => {
    it('buys Over 4 and Under 5 as digit Over/Under with the right barrier', async () => {
        for (const [key, type, barrier] of [['OVER4', 'DIGITOVER', '4'], ['UNDER5', 'DIGITUNDER', '5']] as const) {
            const { conn, engine } = make(key);
            engine.start();
            await flush();
            expect(conn.buysSent()[0].parameters).toMatchObject({ contract_type: type, barrier, duration: 1, duration_unit: 't' });
            engine.stop();
        }
    });

    it('Auto Flip: Even loses -> Over 4 -> loses -> back to Even', async () => {
        const { conn, engine } = make('DIGITEVEN', { auto_flip: true });
        engine.start();
        await flush();
        conn.settle('c1', -1);
        await cooldown();
        expect(conn.buysSent()[1].parameters.contract_type).toBe('DIGITOVER');
        expect(conn.buysSent()[1].parameters.barrier).toBe('4');
        conn.settle('c2', -1);
        await cooldown();
        expect(conn.buysSent()[2].parameters.contract_type).toBe('DIGITEVEN');
        engine.stop();
    });

    it('Higher waits for a higher-high, then buys CALL +0.1 for 5 ticks', async () => {
        const { conn, engine } = make('HIGHER');
        engine.start();
        await flush();
        feed(conn, [5, 5, 5, 5, 5, 5]);
        await flush();
        expect(conn.buysSent()).toHaveLength(0); // no trend yet
        feed(conn, BULL, 2000);
        await flush();
        expect(conn.buysSent()[0].parameters).toMatchObject({ contract_type: 'CALL', barrier: '+0.1', duration: 5 });
        engine.stop();
    });

    it('Fall waits for a lower-low, and does not buy into a bullish chart', async () => {
        const { conn, engine } = make('PUT');
        engine.start();
        await flush();
        feed(conn, BULL);
        await flush();
        expect(conn.buysSent()).toHaveLength(0);
        feed(conn, BEAR, 3000);
        await flush();
        expect(conn.buysSent()[0].parameters.contract_type).toBe('PUT');
        engine.stop();
    });

    it('Lower buys PUT -0.1 for 5 ticks once bearish', async () => {
        const { conn, engine } = make('LOWER');
        engine.start();
        await flush();
        feed(conn, BEAR);
        await flush();
        expect(conn.buysSent()[0].parameters).toMatchObject({ contract_type: 'PUT', barrier: '-0.1', duration: 5 });
        engine.stop();
    });

    it('Touch goes 5 ticks / +0.5 first and falls back to 10 ticks if Deriv refuses 5', async () => {
        const { conn, engine } = make('ONETOUCH');
        conn.buyError = req => (req.parameters.duration === 5 ? 'Trading is not offered for this duration.' : null);
        engine.start();
        await flush();
        const buys = conn.buysSent();
        expect(buys[0].parameters).toMatchObject({ contract_type: 'ONETOUCH', duration: 5, barrier: '+0.5' });
        expect(buys[1].parameters).toMatchObject({ contract_type: 'ONETOUCH', duration: 10, barrier: '+0.5' });
        expect(engine.status).toBe('running');
        engine.stop();
    });

    it('a non-duration error (e.g. low balance) is not retried', async () => {
        const { conn, engine } = make('NOTOUCH');
        conn.buyError = () => 'Insufficient balance.';
        engine.start();
        await flush();
        expect(conn.buysSent()).toHaveLength(1);
        expect(engine.status).toBe('error');
    });

    it('Multiplier Up waits for bullish, sets take profit at 20% of stake, and is sold on stop', async () => {
        const { conn, engine } = make('MULTUP', { stake: 5 });
        conn.contractsFor = { contracts_for: { available: [{ contract_type: 'MULTUP', multiplier_range: [40, 100, 200] }] } };
        engine.start();
        await flush();
        feed(conn, BULL);
        await flush();
        const p = conn.buysSent()[0].parameters;
        expect(p).toMatchObject({ contract_type: 'MULTUP', multiplier: 100, limit_order: { take_profit: 1 } });
        expect(p.duration).toBeUndefined();
        engine.stop();
        expect(conn.sent.some(r => r.sell === 'c1')).toBe(true);
    });

    it('Multiplier Down follows a lower-low and uses an explicit multiplier when given', async () => {
        const { conn, engine } = make('MULTDOWN', { stake: 2, mult_value: 200 });
        engine.start();
        await flush();
        feed(conn, BEAR);
        await flush();
        expect(conn.buysSent()[0].parameters).toMatchObject({ contract_type: 'MULTDOWN', multiplier: 200, limit_order: { take_profit: 0.4 } });
        engine.stop();
    });

    it('a settled multiplier is not sold again on stop', async () => {
        const { conn, engine } = make('MULTUP');
        engine.start();
        await flush();
        feed(conn, BULL);
        await flush();
        conn.settle('c1', 0.2);
        await flush();
        engine.stop();
        expect(conn.sent.some(r => r.sell)).toBe(false);
    });
});

describe('Only Ups / Only Downs on the Bulk Trader tab', () => {
    it('are listed, run 2-5 ticks with no barrier, need a trend, and switch with each other', () => {
        expect(SPECS.RUNHIGH).toMatchObject({ api_type: 'RUNHIGH', label: 'Only Ups', trend: 'bullish' });
        expect(SPECS.RUNLOW).toMatchObject({ api_type: 'RUNLOW', label: 'Only Downs', trend: 'bearish' });
        expect(tickCandidates(SPECS.RUNHIGH, 1)).toEqual([2, 3, 4, 5]);
        expect(SWITCH_PARTNER.RUNHIGH).toBe('RUNLOW');
        expect(nextAfterLoss('RUNHIGH', 'RUNHIGH')).toBe('RUNLOW');
    });
});
