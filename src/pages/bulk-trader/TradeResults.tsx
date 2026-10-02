import React from 'react';
import { localize } from '@deriv-com/translations';
import { TActivity } from './tradeBus';
import { getDurationTicks, TTradeRow } from './tradeHistory';
import './ai-agent-panel.scss';

// Results table + activity/errors log, shared look with the AI Trader tab.
const TradeResults = ({
    rows,
    activity,
    onClear,
}: {
    rows: TTradeRow[];
    activity: TActivity[];
    onClear: () => void;
}) => {
    if (rows.length === 0 && activity.length === 0) return null;
    const closed = rows.filter(r => !r.open);
    return (
        <div className='ai-agent-panel__history'>
            <div className='ai-agent-panel__history-head'>
                <strong>{localize('Bulk trade results')}</strong>
                <span>
                    {localize('{{n}} trades, {{w}} won, {{l}} lost, net {{p}}', {
                        n: closed.length,
                        w: closed.filter(r => r.profit > 0).length,
                        l: closed.filter(r => r.profit <= 0).length,
                        p: closed.reduce((a, r) => a + r.profit, 0).toFixed(2),
                    })}
                </span>
                <button type='button' className='ai-agent-panel__retry' onClick={onClear}>
                    {localize('Clear')}
                </button>
            </div>
            {rows.length > 0 && (
                <div className='ai-agent-panel__history-scroll'>
                    <table className='ai-agent-panel__history-table'>
                        <thead>
                            <tr>
                                <th>{localize('Time')}</th>
                                <th>{localize('Market')}</th>
                                <th>{localize('Contract')}</th>
                                <th>{localize('Ticks')}</th>
                                <th>{localize('Stake')}</th>
                                <th>{localize('P/L')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(r => (
                                <tr key={r.id}>
                                    <td>{new Date(r.ts * 1000).toLocaleTimeString()}</td>
                                    <td>{r.symbol}</td>
                                    <td>{r.type}</td>
                                    <td>{getDurationTicks(r) ?? '-'}</td>
                                    <td>{r.stake.toFixed(2)}</td>
                                    <td className={r.open ? '' : r.profit > 0 ? 'is-win' : 'is-loss'}>
                                        {r.open ? localize('open') : r.profit.toFixed(2)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {activity.length > 0 && (
                <div className='ai-agent-panel__activity'>
                    <strong>{localize('Activity and errors')}</strong>
                    {activity.map((a, i) => (
                        <div key={`${a.ts}-${i}`} className={`ai-agent-panel__activity-line is-${a.kind}`}>
                            {new Date(a.ts).toLocaleTimeString()} {a.text}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default TradeResults;
