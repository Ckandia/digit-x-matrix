import React from 'react';
import { localize } from '@deriv-com/translations';
import type { TSnapshotMap } from './analysis-types';

const ORDER: { key: string; label: string }[] = [
    { key: 'even', label: 'Even' },
    { key: 'odd', label: 'Odd' },
    { key: 'over4', label: 'Over 4' },
    { key: 'under5', label: 'Under 5' },
    { key: 'rise', label: 'Rise' },
    { key: 'fall', label: 'Fall' },
    { key: 'only_up', label: 'Only Up' },
    { key: 'only_down', label: 'Only Down' },
    { key: 'touch', label: 'Touch' },
    { key: 'no_touch', label: 'No Touch' },
];
const shortName = (symbol: string) => symbol.replace(/^1HZ(\d+)V$/, 'V$1 (1s)');

/**
 * The backend's two-tick scan: for every 1-second market, how often each contract's pattern showed up on two consecutive ticks
 * (% of the last ~500 ticks' two-tick windows). Cells marked "above chance" are the ones the AI may paper-test through the virtual hook.
 */
export const PairFrequencyCard = ({ snapshots }: { snapshots: TSnapshotMap }) => {
    const symbols = Object.keys(snapshots)
        .filter(s => snapshots[s]?.pairs)
        .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
    return (
        <div className='ai-agent-panel__history ai-agent-panel__pairs'>
            <div className='ai-agent-panel__history-head'>
                <strong>{localize('Two-tick pattern frequencies (1-second markets)')}</strong>
                <span>{symbols.length ? localize('{{n}} two-tick windows per market', { n: snapshots[symbols[0]].pairs?.n ?? 0 }) : ''}</span>
            </div>
            {!symbols.length ? (
                <div>{localize('No data yet: the backend has not sent the pair scan (deploy the new backend).')}</div>
            ) : (
                <>
                    <div className='ai-agent-panel__history-scroll'>
                        <table className='ai-agent-panel__history-table'>
                            <thead>
                                <tr>
                                    <th>{localize('Contract (both ticks)')}</th>
                                    {symbols.map(s => (
                                        <th key={s}>{shortName(s)}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {ORDER.map(({ key, label }) => (
                                    <tr key={key}>
                                        <td>{localize(label)}</td>
                                        {symbols.map(s => {
                                            const row = snapshots[s].pairs?.rows.find(r => r.key === key);
                                            const above = !!row && row.z !== null && row.z >= 1.5;
                                            return (
                                                <td
                                                    key={s}
                                                    className={above ? 'is-win' : ''}
                                                    title={row ? `${row.hits} windows, chance alone ${row.expected_pct ?? '-'}%, z ${row.z ?? '-'}` : ''}
                                                >
                                                    {row ? `${row.pct.toFixed(1)}%` : '-'}
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
                            'Even/Odd/Over 4/Under 5: both of the two ticks follow the pattern. Rise/Fall: the second tick ends above/below the entry. Only Up/Down: both ticks rise/fall. Touch/No Touch: the price does/does not reach +0.5 within the two ticks. Green = clearly above what chance alone gives; the AI paper-tests those through the virtual hook and trades live only on a paper win.'
                        )}
                    </div>
                </>
            )}
        </div>
    );
};
