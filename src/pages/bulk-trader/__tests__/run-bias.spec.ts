import { biasBoost, BIAS_WEIGHT, runBiasZ } from '../runBias';
import type { TSymbolSnapshot } from '../analysis-types';

const snap = (rows: { key: string; z: number | null }[]) => ({ runs: { n: 499, min_run: 3, recent_ticks: 100, ranked: [], rows } }) as unknown as TSymbolSnapshot;

describe('run bias', () => {
    it('reads the z of the matching contract', () => {
        const s = snap([
            { key: 'even', z: 2.5 },
            { key: 'rise', z: 1.1 },
            { key: 'fall', z: null },
        ]);
        expect(runBiasZ(s, 'DIGITEVEN')).toBe(2.5);
        expect(runBiasZ(s, 'CALL')).toBe(1.1);
        expect(runBiasZ(s, 'RUNHIGH')).toBe(1.1); // Only Up uses the rise run
        expect(runBiasZ(s, 'PUT')).toBe(0); // unknown
        expect(runBiasZ(undefined, 'DIGITEVEN')).toBe(0);
        expect(runBiasZ(s, 'ONETOUCH')).toBe(0); // Touch has no per-tick run rule
    });
    it('below-chance gaps never help or hurt', () => {
        expect(runBiasZ(snap([{ key: 'odd', z: -3 }]), 'DIGITODD')).toBe(0);
        expect(biasBoost(-3)).toBe(0);
    });
    it('is a small, capped nudge that cannot beat a closer entry', () => {
        expect(biasBoost(100)).toBeCloseTo(BIAS_WEIGHT);
        expect(biasBoost(2)).toBeCloseTo(BIAS_WEIGHT / 2);
        // a run two ticks into a three-tick entry scores 1; one tick in scores 0.45: even the maximum boost cannot flip that
        expect(0.45 + BIAS_WEIGHT).toBeLessThan(1);
    });
});
