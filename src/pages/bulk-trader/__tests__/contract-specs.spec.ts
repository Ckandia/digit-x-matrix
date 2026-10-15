import { nextAfterLoss, pickMultiplier, relativeBarrier, SPECS, SWITCH_PARTNER, tickCandidates } from '../contractSpecs';
import { detectTrend } from '../trendFilter';

const BULL = [1, 2, 3, 2, 1, 2, 3, 4, 3, 2];
const BEAR = [9, 8, 7, 8, 9, 8, 7, 6, 7, 8];

describe('switch map', () => {
    it.each([
        ['DIGITEVEN', 'OVER4'],
        ['DIGITODD', 'UNDER5'],
        ['ONETOUCH', 'UNDER5'],
        ['NOTOUCH', 'OVER4'],
        ['CALL', 'UNDER5'],
        ['PUT', 'OVER4'],
        ['HIGHER', 'UNDER5'],
        ['LOWER', 'OVER4'],
    ] as const)('%s switches with %s and back', (start, partner) => {
        expect(SWITCH_PARTNER[start]).toBe(partner);
        expect(nextAfterLoss(start, start)).toBe(partner);
        expect(nextAfterLoss(start, partner)).toBe(start);
    });
});

describe('contract specs', () => {
    it('Over 4 / Under 5 are digit Over/Under with a fixed barrier', () => {
        expect(SPECS.OVER4).toMatchObject({ api_type: 'DIGITOVER', barrier_digit: 4 });
        expect(SPECS.UNDER5).toMatchObject({ api_type: 'DIGITUNDER', barrier_digit: 5 });
    });
    it('Higher/Lower use 5 ticks and a 0.1 barrier; Touch/No Touch try 5 then 10 ticks with 0.5', () => {
        expect(tickCandidates(SPECS.HIGHER, 1)).toEqual([5]);
        expect(relativeBarrier(SPECS.HIGHER)).toBe('+0.1');
        expect(relativeBarrier(SPECS.LOWER)).toBe('-0.1');
        expect(tickCandidates(SPECS.ONETOUCH, 1)).toEqual([5, 10]);
        expect(relativeBarrier(SPECS.NOTOUCH)).toBe('+0.5');
    });
    it('picks the multiplier closest to 100x from contracts_for', () => {
        const reply = { contracts_for: { available: [{ contract_type: 'MULTUP', multiplier_range: [40, 200, 500] }] } };
        expect(pickMultiplier(reply)).toBe(40);
        expect(pickMultiplier({ contracts_for: { available: [] } })).toBeUndefined();
    });
});

describe('trend detection (1-tick chart)', () => {
    it('bullish on a higher high, bearish on a lower low, none otherwise', () => {
        expect(detectTrend(BULL)).toBe('bullish');
        expect(detectTrend(BEAR)).toBe('bearish');
        expect(detectTrend([5, 5, 5, 5, 5, 5, 5, 5])).toBe('none');
        expect(detectTrend([1, 2])).toBe('none');
    });
});
