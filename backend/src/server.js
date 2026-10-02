import 'dotenv/config';
import http from 'http';
import cors from 'cors';
import express from 'express';
import { getRunStatus, startBulkRun, stopStrategy } from './runner.js';
import { getSignalHistory, isPersistenceEnabled, logSignalSnapshot } from './db.js';
import { DIGIT_SYMBOLS, MarketFeed } from './marketFeed.js';
import { attachSignalHub } from './signalHub.js';

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

app.post('/api/bulk/start', async (req, res) => {
    const { token, strategies } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing token' });
    try {
        const result = await startBulkRun(token, strategies);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/bulk/status/:run_id', (req, res) => {
    const status = getRunStatus(req.params.run_id);
    if (!status) return res.status(404).json({ error: 'Run not found' });
    res.json(status);
});

app.post('/api/bulk/stop', (req, res) => {
    const { run_id, strategy_id } = req.body || {};
    if (!run_id) return res.status(400).json({ error: 'Missing run_id' });
    try {
        stopStrategy(run_id, strategy_id);
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Use a raw HTTP server so Express (REST) and the ws WebSocketServer (live
// signals) can share one port — this is what Render exposes for the service.
const httpServer = http.createServer(app);
attachSignalHub(httpServer, marketFeed, { path: '/ws/signals', allowedOrigins: allowed_origins });

httpServer.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Digit X Matrix backend listening on port ${PORT} (REST + /ws/signals)`);
    if (!ALLOWED_ORIGIN) {
        // eslint-disable-next-line no-console
        console.warn('[warn] ALLOWED_ORIGIN is not set — CORS is open to all origins. Set it in production.');
    }
});
