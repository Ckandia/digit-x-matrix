import { buildTradeParameters, partnerCandidate, preferOneTick, pickBestGlobalCandidate } from '../autoPilotEngine';

const sig = (contract_type: string, label: string, confidence: number, extra: Record<string, unknown> = {}) =>
    ({ family: 'digits', contract_type, label, confidence, basis: 'x', ...extra }) as never;
const cand = (contract_type: string, prediction?: number | string) => ({ symbol: 'R_10', ...(sig(contract_type, contract_type, 50, { prediction }) as object) }) as never;

describe('AI Trader: quick contracts first', () => {
    it('prefers a 1-tick contract over a higher-confidence barrier contract', () => {
        const snaps = { R_10: { stats: {} as never, signals: [sig('ONETOUCH', 'Touch', 90, { family: 'touch' }), sig('DIGITEVEN', 'Even', 20)] } };
        expect(pickBestGlobalCandidate(snaps)?.contract_type).toBe('DIGITEVEN');
        expect(preferOneTick(snaps).R_10.signals.map(s => s.contract_type)).toEqual(['DIGITEVEN']);
    });
    it('falls back to the barrier contract when nothing is 1 tick', () => {
        const snaps = { R_10: { stats: {} as never, signals: [sig('ONETOUCH', 'Touch', 90, { family: 'touch' })] } };
        expect(pickBestGlobalCandidate(snaps)?.contract_type).toBe('ONETOUCH');
    });
});

describe('AI Trader: Over 4 / Under 5 and the switch pairs', () => {
    it('sends the fixed barriers', () => {
        expect(buildTradeParameters(cand('DIGITOVER', 4), 1, 'USD')).toMatchObject({ barrier: '4', duration: 1 });
        expect(buildTradeParameters(cand('DIGITUNDER', 5), 1, 'USD')).toMatchObject({ barrier: '5', duration: 1 });
    });
    it('Touch / No Touch use a 0.5 barrier for 5 ticks', () => {
        expect(buildTradeParameters(cand('ONETOUCH', '+9'), 1, 'USD')).toMatchObject({ barrier: '+0.5', duration: 5 });
        expect(buildTradeParameters(cand('NOTOUCH', '+9'), 1, 'USD')).toMatchObject({ barrier: '+0.5', duration: 5 });
    });
    it.each([
        ['DIGITEVEN', 'DIGITOVER', 4],
        ['DIGITODD', 'DIGITUNDER', 5],
        ['ONETOUCH', 'DIGITUNDER', 5],
        ['NOTOUCH', 'DIGITOVER', 4],
        ['CALL', 'DIGITUNDER', 5],
        ['PUT', 'DIGITOVER', 4],
    ])('%s switches with %s %s', (from, to, barrier) => {
        const p = partnerCandidate('R_10', cand(from) as never);
        expect([p?.contract_type, p?.prediction]).toEqual([to, barrier]);
    });
});
