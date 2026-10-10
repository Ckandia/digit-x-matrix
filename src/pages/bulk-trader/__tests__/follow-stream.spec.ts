import { followsStream } from '../autoPilotEngine';

describe('followsStream (enter only while the latest ticks point the contract\'s way)', () => {
    const p = (digits: number[]) => digits.map(d => 100 + d / 100); // pip 2: last digit = d
    it('Even needs even last digits, Odd odd', () => {
        expect(followsStream('DIGITEVEN', undefined, p([3, 4, 8]), 2, 2)).toBe(true);
        expect(followsStream('DIGITEVEN', undefined, p([4, 8, 7]), 2, 2)).toBe(false);
        expect(followsStream('DIGITODD', undefined, p([2, 3, 9]), 2, 2)).toBe(true);
    });
    it('Under 5 needs digits 0-4, Over 4 needs 5-9', () => {
        expect(followsStream('DIGITUNDER', 5, p([9, 0, 4]), 2, 2)).toBe(true);
        expect(followsStream('DIGITUNDER', 5, p([0, 4, 5]), 2, 2)).toBe(false);
        expect(followsStream('DIGITOVER', 4, p([0, 5, 9]), 2, 2)).toBe(true);
        expect(followsStream('DIGITOVER', 4, p([5, 9, 4]), 2, 2)).toBe(false);
    });
    it('Rise needs rising ticks, Fall falling ticks', () => {
        expect(followsStream('CALL', undefined, [1, 2, 3], 2, 2)).toBe(true);
        expect(followsStream('CALL', undefined, [1, 3, 2], 2, 2)).toBe(false);
        expect(followsStream('PUT', undefined, [3, 2, 1], 2, 2)).toBe(true);
        expect(followsStream('PUT', undefined, [3, 3, 1], 2, 2)).toBe(false);
    });
    it('contracts without a rule return null', () => {
        expect(followsStream('ONETOUCH', undefined, [1, 2, 3], 2, 2)).toBeNull();
    });
});
