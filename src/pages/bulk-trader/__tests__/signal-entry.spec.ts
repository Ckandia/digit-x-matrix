import { AutoPilotEngine, buildConfigFromPreset, FOCUS_FAMILY_KEYS, TAutoPilotConfig, TAutoPilotEvent } from '../autoPilotEngine';
import type { TSnapshotMap } from '../analysis-types';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

const wait = (ms = 80) => new Promise(r => setTimeout(r, ms));

class Conn {
    sent: any[] = [];
    subs = new Map<number, { req: any; cb: any }>();
    history: Record<string, number[]> = {};
    payout = 1.9;
    private n = 1;
    private buys = 0;
    accountInfo = { balance: 100000, loginid: 'VRTC1', currency: 'USD' };
    onFatalError: any;
    onReconnecting: any;
    onReconnect: any;
    async send(req: any) {
        this.sent.push(req);
        if (req.proposal) return { proposal: { ask_price: 1, payout: this.payout } };
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

type TSig = { type: string; label: string; entry: boolean; run_id?: number | string; confidence?: number; family?: string };
const sig = (o: TSig) => ({ family: o.family ?? 'run_bias', strategy: 'run_bias', entry: o.entry, run_id: o.run_id, contract_type: o.type, label: o.label, confidence: o.confidence ?? 70, basis: '' }) as never;
const base: TAutoPilotConfig = { recovery_mode: 'flat', stake: 1, martingale_multiplier: 2, max_steps: 4, stop_loss: 1000, take_profit: 1000, protect_trades: 0 };

const make = (signals: Record<string, unknown[]>, cfg: Partial<TAutoPilotConfig> = {}) => {
    const conn = new Conn();
    const snapshots: TSnapshotMap = {};
    for (const [symbol, list] of Object.entries(signals)) snapshots[symbol] = { stats: {} as never, signals: list as never };
    const events: TAutoPilotEvent[] = [];
    const engine = new AutoPilotEngine(conn as never, 'USD', { ...base, ...cfg }, () => snapshots, e => events.push(e));
    return { conn, engine, snapshots, events };
};

describe('the AI executes on the backend signal', () => {
    it('buys right away when the backend flags an entry: no paper trade, no waiting on its own ticks', async () => {
        const h = make({ R_SIG1: [sig({ type: 'DIGITEVEN', label: 'Even', entry: true, run_id: 10 })] });
        h.engine.start();
        await wait();
        expect(h.conn.buys_()).toHaveLength(1);
        expect(h.conn.buys_()[0].parameters).toMatchObject({ contract_type: 'DIGITEVEN', underlying_symbol: 'R_SIG1' });
        expect(h.events.some(e => (e.phase as string) === 'virtual')).toBe(false);
        h.engine.stop();
    });

    it('does nothing while no contract has an entry, and buys as soon as one appears', async () => {
        const h = make({ R_SIG2: [sig({ type: 'DIGITODD', label: 'Odd', entry: false, run_id: 1 })] });
        h.engine.start();
        await wait(700);
        expect(h.conn.buys_()).toHaveLength(0);
        expect(h.events.some(e => e.phase === 'waiting')).toBe(true);
        h.snapshots.R_SIG2.signals = [sig({ type: 'DIGITODD', label: 'Odd', entry: true, run_id: 2 })] as never;
        await wait(700);
        expect(h.conn.buys_()).toHaveLength(1);
        h.engine.stop();
    });

    it('trades one run of ticks only once', async () => {
        const h = make({ R_SIG3: [sig({ type: 'DIGITUNDER', label: 'Under 5', entry: true, run_id: 7 })] });
        h.engine.start();
        await wait();
        h.conn.settle('c1', 0.9);
        await wait(700);
        expect(h.conn.buys_()).toHaveLength(1); // the same run id is not bought again
        h.snapshots.R_SIG3.signals = [sig({ type: 'DIGITUNDER', label: 'Under 5', entry: true, run_id: 8 })] as never;
        await wait(700);
        expect(h.conn.buys_()).toHaveLength(2); // a fresh run is
        h.engine.stop();
    });

    it('takes the strongest entry signal across markets', async () => {
        const h = make({
            R_WEAK: [sig({ type: 'DIGITEVEN', label: 'Even', entry: true, run_id: 1, confidence: 20 })],
            R_STRONG: [sig({ type: 'DIGITOVER', label: 'Over 4', entry: true, run_id: 1, confidence: 90 })],
        });
        h.engine.start();
        await wait();
        expect(h.conn.buys_()[0].parameters).toMatchObject({ contract_type: 'DIGITOVER', underlying_symbol: 'R_STRONG' });
        h.engine.stop();
    });

    it('ignores signals that are not run-bias entries and contracts that are not ticked', async () => {
        const h = make(
            { R_OLD: [sig({ family: 'digits', type: 'DIGITEVEN', label: 'Even', entry: true, run_id: 1 }), sig({ type: 'DIGITODD', label: 'Odd', entry: true, run_id: 2 })] },
            { contract_families: ['over_under'] }
        );
        h.engine.start();
        await wait(500);
        expect(h.conn.buys_()).toHaveLength(0); // the digit-deviation signal is not an entry, and Odd is not in the ticked family
        h.engine.stop();
    });

    it('Rise/Fall signals still wait for a confirmed trend on the 1-tick chart', async () => {
        const h = make({ R_TR: [sig({ type: 'CALL', label: 'Rise', entry: true, run_id: 1 })] });
        h.conn.history.R_TR = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 0 : 0.5)); // sideways, no higher highs
        h.engine.start();
        await wait(300);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('a loss leads to a recovery stake on the next signal, chosen by the AI', async () => {
        const h = make({ R_REC: [sig({ type: 'DIGITEVEN', label: 'Even', entry: true, run_id: 1 })] }, { recovery_mode: 'martingale', recover_losses: true });
        h.engine.start();
        await wait();
        h.snapshots.R_REC.signals = [sig({ type: 'DIGITUNDER', label: 'Under 5', entry: true, run_id: 2 })] as never; // a different contract signals
        h.conn.settle('c1', -1);
        await wait(700);
        expect(h.conn.buys_().map(b => b.price)).toEqual([1, 2.41]);
        expect(h.conn.buys_()[1].parameters).toMatchObject({ contract_type: 'DIGITUNDER' });
        h.engine.stop();
    });
});

describe('Only Ups / Only Downs fire together, only when a win covers both stakes', () => {
    const zigzag = Array.from({ length: 60 }, (_, i) => Number((100 + i * 0.2 + Math.sin(i / 2) * 1.5).toFixed(2))); // higher highs and higher lows: a confirmed uptrend

    it('buys Only Ups AND Only Downs, one stake each, when the winning payout covers both', async () => {
        const h = make({ R_UD: [sig({ type: 'RUNHIGH', label: 'Only Ups', entry: true, run_id: '5:2' })] });
        h.conn.history.R_UD = zigzag;
        h.conn.payout = 3.8; // a 2-tick Only Ups / Only Downs pays about 3.8x
        h.engine.start();
        await wait(300);
        expect(h.conn.buys_().map(b => b.parameters.contract_type).sort()).toEqual(['RUNHIGH', 'RUNLOW']);
        expect(h.conn.buys_().map(b => b.price)).toEqual([1, 1]);
        h.engine.stop();
    });

    it('buys nothing when a winning side would pay less than both stakes together', async () => {
        const h = make({ R_UD2: [sig({ type: 'RUNHIGH', label: 'Only Ups', entry: true, run_id: '5:2' })] });
        h.conn.history.R_UD2 = zigzag;
        h.conn.payout = 1.9; // 1.9 < 2 stakes of 1
        h.engine.start();
        await wait(300);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('with both sides off only the signalled side is bought', async () => {
        const h = make({ R_UD3: [sig({ type: 'RUNHIGH', label: 'Only Ups', entry: true, run_id: '5:2' })] }, { both_sides: false });
        h.conn.history.R_UD3 = zigzag;
        h.engine.start();
        await wait(300);
        expect(h.conn.buys_().map(b => b.parameters.contract_type)).toEqual(['RUNHIGH']);
        h.engine.stop();
    });
});

describe('Touch / No Touch is the focus', () => {
    it('is the only family ticked by default', () => {
        expect(buildConfigFromPreset('moderate', 1000).contract_families).toEqual(FOCUS_FAMILY_KEYS);
        expect(FOCUS_FAMILY_KEYS).toEqual(['touch']);
    });

    it('with the default families only Touch / No Touch signals are bought, with the 0.5 barrier', async () => {
        const h = make(
            { R_TCH: [sig({ type: 'DIGITEVEN', label: 'Even', entry: true, run_id: '1:2', confidence: 99 }), sig({ type: 'ONETOUCH', label: 'Touch', entry: true, run_id: '1:2', confidence: 40 })] },
            { contract_families: FOCUS_FAMILY_KEYS }
        );
        h.engine.start();
        await wait(300);
        expect(h.conn.buys_()).toHaveLength(1);
        expect(h.conn.buys_()[0].parameters).toMatchObject({ contract_type: 'ONETOUCH', barrier: '+0.5', duration: 5 });
        h.engine.stop();
    });
});

describe('no virtual hook any more', () => {
    it('the preset has no virtual-hook, follow-stream or flip settings', () => {
        const c = buildConfigFromPreset('moderate', 1000) as Record<string, unknown>;
        for (const k of ['virtual_hook', 'virtual_mode', 'virtual_confirmations', 'follow_stream', 'entry_tick', 'read_entries', 'rotate_contracts', 'auto_flip']) {
            expect(k in c).toBe(false);
        }
        expect(c.recover_losses).toBe(true);
        expect(c.both_sides).toBe(true);
    });
});
