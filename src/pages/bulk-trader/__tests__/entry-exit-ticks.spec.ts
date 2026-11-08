import { describeTicks } from '../autoPilotEngine';

const cand = (contract_type: string, pattern: string[]) => ({ symbol: 'R_X', contract_type, label: 'x', run: { pattern } }) as never;

describe('the three ticks of a trade as printed in the log', () => {
    it('digit contracts show the pattern digits, the entry digit and the exit digit that decides the trade', () => {
        const t = describeTicks(cand('DIGITEVEN', ['2', '4']), { entry_tick_display_value: '1234.56', exit_tick_display_value: '1234.78' } as never);
        expect(t.signal).toBe('2, 4');
        expect(t.entry).toBe('6');
        expect(t.exit).toBe('8');
        expect(t.text).toContain('exit tick 8');
    });

    it('digit 0 is kept: an exit price printed 100.50 ends in 0', () => {
        const t = describeTicks(cand('DIGITUNDER', ['2', '1']), { entry_tick_display_value: '100.37', exit_tick_display_value: '100.50' } as never);
        expect(t.exit).toBe('0');
    });

    it('price contracts show the full entry and exit prices', () => {
        const t = describeTicks(cand('CALL', ['100.10', '100.20']), { entry_tick_display_value: '100.20', exit_tick_display_value: '100.31' } as never);
        expect(t.entry).toBe('100.20');
        expect(t.exit).toBe('100.31');
        expect(t.text).toContain('signal 100.10, 100.20');
    });

    it('a contract without the tick fields still logs something readable', () => {
        const t = describeTicks(cand('RUNHIGH', []), {} as never);
        expect(t.text).toContain('entry tick ?');
    });
});
