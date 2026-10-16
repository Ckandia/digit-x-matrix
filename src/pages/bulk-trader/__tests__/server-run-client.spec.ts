// The browser side of "keep trading when I close this page": starts a run on the server, remembers how to find it again,
// and copies its state into the AI tab. Deriv itself is never contacted here.
process.env.NEXT_PUBLIC_BULK_TRADER_API_URL = 'https://backend.test';
jest.mock('@/external/deriv-core', () => ({
    getAuthInfo: () => ({ access_token: 'access-token-1234', refresh_token: 'refresh-1', expires_at: 4102444800 }),
}));

import { aiRuntime, aiSet } from '../aiRuntime';
import { hasServerRunHandle, reattachServerRun, startServerRun, stopServerRun, stopWatching } from '../serverRunClient';
import type { TAutoPilotConfig } from '../autoPilotEngine';

const config = { stake: 1, stop_loss: 20, take_profit: 30, martingale_multiplier: 2, max_steps: 4 } as TAutoPilotConfig;
const state = (over: Record<string, unknown> = {}) => ({
    status: 'running',
    error: null,
    totalProfit: 1.25,
    ladder: [{ step: 1, symbol: '1HZ10V', label: 'Even', stake: 1, result: 'win', profit: 0.83 }],
    history: [],
    activity: [{ ts: 1, kind: 'info', text: 'AI auto-pilot started on the server' }],
    virtual: { active: false, current: '', losses: 0, wins: 0, needed: 2, rows: [] },
    ...over,
});

const calls: { url: string; init?: RequestInit }[] = [];
beforeEach(() => {
    calls.length = 0;
    localStorage.clear();
    aiSet.status('idle');
    (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/api/runner/start')) return { ok: true, status: 200, json: async () => ({ loginid: 'CR1', secret: 'sekret' }) };
        if (url.includes('/api/runner/status')) return { ok: true, status: 200, json: async () => ({ data: state() }) };
        if (url.endsWith('/api/runner/stop')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
        return { ok: false, status: 404, json: async () => ({}) };
    });
});
afterEach(() => stopWatching());

describe('server run client', () => {
    it('starts a run, sends the login once, keeps only the control secret, and shows the server state', async () => {
        await startServerRun('CR1', config, 'learn');
        const start = calls.find(c => c.url.endsWith('/api/runner/start'))!;
        const body = JSON.parse(String(start.init?.body));
        expect(body.loginid).toBe('CR1');
        expect(body.auth.access_token).toBe('access-token-1234');
        expect(body.config.stop_loss).toBe(20);
        expect(hasServerRunHandle()).toBe(true);
        expect(JSON.stringify(Object.entries(localStorage))).not.toContain('access-token-1234'); // the Deriv token is not stored by this file
        expect(aiRuntime.get().status).toBe('running');
        expect(aiRuntime.get().totalProfit).toBe(1.25);
        expect(aiRuntime.get().ladder).toHaveLength(1);
        const status = calls.find(c => c.url.includes('/api/runner/status'))!;
        expect((status.init?.headers as Record<string, string>)['x-runner-secret']).toBe('sekret');
    });

    it('shows the server error when the start is refused', async () => {
        (global as any).fetch = jest.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'A server run is already trading this account. Stop it first.' }) }));
        await expect(startServerRun('CR1', config, 'learn')).rejects.toThrow('already trading');
        expect(hasServerRunHandle()).toBe(false);
    });

    it('picks a run up again when the page is reopened, and forgets it when the server no longer has it', async () => {
        localStorage.setItem('dxm_server_run', JSON.stringify({ loginid: 'CR1', secret: 'sekret' }));
        expect(await reattachServerRun()).toBe(true);
        expect(aiRuntime.get().status).toBe('running');
        stopWatching();
        (global as any).fetch = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
        expect(await reattachServerRun()).toBe(false);
        expect(hasServerRunHandle()).toBe(false);
    });

    it('stop sends the secret', async () => {
        localStorage.setItem('dxm_server_run', JSON.stringify({ loginid: 'CR1', secret: 'sekret' }));
        await stopServerRun();
        const stop = calls.find(c => c.url.endsWith('/api/runner/stop'))!;
        expect((stop.init?.headers as Record<string, string>)['x-runner-secret']).toBe('sekret');
    });
});
