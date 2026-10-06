import { getAuthInfo } from '@/external/deriv-core';

/**
 * Bulk Trader and the AI agent trade using the same OAuth session the rest
 * of the app already authenticated with — the same token api-base.ts uses
 * for the main bot engine. There used to be a second, manually-pasted API
 * token just for this tab; it was redundant (this app is OAuth-only, no
 * third-party integration needs a separate credential) and has been removed.
 * If nobody is logged in, this simply returns ''.
 */
export const getActiveToken = (): string => {
    return getAuthInfo()?.access_token ?? '';
};
