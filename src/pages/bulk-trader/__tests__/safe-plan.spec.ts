import {
    AutoPilotEngine,
    buildConfigFromPreset,
    EXPECTED_LOSS_PER_STAKE,
    MIN_STAKE,
    planRun,
    planMartingale,
    ALL_FAMILY_KEYS,
    MARTINGALE_STOP_LOSS_SHARE,
    PLAN_STOP_LOSS_SHARE,
    SAFE_FAMILY_KEYS,
    SPREAD_PER_STAKE,
    TAutoPilotConfig,
} from '../autoPilotEngine';
import { LearningEngine } from '../learningEngine';
import type { TSnapshotMap } from '../analysis-types';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

const wait = (ms = 40) => new Promise(r => setTimeout(r, ms));

describe('24-hour run plan', () => {
    it('the payout costs a fair 50/50 trade 8.5% of its stake on average', () => {
        expect(Math.abs(EXPECTED_LOSS_PER_STAKE - 0.085)) .toBeLessThanOrEqual(1e-9);
    });

    it('sizes the stake so expected cost + a 3-sigma bad run fits inside 70% of the stop loss', () => {
        const plan = planRun(1500);
        expect(plan.trades).toBe(360); // 15 an hour for 24 hours
        expect(plan.trimmed).toBe(false);
        expect(plan.bad_run_loss).toBeLessThanOrEqual(1500 * PLAN_STOP_LOSS_SHARE + 1);
        expect(plan.stake).toBeGreaterThan(10);
        expect(plan.stake).toBeLessThan(15);
        // The payout cost is still a LOSS: the plan bounds it, it does not remove it.
        expect(plan.expected_cost).toBeGreaterThan(0);
    });

    it('a small account is held to the minimum stake and fewer trades, and the plan still fits', () => {
        const plan = planRun(15);
        expect(plan.stake).toBe(MIN_STAKE);
        expect(plan.trimmed).toBe(true);
        expect(plan.trades).toBeLessThan(360);
        expect(plan.bad_run_loss).toBeLessThanOrEqual(15 * PLAN_STOP_LOSS_SHARE + 1e-6);
    });

    it('simulation: at 50% wins and 0.83 payout the stop loss is (almost) never hit, and the run still loses the payout cost', () => {
        const plan = planRun(1500);
        let seed = 12345;
        const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
        const runs = 4000;
        let stopped = 0;
        let total = 0;
        for (let r = 0; r < runs; r++) {
            let pnl = 0;
            let hit = false;
            for (let i = 0; i < plan.trades; i++) {
                pnl += rnd() < 0.5 ? plan.stake * 0.83 : -plan.stake;
                if (pnl <= -1500) {
                    hit = true;
                    break;
                }
            }
            if (hit) stopped += 1;
            total += pnl;
        }
        expect(stopped / runs).toBeLessThanOrEqual(0.005);
        const mean = total / runs;
        // The average run LOSES about the payout cost (it does not profit).
        expect(mean).toBeLessThan(0);
        expect(Math.abs(mean + plan.expected_cost)).toBeLessThanOrEqual(6 * plan.stake * SPREAD_PER_STAKE * Math.sqrt(plan.trades) / Math.sqrt(runs) + 1);
    });
});

describe('24-hour defaults (recovery)', () => {
    it('presets use the recovery martingale, a ladder-sized base stake, every contract and the entry reader', () => {
        const c = buildConfigFromPreset('moderate', 10000);
        expect(c.recovery_mode).toBe('martingale');
        expect(c.recover_losses).toBe(true);
        expect(c.stake).toBe(planMartingale(c.stop_loss, c.max_steps).stake);
        expect(c.contract_families).toEqual(ALL_FAMILY_KEYS);
        expect(c.read_entries).toBe(true);
        expect(c.protect_trades).toBe(0);
        expect(c.both_sides).toBe(false);
        expect(SAFE_FAMILY_KEYS).toEqual(['even_odd', 'over_under']);
    });

    it('a full failed ladder fits inside the stop-loss share, so one bad run cannot reach the stop loss alone', () => {
        const c = buildConfigFromPreset('moderate', 10000);
        const plan = planMartingale(c.stop_loss, c.max_steps);
        expect(plan.worst_ladder).toBeLessThanOrEqual(c.stop_loss * MARTINGALE_STOP_LOSS_SHARE + 1);
    });
});

describe('pacing: max live trades per hour', () => {
    class Conn {
        sent: any[] = [];
        subs = new Map<number, { req: any; cb: any }>();
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
        settle(contract_id: string, profit: number) {
            for (const { req, cb } of this.subs.values()) {
                if (req.proposal_open_contract && req.contract_id === contract_id) cb({ proposal_open_contract: { contract_id, is_sold: 1, profit, buy_price: 1 } }, null);
            }
        }
        buys_ = () => this.sent.filter(r => r.buy);
    }
    const snapshots: TSnapshotMap = {
        R_PACE: { stats: {} as never, signals: [{ family: 'digits', contract_type: 'DIGITEVEN', label: 'Even', confidence: 90, basis: '' } as never] },
    };
    const make = (per_hour: number) => {
        const conn = new Conn();
        const config: TAutoPilotConfig = { recovery_mode: 'flat', stake: 1, martingale_multiplier: 1.2, max_steps: 5, stop_loss: 10000, take_profit: 10000, auto_flip: false, protect_trades: 0, virtual_hook: false, follow_stream: false, max_trades_per_hour: per_hour };
        const engine = new AutoPilotEngine(conn as never, 'USD', config, () => snapshots, () => undefined, new LearningEngine(`pace-${Math.random()}`, 'learn'));
        return { conn, engine };
    };

    it('the second live buy waits for the gap (1800 an hour = 2 s apart)', async () => {
        const h = make(1800);
        h.engine.start();
        await wait(100);
        expect(h.conn.buys_()).toHaveLength(1);
        h.conn.settle('c1', 0.8);
        await wait(600);
        expect(h.conn.buys_()).toHaveLength(1); // still waiting: under 2 s since the first buy
        await wait(1700);
        expect(h.conn.buys_()).toHaveLength(2);
        h.engine.stop();
    });

    it('with no cap the next trade follows at once', async () => {
        const h = make(0);
        h.engine.start();
        await wait(100);
        h.conn.settle('c1', 0.8);
        await wait(150);
        expect(h.conn.buys_().length).toBeGreaterThanOrEqual(2);
        h.engine.stop();
    });

    it('stopping while a buy is waiting for its turn buys nothing more', async () => {
        const h = make(1800);
        h.engine.start();
        await wait(100);
        h.conn.settle('c1', 0.8);
        await wait(200);
        h.engine.stop();
        await wait(2300);
        expect(h.conn.buys_()).toHaveLength(1);
    });
});
