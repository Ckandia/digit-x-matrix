// What the AI has been taught: the owner's trading notes (Build.docx), as data the code reads.
//
// Single source of truth. The duration rule (contractRules.tradeTicks), the contract list and the
// "AI playbook" shown in the panel all read from here, so changing a note in one place changes
// the AI's behaviour everywhere.
//
// The notes cover four things:
//   1. What every Deriv contract is, how it works and a trading tip for it.
//   2. Which contracts suit 1 tick and which need more than 1 tick.
//   3. Which barrier contracts suit a quiet/ranging market and which a volatile/trending one.
//   4. The Even/Odd streak "snap-back" idea, including the notes' own warning about the
//      gambler's fallacy (wait for a rare 5+ streak and for tick speed to slow).
//
// Nothing in this file is a promise of profit. The notes themselves say Even/Odd is "near 50/50
// odds minus payout structure". The learner (learningEngine.ts) is what measures whether any of
// these ideas actually pay on the real account, and 'edge_gate' mode only trades proven ones.

export type TTickSuitability = 'one_tick' | 'multi_tick';
/** Market state a barrier contract is easiest in (from the notes' barrier section). */
export type TBarrierRegime = 'ranging' | 'trending' | 'balanced';

export type TContractNote = {
    name: string;
    group: string;
    /** Deriv contract_type codes this entry covers. Empty when the code is shared with another entry. */
    types: string[];
    how: string;
    tip: string;
    tick: TTickSuitability;
    /** Needs a price barrier chosen by the AI (the only contracts allowed to run longer than 1 tick). */
    barrier?: boolean;
    regime?: TBarrierRegime;
    /** False when the AI cannot place this contract yet, with the reason. */
    supported: boolean;
    unsupported_reason?: string;
};

export const CONTRACT_NOTES: TContractNote[] = [
    // 1. Directional & trend
    {
        name: 'Rise / Fall',
        group: 'Directional & Trend',
        types: ['CALL', 'PUT'],
        how: 'Exit price strictly higher (Rise) or strictly lower (Fall) than the entry price. A flat tick loses both.',
        tip: 'Gauge momentum on very short charts (5-tick or 1-minute).',
        tick: 'one_tick',
        supported: true,
    },
    {
        name: 'Higher / Lower',
        group: 'Directional & Trend',
        types: [], // Deriv uses CALL/PUT with a barrier: the same codes as Rise/Fall, so it cannot be told apart here
        how: 'Win if the exit price finishes above (Higher) or below (Lower) a barrier you choose.',
        tip: 'Best when a strong breakout past a clear structural level is expected.',
        tick: 'multi_tick',
        barrier: true,
        regime: 'balanced',
        supported: false,
        unsupported_reason:
            'Deriv sells it under the same CALL/PUT codes as Rise/Fall, so the shared refusal list could switch Rise/Fall off by mistake. Needs its own contract key first.',
    },
    {
        name: 'Only Ups / Only Downs',
        group: 'Directional & Trend',
        types: ['RUNHIGH', 'RUNLOW'],
        how: 'Win only if every tick after entry rises (Ups) or falls (Downs). One flat or reversed tick loses.',
        tip: 'Extremely high risk; only in clean aggressive impulse waves.',
        tick: 'multi_tick',
        supported: true,
    },
    // 2. Range & boundary
    {
        name: 'Ends Between',
        group: 'Range & Boundary',
        types: ['EXPIRYRANGE'],
        how: 'Win if the final tick finishes inside your upper and lower barriers.',
        tip: 'Suits low-volatility consolidating markets.',
        tick: 'multi_tick',
        barrier: true,
        regime: 'ranging',
        supported: true,
    },
    {
        name: 'Ends Outside',
        group: 'Range & Boundary',
        types: ['EXPIRYMISS'],
        how: 'Win if the final tick finishes above the high barrier or below the low barrier.',
        tip: 'Suits the moments right before major news or sudden breakouts.',
        tick: 'multi_tick',
        barrier: true,
        regime: 'trending',
        supported: true,
    },
    {
        name: 'Stays Between',
        group: 'Range & Boundary',
        types: ['RANGE'],
        how: 'Watches every tick: win if the price never touches or breaches either barrier.',
        tip: 'Needs quiet, range-bound conditions.',
        tick: 'multi_tick',
        barrier: true,
        regime: 'ranging',
        supported: true,
    },
    {
        name: 'Goes Outside',
        group: 'Range & Boundary',
        types: ['UPORDOWN'],
        how: 'Watches every tick: win if the price touches or breaches either barrier at any point.',
        tip: 'Needs a sharp spike or expansion.',
        tick: 'multi_tick',
        barrier: true,
        regime: 'trending',
        supported: true,
    },
    // 3. Barrier touch & tick based
    {
        name: 'Touch',
        group: 'Barrier Touch & Tick-Based',
        types: ['ONETOUCH'],
        how: 'Win if the price reaches the barrier at any point in the contract.',
        tip: 'Set the target just past minor local highs/lows where price tends to hunt liquidity.',
        tick: 'multi_tick',
        barrier: true,
        regime: 'trending',
        supported: true,
    },
    {
        name: 'No Touch',
        group: 'Barrier Touch & Tick-Based',
        types: ['NOTOUCH'],
        how: 'Win if the price completely avoids the barrier the entire time.',
        tip: 'Put the barrier far enough outside the current range during quiet phases.',
        tick: 'multi_tick',
        barrier: true,
        regime: 'ranging',
        supported: true,
    },
    {
        name: 'High Tick / Low Tick',
        group: 'Barrier Touch & Tick-Based',
        types: ['TICKHIGH', 'TICKLOW'],
        how: 'Pick one of the next 5 ticks: win if it is the highest (High Tick) or lowest (Low Tick) of the five.',
        tip: 'Pure micro-tick statistics, not chart patterns.',
        tick: 'multi_tick',
        supported: true,
    },
    // 4. Mathematical & averaging
    {
        name: 'Even / Odd',
        group: 'Mathematical & Averaging',
        types: ['DIGITEVEN', 'DIGITODD'],
        how: 'Win if the last digit of the exit tick is even (0,2,4,6,8) or odd (1,3,5,7,9).',
        tip: 'A near 50/50 probability game minus the payout margin. Needs strict risk management.',
        tick: 'one_tick',
        supported: true,
    },
    {
        name: 'Asians',
        group: 'Mathematical & Averaging',
        types: ['ASIANU', 'ASIAND'],
        how: 'Win if the exit price is above (Up) or below (Down) the average of all ticks in the contract.',
        tip: 'Smooths spike volatility because the average path matters, not just the last tick.',
        tick: 'multi_tick',
        supported: true,
    },
    {
        name: 'Reset Call / Reset Put',
        group: 'Mathematical & Averaging',
        types: ['RESETCALL', 'RESETPUT'],
        how: 'Like Rise/Fall, but the barrier can reset to a new point mid-contract, giving a second chance.',
        tip: 'Needs a duration long enough for the reset to trigger.',
        tick: 'multi_tick',
        supported: true,
    },
    // 5. Growth & risk management
    {
        name: 'Accumulators',
        group: 'Growth & Risk Management',
        types: ['ACCU'],
        how: 'Payout compounds each tick while the price stays inside a channel; one breach ends the trade as a loss.',
        tip: 'Low growth rate (1%) for a wider buffer, high (5%) for fast compounding in low-noise trends.',
        tick: 'multi_tick',
        supported: false,
        unsupported_reason: 'An open-position contract (no fixed duration). It needs its own monitoring and exit logic, which the fixed-duration engine does not have.',
    },
    {
        name: 'Multipliers',
        group: 'Growth & Risk Management',
        types: ['MULTUP', 'MULTDOWN'],
        how: 'Long/short position with a multiplier (x100, x500). Profit and loss are magnified; the loss cannot exceed the stake.',
        tip: 'Trend-following with a predefined stop loss.',
        tick: 'multi_tick',
        supported: false,
        unsupported_reason: 'A CFD-style position held for seconds to hours. It needs its own monitoring and exit logic, which the fixed-duration engine does not have.',
    },
];

