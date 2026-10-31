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
    { key: 'only_up', label: 'Only Ups' },
    { key: 'only_down', label: 'Only Downs' },
    { key: 'touch', label: 'Touch' },
    { key: 'no_touch', label: 'No Touch' },
];
const shortName = (symbol: string) => symbol.replace(/^1HZ(\d+)V$/, 'V$1 (1s)');

/**
 * The backend's run bias: for every 1-second market, how strongly the last ticks favour each contract, measured as its share of
 * all the runs of consecutive ticks (50% = balanced; the higher, the more the market favours it). Even/Odd and Over 4/Under 5 show
 * the 2-tick bias / 3-tick bias; the other contracts the bias from 2 ticks. A number in brackets is
 * a run that is on right now; green means the backend has flagged it as an entry signal, which is what the AI buys on.
 */
export const RunBiasCard = ({ snapshots }: { snapshots: TSnapshotMap }) => {
    const symbols = Object.keys(snapshots)
        .filter(s => snapshots[s]?.run_bias?.rows?.length)
        .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
    const entryKeys = (symbol: string) => new Set((snapshots[symbol].signals ?? []).filter(sig => sig.family === 'run_bias' && sig.entry).map(sig => sig.contract_type));
    return (
        <div className='ai-agent-panel__history ai-agent-panel__pairs'>
            <div className='ai-agent-panel__history-head'>
                <strong>{localize('Run bias: consecutive ticks in favour of a contract')}</strong>
                <span>{symbols.length ? localize('{{n}} ticks per market', { n: snapshots[symbols[0]].run_bias?.n ?? 0 }) : ''}</span>
            </div>
            {!symbols.length ? (
                <div>{localize('No data yet: the backend has not sent the run bias (deploy the new backend).')}</div>
            ) : (
                <div className='ai-agent-panel__history-scroll'>
                    <table className='ai-agent-panel__history-table'>
                        <thead>
                            <tr>
                                <th>{localize('Contract')}</th>
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
                                        const row = snapshots[s].run_bias?.rows.find(r => r.key === key);
                                        const entry = !!row && entryKeys(s).has(row.contract_type);
                                        return (
                                            <td key={s} className={entry ? 'is-win' : ''} title={row ? `${row.runs} runs, ${row.ticks_in_runs} ticks in runs, longest ${row.longest}` : ''}>
                                                {row ? `${(row.levels?.length ? row.levels.map(l => `${l.bias.toFixed(0)}%`).join(' / ') : `${row.bias.toFixed(0)}%`)}${row.current ? ` (${row.current})` : ''}` : '-'}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};
