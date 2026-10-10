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

    const hook = report.hook;
    const contracts = report.contracts;
    const proven = contracts?.filter(c => c.verdict === 'edge') ?? [];
    const priced = contracts?.filter(c => c.ev !== null) ?? [];
    const best = priced.length ? [...priced].sort((x, y) => (y.ev ?? -1) - (x.ev ?? -1))[0] : null;
    const worst_ev = priced.length ? Math.min(...priced.map(c => c.ev ?? 0)) : 0;
    const best_ev = best?.ev ?? 0;
    const money = (x: number | null) => (x === null ? '-' : `${x >= 0 ? '+' : '-'}${Math.abs(x * 100).toFixed(1)}c`);
    const verdictText = (v: string) =>
        v === 'edge'
            ? localize('Edge proven')
            : v === 'loses'
              ? localize('Loses money (proven)')
              : v === 'no_edge'
                ? localize('Not proven either way')
                : v === 'no_payout'
                  ? localize('Waiting for a payout quote')
                  : localize('Collecting');
    const rows = poolByContract(report);
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
            {contracts && (
                <div className={proven.length ? 'is-win' : 'is-loss'}>
                    {proven.length
                        ? localize('Edge found on {{list}}: their win rate beats the payout with 95% confidence. This is what the AI may trade live.', {
                              list: proven.map(c => LABELS[c.contract_type] ?? c.contract_type.toLowerCase()).join(', '),
                          })
                        : priced.length
                          ? localize(
                                'No contract beats its payout. Staking 1.00 on any of them loses on average between {{lo}} and {{hi}} per trade; the least bad is {{best}} at {{ev}}. The AI will not go live on a proven-losing contract in "Only trade a proven edge" mode.',
                                {
                                    lo: Math.abs(best_ev).toFixed(2),
                                    hi: Math.abs(worst_ev).toFixed(2),
                                    best: best ? (LABELS[best.contract_type] ?? best.contract_type) : '-',
                                    ev: money(best_ev),
                                }
                            )
                          : localize('Waiting for Deriv payout quotes before judging the contracts.')}
                </div>
            )}
            <div className='ai-agent-panel__history-scroll'>
                <table className='ai-agent-panel__history-table'>
                    <thead>
                        <tr>
                            <th>{localize('Contract')}</th>
                            <th>{localize('Paper trades')}</th>
                            <th>{localize('Win rate')}</th>
                            <th>{localize('Payout on a win')}</th>
                            <th>{localize('Needed to beat the payout')}</th>
                            <th>{localize('Result per 1.00 staked')}</th>
                            <th>{localize('Verdict')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {contracts
                            ? contracts.map(c => (
                                  <tr key={c.contract_type}>
                                      <td>{LABELS[c.contract_type] ?? c.contract_type}</td>
                                      <td>{c.n.toLocaleString()}</td>
                                      <td>{pct(c.win_rate)}</td>
                                      <td>{c.payout_ratio === null ? '-' : `+${(c.payout_ratio * 100).toFixed(0)}%`}</td>
                                      <td>{c.breakeven === null ? '-' : pct(c.breakeven)}</td>
                                      <td>{money(c.ev)}</td>
                                      <td className={c.verdict === 'edge' ? 'is-win' : c.verdict === 'loses' ? 'is-loss' : ''}>{verdictText(c.verdict)}</td>
                                  </tr>
                              ))
                            : rows.map(r => {
                                  const fixed = FIXED_PAYOUT.includes(r.contract_type);
                                  return (
                                      <tr key={r.contract_type}>
                                          <td>{LABELS[r.contract_type] ?? r.contract_type}</td>
                                          <td>{r.n.toLocaleString()}</td>
                                          <td>{pct(r.win_rate)}</td>
                                          <td>-</td>
                                          <td>{fixed ? pct(report.breakeven_win_rate) : localize('depends on the barrier payout')}</td>
                                          <td>-</td>
                                          <td className={fixed ? (r.proven ? 'is-win' : 'is-loss') : ''}>
                                              {fixed ? (r.proven ? localize('Edge proven') : localize('No edge proven')) : '-'}
                                          </td>
                                      </tr>
                                  );
                              })}
                    </tbody>
                </table>
            </div>
            {report.edge_search && (
                <div>
                    {report.edges?.length
                        ? localize('Pockets that beat their payout by more than luck explains ({{n}} market/contract/condition combinations tested): {{list}}.', {
                              n: report.edge_search.tested.toLocaleString(),
                              list: report.edges
                                  .slice(0, 3)
                                  .map(e => `${LABELS[e.contract_type] ?? e.contract_type} on ${e.symbol} (${e.ctx}, ${pct(e.win_rate)}, ${e.n.toLocaleString()} trades)`)
                                  .join('; '),
                          })
                        : localize('Edge search: {{n}} market / contract / condition combinations tested, none beats its payout by more than luck explains (a result needs z of at least {{z}}).', {
                              n: report.edge_search.tested.toLocaleString(),
                              z: report.edge_search.z_needed ?? '-',
                          })}
                </div>
            )}
            {report.hook_within ? (
                <div>
                    {localize(
                        'Virtual-hook check (within each contract, so different contracts are not mixed): a paper trade after a paper win is {{d}} points {{dir}} likely to win than one after a paper loss (z = {{z}}; beyond +/-3 would be real). Waiting for a paper win only helps if this is clearly positive, and it would still have to beat the payout.',
                        {
                            d: Math.abs(report.hook_within.diff * 100).toFixed(2),
                            dir: report.hook_within.diff >= 0 ? localize('more') : localize('less'),
                            z: report.hook_within.z.toFixed(1),
                        }
                    )}
                </div>
            ) : (
                hook.after_loss.n > 0 &&
                hook.after_win.n > 0 && (
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
                )
            )}
        </div>
    );
};
