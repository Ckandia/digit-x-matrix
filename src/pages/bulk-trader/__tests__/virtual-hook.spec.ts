import { AutoPilotEngine, paperOutcome, TAutoPilotConfig, TAutoPilotEvent } from '../autoPilotEngine';
import { LearningEngine } from '../learningEngine';
import type { TSnapshotMap } from '../analysis-types';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

const wait = (ms = 25) => new Promise(r => setTimeout(r, ms));

class FakeConnection {
    sent: any[] = [];
    subs = new Map<number, { req: any; cb: (d: any, e: Error | null) => void }>();
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
        if (req.ticks_history) return { history: { prices: [], times: [] } };
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
    /** Three ticks make one paper trade: one before the virtual buy, the entry, and the exit whose last digit decides it. */
    paper(symbol: string, exit: number) {
        [100.0, 100.0, exit].forEach(quote => {
            for (const { req, cb } of [...this.subs.values()]) if (req.ticks === symbol) cb({ tick: { quote, pip_size: 2 } }, null);
        });
    }
    /** Feeds an exact list of ticks (for the multi-tick Only Ups / Only Downs paper trades). */
    ticks(symbol: string, quotes: number[]) {
        quotes.forEach(quote => {
            for (const { req, cb } of [...this.subs.values()]) if (req.ticks === symbol) cb({ tick: { quote, pip_size: 2 } }, null);
        });
    }
    settle(contract_id: string, profit: number) {
        for (const { req, cb } of this.subs.values()) {
            if (req.proposal_open_contract && req.contract_id === contract_id) {
                cb({ proposal_open_contract: { contract_id, is_sold: 1, profit, buy_price: 1 } }, null);
            }
        }
    }
    buys_ = () => this.sent.filter(r => r.buy);
}

const OVER_WIN = 100.08; // last digit 8: Over 4 wins, Even wins
const OVER_LOSS = 100.03; // last digit 3: Over 4 loses, Even loses
const EVEN_WIN = 100.02; // last digit 2: Even wins

const sig = (contract_type: string) => ({ family: 'digits', contract_type, label: contract_type, confidence: 50, basis: '' }) as never;

const make = (cfg: Partial<TAutoPilotConfig> = {}, learner?: LearningEngine, symbol = 'R_VH', signal = 'DIGITEVEN') => {
    const snapshots: TSnapshotMap = { [symbol]: { stats: {} as never, signals: [sig(signal)] } };
    const conn = new FakeConnection();
    const events: TAutoPilotEvent[] = [];
    const config: TAutoPilotConfig = {
        recovery_mode: 'flat',
        stake: 1,
        martingale_multiplier: 1.2,
        max_steps: 5,
        stop_loss: 10000,
        take_profit: 10000,
        auto_flip: true,
        protect_trades: 0,
        virtual_hook: true,
        virtual_mode: 'confirm', // the two-wins rule is suspended by default; these older tests still exercise it explicitly
        ...cfg,
    };
    const engine = new AutoPilotEngine(conn as never, 'USD', config, () => snapshots, e => events.push(e), learner);
    return { conn, engine, events, symbol };
};

/** Starts the engine and loses the first real trade, so the hook takes over. */
const loseFirstTrade = async (h: ReturnType<typeof make>) => {
    h.engine.start();
    await wait();
    expect(h.conn.buys_()).toHaveLength(1);
    expect(h.conn.buys_()[0].parameters.contract_type).toBe('DIGITEVEN');
    h.conn.settle('c1', -1);
    await wait();
};

const virtualEvents = (h: ReturnType<typeof make>, state: string) => h.events.filter(e => e.phase === 'virtual' && e.virtual_state === state);

