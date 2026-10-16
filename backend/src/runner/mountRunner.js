import { RunnerManager } from './runnerManager.js';

/**
 * POST /api/runner/start   { loginid, auth: { access_token, refresh_token, expires_at }, config, learnMode }  -> { loginid, secret }
 * GET  /api/runner/status  ?loginid=...   header x-runner-secret
 * POST /api/runner/stop    { loginid }    header x-runner-secret
 * Starting needs a Deriv login that Deriv itself confirms owns the account. Status and stop need the secret returned at start.
 */
export const mountRunner = (app, marketFeed, { port, manager } = {}) => {
    const rest_base = `http://127.0.0.1:${port || process.env.PORT || 4000}`;
    const m =
        manager ||
        new RunnerManager({
            getSnapshots: () => marketFeed.getAllSnapshots(),
            loadEngine: async () => {
                // The engine reads the backend's own rules/paper/learning routes over HTTP, like the browser does.
                process.env.NEXT_PUBLIC_BULK_TRADER_API_URL = rest_base;
                return import('./engine.bundle.mjs');
            },
        });

    const fail = (res, err) => {
        const status = err?.status || 500;
        if (status >= 500 && status !== 502 && status !== 503) console.error('[runner]', err?.message);
        res.status(status).json({ error: status >= 500 && status !== 502 && status !== 503 ? 'Server error' : err.message });
    };

    app.post('/api/runner/start', async (req, res) => {
        try {
            res.json(await m.start(req.body));
        } catch (err) {
            fail(res, err);
        }
    });
    app.get('/api/runner/status', (req, res) => {
        const status = m.status(String(req.query.loginid || ''), String(req.headers['x-runner-secret'] || ''));
        if (!status) return res.status(404).json({ error: 'No such run (or wrong secret)' });
        res.json({ data: status });
    });
    app.post('/api/runner/stop', (req, res) => {
        const ok = m.stop(String(req.body?.loginid || ''), String(req.headers['x-runner-secret'] || ''));
        if (!ok) return res.status(404).json({ error: 'No such run (or wrong secret)' });
        res.json({ ok: true });
    });
    app.get('/api/runner/info', (_req, res) => res.json({ enabled: m.enabled() }));

    setInterval(() => m.sweep(), 10 * 60 * 1000).unref?.();
    // Give the market feed a moment to warm up before a saved run is brought back.
    setTimeout(() => void m.resumeAll().then(n => n && console.log(`[runner] resumed ${n} saved run(s)`)), 20_000).unref?.();
    return m;
};
