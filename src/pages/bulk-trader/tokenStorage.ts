// Shared with src/components/layout/header/header.tsx, which is where this
// value gets written via the "Bulk Trader API token" field. Both the manual
// strategy builder and the AI agent panel read the same saved token — there
// is exactly one Bulk Trader credential per browser, not one per feature.
export const MANUAL_TOKEN_STORAGE_KEY = 'deriv_manual_api_token';

/**
 * Bulk Trader (and the AI agent) prefer a manually-pasted, longer-lived API
 * token when one is set, since that's a stable credential meant for exactly
 * this. Falls back to the OAuth2 browser-session token (Ory-issued, in
 * localStorage.auth_info) only if no manual token has been saved — that one
 * is short-lived by design and not ideal for a backend run, but better than
 * nothing.
 */
export const getActiveToken = (): string => {
    const manual = localStorage.getItem(MANUAL_TOKEN_STORAGE_KEY);
    if (manual && manual.trim()) return manual.trim();
    try {
        const raw = localStorage.getItem('auth_info');
        if (!raw) return '';
        const parsed = JSON.parse(raw);
        return parsed?.access_token ?? '';
    } catch {
        return '';
    }
};
