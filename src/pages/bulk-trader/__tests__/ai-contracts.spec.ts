import { AutoPilotEngine, buildTradeParameters, TAutoPilotConfig, TAutoPilotEvent } from '../autoPilotEngine';
import { extraSignals } from '../aiContracts';
import { markRefused } from '../contractRules';
import type { TSnapshotMap, TSymbolSnapshot } from '../analysis-types';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

const BULL = [1, 2, 3, 2, 1, 2, 3, 4, 3, 2];
const BEAR = [9, 8, 7, 8, 9, 8, 7, 6, 7, 8];
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));

const stats = (over: Partial<TSymbolSnapshot['stats']> = {}) =>
    ({ total_ticks: 200, over5_pct: 40, under5_pct: 50, equal5_pct: 10, ...over }) as TSymbolSnapshot['stats'];
const snap = (signals: TSymbolSnapshot['signals'], s = stats()): TSymbolSnapshot => ({ stats: s, signals });
const sig = (contract_type: string, extra: Record<string, unknown> = {}) =>
    ({ family: 'digits', contract_type, label: contract_type, confidence: 50, basis: '', ...extra }) as TSymbolSnapshot['signals'][number];

class FakeConnection {
    sent: any[] = [];
    subs = new Map<number, { req: any; cb: (d: any, e: Error | null) => void }>();
    private n = 1;
    private buys = 0;
    accountInfo = { balance: 1000, loginid: 'VRTC1', currency: 'USD' };
    contractsFor: any = {};
    proposalError: (req: any) => string | null = () => null;
    onFatalError: any;
    onReconnecting: any;
    onReconnect: any;
    async send(req: any) {
        this.sent.push(req);
        if (req.proposal) {
            const err = this.proposalError(req);
            if (err) throw new Error(err);
            return { proposal: { ask_price: 1, payout: 1.95 } };
        }
        if (req.buy) return { buy: { contract_id: `c${++this.buys}` } };
        if (req.ticks_history) return { history: { prices: [], times: [] } };
        if (req.contracts_for) return this.contractsFor;
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
    ticks(symbol: string, prices: number[], from = 1000) {
        prices.forEach((p, i) => {
            for (const { req, cb } of this.subs.values()) if (req.ticks === symbol) cb({ tick: { quote: p, epoch: from + i } }, null);
        });
    }
    settle(contract_id: string, profit: number) {
        for (const { req, cb } of this.subs.values()) {
            if (req.proposal_open_contract && req.contract_id === contract_id) {
                cb({ proposal_open_contract: { contract_id, is_sold: 1, profit, buy_price: 1 } }, null);
            }
        }
    }
    proposals = () => this.sent.filter(r => r.proposal);
    buys_ = () => this.sent.filter(r => r.buy);
}

const config: TAutoPilotConfig = { recovery_mode: 'reverse', stake: 1, martingale_multiplier: 2, max_steps: 5, stop_loss: 500, take_profit: 500 };

const make = (snapshots: TSnapshotMap, cfg: Partial<TAutoPilotConfig> = {}) => {
    const conn = new FakeConnection();
    const events: TAutoPilotEvent[] = [];
    const logs: string[] = [];
    const engine = new AutoPilotEngine(conn as never, 'USD', { ...config, ...cfg }, () => snapshots, e => events.push(e), undefined, {
        onLog: (_k, m) => logs.push(m),
    });
    return { conn, engine, events, logs };
};

describe('AI buy parameters for the new contracts', () => {
    const p = (type: string, extra: Record<string, unknown> = {}) =>
        buildTradeParameters({ symbol: 'R_100', ...sig(type), ...extra } as never, 2, 'USD');

    it('Over 4 / Under 5 are digit Over/Under with the barrier fixed', () => {
        expect(p('OVER4')).toMatchObject({ contract_type: 'DIGITOVER', barrier: '4', duration: 1 });
        expect(p('UNDER5')).toMatchObject({ contract_type: 'DIGITUNDER', barrier: '5', duration: 1 });
    });
    it('Higher / Lower: CALL / PUT, 5 ticks, barrier 0.1', () => {
        expect(p('HIGHER')).toMatchObject({ contract_type: 'CALL', barrier: '+0.1', duration: 5 });
        expect(p('LOWER')).toMatchObject({ contract_type: 'PUT', barrier: '-0.1', duration: 5 });
    });
    it('Touch / No Touch: barrier 0.5 and 5 ticks, 10 when overridden', () => {
        expect(p('ONETOUCH', { prediction: '+1.5' })).toMatchObject({ contract_type: 'ONETOUCH', barrier: '+0.5', duration: 5 });
        expect(p('NOTOUCH', { prediction: '-2' })).toMatchObject({ contract_type: 'NOTOUCH', barrier: '-0.5', duration: 5 });
        expect(p('ONETOUCH', { ticks_override: 10 })).toMatchObject({ barrier: '+0.5', duration: 10 });
    });
    it('Multipliers: no duration, take profit is 20% of the stake', () => {
        const up = p('MULTUP', { multiplier: 200 });
        expect(up).toMatchObject({ contract_type: 'MULTUP', multiplier: 200, limit_order: { take_profit: 0.4 } });
        expect(up.duration).toBeUndefined();
    });
});

describe('Over 4 / Under 5 signals', () => {
    it('bets the side that is printing less than 50%', () => {
        const lagging_over = extraSignals(snap([], stats({ under5_pct: 62, over5_pct: 30, equal5_pct: 8 }))).find(s => s.contract_type === 'OVER4' || s.contract_type === 'UNDER5');
        expect(lagging_over?.contract_type).toBe('OVER4');
        const lagging_under = extraSignals(snap([], stats({ under5_pct: 38, over5_pct: 52, equal5_pct: 10 }))).find(s => s.contract_type === 'OVER4' || s.contract_type === 'UNDER5');
        expect(lagging_under?.contract_type).toBe('UNDER5');
    });
    it('offers none while the sample is small or the skew is tiny', () => {
        const none = (s: TSymbolSnapshot['stats']) => extraSignals(snap([], s)).filter(x => x.contract_type === 'OVER4' || x.contract_type === 'UNDER5');
        expect(none(stats({ total_ticks: 20, under5_pct: 70, over5_pct: 20 }))).toHaveLength(0);
        expect(none(stats({ under5_pct: 50, over5_pct: 40, equal5_pct: 10 }))).toHaveLength(0);
    });
});

describe('AI switching', () => {
    it.each([
        ['DIGITEVEN', 'DIGITOVER', '4'],
        ['DIGITODD', 'DIGITUNDER', '5'],
    ])('%s loses twice in a row -> switches to its partner', async (start, partner_api, barrier) => {
        const symbol = `R_SW_${start}`;
        const { conn, engine } = make({ [symbol]: snap([sig(start)]) });
        engine.start();
        await wait();
        expect(conn.buys_()[0].parameters.contract_type).toBe(start);
        conn.settle('c1', -1);
        await wait();
        expect(conn.buys_()[1].parameters.contract_type).toBe(start); // one loss is not enough in reverse mode
        conn.settle('c2', -1);
        await wait();
        expect(conn.buys_()[2].parameters).toMatchObject({ contract_type: partner_api, barrier });
        engine.stop();
    });

    it('flip mode: every loss switches with the partner and back (Even -> Over 4 -> Even)', async () => {
        const symbol = 'R_SW_FLIP';
        const { conn, engine } = make({ [symbol]: snap([sig('DIGITEVEN')]) }, { recovery_mode: 'flip' });
        engine.start();
        await wait();
        conn.settle('c1', -1);
        await wait();
        expect(conn.buys_()[1].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '4' });
        conn.settle('c2', -1);
        await wait();
        expect(conn.buys_()[2].parameters.contract_type).toBe('DIGITEVEN');
        engine.stop();
    });

    it('a win ends the loss run: the next loss starts fresh from the new contract', async () => {
        const symbol = 'R_SW_WIN';
        const { conn, engine } = make({ [symbol]: snap([sig('DIGITEVEN')]) });
        engine.start();
        await wait();
        conn.settle('c1', -1);
        await wait();
        conn.settle('c2', 1.5); // win clears the pair
        await wait();
        conn.settle('c3', -1);
        await wait();
        conn.settle('c4', -1);
        await wait();
        expect(conn.buys_()[4].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '4' });
        engine.stop();
    });
});

