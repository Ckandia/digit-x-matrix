// One table describing every contract the Bulk Trader tab can run: what Deriv calls it, how long it
// runs, what barrier it needs, whether it must wait for a trend, and which contract it switches with.
// The strategy engine and the UI both read from here, so changing a rule here changes it everywhere.
import { TBulkContractType } from './types';

export type TBulkFamily = 'digit' | 'rise_fall' | 'higher_lower' | 'touch' | 'multiplier' | 'only_up_down';
export type TTrendSide = 'bullish' | 'bearish';

export type TBulkSpec = {
    key: TBulkContractType;
    /** The contract_type Deriv receives. */
    api_type: string;
    label: string;
    group: string;
    family: TBulkFamily;
    /** The digit is chosen by the user in the form (Matches / Differs / Over / Under). */
    needs_prediction: boolean;
    /** The digit barrier is fixed by the contract (Over 4 / Under 5). */
    barrier_digit?: number;
    /** Tick durations to try, in order. Undefined = use the duration typed in the form. */
    ticks?: number[];
    /** Sign of the relative barrier for Higher/Lower and Touch/No Touch. */
    barrier_sign?: '+' | '-';
    default_barrier_offset?: number;
    /** Must see this trend on the 1-tick chart before the contract is bought. */
    trend?: TTrendSide;
};

/** Multipliers close by themselves once the profit reaches this share of the stake. */
export const MULTIPLIER_TAKE_PROFIT_PCT = 0.2;

const digit = (key: TBulkContractType, label: string, needs_prediction: boolean, extra: Partial<TBulkSpec> = {}): TBulkSpec => ({
    key,
    api_type: key,
    label,
    group: 'Digits',
    family: 'digit',
    needs_prediction,
    ...extra,
});

const SPEC_LIST: TBulkSpec[] = [
    digit('DIGITDIFF', 'Differs', true),
    digit('DIGITMATCH', 'Matches', true),
    digit('DIGITOVER', 'Over', true),
    digit('DIGITUNDER', 'Under', true),
    digit('DIGITEVEN', 'Even', false),
    digit('DIGITODD', 'Odd', false),
    digit('OVER4', 'Over 4', false, { api_type: 'DIGITOVER', barrier_digit: 4 }),
    digit('UNDER5', 'Under 5', false, { api_type: 'DIGITUNDER', barrier_digit: 5 }),
    {
        key: 'CALL',
        api_type: 'CALL',
        label: 'Rise',
        group: 'Rise / Fall',
        family: 'rise_fall',
        needs_prediction: false,
        trend: 'bullish',
    },
    {
        key: 'PUT',
        api_type: 'PUT',
        label: 'Fall',
        group: 'Rise / Fall',
        family: 'rise_fall',
        needs_prediction: false,
        trend: 'bearish',
    },
    {
        key: 'HIGHER',
        api_type: 'CALL',
        label: 'Higher',
        group: 'Higher / Lower',
        family: 'higher_lower',
        needs_prediction: false,
        ticks: [5],
        barrier_sign: '+',
        default_barrier_offset: 0.1,
        trend: 'bullish',
    },
    {
        key: 'LOWER',
        api_type: 'PUT',
        label: 'Lower',
        group: 'Higher / Lower',
        family: 'higher_lower',
        needs_prediction: false,
        ticks: [5],
        barrier_sign: '-',
        default_barrier_offset: 0.1,
        trend: 'bearish',
    },
    {
        key: 'ONETOUCH',
        api_type: 'ONETOUCH',
        label: 'Touch',
        group: 'Touch / No Touch',
        family: 'touch',
        needs_prediction: false,
        ticks: [5, 10], // 5 ticks first; 10 if Deriv refuses 5 for this market
        barrier_sign: '+',
        default_barrier_offset: 0.5,
    },
    {
        key: 'NOTOUCH',
        api_type: 'NOTOUCH',
        label: 'No Touch',
        group: 'Touch / No Touch',
        family: 'touch',
        needs_prediction: false,
        ticks: [5, 10],
        barrier_sign: '+',
        default_barrier_offset: 0.5,
    },
    {
        key: 'RUNHIGH',
        api_type: 'RUNHIGH',
        label: 'Only Ups',
        group: 'Only Ups / Only Downs',
        family: 'only_up_down',
        needs_prediction: false,
        ticks: [2, 3, 4, 5], // Deriv sells Only Ups / Downs from 2 to 5 ticks; the shortest first
        trend: 'bullish', // every tick must rise, so wait for a higher-high on the 1-tick chart first
    },
    {
        key: 'RUNLOW',
        api_type: 'RUNLOW',
        label: 'Only Downs',
        group: 'Only Ups / Only Downs',
        family: 'only_up_down',
        needs_prediction: false,
        ticks: [2, 3, 4, 5],
        trend: 'bearish',
    },
    {
        key: 'MULTUP',
        api_type: 'MULTUP',
        label: 'Multiplier Up',
        group: 'Multipliers',
        family: 'multiplier',
        needs_prediction: false,
        trend: 'bullish',
    },
    {
        key: 'MULTDOWN',
        api_type: 'MULTDOWN',
        label: 'Multiplier Down',
        group: 'Multipliers',
        family: 'multiplier',
        needs_prediction: false,
        trend: 'bearish',
    },
];

