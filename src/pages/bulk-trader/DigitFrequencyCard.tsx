import React from 'react';
import { localize } from '@deriv-com/translations';
import type { TDigitFreq, TDigitLogic, TDigitRank, TSnapshotMap } from './analysis-types';

const shortName = (symbol: string) => symbol.replace(/^1HZ(\d+)V$/, 'V$1 (1s)');

const RANK_ROWS: { key: 'first' | 'second' | 'third' | 'least'; label: string }[] = [
    { key: 'first', label: '1st most appearing digit' },
    { key: 'second', label: '2nd most appearing digit' },
    { key: 'third', label: '3rd most appearing digit' },
    { key: 'least', label: 'Least appearing digit' },
];

const LOGIC_ROWS: { pair: 'even_odd' | 'over_under'; a: TDigitLogic['key']; b: TDigitLogic['key']; label: string }[] = [
    { pair: 'even_odd', a: 'even', b: 'odd', label: 'Even / Odd (from the 4 digits)' },
    { pair: 'over_under', a: 'over4', b: 'under5', label: 'Over 4 / Under 5 (from the 4 digits)' },
];

const rankText = (r?: TDigitRank) => (r ? `${r.digit} · ${r.pct.toFixed(1)}%${r.tied > 0 ? ' =' : ''}` : '-');

const rankTitle = (d: TDigitFreq, r?: TDigitRank) =>
    r
        ? `Digit ${r.digit} appeared ${r.count} times in the last ${d.n} ticks (${r.pct}%)${r.tied > 0 ? `; ${r.tied} other digit(s) have the same count, so this rank is a tie-break (the digit seen most recently ranks higher)` : ''}. All digits: ${d.ranking.map(x => `${x.digit}: ${x.pct}%`).join(', ')}`
        : '';

/**
 * The backend's digit frequency: for every 1-second market, the 1st, 2nd and 3rd most appearing last digit, the least appearing digit
 * and how often each showed up in the last ~500 ticks. Below them, the frequency logic for Even / Odd and Over 4 / Under 5: each of the
 * four digits favours a contract or not (a top-3 digit favours the contract it belongs to; the least digit favours the contract it does NOT
 * belong to). At least 2 of the 4, and ahead of the opposite contract, = favoured (green): the AI adds a confidence boost. Not all four
 * have to agree, and the digits never delay a trade. Split = 2 against 2. This describes the recent ticks; it is not a prediction.
 */
export const DigitFrequencyCard = ({ snapshots }: { snapshots: TSnapshotMap }) => {
    const symbols = Object.keys(snapshots)
        .filter(s => snapshots[s]?.digit_freq?.ranking?.length)
        .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
    return (
        <div className='ai-agent-panel__history ai-agent-panel__pairs'>
            <div className='ai-agent-panel__history-head'>
                <strong>{localize('Digit frequency (1-second markets)')}</strong>
                <span>{symbols.length ? localize('{{n}} ticks per market', { n: snapshots[symbols[0]].digit_freq?.n ?? 0 }) : ''}</span>
            </div>
            {!symbols.length ? (
                <div>{localize('No data yet: the backend has not sent the digit frequency (deploy the new backend).')}</div>
            ) : (
                <>
                    <div className='ai-agent-panel__history-scroll'>
                        <table className='ai-agent-panel__history-table'>
                            <thead>
                                <tr>
                                    <th>{localize('Digit')}</th>
                                    {symbols.map(s => (
                                        <th key={s}>{shortName(s)}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {RANK_ROWS.map(({ key, label }) => (
                                    <tr key={key}>
                                        <td>{localize(label)}</td>
                                        {symbols.map(s => {
                                            const d = snapshots[s].digit_freq as TDigitFreq;
                                            return (
                                                <td key={s} className={key === 'least' ? 'is-loss' : ''} title={rankTitle(d, d[key])}>
                                                    {rankText(d[key])}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                                {LOGIC_ROWS.map(({ pair, a, b, label }) => (
                                    <tr key={pair}>
                                        <td>{localize(label)}</td>
                                        {symbols.map(s => {
                                            const d = snapshots[s].digit_freq as TDigitFreq;
                                            const side = d[pair];
                                            const la = d.logic.find(l => l.key === a);
                                            const lb = d.logic.find(l => l.key === b);
                                            const chosen = side ? d.logic.find(l => l.key === side) : undefined;
                                            const detail = [la, lb]
                                                .filter((l): l is TDigitLogic => !!l)
                                                .map(l => `${l.label}: ${l.pct}% of ticks, ${l.agree} of the 4 digits favour it (${l.top3_votes} of the top 3${l.least_inside ? ', the least digit is on this side' : ', the least digit is on the other side'}) (${l.verdict})`)
                                                .join('; ');
                                            return (
                                                <td key={s} className={chosen ? 'is-win' : ''} title={detail}>
                                                    {chosen ? `${chosen.label} · ${chosen.agree}/4 · ${chosen.pct.toFixed(1)}%` : localize('Split')}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div>
                        {localize(
                            'Each cell: the digit and its share of the last ticks (= means a tie with another digit; the digit seen most recently ranks higher). Even / Odd and Over 4 / Under 5: each of the four digits above favours a contract or not (a top-3 digit favours the contract it belongs to, the least appearing digit favours the other side). When at least 2 of the 4 favour a contract and it is ahead of its opposite it is favoured (green, shown as digits out of 4 and its share of the ticks) and its confidence gets a boost: +5 for 2, +10 for 3, +15 for 4. Split = 2 against 2. The digits never delay or block a trade. This describes the recent ticks; it does not predict the next one.'
                        )}
                    </div>
                </>
            )}
        </div>
    );
};
