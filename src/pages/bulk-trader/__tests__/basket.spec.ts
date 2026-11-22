import { AutoPilotEngine, TAutoPilotConfig, buildConfigFromPreset, BASKET_BASES, basketSetup, basketStakes, basketMinTotal, basketHasConflict, basketDiagnosis } from '../autoPilotEngine';
import type { TSnapshotMap } from '../analysis-types';
import { typeKey } from '../../journal/selfReview';

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
    settle(contract_id: number, profit: number, buy_price = 1) {
        for (const { req, cb } of this.subs.values()) {
            if (req.proposal_open_contract && req.contract_id === contract_id) cb({ proposal_open_contract: { contract_id, is_sold: 1, profit, buy_price, sell_price: Number((buy_price + profit).toFixed(2)) } }, null);
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

// a basket signal: a digit-pair signal with the chart direction and the momentum flag (a fresh run id on every read)
const basketSig = (key: string, types: [string, string], trend: string, momentum: boolean, extra: object = {}) =>
    ({ family: 'run_bias', strategy: 'run_bias', entry: true, basket_entry: true, confluence: false, pair_types: types, pair_key: key, trend, momentum, get run_id() { return `${++rid}:2:pair`; }, contract_type: types[0], label: 'pair', confidence: 70, basis: '', ...extra }) as never;
const bk: Partial<TAutoPilotConfig> = { basket_mode: true, stake: 2, martingale_multiplier: 1.5, max_steps: 5, stop_loss: 1000, take_profit: 1000, recovery_mode: 'flat' };
const EU = ['even_under5', ['DIGITEVEN', 'DIGITUNDER']] as const;
const buyTypes = (h: { conn: Conn }, from = 0, n = 3) => h.conn.buys_().slice(from, from + n).map(b => b.parameters.contract_type);
const buyStakes = (h: { conn: Conn }, from = 0, n = 3) => h.conn.buys_().slice(from, from + n).map(b => b.price);
// settles the three legs of the round that starts at buy index `from` (ids are 101, 102, ... in buy order)
const settleRound = (h: { conn: Conn }, from: number, results: number[]) => results.forEach((profit, i) => h.conn.settle(101 + from + i, profit, h.conn.buys_()[from + i].price));

describe('the 16 basket setups', () => {
    it('numbers 1-16 map to base x regime x direction, in the order the spec lists them', () => {
        const rows: [string, boolean, string, number, string[], number[]][] = [
            ['even_under5', true, 'bullish', 1, ['DIGITEVEN', 'DIGITUNDER', 'RUNHIGH'], [0.4, 0.4, 0.2]],
            ['even_under5', true, 'bearish', 2, ['DIGITEVEN', 'DIGITUNDER', 'RUNLOW'], [0.4, 0.4, 0.2]],
            ['even_under5', false, 'bullish', 3, ['DIGITEVEN', 'DIGITUNDER', 'CALL'], [0.35, 0.35, 0.3]],
            ['even_under5', false, 'bearish', 4, ['DIGITEVEN', 'DIGITUNDER', 'PUT'], [0.35, 0.35, 0.3]],
            ['odd_over4', true, 'bullish', 5, ['DIGITODD', 'DIGITOVER', 'RUNHIGH'], [0.4, 0.4, 0.2]],
            ['odd_over4', true, 'bearish', 6, ['DIGITODD', 'DIGITOVER', 'RUNLOW'], [0.4, 0.4, 0.2]],
            ['odd_over4', false, 'bullish', 7, ['DIGITODD', 'DIGITOVER', 'CALL'], [0.35, 0.35, 0.3]],
            ['odd_over4', false, 'bearish', 8, ['DIGITODD', 'DIGITOVER', 'PUT'], [0.35, 0.35, 0.3]],
            ['even_over4', true, 'bullish', 9, ['DIGITEVEN', 'DIGITOVER', 'RUNHIGH'], [0.4, 0.4, 0.2]],
            ['even_over4', true, 'bearish', 10, ['DIGITEVEN', 'DIGITOVER', 'RUNLOW'], [0.4, 0.4, 0.2]],
            ['even_over4', false, 'bullish', 11, ['DIGITEVEN', 'DIGITOVER', 'CALL'], [0.35, 0.35, 0.3]],
            ['even_over4', false, 'bearish', 12, ['DIGITEVEN', 'DIGITOVER', 'PUT'], [0.35, 0.35, 0.3]],
            ['odd_under5', true, 'bullish', 13, ['DIGITODD', 'DIGITUNDER', 'RUNHIGH'], [0.4, 0.4, 0.2]],
            ['odd_under5', true, 'bearish', 14, ['DIGITODD', 'DIGITUNDER', 'RUNLOW'], [0.4, 0.4, 0.2]],
            ['odd_under5', false, 'bullish', 15, ['DIGITODD', 'DIGITUNDER', 'CALL'], [0.35, 0.35, 0.3]],
            ['odd_under5', false, 'bearish', 16, ['DIGITODD', 'DIGITUNDER', 'PUT'], [0.35, 0.35, 0.3]],
        ];
        for (const [key, momentum, direction, number, types, shares] of rows) {
            const setup = basketSetup(key, direction, momentum)!;
            expect(setup.number).toBe(number);
            expect(setup.legs.map(l => l.type)).toEqual(types);
            expect(setup.legs.map(l => l.share)).toEqual(shares);
            expect(setup.legs.map(l => l.ticks)).toEqual([1, 1, momentum ? 2 : 1]);
            expect(basketHasConflict(setup.legs.map(l => l.type))).toBe(false);
        }
        expect(BASKET_BASES.map(b => b.blind)).toEqual(['5, 7, 9', '0, 2, 4', '1, 3', '6, 8']);
    });

    it('no direction, no setup; and contracts that cancel each other are recognised', () => {
        expect(basketSetup('even_under5', 'none', true)).toBeNull();
        expect(basketSetup('rise_odd', 'bullish', true)).toBeNull();
        expect(basketHasConflict(['DIGITEVEN', 'DIGITODD', 'CALL'])).toBe(true);
        expect(basketHasConflict(['DIGITEVEN', 'DIGITUNDER', 'CALL', 'PUT'])).toBe(true);
        expect(basketHasConflict(['CALL', 'RUNLOW'])).toBe(true);
    });

    it('stakes split 40/40/20 and 35/35/30 to the cent and add up to the total; tiny totals are raised to the 0.35 minimum', () => {
        const mom = basketSetup('even_under5', 'bullish', true)!.legs;
        const drift = basketSetup('even_under5', 'bullish', false)!.legs;
        expect(basketStakes(2, mom)).toEqual([0.8, 0.8, 0.4]);
        expect(basketStakes(10, drift)).toEqual([3.5, 3.5, 3]);
        const odd = basketStakes(1.17, drift);
        expect(Number(odd.reduce((a, b) => a + b, 0).toFixed(2))).toBe(1.17);
        expect(basketMinTotal(mom)).toBe(1.75);
        expect(basketMinTotal(drift)).toBe(1.17);
    });
});

describe('the optional cover leg', () => {
    it('adds Differs from the cover digit; shares add up to 1; no cover without a valid digit', () => {
        const m = basketSetup('even_under5', 'bullish', true, 7)!;
        expect(m.legs.map(l => l.type)).toEqual(['DIGITEVEN', 'DIGITUNDER', 'RUNHIGH', 'DIGITDIFF']);
        expect(m.legs.map(l => l.share)).toEqual([0.35, 0.35, 0.15, 0.15]);
        const d = basketSetup('odd_over4', 'bearish', false, 0)!;
        expect(d.legs.map(l => l.share)).toEqual([0.3, 0.3, 0.25, 0.15]);
        expect(d.legs[3].digit).toBe(0);
        expect(d.number).toBe(basketSetup('odd_over4', 'bearish', false)!.number);
        expect(basketSetup('even_under5', 'bullish', true, undefined)!.legs).toHaveLength(3);
        expect(basketSetup('even_under5', 'bullish', true, 10)!.legs).toHaveLength(3);
        expect(basketStakes(10, m.legs)).toEqual([3.5, 3.5, 1.5, 1.5]);
        expect(basketMinTotal(m.legs)).toBe(2.34);
        expect(basketHasConflict(m.legs.map(l => l.type))).toBe(false);
    });
});

describe('the basket is bought in one go', () => {
    it('one signal = three buys sent in the same tick, with the split stakes and the right durations', async () => {
        const h = make({ R_B1: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true)] }, bk);
        const times: number[] = [];
        const orig = h.conn.send.bind(h.conn);
        h.conn.send = ((r: any) => {
            if (r.buy) times.push(performance.now());
            return orig(r);
        }) as never;
        h.engine.start();
        await wait(150);
        expect(buyTypes(h)).toEqual(['DIGITEVEN', 'DIGITUNDER', 'RUNHIGH']);
        expect(buyStakes(h)).toEqual([0.8, 0.8, 0.4]);
        expect(h.conn.buys_().slice(0, 3).map(b => b.parameters.duration)).toEqual([1, 1, 2]);
        expect(times).toHaveLength(3);
        expect(Math.max(...times) - Math.min(...times)).toBeLessThan(5);
        h.engine.stop();
    });

    it('bearish drift on Odd + Under 5 buys Odd, Under 5 and Fall, 35/35/30 (setup 16)', async () => {
        const h = make({ R_B2: [basketSig('odd_under5', ['DIGITODD', 'DIGITUNDER'], 'bearish', false)] }, { ...bk, stake: 10 });
        h.engine.start();
        await wait(150);
        expect(buyTypes(h)).toEqual(['DIGITODD', 'DIGITUNDER', 'PUT']);
        expect(buyStakes(h)).toEqual([3.5, 3.5, 3]);
        expect(h.conn.buys_()[1].parameters.barrier).toBe('5');
        h.engine.stop();
    });

    it('a base total too small for the 20% contract is raised so every contract is at least 0.35', async () => {
        const h = make({ R_B3: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true)] }, { ...bk, stake: 1 });
        h.engine.start();
        await wait(150);
        expect(buyStakes(h)).toEqual([0.7, 0.7, 0.35]);
        h.engine.stop();
    });

    it('no chart direction, no basket; a single-contract signal is never bought in basket mode', async () => {
        const h = make({ R_B4: [basketSig(EU[0], [...EU[1]] as [string, string], 'none', true), sig({ type: 'DIGITEVEN', label: 'Even' })] }, bk);
        h.engine.start();
        await wait(150);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('no confirmed trend is needed: the basket buys at once, the third contract leaning the way the backend names', async () => {
        const h = make({ R_B5: [basketSig(EU[0], [...EU[1]] as [string, string], 'none', false, { basket_direction: 'bearish', basket_setup: 4 })] }, bk);
        h.engine.start();
        await wait(150);
        const types = h.conn.buys_().map(b => b.parameters.contract_type);
        expect(types).toHaveLength(3);
        expect([...types].sort()).toEqual(['DIGITEVEN', 'DIGITUNDER', 'PUT']); // setup 3/4 = bearish drift: Fall
        expect(h.conn.log.filter(x => x === 'ticks_history')).toHaveLength(0); // no chart request before the buy
        h.engine.stop();
    });

    it('cover on: a 4th contract, Differs from the least frequent digit, is bought in the same go; cover off keeps 3', async () => {
        const on = make({ R_B10: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true, { cover_digit: 7 })] }, { ...bk, stake: 10, basket_cover: true });
        on.engine.start();
        await wait(150);
        const buys = on.conn.buys_();
        expect(buys).toHaveLength(4);
        const diff = buys.find(b => b.parameters.contract_type === 'DIGITDIFF');
        expect(diff.parameters.barrier).toBe('7');
        expect(diff.parameters.duration).toBe(1);
        expect(diff.price).toBe(1.5); // 15% of 10
        expect(Number(buys.reduce((a, b) => a + b.price, 0).toFixed(2))).toBe(10); // the four stakes add up to the total
        on.engine.stop();
        const off = make({ R_B11: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true, { cover_digit: 7 })] }, { ...bk, stake: 10 });
        off.engine.start();
        await wait(150);
        expect(off.conn.buys_()).toHaveLength(3);
        off.engine.stop();
    });

    it('cover on but the signal has no cover digit: the plain 3-contract basket', async () => {
        const h = make({ R_B12: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true)] }, { ...bk, basket_cover: true });
        h.engine.start();
        await wait(150);
        expect(h.conn.buys_()).toHaveLength(3);
        h.engine.stop();
    });

    it('a cover that wins turns a sweep of the other three into a partial loss: the total stake stays flat', async () => {
        const h = make({ R_B13: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true, { cover_digit: 3 })] }, { ...bk, stake: 10, basket_cover: true });
        h.engine.start();
        await wait(150);
        const buys = h.conn.buys_();
        expect(buys).toHaveLength(4);
        buys.forEach((b, i) => h.conn.settle(100 + i + 1, b.parameters.contract_type === 'DIGITDIFF' ? 0.12 : -b.price, b.price));
        await wait(150);
        const next = h.conn.buys_().slice(4);
        expect(next.length).toBeGreaterThan(0);
        expect(Number(next.reduce((a, b) => a + b.price, 0).toFixed(2))).toBe(10); // not 15: no x1.5 after a partial loss
        h.engine.stop();
    });

    it('the self-review gate (skip "All markets DIGITEVEN / DIGITODD") never blocks a basket; it still blocks single contracts', async () => {
        const gate = { blocked: new Set([typeKey('DIGITEVEN', 'run_bias'), typeKey('DIGITODD', 'run_bias')]), watch: new Set<string>() };
        const run = async (signals: unknown[], cfg: Partial<TAutoPilotConfig>) => {
            const conn = new Conn();
            const snapshots: TSnapshotMap = { R_G1: { stats: {} as never, signals: signals as never } };
            const engine = new AutoPilotEngine(conn as never, 'USD', { ...base, ...cfg }, () => snapshots, () => undefined, undefined, { onLog: () => undefined, gate: () => gate } as never);
            engine.start();
            await wait(150);
            engine.stop();
            return conn.buys_();
        };
        expect(await run([basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true)], bk)).toHaveLength(3);
        expect(await run([sig({ type: 'DIGITEVEN', label: 'Even' })], { recovery_mode: 'flat' })).toHaveLength(0); // outside basket mode the gate still works
    });

    it('a single-contract basket signal (one confirmed contract, the basket it belongs to) is bought as a normal basket', async () => {
        const h = make({ R_B20: [basketSig('even_over4', ['DIGITEVEN', 'DIGITOVER'], 'none', false, { single_basket: true, trigger_contract: 'DIGITEVEN', basket_direction: 'bullish', basket_setup: 11 })] }, bk);
        h.engine.start();
        await wait(150);
        expect([...h.conn.buys_().map(b => b.parameters.contract_type)].sort()).toEqual(['CALL', 'DIGITEVEN', 'DIGITOVER']);
        h.engine.stop();
    });

    it('a digit-pair entry the backend did NOT judge a basket entry is not bought', async () => {
        const h = make({ R_B7: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true, { basket_entry: false })] }, bk);
        h.engine.start();
        await wait(150);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('the setup number the backend judged must match the one the AI builds, otherwise nothing is bought', async () => {
        const wrong = make({ R_B8: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true, { basket_setup: 3 })] }, bk); // bullish momentum is setup 1
        wrong.engine.start();
        await wait(150);
        expect(wrong.conn.buys_()).toHaveLength(0);
        expect(wrong.logs.some(l => /judged setup 3 but this signal builds setup 1/.test(l))).toBe(true);
        wrong.engine.stop();
        const right = make({ R_B9: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true, { basket_setup: 1 })] }, bk);
        right.engine.start();
        await wait(150);
        expect(buyTypes(right)).toEqual(['DIGITEVEN', 'DIGITUNDER', 'RUNHIGH']);
        right.engine.stop();
    });

    it('a basket on an unticked base does not fire', async () => {
        const h = make({ R_B5: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true)] }, { ...bk, basket_keys: ['odd_over4'] });
        h.engine.start();
        await wait(150);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('if one contract is refused the other two still run and are watched', async () => {
        const h = make({ R_B6: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true)] }, bk);
        const orig = h.conn.send.bind(h.conn);
        h.conn.send = ((r: any) => (r.buy && r.parameters.contract_type === 'RUNHIGH' ? Promise.reject(new Error('refused')) : orig(r))) as never;
        h.engine.start();
        await wait(150);
        expect(h.logs.some(l => /runs with 2 of 3/.test(l))).toBe(true);
        settleRound(h, 0, [0.76, -0.8]);
        await wait(250);
        expect(h.logs.some(l => /Basket closed: net -0.04/.test(l))).toBe(true);
        h.engine.stop();
    });
});

