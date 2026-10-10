import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { observer } from 'mobx-react-lite';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { localize } from '@deriv-com/translations';
import { buildAnalytics, DEFAULT_FILTERS, filterTrades, localTimeZone, monthOf, TBreakdownRow, TFilters, toCsv } from './analytics';
import { syncFromDeriv } from './backfill';
import { activeAccount } from './derivMapping';
import { journalStore } from './journalStore';
import { PaperLearningCard } from '../bulk-trader/PaperLearningCard';
import { TCellReview, TVerdict } from './selfReview';
import './journal.scss';

const money = (n: number) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${(n * 100).toFixed(1)}%`);
const num = (n: number | null | undefined, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? '-' : n.toFixed(d));
const tone = (n: number) => (n > 0 ? 'jrnl__pos' : n < 0 ? 'jrnl__neg' : '');

const VERDICT_LABEL: Record<TVerdict, string> = {
    too_few: 'Collecting evidence',
    inconclusive: 'Not proven',
    lagging: 'Lagging, ranked lower',
    losing: 'Losing, skipped',
    winning: 'Winning so far',
};

const Kpi = ({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) => (
    <div className='jrnl__kpi'>
        <span className='jrnl__kpi-label'>{label}</span>
        <strong className={cls}>{value}</strong>
        {sub && <span className='jrnl__kpi-sub'>{sub}</span>}
    </div>
);

const EquityChart = ({ points }: { points: { cumNetPnl: number }[] }) => {
    if (points.length < 2) return <div className='jrnl__empty'>{localize('The equity curve appears after a few trades.')}</div>;
    const W = 600;
    const H = 150;
    const values = [0, ...points.map(p => p.cumNetPnl)];
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const x = (i: number) => (i / (values.length - 1)) * W;
    const y = (v: number) => H - ((v - lo) / span) * (H - 12) - 6;
    const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const last = values[values.length - 1] ?? 0;
    return (
        <svg className='jrnl__chart' viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' role='img' aria-label={localize('Equity curve')}>
            <line x1={0} x2={W} y1={y(0)} y2={y(0)} className='jrnl__chart-zero' />
            <path d={line} className={last >= 0 ? 'jrnl__chart-line jrnl__chart-line--up' : 'jrnl__chart-line jrnl__chart-line--down'} />
        </svg>
    );
};

const Breakdown = ({ rows }: { rows: TBreakdownRow[] }) =>
    rows.length === 0 ? (
        <div className='jrnl__empty'>{localize('Nothing to show for these filters yet.')}</div>
    ) : (
        <div className='jrnl__table-wrap'>
            <table className='jrnl__table'>
                <thead>
                    <tr>
                        <th />
                        <th>{localize('Trades')}</th>
                        <th>{localize('Win rate')}</th>
                        <th>{localize('Net')}</th>
                        <th>{localize('Profit factor')}</th>
                        <th>{localize('Avg R')}</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(r => (
                        <tr key={r.key}>
                            <td>{r.key}</td>
                            <td>{r.trades}</td>
                            <td>{pct(r.win_rate)}</td>
                            <td className={tone(r.net)}>{money(r.net)}</td>
                            <td>{num(r.profit_factor)}</td>
                            <td>{num(r.avg_r, 3)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );

const ReviewRow = ({ c }: { c: TCellReview }) => (
    <tr>
        <td>{c.label}</td>
        <td>{c.n}</td>
        <td>
            {pct(c.win_rate)}
            {c.break_even ? <span className='jrnl__muted'> / {pct(c.break_even)}</span> : null}
        </td>
        <td className={tone(c.net)}>{money(c.net)}</td>
        <td className={tone(c.mean_r)}>{num(c.mean_r, 3)}</td>
        <td>
            <span className={`jrnl__chip jrnl__chip--${c.verdict}`}>{localize(VERDICT_LABEL[c.verdict])}</span>
        </td>
    </tr>
);

type TDim = 'type' | 'symbol' | 'hour' | 'step' | 'strategy';
const DIMS: { id: TDim; label: string }[] = [
    { id: 'type', label: 'Contract' },
    { id: 'symbol', label: 'Market' },
    { id: 'hour', label: 'Hour of day' },
    { id: 'step', label: 'Stake step (AI)' },
    { id: 'strategy', label: 'Strategy (AI)' },
];

const Journal = observer(() => {
    const { activeLoginid } = useApiBase();
    // The same live balance the page header shows (client store), so the Journal and the header always agree.
    const { client } = useStore();
    const balance = Number(client?.balance);
    const account = activeLoginid || activeAccount();
    const tz = localTimeZone();

    const [filters, setFilters] = useState<TFilters>(DEFAULT_FILTERS);
    const [dim, setDim] = useState<TDim>('type');
    const [syncing, setSyncing] = useState(false);
    const [sync_note, setSyncNote] = useState<string | null>(null);
    const [sync_error, setSyncError] = useState<string | null>(null);
    const [self_review_on, setSelfReviewOn] = useState(journalStore.selfReviewEnabled());
    const now = new Date();
    const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });

    // Re-render whenever a trade is added anywhere in the app (the AI, Bulk Trader or a sync).
    const version = useSyncExternalStore(journalStore.subscribe, journalStore.version);
    const all_trades = useMemo(() => journalStore.trades(account), [account, version]);
    const filtered = useMemo(() => filterTrades(all_trades, filters), [all_trades, filters]);
    const a = useMemo(() => buildAnalytics(filtered, tz), [filtered, tz]);
    const review = useMemo(() => journalStore.review(account), [account, version]);
    const cal = useMemo(() => monthOf(a.days, month.y, month.m), [a.days, month]);

    const symbols = useMemo(() => [...new Set(all_trades.map(t => t.symbol))].sort(), [all_trades]);
    const types = useMemo(() => [...new Set(all_trades.map(t => t.type))].sort(), [all_trades]);
    const m = a.metrics;

    const set = <K extends keyof TFilters>(k: K, v: TFilters[K]) => setFilters(f => ({ ...f, [k]: v }));

    const sync = async () => {
        setSyncing(true);
        setSyncError(null);
        setSyncNote(null);
        try {
            const r = await syncFromDeriv(n => setSyncNote(localize('Reading your Deriv history... {{n}} contracts', { n })));
            setSyncNote(
                r.fetched === 0
                    ? localize('Your Deriv account has no settled contracts yet.')
                    : localize('Sync done: {{added}} new trade(s) added ({{fetched}} read).', { added: r.added, fetched: r.fetched })
            );
        } catch (err) {
            setSyncError(err instanceof Error ? err.message : localize('Could not sync with Deriv.'));
            setSyncNote(null);
        } finally {
            setSyncing(false);
        }
    };

    const exportCsv = () => {
        const blob = new Blob([toCsv(filtered)], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const el = document.createElement('a');
        el.href = url;
        el.download = `journal-${account}-${new Date().toISOString().slice(0, 10)}.csv`;
        el.click();
        URL.revokeObjectURL(url);
    };

    const rows_for: Record<TDim, TBreakdownRow[]> = {
        type: a.by_type,
        symbol: a.by_symbol,
        hour: a.by_hour,
        step: a.by_step,
        strategy: a.by_strategy,
    };
    const judged = [...review.cells].filter(c => c.n >= 10).slice(0, 12);
    const month_label = new Date(Date.UTC(month.y, month.m - 1, 1)).toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const step_month = (d: number) =>
        setMonth(p => {
            const idx = p.y * 12 + (p.m - 1) + d;
            return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
        });

    return (
        <div className='jrnl'>
            <header className='jrnl__head'>
                <div>
                    <h3>{localize('Journal')}</h3>
                    <p>
                        {localize('Every settled contract on')} <strong>{account}</strong>
                        {'. '}
                        {localize('Saved in this browser; Sync from Deriv rebuilds it from your account history.')}
                    </p>
                    <p className='jrnl__balance'>
                        {localize('Account balance')}:{' '}
                        <strong>{Number.isFinite(balance) ? `${client?.currency ?? ''} ${balance.toFixed(2)}` : '-'}</strong>{' '}
                        <span className='jrnl__muted'>
                            {localize('live. Run results also appear in the Summary, Transactions and Journal panel below.')}
                        </span>
                    </p>
                </div>
                <div className='jrnl__actions'>
                    <button type='button' onClick={sync} disabled={syncing}>
                        {syncing ? localize('Syncing...') : localize('Sync from Deriv')}
                    </button>
                    <button type='button' onClick={exportCsv} disabled={filtered.length === 0}>
                        {localize('Export CSV')}
                    </button>
                </div>
            </header>
            {sync_note && <div className='jrnl__note'>{sync_note}</div>}
            {sync_error && <div className='jrnl__error'>{sync_error}</div>}

            <div className='jrnl__filters'>
                <label>
                    {localize('Period')}
                    <select value={filters.period} onChange={e => set('period', e.target.value as TFilters['period'])}>
                        <option value='all'>{localize('All time')}</option>
                        <option value='today'>{localize('Today')}</option>
                        <option value='7d'>{localize('Last 7 days')}</option>
                        <option value='30d'>{localize('Last 30 days')}</option>
                    </select>
                </label>
                <label>
                    {localize('Trades')}
                    <select value={filters.source} onChange={e => set('source', e.target.value as TFilters['source'])}>
                        <option value='all'>{localize('All trades')}</option>
                        <option value='ai'>{localize('AI trades only')}</option>
                    </select>
                </label>
                <label>
                    {localize('Market')}
                    <select value={filters.symbol} onChange={e => set('symbol', e.target.value)}>
                        <option value='all'>{localize('All markets')}</option>
                        {symbols.map(s => (
                            <option key={s} value={s}>
                                {s}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    {localize('Contract')}
                    <select value={filters.type} onChange={e => set('type', e.target.value)}>
                        <option value='all'>{localize('All contracts')}</option>
                        {types.map(t => (
                            <option key={t} value={t}>
                                {t}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {all_trades.length === 0 ? (
                <div className='jrnl__empty jrnl__empty--big'>
                    {localize(
                        'No trades yet. Trades from the AI Trader and Bulk Trader appear here as they settle. Press Sync from Deriv to bring in your account history.'
                    )}
                </div>
            ) : (
                <>
                    <section className='jrnl__kpis'>
                        <Kpi label={localize('Net P&L')} value={money(m.netPnl)} cls={tone(m.netPnl)} sub={`${m.closedTrades} ${localize('trades')}`} />
                        <Kpi label={localize('Win rate')} value={pct(m.winRate)} sub={`${m.wins}W / ${m.losses}L`} />
                        <Kpi label={localize('Profit factor')} value={m.profitFactorIsInfinite ? 'inf' : num(m.profitFactor)} sub={localize('wins / losses (1.0 = break-even)')} />
                        <Kpi label={localize('Expectancy')} value={m.expectancy === null ? '-' : money(m.expectancy)} cls={tone(m.expectancy ?? 0)} sub={localize('per trade')} />
                        <Kpi label={localize('Average R')} value={num(m.avgRealizedR, 3)} cls={tone(m.avgRealizedR ?? 0)} sub={localize('result per unit staked')} />
                        <Kpi label={localize('Max drawdown')} value={num(a.max_drawdown)} cls={a.max_drawdown > 0 ? 'jrnl__neg' : ''} sub={localize('peak to trough')} />
                        <Kpi label={localize('Streaks')} value={`${m.maxWinStreak}W / ${m.maxLossStreak}L`} sub={`${localize('now')} ${m.currentStreak > 0 ? `${m.currentStreak}W` : m.currentStreak < 0 ? `${-m.currentStreak}L` : '-'}`} />
                        <Kpi label={localize('Edge Score')} value={a.edge.score === null ? '-' : String(Math.round(a.edge.score))} sub={localize('0-100, needs 5+ trades')} />
                    </section>

                    <section className='jrnl__card'>
                        <h4>{localize('Equity curve')}</h4>
                        <EquityChart points={a.equity} />
                    </section>

                    <section className='jrnl__card'>
                        <h4>{localize('What the backend paper trader says about your contracts')}</h4>
                        <PaperLearningCard />
                    </section>

                    <section className='jrnl__card jrnl__review'>
                        <h4>{localize('AI self-review')}</h4>
                        <p className='jrnl__muted'>
                            {localize(
                                'The AI reads its own trades and judges each market and contract by its results. It skips only combinations that are clearly losing; most stay "not proven" until there are hundreds of trades.'
                            )}
                        </p>
                        <ul className='jrnl__lines'>
                            {review.lines.map(l => (
                                <li key={l}>{l}</li>
                            ))}
                        </ul>
                        <label className='jrnl__toggle'>
                            <input
                                type='checkbox'
                                checked={self_review_on}
                                onChange={e => {
                                    setSelfReviewOn(e.target.checked);
                                    journalStore.setSelfReviewEnabled(e.target.checked);
                                }}
                            />{' '}
                            {localize('The AI uses this review when choosing contracts (also a switch in the AI Trader tab)')}
                        </label>
                        {judged.length > 0 && (
                            <div className='jrnl__table-wrap'>
                                <table className='jrnl__table'>
                                    <thead>
                                        <tr>
                                            <th>{localize('Market and contract')}</th>
                                            <th>{localize('Trades')}</th>
                                            <th>{localize('Win rate / break-even')}</th>
                                            <th>{localize('Net')}</th>
                                            <th>{localize('Avg R')}</th>
                                            <th>{localize('Verdict')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {judged.map(c => (
                                            <ReviewRow key={c.key} c={c} />
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        {review.stake && (
                            <p>
                                {localize('Stake growth, {{n}} raised trades: actual {{actual}} vs {{flat}} at the base stake.', {
                                    n: review.stake.raised_trades,
                                    actual: money(review.stake.actual_net),
                                    flat: money(review.stake.flat_net),
                                })}
                            </p>
                        )}
                        {review.calibration.length > 0 && (
                            <p className='jrnl__muted'>
                                {localize('Confidence vs result')}:{' '}
                                {review.calibration.map(b => `${b.band}: ${b.n} trades, avg R ${num(b.mean_r, 3)}`).join('  |  ')}
                            </p>
                        )}
                    </section>

                    <section className='jrnl__card'>
                        <div className='jrnl__tabs'>
                            {DIMS.map(d => (
                                <button key={d.id} type='button' className={dim === d.id ? 'is-active' : ''} onClick={() => setDim(d.id)}>
                                    {localize(d.label)}
                                </button>
                            ))}
                        </div>
                        <Breakdown rows={rows_for[dim]} />
                    </section>

                    <section className='jrnl__card'>
                        <div className='jrnl__cal-head'>
                            <button type='button' onClick={() => step_month(-1)} aria-label={localize('Previous month')}>
                                {'<'}
                            </button>
                            <h4>{month_label}</h4>
                            <button type='button' onClick={() => step_month(1)} aria-label={localize('Next month')}>
                                {'>'}
                            </button>
                            <span className={`jrnl__cal-total ${tone(cal.monthNetPnl)}`}>
                                {money(cal.monthNetPnl)} ({cal.monthTrades} {localize('trades')})
                            </span>
                        </div>
                        <div className='jrnl__cal'>
                            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                                <span key={d} className='jrnl__cal-dow'>
                                    {d}
                                </span>
                            ))}
                            {cal.weeks.flatMap((w, wi) =>
                                w.days.map((d, di) => (
                                    <span
                                        key={`${wi}-${di}`}
                                        className={`jrnl__cal-day ${d && d.trades ? (d.netPnl >= 0 ? 'is-up' : 'is-down') : ''} ${d ? '' : 'is-blank'}`}
                                        title={d ? `${d.date}: ${money(d.netPnl)}, ${d.trades} trades` : ''}
                                    >
                                        {d && <small>{Number(d.date.slice(8))}</small>}
                                        {d && d.trades > 0 && <b>{money(d.netPnl)}</b>}
                                    </span>
                                ))
                            )}
                        </div>
                    </section>

                    <section className='jrnl__card'>
                        <h4>{localize('Latest trades')}</h4>
                        <div className='jrnl__table-wrap'>
                            <table className='jrnl__table'>
                                <thead>
                                    <tr>
                                        <th>{localize('Closed')}</th>
                                        <th>{localize('Market')}</th>
                                        <th>{localize('Contract')}</th>
                                        <th>{localize('Stake')}</th>
                                        <th>{localize('Result')}</th>
                                        <th>{localize('Source')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...filtered]
                                        .reverse()
                                        .slice(0, 40)
                                        .map(t => (
                                            <tr key={t.id}>
                                                <td>{new Date(t.sell_ts).toLocaleString()}</td>
                                                <td>{t.symbol}</td>
                                                <td>
                                                    {t.type}
                                                    {t.ai?.strategy ? <span className='jrnl__muted'> ({t.ai.strategy.replace('_', ' ')})</span> : null}
                                                </td>
                                                <td>
                                                    {t.stake.toFixed(2)}
                                                    {t.ai && t.ai.step > 1 ? <span className='jrnl__muted'> step {t.ai.step}</span> : null}
                                                </td>
                                                <td className={tone(t.profit)}>{money(t.profit)}</td>
                                                <td>
                                                    {t.source === 'ai' ? 'AI' : t.source === 'bulk' ? 'Bulk' : 'Deriv'}
                                                    {t.ai?.tag === 'switched' ? <span className='jrnl__muted'> switched</span> : null}
                                                </td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                </>
            )}

            <footer className='jrnl__foot'>
                {localize(
                    'Statistics describe the past; they do not predict the next trade. Analytics engine: journal-core by LuxAlgo (MIT licence), vendored unmodified.'
                )}
            </footer>
        </div>
    );
});

export default Journal;
