// Market bias from the backend's run scan (backend/src/runScan.js): how often three or more consecutive ticks favoured each
// ticked contract on each market. The entry reader uses it ONLY to choose between entries that are equally close to firing.
// It describes what the tick stream has done lately, not what the next tick will do (these markets are random processes).
import type { TSymbolSnapshot } from './analysis-types';

export const RUN_KEY_BY_TYPE: Record<string, string> = {
    DIGITEVEN: 'even',
    DIGITODD: 'odd',
    DIGITOVER: 'over4',
    DIGITUNDER: 'under5',
    CALL: 'rise',
    RUNHIGH: 'rise',
    PUT: 'fall',
    RUNLOW: 'fall',
};

/** The largest amount bias can add to an entry score (an entry's closeness is 0..1, so bias only reorders near-equal entries). */
export const BIAS_WEIGHT = 0.15;
const BIAS_Z_CAP = 4;

/** z-score of the contract's 3-tick windows against a fair market on this market (0 when unknown or below chance). */
export const runBiasZ = (snapshot: TSymbolSnapshot | undefined, type: string): number => {
    const key = RUN_KEY_BY_TYPE[type];
    const row = key ? snapshot?.runs?.rows.find(r => r.key === key) : undefined;
    return row && row.z !== null && Number.isFinite(row.z) ? Math.max(0, row.z) : 0;
};

export const biasBoost = (z: number): number => (Math.min(BIAS_Z_CAP, Math.max(0, z)) / BIAS_Z_CAP) * BIAS_WEIGHT;