describe('the 1.5x martingale state machine', () => {
    it('full sweep (all 3 return 0): the total stake x1.5 for the next signal', async () => {
        const h = make({ R_M1: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true)] }, bk);
        h.engine.start();
        await wait(150);
        settleRound(h, 0, [-0.8, -0.8, -0.4]);
        await wait(250);
        expect(buyStakes(h, 3)).toEqual([1.2, 1.2, 0.6]); // total 3 = 2 x 1.5
        h.engine.stop();
    });

    it('partial loss (some contracts pay but the net is negative): the total stake stays flat', async () => {
        const h = make({ R_M2: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true)] }, bk);
        h.engine.start();
        await wait(150);
        settleRound(h, 0, [0.76, -0.8, -0.4]); // net -0.44, one contract paid
        await wait(250);
        expect(buyStakes(h, 3)).toEqual([0.8, 0.8, 0.4]);
        h.engine.stop();
    });

    it('after a full sweep then a partial loss the raised total stays; a net profit goes back to the base', async () => {
        const h = make({ R_M3: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true)] }, bk);
        h.engine.start();
        await wait(150);
        settleRound(h, 0, [-0.8, -0.8, -0.4]); // sweep -> total 3
        await wait(250);
        settleRound(h, 3, [1.14, -1.2, -0.6]); // total 3, net -0.66: partial -> stays 3
        await wait(250);
        expect(buyStakes(h, 6)).toEqual([1.2, 1.2, 0.6]);
        settleRound(h, 6, [1.14, 1.14, -0.6]); // net +1.68: reset
        await wait(250);
        expect(buyStakes(h, 9)).toEqual([0.8, 0.8, 0.4]); // back to the base total 2
        h.engine.stop();
    });

    it('a net of exactly 0 counts as profit and resets the stake', async () => {
        const h = make({ R_M4: [basketSig(EU[0], [...EU[1]] as [string, string], 'bullish', true)] }, bk);
        h.engine.start();
        await wait(150);
        settleRound(h, 0, [-0.8, -0.8, -0.4]); // total 3 next
        await wait(250);
        settleRound(h, 3, [1.2, 0, -1.2]); // net 0
        await wait(250);
        expect(buyStakes(h, 6)).toEqual([0.8, 0.8, 0.4]);
        h.engine.stop();
    });

    it('presets turn the basket on, all four bases', () => {
        const c = buildConfigFromPreset('moderate', 10000);
        expect(c.basket_mode).toBe(true);
        expect(c.basket_keys).toEqual(['even_under5', 'odd_over4', 'even_over4', 'odd_under5']);
        expect(c.martingale_multiplier).toBe(1.5);
    });
});