describe('AI switch map (first loss in flip mode)', () => {
    // [contract it starts on, signals in the market, chart it needs, the Deriv contract + barrier it switches to]
    it.each([
        ['ONETOUCH', [sig('ONETOUCH', { family: 'touch', prediction: '+1.5' })], null, 'DIGITUNDER', '5'],
        ['NOTOUCH', [sig('NOTOUCH', { family: 'touch', prediction: '+1.5' })], null, 'DIGITOVER', '4'],
        ['CALL (Rise)', [sig('CALL', { family: 'rise_fall' })], BULL, 'DIGITUNDER', '5'],
        ['PUT (Fall)', [sig('PUT', { family: 'rise_fall' })], BEAR, 'DIGITOVER', '4'],
        ['HIGHER', [], BULL, 'DIGITUNDER', '5'],
        ['LOWER', [], BEAR, 'DIGITOVER', '4'],
    ] as const)('%s switches with its partner', async (name, signals, chart, partner_api, barrier) => {
        const symbol = `R_MAP_${name.replace(/\W/g, '')}`;
        const { conn, engine } = make({ [symbol]: snap([...signals]) }, { recovery_mode: 'flip' });
        engine.start();
        await wait();
        if (chart) {
            conn.ticks(symbol, [...chart]);
            await wait(1700);
        }
        expect(conn.buys_()).toHaveLength(1);
        conn.settle('c1', -1);
        await wait();
        expect(conn.buys_()[1].parameters).toMatchObject({ contract_type: partner_api, barrier });
        engine.stop();
    });
});

