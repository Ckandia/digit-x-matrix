import React, { useEffect, useState } from 'react';
import { localize } from '@deriv-com/translations';
import { fetchPaperReport, poolByContract, TPaperReport } from './paperStats';

const LABELS: Record<string, string> = {
    DIGITEVEN: 'Even',
    DIGITODD: 'Odd',
    DIGITOVER: 'Over 4',
    DIGITUNDER: 'Under 5',
    CALL: 'Rise',
    PUT: 'Fall',
    ONETOUCH: 'Touch',
    NOTOUCH: 'No Touch',
};
const FIXED_PAYOUT = ['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'CALL', 'PUT'];
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** What the backend's 24/7 paper trader has learned. It trades virtually on every market, even while this app is closed. */
export const PaperLearningCard = () => {
    const [report, setReport] = useState<TPaperReport | null | undefined>(undefined);

    useEffect(() => {
        let alive = true;
        const load = async () => {
            const r = await fetchPaperReport();
            if (alive) setReport(r);
        };
        void load();
        const timer = setInterval(load, 60_000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, []);

    if (report === undefined) return null;
    if (report === null) {
        return (
            <div className='ai-agent-panel__history ai-agent-panel__paper'>
                <div className='ai-agent-panel__history-head'>
                    <strong>{localize('Backend paper trader (runs 24/7, even when you are offline)')}</strong>
                </div>
                <div>{localize('No data yet: the backend did not answer, or the new backend (with the paper trader) is not deployed.')}</div>
            </div>
        );
    }

    const rows = poolByContract(report);
    const hook = report.hook;
    return (
        <div className='ai-agent-panel__history ai-agent-panel__paper'>
            <div className='ai-agent-panel__history-head'>
                <strong>{localize('Backend paper trader (runs 24/7, even when you are offline)')}</strong>
                <span>
                    {localize('{{n}} virtual trades since {{d}}', {
                        n: report.total_paper_trades.toLocaleString(),
                        d: new Date(report.started_at).toLocaleString(),
                    })}
                </span>
            </div>
            <div className='ai-agent-panel__history-scroll'>
                <table className='ai-agent-panel__history-table'>
                    <thead>
                        <tr>
                            <th>{localize('Contract')}</th>
                            <th>{localize('Paper trades')}</th>
                            <th>{localize('Win rate')}</th>
                            <th>{localize('Needed to beat the payout')}</th>
                            <th>{localize('Verdict')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(r => {
                            const fixed = FIXED_PAYOUT.includes(r.contract_type);
                            return (
                                <tr key={r.contract_type}>
                                    <td>{LABELS[r.contract_type] ?? r.contract_type}</td>
                                    <td>{r.n.toLocaleString()}</td>
                                    <td>{pct(r.win_rate)}</td>
                                    <td>{fixed ? pct(report.breakeven_win_rate) : localize('depends on the barrier payout')}</td>
                                    <td className={fixed ? (r.proven ? 'is-win' : 'is-loss') : ''}>
                                        {fixed ? (r.proven ? localize('Edge proven') : localize('No edge proven')) : '-'}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {hook.after_loss.n > 0 && hook.after_win.n > 0 && (
                <div>
                    {localize(
                        'Virtual-hook check: after a paper loss the next paper trade won {{a}} of the time ({{an}} trades); after a paper win, {{b}} ({{bn}} trades). If these are about equal, waiting for a win does not make the next trade more likely to win.',
                        {
                            a: pct(hook.after_loss.win_rate),
                            an: hook.after_loss.n.toLocaleString(),
                            b: pct(hook.after_win.win_rate),
                            bn: hook.after_win.n.toLocaleString(),
                        }
                    )}
                </div>
            )}
        </div>
    );
};
