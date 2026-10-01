import 'dotenv/config';
import http from 'http';
import cors from 'cors';
import express from 'express';
import { getSignalHistory, isPersistenceEnabled, logSignalSnapshot } from './db.js';
import { DIGIT_SYMBOLS, MarketFeed } from './marketFeed.js';
import { attachSignalHub } from './signalHub.js';
import { getStats, isValidProfile, parseOutcome, recordOutcome } from './learning.js';

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

// The analysis "brain": one shared public feed of Deriv ticks for every digit
// symbol, turned into rolling stats + signals. Starts immediately on boot so
// the window is warm by the time the first client connects.
const marketFeed = new MarketFeed();
marketFeed.start();

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

app.get('/api/analysis/symbols', (_req, res) => {
    res.json({ symbols: DIGIT_SYMBOLS });
});

app.get('/api/analysis/snapshot', (_req, res) => {
    res.json({ data: marketFeed.getAllSnapshots() });
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

// The AI auto-pilot (contract choice, duration, martingale ladder, flip on
// loss, stop-loss/take-profit) runs entirely in the browser — see
// src/pages/bulk-trader/autoPilotEngine.ts. It reads its signals straight off
// this same /ws/signals feed (now covering 8 additional contract families
// alongside digits — see contractAnalysis.js), so there is nothing left for
// the backend to start/stop/status on its behalf.

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