describe('virtual hook: paper wins in a row before going live', () => {
    it('pauses real trading after a loss and asks for two paper wins by default', async () => {
        const h = make();
        await loseFirstTrade(h);
        const start = virtualEvents(h, 'start')[0];
        expect(start).toMatchObject({ virtual_needed: 2, virtual_wins: 0, contract_type: 'DIGITOVER' }); // Even lost -> Over 4 is tested
        expect(h.conn.buys_()).toHaveLength(1); // nothing real while paper trading
        h.engine.stop();
    });

    it('one paper win is not enough: it needs the second one, then trades THAT contract for real', async () => {
        const h = make();
        await loseFirstTrade(h);
        h.conn.paper(h.symbol, OVER_WIN);
        await wait();
        expect(h.conn.buys_()).toHaveLength(1); // 1 of 2: still paper
        expect(virtualEvents(h, 'result').pop()).toMatchObject({ result: 'win', virtual_wins: 1, virtual_needed: 2 });
        h.conn.paper(h.symbol, OVER_WIN);
        await wait();
        expect(h.conn.buys_()).toHaveLength(2);
        // the contract that passed twice (Over 4) on the same market is the one bought, not a fresh pick (Even)
        expect(h.conn.buys_()[1].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '4', underlying_symbol: h.symbol });
        expect(virtualEvents(h, 'end')).toHaveLength(1);
        h.engine.stop();
    });

    it('a paper loss restarts the count and moves to the next contract, which must pass twice itself', async () => {
        const h = make();
        await loseFirstTrade(h);
        h.conn.paper(h.symbol, OVER_WIN); // Over 4: win (1/2)
        await wait();
        h.conn.paper(h.symbol, OVER_LOSS); // Over 4: loss -> back to 0, switch to Even
        await wait();
        const result = virtualEvents(h, 'result').pop();
        expect(result).toMatchObject({ result: 'loss', virtual_wins: 0, virtual_losses: 1 });
        expect(virtualEvents(h, 'paper').pop()).toMatchObject({ contract_type: 'DIGITEVEN', virtual_wins: 0 });
        h.conn.paper(h.symbol, EVEN_WIN); // Even: 1/2
        await wait();
        expect(h.conn.buys_()).toHaveLength(1);
        h.conn.paper(h.symbol, EVEN_WIN); // Even: 2/2 -> live
        await wait();
        expect(h.conn.buys_()).toHaveLength(2);
        expect(h.conn.buys_()[1].parameters.contract_type).toBe('DIGITEVEN');
        h.engine.stop();
    });

    it('the number of confirmations is configurable (1 = the old one-win behaviour, 3 = three)', async () => {
        const one = make({ virtual_confirmations: 1 }, undefined, 'R_VH1');
        await loseFirstTrade(one);
        one.conn.paper(one.symbol, OVER_WIN);
        await wait();
        expect(one.conn.buys_()).toHaveLength(2);
        one.engine.stop();

        const three = make({ virtual_confirmations: 3 }, undefined, 'R_VH3');
        await loseFirstTrade(three);
        for (let i = 0; i < 2; i++) {
            three.conn.paper(three.symbol, OVER_WIN);
            await wait();
        }
        expect(three.conn.buys_()).toHaveLength(1);
        three.conn.paper(three.symbol, OVER_WIN);
        await wait();
        expect(three.conn.buys_()).toHaveLength(2);
        three.engine.stop();
    });

    it('the live trade goes in at the stake it would have used, and a live loss pauses again', async () => {
        const h = make({ recovery_mode: 'martingale', martingale_multiplier: 2, stake: 1 }, undefined, 'R_VHS');
        await loseFirstTrade(h);
        for (let i = 0; i < 2; i++) {
            h.conn.paper(h.symbol, OVER_WIN);
            await wait();
        }
        expect(h.conn.buys_()[1].price).toBe(2); // 1 x 2, as if there had been no pause
        h.conn.settle('c2', -2);
        await wait();
        expect(virtualEvents(h, 'start')).toHaveLength(2); // lose again -> the hook pauses again
        expect(h.conn.buys_()).toHaveLength(2);
        h.engine.stop();
    });

    it('does nothing when the virtual hook is switched off', async () => {
        const h = make({ virtual_hook: false }, undefined, 'R_VHOFF');
        await loseFirstTrade(h);
        expect(virtualEvents(h, 'start')).toHaveLength(0);
        expect(h.conn.buys_()).toHaveLength(2);
        h.engine.stop();
    });
});

describe('virtual hook: the AI learns from its paper trades', () => {
    beforeEach(() => localStorage.clear());

    it('gives every paper result to the learner, per contract, and keeps it between sessions', async () => {
        const learner = new LearningEngine('virt-test', 'off');
        const h = make({}, learner, 'R_VHL');
        await loseFirstTrade(h);
        h.conn.paper(h.symbol, OVER_WIN);
        await wait();
        h.conn.paper(h.symbol, OVER_LOSS);
        await wait();
        expect(learner.virtualEvidence()).toEqual({ DIGITOVER: { wins: 1, losses: 1 } });
        h.engine.stop();
        expect(new LearningEngine('virt-test', 'off').virtualEvidence()).toEqual({ DIGITOVER: { wins: 1, losses: 1 } });
    });

    it('ignores Touch / No Touch (their payout swings with the barrier, so a win rate says nothing)', () => {
        const learner = new LearningEngine('virt-test-2', 'off');
        learner.recordVirtual('ONETOUCH', true);
        learner.recordVirtual('NOTOUCH', false);
        expect(learner.virtualEvidence()).toEqual({});
    });
});