describe('a silent AI explains itself', () => {
    const snap = (signals: unknown[]) => ({ R_X: { signals } });
    const old = { family: 'run_bias', pair_types: ['DIGITEVEN', 'DIGITUNDER'], pair_key: 'even_under5', entry: true, confidence: 40 };

    it('an OLD backend (no basket fields) is named as the reason', () => {
        expect(basketDiagnosis(snap([old]), {})).toMatch(/OLD version/);
    });

    it('no digit-pair signals at all is reported', () => {
        expect(basketDiagnosis(snap([]), {})).toMatch(/no digit-pair signals at all/);
    });

    it('a quiet market, then the reasons digit-pair entries were dropped', () => {
        const base = { ...old, basket_setup: 1, basket_entry: false };
        expect(basketDiagnosis(snap([{ ...base, entry: false }]), {})).toMatch(/No digit-pair entry on any market/);
        expect(basketDiagnosis(snap([{ ...base, basket_setup: null }]), {})).toMatch(/1 had no chart direction/);
        expect(basketDiagnosis(snap([{ ...base, basket: { third_bias: 51 } }]), {})).toMatch(/no support for the third contract/);
        expect(basketDiagnosis(snap([{ ...base, basket: { third_bias: 60 } }]), {})).toMatch(/losing when replayed/);
        expect(basketDiagnosis(snap([{ ...base, basket_entry: true, confidence: 12 }]), { min_confidence: 20 })).toMatch(/weaker than the minimum signal strength \(20\)/);
        expect(basketDiagnosis(snap([{ ...base, basket_entry: true }]), { basket_keys: ['odd_over4'] })).toMatch(/unticked base/);
        expect(basketDiagnosis(snap([{ ...base, basket_entry: true }]), {})).toMatch(/1 basket entry is ready/);
    });

    it('with an old backend the AI logs the reason as an error once it has waited', async () => {
        const h = make({ R_OLD: [{ ...old, run_id: 1, contract_type: 'DIGITEVEN', label: 'x', basis: '' } as never] }, bk);
        h.engine.start();
        await wait(60);
        (h.engine as unknown as { started_at: number }).started_at = Date.now() - 20_000; // pretend it has been running a while
        (h.engine as unknown as { last_wait_emit: number }).last_wait_emit = 0;
        await wait(400);
        expect(h.logs.some(l => /Not buying yet: The backend is an OLD version/.test(l))).toBe(true);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });
});