describe('AI trend gate (1-tick chart)', () => {
    it('Rise is not bought until a higher high shows, then it is', async () => {
        const symbol = 'R_T1';
        const { conn, engine } = make({ [symbol]: snap([sig('CALL', { family: 'rise_fall' })]) });
        engine.start();
        await wait();
        conn.ticks(symbol, [5, 5, 5, 5, 5, 5]);
        await wait(1700); // the engine re-scans every 1.5 s while nothing qualifies
        expect(conn.proposals()).toHaveLength(0);
        conn.ticks(symbol, BULL, 2000);
        await wait(1700);
        expect(conn.proposals()[0].contract_type).toBe('CALL');
        engine.stop();
    });

    it('Fall is refused on a bullish chart', async () => {
        const symbol = 'R_T2';
        markRefused(symbol, 'HIGHER'); // Higher is also bullish: switch it and Multiplier Up off so only Fall is in play
        markRefused(symbol, 'MULTUP');
        const { conn, engine } = make({ [symbol]: snap([sig('PUT', { family: 'rise_fall' })]) });
        engine.start();
        await wait();
        conn.ticks(symbol, BULL);
        await wait(1700);
        expect(conn.proposals()).toHaveLength(0);
        conn.ticks(symbol, BEAR, 3000);
        await wait(1700);
        expect(conn.proposals()[0].contract_type).toBe('PUT');
        engine.stop();
    });

    it('Higher buys CALL +0.1 for 5 ticks on a bullish chart; Lower buys PUT -0.1 on a bearish one', async () => {
        const up = make({ R_T3: snap([]) });
        up.engine.start();
        await wait();
        up.conn.ticks('R_T3', BULL);
        await wait(1700);
        expect(up.conn.proposals()[0]).toMatchObject({ contract_type: 'CALL', barrier: '+0.1', duration: 5 });
        up.engine.stop();

        const down = make({ R_T4: snap([]) });
        down.engine.start();
        await wait();
        down.conn.ticks('R_T4', BEAR);
        await wait(1700);
        expect(down.conn.proposals()[0]).toMatchObject({ contract_type: 'PUT', barrier: '-0.1', duration: 5 });
        down.engine.stop();
    });
});

describe('AI Touch / No Touch', () => {
    it('buys 5 ticks with a 0.5 barrier and falls back to 10 ticks if Deriv refuses 5', async () => {
        const symbol = 'R_TOUCH';
        const { conn, engine } = make({ [symbol]: snap([sig('ONETOUCH', { family: 'touch', prediction: '+1.5' })]) });
        conn.proposalError = req => (req.duration === 5 ? 'Trading is not offered for this duration.' : null);
        engine.start();
        await wait(500);
        const [first, second] = conn.proposals();
        expect(first).toMatchObject({ contract_type: 'ONETOUCH', duration: 5, barrier: '+0.5' });
        expect(second).toMatchObject({ contract_type: 'ONETOUCH', duration: 10, barrier: '+0.5' });
        expect(conn.buys_()).toHaveLength(1);
        engine.stop();
    });
});

describe('AI Multipliers', () => {
    it('buys with a 20% take profit, no duration, and sells the open position on stop', async () => {
        const symbol = 'R_MULT';
        markRefused(symbol, 'HIGHER'); // leave Multiplier Up as the only bullish trend contract
        const { conn, engine } = make({ [symbol]: snap([]) }, { stake: 5 });
        conn.contractsFor = { contracts_for: { available: [{ contract_type: 'MULTUP', multiplier_range: [40, 100, 200] }] } };
        engine.start();
        await wait();
        conn.ticks(symbol, BULL);
        await wait(1700);
        const proposal = conn.proposals()[0];
        expect(proposal).toMatchObject({ contract_type: 'MULTUP', multiplier: 100, limit_order: { take_profit: 1 } });
        expect(proposal.duration).toBeUndefined();
        expect(conn.buys_()).toHaveLength(1);
        engine.stop();
        expect(conn.sent.some(r => r.sell === 'c1')).toBe(true);
    });

    it('does not sell a multiplier that already closed at its take profit', async () => {
        const symbol = 'R_MULT2';
        markRefused(symbol, 'HIGHER');
        const { conn, engine } = make({ [symbol]: snap([]) });
        engine.start();
        await wait();
        conn.ticks(symbol, BULL);
        await wait(1700);
        conn.settle('c1', 0.2);
        await wait();
        engine.stop();
        // The engine moved on to a new multiplier (c2); the one that hit its take profit (c1) is never sold.
        expect(conn.sent.filter(r => r.sell === 'c1')).toHaveLength(0);
    });
});
