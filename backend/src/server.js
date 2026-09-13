import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { getRunStatus, startBulkRun, stopStrategy } from './runner.js';
import { isPersistenceEnabled } from './db.js';

const app = express();
const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN; // e.g. https://digit-x-matrix.vercel.app

app.use(express.json());
app.use(
    cors({
        origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',').map(o => o.trim()) : true,
    })
);

app.get('/health', (_req, res) => {
    res.json({ ok: true, persistence: isPersistenceEnabled() });
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

app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Bulk Trader backend listening on port ${PORT}`);
    if (!ALLOWED_ORIGIN) {
        // eslint-disable-next-line no-console
        console.warn('[warn] ALLOWED_ORIGIN is not set — CORS is open to all origins. Set it in production.');
    }
});