export const SPECS = Object.fromEntries(SPEC_LIST.map(s => [s.key, s])) as Record<TBulkContractType, TBulkSpec>;
export const SPEC_ORDER: TBulkSpec[] = SPEC_LIST;

export const specOf = (key: string): TBulkSpec => {
    const spec = SPECS[key as TBulkContractType];
    if (!spec) throw new Error(`Unknown contract type "${key}"`);
    return spec;
};

/**
 * Auto Flip: after a loss a contract switches with its partner, and after the next loss goes back.
 *   Even <-> Over 4      Odd <-> Under 5
 *   Touch <-> Under 5    No Touch <-> Over 4
 *   Rise <-> Under 5     Fall <-> Over 4
 *   Higher <-> Under 5   Lower <-> Over 4
 * (Over 4 / Under 5 started on their own switch with each other; multipliers with each other.)
 * Over / Under with a user-picked digit are deliberately left out: their opposite depends on the digit.
 */
export const SWITCH_PARTNER: Partial<Record<TBulkContractType, TBulkContractType>> = {
    DIGITEVEN: 'OVER4',
    DIGITODD: 'UNDER5',
    ONETOUCH: 'UNDER5',
    NOTOUCH: 'OVER4',
    CALL: 'UNDER5',
    PUT: 'OVER4',
    HIGHER: 'UNDER5',
    LOWER: 'OVER4',
    RUNHIGH: 'RUNLOW',
    RUNLOW: 'RUNHIGH',
    OVER4: 'UNDER5',
    UNDER5: 'OVER4',
    MULTUP: 'MULTDOWN',
    MULTDOWN: 'MULTUP',
};

/** The contract to trade after a loss: the partner if on the original, the original if on the partner. */
export const nextAfterLoss = (original: TBulkContractType, current: TBulkContractType): TBulkContractType => {
    if (current !== original) return original;
    return SWITCH_PARTNER[original] ?? original;
};

/** Duration list for this contract; `form_ticks` is what the form says (digit and Rise/Fall only). */
export const tickCandidates = (spec: TBulkSpec, form_ticks: number): number[] => {
    if (spec.family === 'multiplier') return [];
    return spec.ticks ?? [Math.max(1, Math.floor(Number(form_ticks) || 1))];
};

/** Relative barrier string such as "+0.5" or "-0.1" for Higher/Lower and Touch/No Touch. */
export const relativeBarrier = (spec: TBulkSpec, offset?: number): string => {
    const raw = Number(offset ?? spec.default_barrier_offset ?? 0);
    const size = Math.abs(Number.isFinite(raw) && raw > 0 ? raw : spec.default_barrier_offset ?? 0.1);
    return `${spec.barrier_sign ?? '+'}${size}`;
};

/**
 * Picks the multiplier to use from a Deriv `contracts_for` reply: of the values offered for MULTUP,
 * the one closest to 100x (moderate leverage). Undefined if the reply holds no multiplier range.
 */
export const pickMultiplier = (reply: unknown, target = 100): number | undefined => {
    let range: number[] = [];
    const walk = (node: unknown) => {
        if (range.length || !node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        if (obj.contract_type === 'MULTUP' && Array.isArray(obj.multiplier_range)) {
            range = (obj.multiplier_range as unknown[]).map(Number).filter(n => Number.isFinite(n) && n > 0);
            return;
        }
        Object.values(obj).forEach(walk);
    };
    walk(reply);
    if (!range.length) return undefined;
    return range.reduce((best, m) => (Math.abs(m - target) < Math.abs(best - target) ? m : best), range[0]);
};
