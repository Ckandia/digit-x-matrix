// Talks to the backend's server-side AI runner (backend/src/runner). The runner keeps trading when this page or the device is
// closed. Every call carries the runner key (RUNNER_KEY on the backend); the Deriv token is only sent when a run starts.
const base = (process.env.NEXT_PUBLIC_BULK_TRADER_API_URL || '').trim().replace(/\/$/, '');
const KEY = 'dxm_runner_key';
const ON = 'dxm_runner_on';

export const runnerAvailable = () => base.length > 0;
export const getRunnerKey = () => {
    try {
        return localStorage.getItem(KEY) ?? '';
    } catch {
        return '';
    }
};
export const setRunnerKey = (value: string) => {
    try {
        localStorage.setItem(KEY, value);
    } catch {
        /* ignore */
    }
};
export const getRemoteOn = () => {
    try {
        return localStorage.getItem(ON) === '1';
    } catch {
        return false;
    }
};
export const setRemoteOn = (on: boolean) => {
    try {
        localStorage.setItem(ON, on ? '1' : '0');
    } catch {
        /* ignore */
    }
};

export type TRunnerItem = { seq: number; kind: 'event' | 'contract' | 'log'; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
export type TRunnerStatus = {
    enabled: boolean;
    state: 'idle' | 'starting' | 'running' | 'stopped' | 'error';
    running: boolean;
    account: string;
    started_at: number | null;
    max_hours: number;
    stop_reason: string;
    error: string;
    seq: number;
    items: TRunnerItem[];
};

const call = async (path: string, key: string, init?: RequestInit): Promise<TRunnerStatus> => {
    const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-runner-key': key },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `The server runner answered ${res.status}.`);
    return body.data as TRunnerStatus;
};

export const runnerStatus = (key: string, since: number) => call(`/api/runner/status?since=${since}`, key);
export const runnerStart = (key: string, body: { token: string; account_id: string; config: unknown; learn_mode: string }) =>
    call('/api/runner/start', key, { method: 'POST', body: JSON.stringify(body) });
export const runnerStop = (key: string) => call('/api/runner/stop', key, { method: 'POST' });
