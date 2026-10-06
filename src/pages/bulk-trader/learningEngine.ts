// The auto-pilot's memory. It remembers how every (symbol, contract, duration)
// combination has actually performed on THIS account, and uses that to choose
// which market and contract to try next. The time frame is not explored any more: every
// contract trades for 1 tick (barrier contracts: Deriv's shortest), see contractRules.tradeTicks.
//
// How it learns: each combination keeps wins/losses. Its win rate is a Beta
// posterior, compared against the break-even rate implied by the real payout
// (stake / payout). Untried combinations have wide uncertainty, so they get
// explored (Thompson sampling); proven ones get chosen more.
//
// Honest limit: Deriv's synthetic indices are fair random processes. Learning
// can measure whether any combination beats break-even; it cannot create an
// edge that isn't there. Expect it to conclude "nothing proven" on most
// combinations, and that is the correct, useful answer. 'edge_gate' mode
// refuses to trade until an edge is statistically demonstrated.
import { TSnapshotMap } from './analysis-types';
import { STREAK_PLAYBOOK } from './tradingKnowledge';
import { isTickTradable, loadLiveRules, markRefused, skewBucket, tradeTicks } from './contractRules';

export type TLearningMode = 'off' | 'learn' | 'edge_gate';
type TCell = { wins: number; losses: number; staked: number; profit: number; payout_ratio_sum: number };
type TCandidateLike = { symbol: string; contract_type: string; duration_ticks?: number; confidence: number; bucket?: string };
const statType = (type: string, bucket?: string) => (bucket ? `${type}@${bucket}` : type);

const MIN_EXPLORE = 20; // trades per combination before it stops counting as "exploring"
const MIN_PROVEN = 30; // trades before an edge can be called proven
const Z_LOWER = 1.96; // ~97.5% one-sided lower bound
const DEFAULT_PAYOUT_MULT = 1.95;
const STORE_KEY = 'dxm_learning_v1';
const rest_base = (process.env.NEXT_PUBLIC_BULK_TRADER_API_URL || '').trim().replace(/\/$/, '');


const randn = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
// Every synthetic index is an independent random process, so results are POOLED across markets
// ("ALL"): splitting them per market spread a few hundred trades over 150+ cells, none of which
// could ever reach the 30 trades needed to prove or disprove an edge.
const POOL = 'ALL';
const cellKey = (_symbol: string, type: string, duration: number) => `${POOL}|${type}|${duration}`;
const emptyCell = (): TCell => ({ wins: 0, losses: 0, staked: 0, profit: 0, payout_ratio_sum: 0 });
const addInto = (a: TCell, b: TCell) => {
    a.wins += b.wins;
    a.losses += b.losses;
    a.staked += b.staked;
    a.profit += b.profit;
    a.payout_ratio_sum += b.payout_ratio_sum;
};
/** Folds old per-market cells (key `SYMBOL|type|duration`) into the pooled `ALL|type|duration` cells. */
const poolCells = (cells: Record<string, TCell>): Record<string, TCell> => {
    const out: Record<string, TCell> = {};
    for (const [key, c] of Object.entries(cells)) {
        const [, type, duration] = key.split('|');
        const pk = `${POOL}|${type}|${duration}`;
        addInto((out[pk] ||= emptyCell()), c);
    }
    return out;
};
const n_of = (c?: TCell) => (c ? c.wins + c.losses : 0);

export const makeProfileId = async (loginid: string): Promise<string> => {
    try {
        const data = new TextEncoder().encode(`dxm:${loginid}`);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
            .slice(0, 32);
    } catch {
        return `p${Array.from(loginid).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}xxxxxxxx`;
    }
};

export class LearningEngine {
    mode: TLearningMode;
    private cells: Record<string, TCell> = {};
    private profile: string;

    constructor(profile: string, mode: TLearningMode = 'learn') {
        this.profile = profile;
        this.mode = mode;
        try {
            this.cells = JSON.parse(localStorage.getItem(`${STORE_KEY}:${profile}`) || '{}');
        } catch {
            this.cells = {};
        }
        this.cells = poolCells(this.cells);
    }

    /** Merges what the backend remembers (Neon) with the browser's copy: whichever has more trades wins per cell. */
    async syncFromBackend() {
        if (!rest_base) return;
        try {
            const res = await fetch(`${rest_base}/api/learning/stats/${this.profile}`);
            if (!res.ok) return;
            const { data } = await res.json();
            const remote: Record<string, TCell> = {};
            for (const r of data || []) {
                const key = cellKey(r.symbol, r.contract_type, r.duration);
                addInto((remote[key] ||= emptyCell()), {
                    wins: r.wins,
                    losses: r.losses,
                    staked: r.staked,
                    profit: r.profit,
                    payout_ratio_sum: r.payout_ratio_sum,
                });
            }
            for (const [key, cell] of Object.entries(remote)) {
                if (n_of(cell) > n_of(this.cells[key])) this.cells[key] = cell;
            }
            this.save();
        } catch {
            /* offline backend: keep working from the browser copy */
        }
    }

    /** Deriv refused this symbol/contract: skip it for the next 6 hours (shared list, see contractRules). */
    markUnavailable(symbol: string, type: string, _duration?: number) {
        markRefused(symbol, type);
    }

    private save() {
        try {
            localStorage.setItem(`${STORE_KEY}:${this.profile}`, JSON.stringify(this.cells));
        } catch {
            /* storage full or blocked */
        }
    }

