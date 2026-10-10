import { AutoPilotEngine, buildConfigFromPreset, TAutoPilotConfig } from '../autoPilotEngine';
import { LearningEngine } from '../learningEngine';
import type { TSnapshotMap } from '../analysis-types';

jest.mock('uuid', () => ({ v4: () => 'test-id' }));

const wait = (ms = 40) => new Promise(r => setTimeout(r, ms));

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
    buys_ = () => this.sent.filter(r => r.buy);
}

const snapshots: TSnapshotMap = {
    R_EG: { stats: {} as never, signals: [{ family: 'digits', contract_type: 'DIGITEVEN', label: 'Even', confidence: 90, basis: '' } as never] },
};

const run = (mode: 'off' | 'learn' | 'edge_gate', cfg: Partial<TAutoPilotConfig> = {}) => {
    const conn = new Conn();
    const learner = new LearningEngine(`eg-${mode}-${Math.random()}`, mode);
    const config: TAutoPilotConfig = { recovery_mode: 'flat', stake: 1, martingale_multiplier: 1.2, max_steps: 5, stop_loss: 10000, take_profit: 10000, auto_flip: true, protect_trades: 0, virtual_hook: false, follow_stream: false, ...cfg };
    const engine = new AutoPilotEngine(conn as never, 'USD', config, () => snapshots, () => undefined, learner);
    return { conn, engine, learner };
};

describe('quality gate: only trade a proven edge', () => {
    it('buys NOTHING live when no contract has a proven edge', async () => {
        const h = run('edge_gate');
        h.engine.start();
        await wait(80);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('still trades in learn mode (control)', async () => {
        const h = run('learn');
        h.engine.start();
        await wait(80);
        expect(h.conn.buys_().length).toBeGreaterThan(0);
        h.engine.stop();
    });

    it('also blocks the virtual-hook route to a live buy (the old gap)', async () => {
        const h = run('edge_gate', { virtual_hook: true, virtual_mode: 'opposite' });
        h.engine.start();
        await wait(80);
        expect(h.conn.buys_()).toHaveLength(0);
        h.engine.stop();
    });

    it('isTradable is true only after enough winning trades beat the break-even', () => {
        const l = new LearningEngine(`eg-proof-${Math.random()}`, 'edge_gate');
        expect(l.isTradable('R_EG', 'DIGITEVEN')).toBe(false);
        expect(new LearningEngine('eg-other', 'learn').isTradable('R_EG', 'DIGITEVEN')).toBe(true);
    });
});

describe('safer presets', () => {
    it('both-sides buying is off by default', () => {
        expect(buildConfigFromPreset('moderate', 100).both_sides).toBe(false);
    });
});
