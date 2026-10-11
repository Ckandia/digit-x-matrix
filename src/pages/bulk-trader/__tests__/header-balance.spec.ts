import { pushHeaderBalance, setHeaderBalanceSink } from '../headerBalance';

describe('header balance sink', () => {
    afterEach(() => setHeaderBalanceSink(null));

    it('passes the trading connection balance to the registered sink', () => {
        const sink = jest.fn();
        setHeaderBalanceSink(sink);
        pushHeaderBalance('DOT1', 9837.02, 'USD');
        expect(sink).toHaveBeenCalledWith('DOT1', 9837.02, 'USD');
    });

    it('ignores empty account ids and non-numbers, and never throws', () => {
        const sink = jest.fn(() => {
            throw new Error('boom');
        });
        setHeaderBalanceSink(sink);
        pushHeaderBalance('', 5, 'USD');
        pushHeaderBalance('DOT1', NaN, 'USD');
        expect(sink).not.toHaveBeenCalled();
        expect(() => pushHeaderBalance('DOT1', 5, 'USD')).not.toThrow();
    });
});
