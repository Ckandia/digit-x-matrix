import React from 'react';
import { localize } from '@deriv-com/translations';
import type { TSnapshotMap } from './analysis-types';

const ORDER: { key: string; label: string }[] = [
    { key: 'even', label: 'Even' },
    { key: 'odd', label: 'Odd' },
    { key: 'over4', label: 'Over 4' },
    { key: 'under5', label: 'Under 5' },
    { key: 'rise', label: 'Rise / Only Up' },
    { key: 'fall', label: 'Fall / Only Down' },
];
const shortName = (symbol: string) => symbol.replace(/^1HZ(\d+)V$/, 'V$1 (1s)');

/**
 * Market bias: for every 1-second market, how often three or more consecutive ticks favoured each contract (Even 2,4,6 / Odd 1,3,7 /
 * Over 4 5,8,9 / Under 5 2,1,4 / rising / falling ticks). Each cell is the % of three-tick windows that were all in the contract's
 * favour; green = clearly above what a fair market gives. The entry reader uses it to choose between equally ready entries.
 */
export const RunBiasCard = ({ snapshots }: { snapshots: TSnapshotMap }) => {
    const symbols = Object.keys(snapshots)
        .filter(s => snapshots[s]?.runs)
        .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
    return (
        <div className='ai-agent-panel__history ai-agent-panel__runs'>
            <div className='ai-agent-panel__history-head'>
                <strong>{localize('Market bias: 3+ ticks in a row (1-second markets)')}</strong>
                <span>{symbols.length ? localize('{{n}} ticks per market', { n: snapshots[symbols[0]].runs?.n ?? 0 }) : ''}</span>
            </div>
            {!symbols.length ? (
                <div>{localize('No data yet: the backend has not sent the run scan (deploy the new backend).')}</div>
            ) : (
                <>
                    <div className='ai-agent-panel__history-scroll'>
                        <table className='ai-agent-panel__history-table'>
                            <thead>
                                <tr>
                                    <th>{localize('Contract (3+ ticks)')}</th>
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
                                            const row = snapshots[s].runs?.rows.find(r => r.key === key);
                                            return (
                                                <td
                                                    key={s}
                                                    className={row?.favoured ? 'is-win' : ''}
                                                    title={
                                                        row
                                                            ? `${row.triples}/${row.windows} three-tick windows, fair market ${row.expected_pct}%, z ${row.z ?? '-'}, bias ${row.bias}/100; ${row.runs} separate runs (longest ${row.longest}), run now: ${row.current_run}`
                                                            : ''
                                                    }
                                                >
                                                    {row ? `${row.pct.toFixed(1)}%` : '-'}
                                                    {row && row.current_run > 0 ? ` \u00B7${row.current_run}` : ''}
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
                            'Each cell: % of three-tick windows in which all three ticks were in the contract\'s favour (a fair market gives 12.5%; Rise/Fall a little less because equal ticks count for neither). The small number after the dot is the run in progress right now (2 = the next favouring tick makes three). Green = clearly above a fair market (z of 1.5 or more): the higher it is, the more this market has favoured that contract lately. This describes the last ~500 ticks; it is not a promise about the next tick, and about 1 cell in 12 turns green by chance alone. The AI uses it only to choose between entries that are equally close to firing.'
                        )}
                    </div>
                </>
            )}
        </div>
    );
};
