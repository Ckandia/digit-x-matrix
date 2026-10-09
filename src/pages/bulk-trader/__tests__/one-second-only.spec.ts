import { DEFAULT_STRATEGY, isOneSecondSymbol, SYMBOL_OPTIONS } from '../constants';

describe('1-second volatilities only', () => {
    it('accepts 1HZ symbols and rejects the 2-second, Jump and other indices', () => {
        ['1HZ10V', '1HZ25V', '1HZ100V', '1HZ15V'].forEach(s => expect(isOneSecondSymbol(s)).toBe(true));
        ['R_10', 'R_100', 'JD10', 'BOOM500', 'stpRNG', ''].forEach(s => expect(isOneSecondSymbol(s)).toBe(false));
    });

    it('the market picker and the default market are all 1-second', () => {
        expect(SYMBOL_OPTIONS.length).toBeGreaterThan(0);
        SYMBOL_OPTIONS.forEach(o => expect(isOneSecondSymbol(o.value)).toBe(true));
        expect(isOneSecondSymbol(DEFAULT_STRATEGY.symbol)).toBe(true);
    });
});
