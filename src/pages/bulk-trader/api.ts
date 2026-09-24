import { TRunStatus, TStartBulkRunResponse, TStrategyConfig } from './types';
import { TAiAgentConfig, TAiRunStatus, TStartAiRunResponse } from './aiAgentTypes';

// Injected at build time via rsbuild's source.define (see rsbuild.config.ts).
// Falls back to '' so calls fail loudly/obviously in dev if it isn't configured,
// instead of silently hitting the wrong host.
const BASE_URL = (process.env.NEXT_PUBLIC_BULK_TRADER_API_URL || '').replace(/\/$/, '');

class BulkTraderApiError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.name = 'BulkTraderApiError';
        this.status = status;
    }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (!BASE_URL) {
        throw new BulkTraderApiError(
            'Bulk Trader backend URL is not configured. Set NEXT_PUBLIC_BULK_TRADER_API_URL in your deployment environment.'
        );
    }
    const response = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
        },
    });
    const is_json = response.headers.get('content-type')?.includes('application/json');
    const body = is_json ? await response.json().catch(() => null) : null;
    if (!response.ok) {
        throw new BulkTraderApiError(body?.error || `Request failed with status ${response.status}`, response.status);
    }
    return body as T;
};

export const startBulkRun = (token: string, strategies: TStrategyConfig[]) =>
    request<TStartBulkRunResponse>('/api/bulk/start', {
        method: 'POST',
        body: JSON.stringify({ token, strategies }),
    });

export const getBulkRunStatus = (runId: string) => request<TRunStatus>(`/api/bulk/status/${runId}`);

export const stopBulkRun = (runId: string, strategyId?: string) =>
    request<{ ok: boolean }>('/api/bulk/stop', {
        method: 'POST',
        body: JSON.stringify({ run_id: runId, strategy_id: strategyId }),
    });

// --- AI agent -------------------------------------------------------------
// Same token-authenticated pattern as the bulk-run calls above. The backend
// re-validates and clamps `config` against hard caps regardless of what is
// sent here (see backend/src/aiAgent.js) — nothing here is the real gate.

export const startAiRun = (token: string, config: TAiAgentConfig) =>
    request<TStartAiRunResponse>('/api/ai/start', {
        method: 'POST',
        body: JSON.stringify({ token, config }),
    });

export const getAiRunStatus = (runId: string) => request<TAiRunStatus>(`/api/ai/status/${runId}`);

export const stopAiRun = (runId: string) =>
    request<{ ok: boolean }>('/api/ai/stop', {
        method: 'POST',
        body: JSON.stringify({ run_id: runId }),
    });

export { BulkTraderApiError };
