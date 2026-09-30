// Strategy Lab: the AI's way of choosing take-profit / stop-loss and of
// checking its own strategies before trusting them.
//
// It never assumes an edge. For each learned market/contract/time-frame it
// re-plays thousands of simulated sessions using YOUR observed win rate and
// payout, then reports the TP-hit rate, SL-hit rate and the average result.
// A strategy where TP hits outnumber SL hits but the average result is
// negative is flagged as a "hit-rate illusion": the many small wins are paid
// back by the few big losses. Limits are then set by evidence:
//  - no proven edge  -> smallest allowed exposure (SL at 1/4 of your cap)
//  - proven edge     -> SL up to your cap, TP at a positive reward:risk ratio
// The AI can only tighten limits. It can never exceed the cap you set.
import type { LearningEngine } from './learningEngine';

export type TLabRow = {
    label: string;
    n: number;
    win_rate: number;
    tp_hit: number;
    sl_hit: number;
    expectancy: number; // average result per session, in units of base stake
    verdict: 'proven_edge' | 'illusion' | 'negative' | 'not_enough_data';
};

const SESSIONS = 3000;
const MAX_TRADES = 400;

const simulate = (win_rate: number, payout_mult: number, tp: number, sl: number, martingale: number, max_steps: number) => {
    let tps = 0;
    let sls = 0;
    let total = 0;
    for (let i = 0; i < SESSIONS; i++) {
        let pnl = 0;
        let stake = 1;
        let step = 1;
        for (let t = 0; t < MAX_TRADES; t++) {
            if (Math.random() < win_rate) {
                pnl += stake * (payout_mult - 1);
                stake = 1;
                step = 1;
            } else {
                pnl -= stake;
                if (step >= max_steps) {
                    stake = 1;
                    step = 1;
                } else {
                    stake *= martingale;
                    step += 1;
                }
            }
            if (pnl >= tp) {
                tps++;
                break;
            }
            if (pnl <= -sl) {
                sls++;
                break;
            }
        }
        total += pnl;
    }
    return { tp_hit: tps / SESSIONS, sl_hit: sls / SESSIONS, expectancy: total / SESSIONS };
};

/** tp and sl are in units of base stake. */
export const labReport = (learner: LearningEngine, tp_units: number, sl_units: number, martingale: number, max_steps: number): TLabRow[] =>
    learner
        .cellsSnapshot()
        .filter(c => c.n >= 10)
        .sort((a, b) => b.n - a.n)
        .slice(0, 6)
        .map(c => {
            const sim = simulate(c.win_rate, c.payout_mult, tp_units, sl_units, martingale, max_steps);
            const verdict: TLabRow['verdict'] =
                c.n < 30
                    ? 'not_enough_data'
                    : c.proven_edge && sim.expectancy > 0
                      ? 'proven_edge'
                      : sim.tp_hit > sim.sl_hit && sim.expectancy <= 0
                        ? 'illusion'
                        : 'negative';
            return { label: `${c.symbol} ${c.contract_type} ${c.duration}t`, n: c.n, win_rate: c.win_rate, ...sim, verdict };
        });

/** AI-chosen limits, always at or below the user's cap (in currency). */
export const suggestLimits = (learner: LearningEngine, cap_stop_loss: number) => {
    const proven = learner.cellsSnapshot().filter(c => c.proven_edge);
    if (proven.length === 0) {
        const stop_loss = Number((cap_stop_loss * 0.25).toFixed(2));
        return { stop_loss, take_profit: stop_loss, reason: 'No proven edge yet: keeping exposure small.' };
    }
    const best = proven.sort((a, b) => b.win_rate * b.payout_mult - a.win_rate * a.payout_mult)[0];
    const stop_loss = Number(cap_stop_loss.toFixed(2));
    const take_profit = Number((stop_loss * 1.5).toFixed(2));
    return {
        stop_loss,
        take_profit,
        reason: `Proven edge on ${best.symbol} ${best.contract_type} ${best.duration}t: full cap, 1.5x reward.`,
    };
};