const byType = new Map<string, TContractNote>();
for (const note of CONTRACT_NOTES) for (const t of note.types) byType.set(t, note);

export const noteFor = (contract_type: string): TContractNote | undefined => byType.get(contract_type);

/** True for contracts that need a price barrier: the only ones the AI may trade for longer than 1 tick. */
export const isBarrierContract = (contract_type: string): boolean => !!noteFor(contract_type)?.barrier;

/** Which market state a barrier contract is easiest in, per the notes. */
export const regimeFor = (contract_type: string): TBarrierRegime | undefined => noteFor(contract_type)?.regime;

/** Contract codes the AI is allowed to place (everything the notes mark as supported). */
export const supportedTypes = (): string[] => CONTRACT_NOTES.filter(n => n.supported).flatMap(n => n.types);

// ---- The Even/Odd streak "snap-back" playbook -----------------------------------------------
// Mirrored by backend/src/streakStrategy.js (the backend is plain JS and cannot import this file):
// keep the two in step when changing a number.
export const STREAK_PLAYBOOK = {
    /** The notes: don't bet a reversal after 2 evens; wait for a rare 5+ streak. */
    min_streak: 5,
    /** Tick speed = average absolute price change per tick. Compared over the last N ticks... */
    velocity_recent_ticks: 5,
    /** ...against the N ticks before them. */
    velocity_baseline_ticks: 20,
    /** "Slowing" = recent speed is below this fraction of the baseline speed. */
    velocity_slow_ratio: 0.8,
    /** Learner bucket: results of this strategy are recorded on their own, apart from other Even/Odd signals. */
    learner_bucket: 'streak',
} as const;

/** The playbook as plain sentences, for the panel. */
export const playbookLines = (): string[] => [
    'Every contract trades for 1 tick, except barrier contracts (Touch/No Touch, Stays Between/Goes Outside, Ends Between/Outside), which use the shortest duration Deriv offers.',
    'Suited for 1 tick: Even/Odd and Rise/Fall. Everything else needs more than 1 tick and is skipped, because Deriv does not sell it at 1 tick.',
    'Quiet / ranging market: prefers Stays Between, No Touch and Ends Between. Volatile / trending market: prefers Touch, Goes Outside and Ends Outside.',
    `Even/Odd streaks: waits for a rare ${STREAK_PLAYBOOK.min_streak}+ streak AND for tick speed to slow before betting the reversal, never after just 2.`,
    'Not yet tradable: Higher/Lower, Accumulators, Multipliers (they need their own execution logic).',
    'Every idea above is tested on your own account results; in "Only trade a proven edge" mode the AI trades only what has actually beaten break-even.',
];