describe('virtual hook: opposite mode (a paper loss buys the opposite for real)', () => {
    const lastBuyType = (h: ReturnType<typeof make>) => h.conn.buys_()[h.conn.buys_().length - 1].parameters.contract_type;

    it('a paper loss buys the opposite of the paper contract for real, on the same market', async () => {
        const h = make({ virtual_mode: 'opposite' });
        await loseFirstTrade(h); // Even lost -> Over 4 is paper-traded
        expect(h.conn.buys_()).toHaveLength(1);
        h.conn.paper(h.symbol, OVER_LOSS); // paper Over 4 loses -> buy Under 5 live
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(2);
        expect(lastBuyType(h)).toBe('DIGITUNDER');
        expect(h.conn.buys_()[1].parameters.underlying_symbol).toBe(h.symbol);
        h.engine.stop();
    });

    it('paper wins do not go live: it keeps paper trading until one loses', async () => {
        const h = make({ virtual_mode: 'opposite' });
        await loseFirstTrade(h);
        h.conn.paper(h.symbol, OVER_WIN);
        await wait(60);
        h.conn.paper(h.symbol, OVER_WIN);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        h.conn.paper(h.symbol, OVER_LOSS);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(2);
        expect(lastBuyType(h)).toBe('DIGITUNDER');
        h.engine.stop();
    });

    it('and so on: a loss on the opposite trade starts the hook again', async () => {
        const h = make({ virtual_mode: 'opposite' });
        await loseFirstTrade(h);
        h.conn.paper(h.symbol, OVER_LOSS);
        await wait(60);
        h.conn.settle('c2', -1); // the opposite lost for real
        await wait(60);
        expect(virtualEvents(h, 'start').length).toBeGreaterThanOrEqual(2);
        expect(h.conn.buys_()).toHaveLength(2); // paused again, nothing new bought
        h.engine.stop();
    });
});


