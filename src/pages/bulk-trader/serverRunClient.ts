// The browser side of "keep trading when I close this page". The run itself lives on the backend (backend/src/runner), which
// holds your Deriv login and trades with the same AI engine. This file starts it, remembers how to find it again, and copies
// its state into the AI tab (aiRuntime) every few seconds while the tab is open. Closing the tab, laptop or phone does not stop
// the run; opening the page later picks it up again.
import { getAuthInfo } from '@/external/deriv-core';
import { aiSet } from './aiRuntime';
import type { TAutoPilotConfig } from './autoPilotEngine';
import type { TLearningMode } from './learningEngine';
import type { TServerRunState } from './serverRun';

const rest_base = (process.env.NEXT_PUBLIC_BULK_TRADER_API_URL || '').trim().replace(/\/$/, '');
const HANDLE_KEY = 'dxm_server_run';
const POLL_MS = 3000;

type THandle = { loginid: string; secret: string };

const readHandle = (): THandle | null => {
    try {
        const h = JSON.parse(localStorage.getItem(HANDLE_KEY) || 'null');
        return h && typeof h.loginid === 'string' && typeof h.secret === 'string' ? h : null;
    } catch {
        return null;
    }
};
const writeHandle = (h: THandle | null) => {
    try {
        if (h) localStorage.setItem(HANDLE_KEY, JSON.stringify(h));
        else localStorage.removeItem(HANDLE_KEY);
    } catch {
        /* private mode: the run still works, the page just cannot re-find it later */
    }
};

export const serverRunConfigured = () => !!rest_base;

let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

// The AI tab registers a sink so the server run's trades also land in the run panel on the right (Summary / Transactions).
type TContractSink = (contract: Record<string, unknown>) => void;
let sink: TContractSink | null = null;
const seen = new Map<string, string>(); // contract id -> what was last passed on (so an unchanged contract is not sent twice)
export const setServerContractSink = (fn: TContractSink | null) => {
    sink = fn;
};
const feedContracts = (contracts: Record<string, unknown>[] | undefined) => {
    if (!sink || !contracts) return;
    // oldest first, so the panel's newest-first list ends up in the right order
    for (const c of [...contracts].reverse()) {
        const id = String(c.contract_id ?? c.id ?? '');
        const sig = `${c.is_sold ? 1 : 0}|${c.profit}|${c.status}`;
        if (!id || seen.get(id) === sig) continue;
        seen.set(id, sig);
        try {
            sink(c);
        } catch {
            /* the side panel must never break the poll */
        }
    }
};

/** Copies the server's state into the AI tab. Returns false if the server no longer knows the run. */
const applyState = (s: TServerRunState & { loginid?: string }) => {
    aiSet.status(s.status);
    aiSet.stopReason(s.stopReason);
    aiSet.error(s.error);
    aiSet.totalProfit(s.totalProfit);
    aiSet.ladder(s.ladder);
    aiSet.history(s.history);
    aiSet.activity(s.activity.slice(0, 40));
    aiSet.virtual(s.virtual);
    feedContracts(s.contracts);
};

const pollOnce = async (): Promise<'ok' | 'gone' | 'unreachable'> => {
    const h = readHandle();
    if (!h) return 'gone';
    try {
        const res = await fetch(`${rest_base}/api/runner/status?loginid=${encodeURIComponent(h.loginid)}`, { headers: { 'x-runner-secret': h.secret } });
        if (res.status === 404) return 'gone';
        if (!res.ok) return 'unreachable';
        const body = await res.json();
        applyState(body.data);
        if (body.data.status === 'stopped' || body.data.status === 'error') stopWatching();
        return 'ok';
    } catch {
        return 'unreachable'; // the page being offline does not stop the server's run; keep the last state and try again
    }
};

export const stopWatching = () => {
    if (timer) clearInterval(timer);
    timer = null;
};

const watch = () => {
    stopWatching();
    timer = setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
            const r = await pollOnce();
            if (r === 'gone') {
                stopWatching();
                writeHandle(null);
                aiSet.status('stopped');
                aiSet.stopReason('the server no longer has this run (it was restarted or stopped)');
            }
        } finally {
            polling = false;
        }
    }, POLL_MS);
};

/** True when a run started from this browser is still known to the server (called when the AI tab opens). */
export const reattachServerRun = async (): Promise<boolean> => {
    if (!serverRunConfigured() || !readHandle()) return false;
    const r = await pollOnce();
    if (r === 'gone') {
        writeHandle(null);
        return false;
    }
    if (r === 'ok') {
        watch();
        return true;
    }
    return false;
};

export const startServerRun = async (loginid: string, config: TAutoPilotConfig, learnMode: TLearningMode): Promise<void> => {
    if (!serverRunConfigured()) throw new Error('The backend address is not set (NEXT_PUBLIC_BULK_TRADER_API_URL), so a server run is not available.');
    const auth = getAuthInfo();
    if (!auth?.access_token) throw new Error('No active Deriv login found. Log in again.');
    const res = await fetch(`${rest_base}/api/runner/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            loginid,
            learnMode,
            config,
            auth: { access_token: auth.access_token, refresh_token: auth.refresh_token, expires_at: auth.expires_at },
        }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `The server could not start the run (${res.status})`);
    writeHandle({ loginid: body.loginid, secret: body.secret });
    aiSet.status('running');
    await pollOnce();
    watch();
};

export const stopServerRun = async (): Promise<void> => {
    const h = readHandle();
    if (!h) return;
    try {
        await fetch(`${rest_base}/api/runner/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-runner-secret': h.secret },
            body: JSON.stringify({ loginid: h.loginid }),
        });
    } catch {
        throw new Error('Could not reach the server to stop the run. Try again.');
    }
    await pollOnce();
};

export const hasServerRunHandle = () => !!readHandle();
