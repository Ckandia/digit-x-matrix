import 'dotenv/config';
import http from 'http';
import cors from 'cors';
import express from 'express';
import { getSignalHistory, isPersistenceEnabled, logSignalSnapshot } from './db.js';
import { DIGIT_SYMBOLS, MarketFeed } from './marketFeed.js';
import { attachSignalHub } from './signalHub.js';
import { getStats, isValidProfile, parseOutcome, recordOutcome } from './learning.js';
import { PaperTrader } from './paperTrader.js';
import { startTradePurge } from './tradeStore.js';
import { mountJournalIngest } from './journalIngest.js';
import { mountMcp } from './mcpServer.js';
import { mountRunner } from './runner/mountRunner.js';

const app = express();
const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN; // e.g. https://digit-x-matrix.vercel.app
const allowed_origins = ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',').map(o => o.trim()) : undefined;
const SIGNAL_LOG_INTERVAL_MS = 30_000; // one row per symbol every 30s, not every tick

app.use(express.json());
app.use(
    cors({
        origin: allowed_origins || true,
    })
);

// Journal sync: the browser app pushes each settled trade here (shared secret in x-sync-key) so the Claude connector can read it.
mountJournalIngest(app);
startTradePurge();
mountMcp(app); // the Claude connector (read-only); needs MCP_SECRET

// The analysis "brain": one shared public feed of Deriv ticks for every digit
// symbol, turned into rolling stats + signals. Starts immediately on boot so
// the window is warm by the time the first client connects.
const marketFeed = new MarketFeed();
marketFeed.start();

// The offline "virtual hook": paper trades on every market and contract, 24/7, no token and no money.
// The AI Trader reads these results (GET /api/paper/stats) to see which contracts really beat the payout.
const paperTrader = new PaperTrader(marketFeed);
paperTrader.start().catch(err => console.error('[paper] failed to start:', err.message));

// Optional (only runs when DATABASE_URL is set, e.g. a Neon connection
// string): periodically persist each symbol's current stats + signals so
// there's a queryable history of what the "brain" was seeing over time —
// useful for later checking how well the confidence score tracked outcomes.
// Throttled per-symbol so this stays well within Neon's free-tier limits
// even with all 10 symbols ticking continuously.
if (isPersistenceEnabled()) {
    const last_logged_at = new Map();
    marketFeed.onUpdate(symbol => {
        const now = Date.now();
        if (now - (last_logged_at.get(symbol) || 0) < SIGNAL_LOG_INTERVAL_MS) return;
        last_logged_at.set(symbol, now);
        const snapshot = marketFeed.getSnapshot(symbol);
        if (snapshot) logSignalSnapshot(symbol, snapshot.stats, snapshot.signals);
    });
}

app.get('/health', (_req, res) => {
    res.json({ ok: true, persistence: isPersistenceEnabled(), analysis_symbols: DIGIT_SYMBOLS.length });
});

// REST fallback / initial page-load snapshot for the Digit Matrix tab — the
// frontend should prefer the /ws/signals WebSocket for live updates and use
// this only for a first paint before the socket opens, or if sockets are
// blocked on the client's network.
// What Deriv really allows per contract type for a symbol (tick-duration ranges), so the
// frontend never has to guess. { rules: null } means Deriv did not answer: use the built-in table.
app.get('/api/contracts/:symbol', async (req, res) => {
    if (!/^[A-Za-z0-9_]{2,20}$/.test(req.params.symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    try {
        res.json({ symbol: req.params.symbol, rules: await marketFeed.getContractRules(req.params.symbol) });
    } catch (err) {
        console.error('[contracts] failed:', err.message);
        res.json({ symbol: req.params.symbol, rules: null });
    }
});

let paper_cache = { at: 0, body: null };
app.get('/api/paper/stats', (_req, res) => {
    if (Date.now() - paper_cache.at > 10_000) paper_cache = { at: Date.now(), body: paperTrader.getReport() };
    res.json({ data: paper_cache.body });
});

app.get('/api/analysis/symbols', (_req, res) => {
    res.json({ symbols: DIGIT_SYMBOLS });
});

app.get('/api/analysis/snapshot', (_req, res) => {
    res.json({ data: marketFeed.getAllSnapshots() });
});

// Two-tick pair frequencies (% of two-tick windows showing each contract's pattern) for every 1s market.
app.get('/api/analysis/pairs', (_req, res) => {
    const data = {};
    for (const [symbol, snapshot] of Object.entries(marketFeed.getAllSnapshots())) if (snapshot?.pairs) data[symbol] = snapshot.pairs;
    res.json({ data });
});

app.get('/api/analysis/snapshot/:symbol', (req, res) => {
    const snapshot = marketFeed.getSnapshot(req.params.symbol);
    if (!snapshot) return res.status(404).json({ error: 'Unknown symbol' });
    res.json({ data: snapshot });
});

// Historical signal log — only returns rows when a database (e.g. Neon) is
// configured; otherwise an empty array, so the frontend can treat it the
// same way either way instead of special-casing "no database".
app.get('/api/analysis/history/:symbol', async (req, res) => {
    const rows = await getSignalHistory(req.params.symbol, req.query.limit);
    res.json({ data: rows, persistence: isPersistenceEnabled() });
});

// Learning memory: the browser posts each settled trade's result (aggregates
// only) and reads its own stats back on load. See learning.js.
const outcome_calls = new Map(); // profile -> timestamps, crude flood guard
app.post('/api/learning/outcome', async (req, res) => {
    const outcome = parseOutcome(req.body);
    if (!outcome) return res.status(400).json({ error: 'Invalid outcome' });
    const now = Date.now();
    const recent = (outcome_calls.get(outcome.profile) || []).filter(t => now - t < 60_000);
    if (recent.length >= 120) return res.status(429).json({ error: 'Too many outcomes' });
    outcome_calls.set(outcome.profile, [...recent, now]);
    try {
        await recordOutcome(outcome);
        res.json({ ok: true });
    } catch (err) {
        console.error('[learning] record failed:', err.message);
        res.status(500).json({ error: 'Could not record outcome' });
    }
});

app.get('/api/learning/stats/:profile', async (req, res) => {
    if (!isValidProfile(req.params.profile)) return res.status(400).json({ error: 'Invalid profile' });
    try {
        res.json({ data: await getStats(req.params.profile), persistence: isPersistenceEnabled() });
    } catch (err) {
        console.error('[learning] stats failed:', err.message);
        res.status(500).json({ error: 'Could not read stats' });
    }
});

// 24/7 server-side AI runs: the browser hands over its Deriv login once and the run keeps trading with every tab closed.
// Off unless RUNNER_ENABLED=true. See runner/runnerManager.js for what is stored and how it is protected.
// The AI's logic lives in src/pages/bulk-trader/autoPilotEngine.ts; runner/engine.bundle.mjs is that same engine, built by
// scripts/build-runner.mjs (re-run it after any change to the engine).
mountRunner(app, marketFeed, { port: PORT });

// Use a raw HTTP server so Express (REST) and the ws WebSocketServer (live
// signals) can share one port — this is what Render exposes for the service.
const httpServer = http.createServer(app);
attachSignalHub(httpServer, marketFeed, {
    path: '/ws/signals',
    allowedOrigins: allowed_origins,
});

httpServer.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Digit X Matrix backend listening on port ${PORT} (REST + /ws/signals)`);
    if (!ALLOWED_ORIGIN) {
        // eslint-disable-next-line no-console
        console.warn('[warn] ALLOWED_ORIGIN is not set — CORS is open to all origins. Set it in production.');
    }
});