    record(o: { symbol: string; contract_type: string; duration: number; stake: number; profit: number; payout?: number }) {
        const key = cellKey(o.symbol, o.contract_type, o.duration);
        const c = (this.cells[key] ||= { wins: 0, losses: 0, staked: 0, profit: 0, payout_ratio_sum: 0 });
        const win = o.profit > 0;
        c.wins += win ? 1 : 0;
        c.losses += win ? 0 : 1;
        c.staked += o.stake;
        c.profit += o.profit;
        c.payout_ratio_sum += o.payout && o.payout > o.stake ? o.payout / o.stake : 0;
        this.save();
        if (!rest_base) return;
        fetch(`${rest_base}/api/learning/outcome`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile: this.profile, ...o, symbol: POOL, payout: o.payout ?? 0 }),
        }).catch(() => undefined);
    }

    private globalPayoutMult(): number {
        let sum = 0;
        let n = 0;
        for (const c of Object.values(this.cells)) {
            sum += c.payout_ratio_sum;
            n += n_of(c);
        }
        return n > 0 && sum > 0 ? sum / n : DEFAULT_PAYOUT_MULT;
    }

    private breakeven(c?: TCell): number {
        const n = n_of(c);
        const mult = c && n > 0 && c.payout_ratio_sum > 0 ? c.payout_ratio_sum / n : this.globalPayoutMult();
        return 1 / Math.max(mult, 1.01);
    }

    private posterior(c?: TCell) {
        const a = 1 + (c?.wins ?? 0);
        const b = 1 + (c?.losses ?? 0);
        const mean = a / (a + b);
        const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
        return { mean, sd };
    }

    private lowerBound(c?: TCell) {
        const { mean, sd } = this.posterior(c);
        return mean - Z_LOWER * sd;
    }

    private sampleEdge(c?: TCell) {
        const { mean, sd } = this.posterior(c);
        return mean + sd * randn() - this.breakeven(c);
    }

    /** The one duration this contract trades for (1 tick; barrier contracts: Deriv's shortest), or -1 if it must be skipped. */
    chooseDuration(symbol: string, type: string): number {
        return tradeTicks(symbol, type) ?? -1;
    }

    /** Chooses the next trade from the live candidates, or null if nothing qualifies right now. */
    pickBest<T extends TCandidateLike>(candidates: T[]): T | null {
        let best: T | null = null;
        let bestScore = -Infinity;
        for (const cand of candidates) {
            const duration = this.chooseDuration(cand.symbol, cand.contract_type);
            if (duration < 0) continue;
            const c = this.cells[cellKey(cand.symbol, statType(cand.contract_type, cand.bucket), duration)];
            if (this.mode === 'edge_gate' && !(n_of(c) >= MIN_PROVEN && this.lowerBound(c) > this.breakeven(c))) continue;
            // Signal confidence is only a tiny tie-breaker: it is a deviation score, not a win probability.
            const score = this.sampleEdge(c) + (cand.confidence / 100) * 0.01;
            if (score > bestScore) {
                bestScore = score;
                best = { ...cand, duration_ticks: duration };
            }
        }
        return best;
    }

    /** While a combination is still being explored, cap the stake at a quarter of the base stake. */
    governStake(stake: number, baseStake: number, cand: TCandidateLike & { duration_ticks?: number }): number {
        if (this.mode !== 'learn') return stake;
        const c = this.cells[cellKey(cand.symbol, statType(cand.contract_type, cand.bucket), cand.duration_ticks ?? 0)];
        if (n_of(c) >= MIN_EXPLORE) return stake;
        return Number(Math.min(stake, Math.max(0.35, baseStake * 0.25)).toFixed(2));
    }

    /** Fetches what Deriv actually offers for these markets (see contractRules.ts). */
    loadRules(symbols: string[]) {
        return loadLiveRules(symbols);
    }

    /** Read-only copy of per-combination results, for the Strategy Lab. */
    cellsSnapshot() {
        return Object.entries(this.cells).map(([key, c]) => {
            const [symbol, contract_type, d] = key.split('|');
            const n = n_of(c);
            return {
                symbol,
                contract_type,
                duration: Number(d),
                n,
                win_rate: n ? c.wins / n : 0,
                payout_mult: n && c.payout_ratio_sum > 0 ? c.payout_ratio_sum / n : this.globalPayoutMult(),
                breakeven: this.breakeven(c),
                proven_edge: n >= MIN_PROVEN && this.lowerBound(c) > this.breakeven(c),
            };
        });
    }

    summary() {
        const rows = Object.entries(this.cells).map(([key, c]) => {
            const n = n_of(c);
            const edge = n >= MIN_PROVEN && this.lowerBound(c) > this.breakeven(c);
            return { key, n, win_rate: n ? c.wins / n : 0, breakeven: this.breakeven(c), profit: c.profit, proven_edge: edge };
        });
        return {
            total_trades: rows.reduce((s, r) => s + r.n, 0),
            combinations: rows.length,
            proven: rows.filter(r => r.proven_edge).length,
            top: rows.sort((a, b) => b.n - a.n).slice(0, 5),
        };
    }
}

/** Flattens the live snapshot map into candidate rows for pickBest. */
export const candidatesFromSnapshots = <S extends { confidence: number; contract_type: string }>(
    snapshots: TSnapshotMap,
    allowed: readonly string[]
) => {
    const out: (S & { symbol: string; bucket?: string })[] = [];
    for (const [symbol, snap] of Object.entries(snapshots)) {
        for (const s of snap.signals as unknown as S[]) {
            if (!allowed.includes(s.contract_type) || !isTickTradable(symbol, s.contract_type)) continue;
            // A signal from a named playbook strategy is scored on its own record, apart from the plain skew signals.
            const strategy = (s as { strategy?: string }).strategy;
            const bucket = strategy === 'streak_reversal' ? STREAK_PLAYBOOK.learner_bucket : skewBucket(snap.stats.recent as never, s.contract_type);
            out.push({ symbol, ...s, bucket });
        }
    }
    return out;
};
