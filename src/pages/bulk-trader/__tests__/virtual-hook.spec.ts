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
    history: number[] = [];
    proposalError?: (req: any) => string | null;
    onFatalError: any;
    onReconnecting: any;
    onReconnect: any;
    async send(req: any) {
        this.sent.push(req);
        if (req.proposal) {
            const bad = this.proposalError?.(req);
            if (bad) throw new Error(bad);
            return { proposal: { ask_price: 1, payout: 1.9 } };
        }
        if (req.buy) return { buy: { contract_id: `c${++this.buys}` } };
        if (req.ticks_history) return { history: { prices: this.history, times: [] } };
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

const BULL = [100, 101, 102, 101, 100, 101, 103, 104, 103, 102, 103, 105, 107, 105, 104]; // a higher-high on the 1-tick chart
const BEAR = BULL.map(x => 200 - x); // a lower-low
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
    it('pauses real trading after a loss and asks for two paper wins by default (older confirm mode)', async () => {
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


describe('virtual hook: paper trade before EVERY live trade (the default)', () => {
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
        expect(virtualEvents(h, 'start')[0]).toMatchObject({ contract_type: 'DIGITEVEN', virtual_needed: 1 });
        h.engine.stop();
    });

    it('rule 1: Even/Odd follows the hook: a paper loss buys NOTHING (no Odd), it stays on paper until Even wins, then Even is live', async () => {
        const h = hookMake({}, 'R_UH1');
        await startOnPaper(h);
        h.conn.paper(h.symbol, OVER_LOSS); // last digit 3: Even loses on paper
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(0);
        expect(virtualEvents(h, 'paper').pop()).toMatchObject({ contract_type: 'DIGITEVEN' });
        h.conn.paper(h.symbol, OVER_LOSS); // loses again: still nothing live
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(0);
        h.conn.paper(h.symbol, EVEN_WIN); // paper win -> the same contract live
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        expect(lastBuy(h)).toMatchObject({ contract_type: 'DIGITEVEN', underlying_symbol: h.symbol });
        h.engine.stop();
    });

    it('rule 1b: Odd follows the hook too (paper Odd wins on an odd digit -> live Odd; paper loss -> nothing live)', async () => {
        const h = hookMake({}, 'R_UH1B', 'DIGITODD');
        await startOnPaper(h);
        expect(virtualEvents(h, 'start')[0]).toMatchObject({ contract_type: 'DIGITODD' });
        h.conn.paper(h.symbol, EVEN_WIN); // digit 2: Odd loses on paper
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(0);
        h.conn.paper(h.symbol, OVER_LOSS); // digit 3: Odd wins on paper
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        expect(lastBuy(h)).toMatchObject({ contract_type: 'DIGITODD', underlying_symbol: h.symbol });
        h.engine.stop();
    });

    it('Even/Odd cap: after 25 paper losses in a row it picks a fresh contract and paper-tests it, never buying live unproven', async () => {
        const h = hookMake({}, 'R_UH1C');
        await startOnPaper(h);
        for (let i = 0; i < 25; i++) {
            h.conn.paper(h.symbol, OVER_LOSS);
            await wait(30);
        }
        await wait(100);
        expect(h.conn.buys_()).toHaveLength(0);
        expect(virtualEvents(h, 'start').length).toBeGreaterThanOrEqual(2); // a new paper test began
        h.engine.stop();
    });

    it('rule 2: ONE paper win buys the SAME contract live', async () => {
        const h = hookMake({}, 'R_UH2');
        await startOnPaper(h);
        expect(h.conn.buys_()).toHaveLength(0);
        h.conn.paper(h.symbol, EVEN_WIN);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        expect(lastBuy(h)).toMatchObject({ contract_type: 'DIGITEVEN', underlying_symbol: h.symbol });
        h.engine.stop();
    });

    it('rule 3: a live loss goes back to paper: nothing is bought, and there is NO flip or switch to another contract', async () => {
        const h = hookMake({ auto_flip: true }, 'R_UH4');
        await startOnPaper(h);
        h.conn.paper(h.symbol, EVEN_WIN); // -> live Even
        await wait(60);
        h.conn.settle('c1', -1); // Even loses live
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1); // paused again, nothing new bought
        expect(virtualEvents(h, 'start')).toHaveLength(2);
        expect(virtualEvents(h, 'start')[1]).toMatchObject({ contract_type: 'DIGITEVEN' }); // the market that just lost is the one tested
        h.engine.stop();
    });

    it('a live WIN also goes back to paper first: the next live trade is only bought after another paper result', async () => {
        const h = hookMake({}, 'R_UH5');
        await startOnPaper(h);
        h.conn.paper(h.symbol, EVEN_WIN); // paper win -> live Even
        await wait(60);
        h.conn.settle('c1', 1); // live win
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1); // nothing new live yet
        expect(virtualEvents(h, 'start')).toHaveLength(2);
        expect(virtualEvents(h, 'start')[1]).toMatchObject({ contract_type: 'DIGITEVEN' });
        h.conn.paper(h.symbol, EVEN_WIN); // paper win again -> same contract live
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(2);
        expect(lastBuy(h).contract_type).toBe('DIGITEVEN');
        h.conn.settle('c2', -1); // live loss -> paper again; this time the paper trade loses -> Even/Odd buys nothing
        await wait(60);
        h.conn.paper(h.symbol, OVER_LOSS);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(2);
        h.conn.paper(h.symbol, EVEN_WIN); // paper win -> Even live again
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(3);
        expect(lastBuy(h).contract_type).toBe('DIGITEVEN');
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
        h.conn.history = BULL; // Only Ups waits for a higher-high on the 1-tick chart
        await startOnPaper(h);
        expect(virtualEvents(h, 'start')[0]).toMatchObject({ contract_type: 'RUNHIGH' });
        h.conn.history = BEAR; // by the time the opposite is bought, the chart shows a lower-low (Only Downs needs it)
        h.conn.ticks(h.symbol, [100, 100, 99]); // first tick after entry falls: Only Ups loses
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(2); // both sides: Only Downs (the opposite) + Only Ups
        expect(h.conn.buys_()[0].parameters).toMatchObject({ contract_type: 'RUNLOW', duration: 2, duration_unit: 't' });
        expect(h.conn.buys_()[1].parameters).toMatchObject({ contract_type: 'RUNHIGH', duration: 2, duration_unit: 't' });
        h.engine.stop();
    });

    it('Only Ups: a paper win (every tick rises) buys Only Ups live', async () => {
        const h = hookMake({}, 'R_UH9', 'RUNHIGH');
        h.conn.history = BULL;
        await startOnPaper(h);
        h.conn.ticks(h.symbol, [100, 100, 101]);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(0); // 1 of 2 ticks: not settled yet
        h.conn.ticks(h.symbol, [102]);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(2); // both sides
        expect(h.conn.buys_()[0].parameters).toMatchObject({ contract_type: 'RUNHIGH', duration: 2 });
        expect(h.conn.buys_()[1].parameters).toMatchObject({ contract_type: 'RUNLOW', duration: 2 });
        h.engine.stop();
    });

    it('both sides: the two legs settle as ONE trade (net result), and only then does the hook start again', async () => {
        const h = hookMake({}, 'R_UH11', 'RUNHIGH');
        h.conn.history = BULL;
        await startOnPaper(h);
        h.conn.ticks(h.symbol, [100, 100, 101, 102]); // paper win
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(2);
        const starts = virtualEvents(h, 'start').length;
        h.conn.settle('c1', 9); // Only Ups wins
        await wait(60);
        expect(virtualEvents(h, 'start')).toHaveLength(starts); // the other side is still open: nothing new yet
        h.conn.settle('c2', -1); // Only Downs loses
        await wait(60);
        expect(virtualEvents(h, 'start')).toHaveLength(starts + 1); // net +8: a win -> back to paper first
        expect(h.conn.buys_()).toHaveLength(2);
        h.engine.stop();
    });

    it('both sides off: Only Ups is bought alone', async () => {
        const h = hookMake({ both_sides: false }, 'R_UH12', 'RUNHIGH');
        h.conn.history = BULL;
        await startOnPaper(h);
        h.conn.ticks(h.symbol, [100, 100, 101, 102]);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        h.engine.stop();
    });

    it('both sides does not apply to Even/Odd or Over/Under (one contract only)', async () => {
        const h = hookMake({}, 'R_UH13');
        await startOnPaper(h);
        h.conn.paper(h.symbol, EVEN_WIN);
        await wait(60);
        expect(h.conn.buys_()).toHaveLength(1);
        h.engine.stop();
    });

    it('both sides: Touch + No Touch are bought together on the same market, same barrier and duration', async () => {
        const h = hookMake({ contract_families: ['touch'], rotate_contracts: true }, 'R_UH14', 'DIGITEVEN');
        await startOnPaper(h);
        await wait(150);
        h.conn.ticks(h.symbol, [100, 100, 100, 100, 100, 100, 100, 100]); // never touches +0.5: paper Touch loses -> No Touch is the live contract
        await wait(150);
        expect(h.conn.buys_()).toHaveLength(2);
        const types = h.conn.buys_().map(b => b.parameters.contract_type).sort();
        expect(types).toEqual(['NOTOUCH', 'ONETOUCH']);
        expect(h.conn.buys_()[0].parameters).toMatchObject({ barrier: '+0.5', duration: 5 });
        expect(h.conn.buys_()[1].parameters).toMatchObject({ barrier: '+0.5', duration: 5 });
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


describe('AI Trader contract picker and rotation', () => {
    const FAMS_ALL = ['even_odd', 'over_under', 'rise_fall', 'touch', 'only_ups_downs'];
    const mk = (cfg: Partial<TAutoPilotConfig>, symbol: string, signal = 'DIGITEVEN') => make({ virtual_mode: undefined, ...cfg }, undefined, symbol, signal);
    const lastStart = (h: ReturnType<typeof make>) => virtualEvents(h, 'start').slice(-1)[0];

    it('after every live trade the next paper test is on the next ticked contract (Even -> Over 4 -> Touch, Rise/Fall skipped without a trend)', async () => {
        const h = mk({ contract_families: FAMS_ALL, rotate_contracts: true }, 'R_RT1');
        h.engine.start();
        await wait(80);
        expect(lastStart(h)).toMatchObject({ contract_type: 'DIGITEVEN' });
        h.conn.paper(h.symbol, EVEN_WIN); // paper win -> live Even
        await wait(80);
        expect(h.conn.buys_()).toHaveLength(1);
        h.conn.settle('c1', 1);
        await wait(120);
        expect(lastStart(h)).toMatchObject({ contract_type: 'DIGITOVER' }); // next family: Over 4 / Under 5
        h.conn.paper(h.symbol, OVER_WIN); // digit 8: Over 4 wins -> live Over 4
        await wait(80);
        expect(h.conn.buys_()[1].parameters).toMatchObject({ contract_type: 'DIGITOVER', barrier: '4' });
        h.conn.settle('c2', 1);
        await wait(150);
        expect(lastStart(h)).toMatchObject({ contract_type: 'ONETOUCH' }); // Rise/Fall had no confirmed trend, so it was skipped
        h.engine.stop();
    });

    it('Rise/Fall and Only Ups/Downs take the side the 1-tick chart confirms', async () => {
        const up = mk({ contract_families: ['rise_fall', 'only_ups_downs'], rotate_contracts: true }, 'R_RT2');
        up.conn.history = BULL;
        up.engine.start();
        await wait(120);
        expect(lastStart(up).contract_type).toBe('CALL'); // higher-high -> Rise
        up.engine.stop();

        const down = mk({ contract_families: ['only_ups_downs'], rotate_contracts: true }, 'R_RT3');
        down.conn.history = BEAR;
        down.engine.start();
        await wait(120);
        expect(lastStart(down).contract_type).toBe('RUNLOW'); // lower-low -> Only Downs
        down.engine.stop();
    });

    it('only the ticked families are traded: with Even/Odd alone it never leaves it', async () => {
        const h = mk({ contract_families: ['even_odd'], rotate_contracts: true }, 'R_RT4');
        h.engine.start();
        await wait(80);
        h.conn.paper(h.symbol, EVEN_WIN);
        await wait(80);
        h.conn.settle('c1', 1);
        await wait(120);
        expect(lastStart(h)).toMatchObject({ contract_type: 'DIGITEVEN' });
        h.engine.stop();
    });

    it('rotation off: the AI stays on the contract it just traded', async () => {
        const h = mk({ contract_families: FAMS_ALL, rotate_contracts: false }, 'R_RT5');
        h.engine.start();
        await wait(80);
        h.conn.paper(h.symbol, EVEN_WIN);
        await wait(80);
        h.conn.settle('c1', 1);
        await wait(120);
        expect(lastStart(h)).toMatchObject({ contract_type: 'DIGITEVEN' });
        h.engine.stop();
    });

    it('a ticked contract with no live signal can still be paper-tested (Touch only, signals only for Even)', async () => {
        const h = mk({ contract_families: ['touch'], rotate_contracts: true }, 'R_RT6');
        h.engine.start();
        await wait(120);
        expect(lastStart(h).contract_type).toBe('ONETOUCH');
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });
});


describe('Touch / No Touch: "This contract offers no return"', () => {
    const NO_RETURN = 'This contract offers no return';
    const isTouchReq = (r: any) => r.contract_type === 'ONETOUCH' || r.contract_type === 'NOTOUCH';
    const mk = (cfg: Partial<TAutoPilotConfig>, symbol: string, signal: string) => make({ virtual_mode: undefined, ...cfg }, undefined, symbol, signal);
    const flat = (n: number) => Array.from({ length: n }, () => 100);

    it('5 ticks has no return -> the hook prices 10 ticks (barrier 0.5), paper-tests it and buys it live at 10 ticks', async () => {
        const h = mk({ contract_families: ['touch'], rotate_contracts: true }, 'R_NR1', 'DIGITEVEN');
        h.conn.proposalError = r => (isTouchReq(r) && r.duration === 5 ? NO_RETURN : null);
        h.engine.start();
        await wait(150);
        expect(virtualEvents(h, 'start').slice(-1)[0].contract_type).toBe('ONETOUCH');
        expect(h.engine.isRunning).toBe(true);
        h.conn.ticks(h.symbol, [100, 100, ...flat(10)]); // never reaches +0.5: Touch loses on paper -> opposite (No Touch) live
        await wait(400);
        expect(h.conn.buys_()).toHaveLength(2); // both sides, both at 10 ticks
        expect(h.conn.buys_()[0].parameters).toMatchObject({ contract_type: 'NOTOUCH', duration: 10, barrier: '+0.5' });
        expect(h.conn.buys_()[1].parameters).toMatchObject({ contract_type: 'ONETOUCH', duration: 10, barrier: '+0.5' });
        h.engine.stop();
    });

    it('no return at 5 AND 10 ticks: the market is skipped, the run keeps going and does not stop', async () => {
        const h = mk({ contract_families: ['touch'], rotate_contracts: true }, 'R_NR2', 'DIGITEVEN');
        h.conn.proposalError = r => (isTouchReq(r) ? NO_RETURN : null);
        h.engine.start();
        await wait(200);
        expect(h.engine.isRunning).toBe(true);
        expect(h.conn.buys_()).toHaveLength(0);
        expect(virtualEvents(h, 'start')).toHaveLength(0); // nothing was paper-traded on a contract that cannot be priced
        h.engine.stop();
    });

    it('a live buy refused with "no return" at 5 ticks is retried at 10 ticks instead of stopping the run', async () => {
        const h = mk({ virtual_hook: false, auto_flip: false }, 'R_NR3', 'NOTOUCH');
        h.conn.proposalError = r => (isTouchReq(r) && r.duration === 5 ? NO_RETURN : null);
        h.engine.start();
        await wait(600); // the 5 -> 10 tick retry waits 300 ms
        expect(h.engine.isRunning).toBe(true);
        expect(h.conn.buys_()).toHaveLength(2); // both sides, both at 10 ticks
        expect(h.conn.buys_()[0].parameters).toMatchObject({ contract_type: 'NOTOUCH', duration: 10, barrier: '+0.5' });
        expect(h.conn.buys_()[1].parameters).toMatchObject({ contract_type: 'ONETOUCH', duration: 10, barrier: '+0.5' });
        h.engine.stop();
    });
});