describe('virtual hook: the unified rules (the default)', () => {
    const lastBuy = (h: ReturnType<typeof make>) => h.conn.buys_()[h.conn.buys_().length - 1].parameters;
    const startOnPaper = async (h: ReturnType<typeof make>) => {
        h.engine.start();
        await wait(60);
    };
    const hookMake = (cfg: Partial<TAutoPilotConfig> = {}, symbol = 'R_UH', signal = 'DIGITEVEN') =>
        make({ virtual_mode: undefined, ...cfg }, undefined, symbol, signal);

    it('is the default and the run STARTS on paper: no real trade until the hook decides', async () => {
        const h = hookMake();
        await startOnPaper(h);
        expect(h.conn.buys_()).toHaveLength(0);
        expect(virtualEvents(h, 'start')).toHaveLength(1);
        expect(virtualEvents(h, 'start')[0]).toMatchObject({ contract_type: 'DIGITEVEN', virtual_needed: 2 });
        h.engine.stop();
    });

    it('rule 1: a paper loss buys the OPPOSITE contract live on the same market (Even lost -> Odd)', async () => {
        const h = hookMake({}, 'R_UH1');
        await startOnPaper(h);
        h.conn.paper(h.symbol, OVER_LOSS); // last digit 3: Even loses on paper
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        expect(lastBuy(h)).toMatchObject({ contract_type: 'DIGITODD', underlying_symbol: h.symbol });
        h.engine.stop();
    });

    it('rule 2: two paper wins in a row buy the SAME contract live, one is not enough', async () => {
        const h = hookMake({}, 'R_UH2');
        await startOnPaper(h);
        h.conn.paper(h.symbol, EVEN_WIN);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(0); // 1 of 2: still paper
        h.conn.paper(h.symbol, EVEN_WIN);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        expect(lastBuy(h)).toMatchObject({ contract_type: 'DIGITEVEN', underlying_symbol: h.symbol });
        h.engine.stop();
    });

    it('a paper loss after one paper win still buys the opposite (the win count does not carry on)', async () => {
        const h = hookMake({}, 'R_UH3');
        await startOnPaper(h);
        h.conn.paper(h.symbol, EVEN_WIN);
        await wait(60);
        h.conn.paper(h.symbol, OVER_LOSS);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        expect(lastBuy(h).contract_type).toBe('DIGITODD');
        h.engine.stop();
    });

    it('rule 3: a live loss goes back to paper: nothing is bought, and there is NO flip or switch to another contract', async () => {
        const h = hookMake({ auto_flip: true }, 'R_UH4');
        await startOnPaper(h);
        h.conn.paper(h.symbol, OVER_LOSS); // -> live Odd
        await wait(60);
        h.conn.settle('c1', -1); // Odd loses live
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1); // paused again, nothing new bought
        expect(virtualEvents(h, 'start')).toHaveLength(2);
        expect(virtualEvents(h, 'start')[1]).toMatchObject({ contract_type: 'DIGITODD' }); // the market that just lost is the one tested
        h.engine.stop();
    });

    it('a live win keeps trading the same contract live (no new paper test)', async () => {
        const h = hookMake({}, 'R_UH5');
        await startOnPaper(h);
        h.conn.paper(h.symbol, EVEN_WIN);
        await wait(60);
        h.conn.paper(h.symbol, EVEN_WIN); // -> live Even
        await wait(60);
        h.conn.settle('c1', 1);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(2);
        expect(lastBuy(h).contract_type).toBe('DIGITEVEN');
        expect(virtualEvents(h, 'start')).toHaveLength(1);
        h.engine.stop();
    });

    it('rule 4: Over 4 <-> Under 5 are opposites (paper Over 4 loses -> Under 5 live, barrier 5)', async () => {
        const h = hookMake({}, 'R_UH6', 'DIGITOVER');
        await startOnPaper(h);
        h.conn.paper(h.symbol, OVER_LOSS); // digit 3: Over 4 loses
        await wait(60);
        expect(lastBuy(h)).toMatchObject({ contract_type: 'DIGITUNDER', barrier: '5' });
        h.engine.stop();

        const u = hookMake({}, 'R_UH7', 'DIGITUNDER');
        await startOnPaper(u);
        u.conn.paper(u.symbol, OVER_WIN); // digit 8: Under 5 loses
        await wait(60);
        expect(lastBuy(u)).toMatchObject({ contract_type: 'DIGITOVER', barrier: '4' });
        u.engine.stop();
    });

    it('rule 4: Only Ups <-> Only Downs are opposites (paper Only Ups loses -> Only Downs live, 2 ticks)', async () => {
        const h = hookMake({}, 'R_UH8', 'RUNHIGH');
        await startOnPaper(h);
        expect(virtualEvents(h, 'start')[0]).toMatchObject({ contract_type: 'RUNHIGH' });
        h.conn.ticks(h.symbol, [100, 100, 99]); // first tick after entry falls: Only Ups loses
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        expect(lastBuy(h)).toMatchObject({ contract_type: 'RUNLOW', duration: 2, duration_unit: 't' });
        h.engine.stop();
    });

    it('Only Ups: two paper wins (every tick rises) buy Only Ups live', async () => {
        const h = hookMake({}, 'R_UH9', 'RUNHIGH');
        await startOnPaper(h);
        h.conn.ticks(h.symbol, [100, 100, 101, 102]);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(0);
        h.conn.ticks(h.symbol, [100, 100, 101, 102]);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        expect(lastBuy(h)).toMatchObject({ contract_type: 'RUNHIGH', duration: 2 });
        h.engine.stop();
    });

    it('with the hook switched off the old behaviour is unchanged (first trade is real, a loss flips)', async () => {
        const h = make({ virtual_hook: false, auto_flip: true, virtual_mode: undefined }, undefined, 'R_UH10');
        h.engine.start();
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        h.conn.settle('c1', -1);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(2);
        expect(virtualEvents(h, 'start')).toHaveLength(0);
        h.engine.stop();
    });
});

describe('paperOutcome: Only Ups / Only Downs', () => {
    it('Only Ups needs every tick higher than the one before, over its full duration', () => {
        expect(paperOutcome('RUNHIGH', 100, [101, 102], 2, 2)).toBe(true);
        expect(paperOutcome('RUNHIGH', 100, [101], 2, 2)).toBeNull();
        expect(paperOutcome('RUNHIGH', 100, [101, 101], 2, 2)).toBe(false);
        expect(paperOutcome('RUNHIGH', 100, [99], 2, 2)).toBe(false);
    });
    it('Only Downs is the mirror image', () => {
        expect(paperOutcome('RUNLOW', 100, [99, 98], 2, 2)).toBe(true);
        expect(paperOutcome('RUNLOW', 100, [99, 99], 2, 2)).toBe(false);
        expect(paperOutcome('RUNLOW', 100, [101], 2, 2)).toBe(false);
    });
});
