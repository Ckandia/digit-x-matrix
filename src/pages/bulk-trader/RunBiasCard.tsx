import React from 'react';
import { localize } from '@deriv-com/translations';
import type { TDigitFrequency, TDigitRank, TSnapshotMap } from './analysis-types';

const ORDER: { key: string; label: string }[] = [
    { key: 'even', label: 'Even' },
    { key: 'odd', label: 'Odd' },
    { key: 'over4', label: 'Over 4' },
    { key: 'under5', label: 'Under 5' },
    { key: 'rise', label: 'Rise' },
    { key: 'fall', label: 'Fall' },
    { key: 'only_up', label: 'Only Ups' },
    { key: 'only_down', label: 'Only Downs' },
    { key: 'even_under5', label: 'Even + Under 5 together' },
    { key: 'odd_over4', label: 'Odd + Over 4 together' },
];
const shortName = (symbol: string) => symbol.replace(/^1HZ(\d+)V$/, 'V$1 (1s)');

/**
 * The backend's run bias: for every 1-second market, how strongly the last ticks favour each contract, measured as its share of
 * all the runs of consecutive ticks (50% = balanced; the higher, the more the market favours it). Even/Odd and Over 4/Under 5 show
 * the 2-tick bias / 3-tick bias; the other contracts the bias from 2 ticks. A number in brackets is
 * a run that is on right now; green means the backend has flagged it as an entry signal, which is what the AI buys on.
 */
const RunBiasTable = ({ snapshots }: { snapshots: TSnapshotMap }) => {
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
                                    <th key={s} title={localize('Decimal places this market prints: the last digit is read at this place')}>
                                        {shortName(s)}
                                        {snapshots[s].run_bias?.decimals !== undefined ? ` · ${snapshots[s].run_bias?.decimals}dp` : ''}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {ORDER.map(({ key, label }) => (
                                <tr key={key}>
                                    <td>{localize(label)}</td>
                                    {symbols.map(s => {
                                        const row = snapshots[s].run_bias?.rows.find(r => r.key === key) ?? snapshots[s].run_bias?.pairs?.find(r => r.key === key);
                                        const entry = !!row && ('types' in row ? entryKeys(s).has((row as { types: string[] }).types[0]) : entryKeys(s).has((row as { contract_type: string }).contract_type));
                                        return (
                                            <td key={s} className={entry ? 'is-win' : ''} title={row ? `${row.runs} runs, ${row.ticks_in_runs} ticks in runs, longest ${row.longest}. Replayed entry and exit ticks after the pattern: ${(row.levels ?? []).map(l => `${l.min_run}+ ticks: ${l.wins ?? 0}/${l.outcomes ?? 0} won${l.hit == null ? '' : ` (${l.hit}%)`}`).join(', ')}` : ''}>
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

const CONTRACT_ROWS: { key: string; label: string }[] = [
    { key: 'even', label: 'Even' },
    { key: 'odd', label: 'Odd' },
    { key: 'over4', label: 'Over 4' },
    { key: 'under5', label: 'Under 5' },
];

/**
 * The backend's digit frequency for every 1-second market: the 1st, 2nd and 3rd most frequent digit and the least frequent digit of
 * the last ticks (with their share of the window), and what those four digits say about Even / Odd / Over 4 / Under 5: how many of the
 * four support the contract and the strength % the AI ranks it by. Two supporting digits already make a bias; green = the frequency is in
 * favour of the contract, which (with 2 consecutive ticks) is what the AI buys on.
 */
const DigitFrequencyTable = ({ snapshots }: { snapshots: TSnapshotMap }) => {
    const symbols = Object.keys(snapshots)
        .filter(s => snapshots[s]?.run_bias?.digits)
        .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
    const ranks: { label: string; pick: (d: TDigitFrequency) => TDigitRank }[] = [
        { label: 'Most frequent digit', pick: d => d.first },
        { label: '2nd most frequent', pick: d => d.second },
        { label: '3rd most frequent', pick: d => d.third },
        { label: 'Least frequent digit', pick: d => d.least },
    ];
    return (
        <div className='ai-agent-panel__history ai-agent-panel__pairs'>
            <div className='ai-agent-panel__history-head'>
                <strong>{localize('Digit frequency: the 4 key digits of every 1s market')}</strong>
                <span>{symbols.length ? localize('{{n}} ticks per market', { n: snapshots[symbols[0]].run_bias?.digits?.n ?? 0 }) : ''}</span>
            </div>
            {!symbols.length ? (
                <div>{localize('No data yet: the backend has not sent the digit frequency (deploy the new backend).')}</div>
            ) : (
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
                            {ranks.map(({ label, pick }) => (
                                <tr key={label}>
                                    <td>{localize(label)}</td>
                                    {symbols.map(s => {
                                        const d = snapshots[s].run_bias?.digits;
                                        const r = d ? pick(d) : null;
                                        return <td key={s}>{r ? `${r.digit} · ${r.pct.toFixed(1)}%` : '-'}</td>;
                                    })}
                                </tr>
                            ))}
                            {CONTRACT_ROWS.map(({ key, label }) => (
                                <tr key={key}>
                                    <td>{localize(label)}</td>
                                    {symbols.map(s => {
                                        const c = snapshots[s].run_bias?.digits?.contracts?.[key];
                                        return (
                                            <td
                                                key={s}
                                                className={c?.favoured ? 'is-win' : ''}
                                                title={c ? `${c.support} of the 4 key digits support it (${c.supporting.join(', ') || 'none'}); ${c.share.toFixed(1)}% of the ticks ended on its digits` : ''}
                                            >
                                                {c ? `${c.support}/4 · ${c.share.toFixed(0)}%${c.favoured ? ` · ${c.strength}%` : ''}` : '-'}
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

export const RunBiasCard = ({ snapshots }: { snapshots: TSnapshotMap }) => (
    <>
        <DigitFrequencyTable snapshots={snapshots} />
        <RunBiasTable snapshots={snapshots} />
    </>
);
