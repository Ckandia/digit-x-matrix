import { TRunStatus, TStartBulkRunResponse, TStrategyConfig } from './types';
import * as bulkRunManager from './bulkRunManager';

class BulkTraderApiError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
        super(message);
        this.name = 'BulkTraderApiError';
        this.status = status;
    }
}

// --- Bulk Trades ------------------------------------------------------------
// These run entirely in this browser tab (see bulkRunManager.ts /
// derivClient.ts / strategyEngineClient.ts) — the token never leaves the
// browser and our own backend never sees it. Kept as async functions with
// the same shape as before so the rest of the UI didn't need to change.

const wrapManagerError = (err: unknown): never => {
    throw err instanceof Error ? new BulkTraderApiError(err.message) : new BulkTraderApiError('Something went wrong.');
};

export const startBulkRun = (token: string, strategies: TStrategyConfig[]): Promise<TStartBulkRunResponse> =>
    bulkRunManager.startBulkRun(token, strategies).catch(wrapManagerError);

export const getBulkRunStatus = (runId: string): Promise<TRunStatus> =>
    bulkRunManager.getBulkRunStatus(runId).catch(wrapManagerError);

export const stopBulkRun = (runId: string, strategyId?: string): Promise<{ ok: boolean }> =>
    bulkRunManager.stopBulkRun(runId, strategyId).catch(wrapManagerError);

// The AI auto-pilot (see autoPilotEngine.ts + AiAgentPanel.tsx) has no REST
// calls of its own anymore — the backend only ever computes and broadcasts
// signals over /ws/signals (already consumed by useDigitSignals for the
// Digit Matrix grid), and every trading decision is made and executed
// entirely in this browser tab.

export { BulkTraderApiError };
