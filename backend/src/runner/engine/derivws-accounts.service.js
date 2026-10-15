// Node version of src/services/derivws-accounts.service.ts: the same two REST calls the browser makes (accounts list, and a
// one-time login URL per socket), with the token passed in by the runner. Nothing is cached on disk.
const BASE = process.env.DERIV_ENV === 'staging' ? 'https://staging-api.derivws.com/trading/v1/' : 'https://api.derivws.com/trading/v1/';
const OPTIONS_DIR = 'options/';

let stored = null;

// The runner uses a personal API token the owner created (Read + Trade), not the website's login token. Deriv asks such a token to
// come with the app id (DERIV_APP_ID, already set on the backend for the market feed). Sent when present.
const authHeaders = accessToken => {
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (process.env.DERIV_APP_ID) headers['Deriv-App-ID'] = process.env.DERIV_APP_ID;
    return headers;
};

export class DerivWSAccountsService {
    static getStoredAccounts() {
        return stored;
    }
    static storeAccounts(accounts) {
        stored = accounts;
    }
    static clearStoredAccounts() {
        stored = null;
    }
    static clearCache() {
        stored = null;
    }
    static async fetchAccountsList(accessToken) {
        const response = await fetch(`${BASE}${OPTIONS_DIR}accounts`, { method: 'GET', headers: authHeaders(accessToken) });
        if (!response.ok) throw new Error(`Failed to fetch accounts: ${response.status} ${response.statusText}`);
        const data = await response.json();
        const accounts = data?.data || [];
        stored = accounts;
        return accounts;
    }
    // A login URL is single-use, so every call asks for a new one (the `fresh` option of the browser version).
    static async fetchOTPWebSocketURL(accessToken, accountId) {
        const response = await fetch(`${BASE}${OPTIONS_DIR}accounts/${accountId}/otp`, { method: 'POST', headers: authHeaders(accessToken) });
        if (!response.ok) throw new Error(`Failed to fetch OTP: ${response.status} ${response.statusText}`);
        const body = await response.json();
        const url = body?.data?.url;
        if (!url) throw new Error('WebSocket URL not found in OTP response');
        return url;
    }
}
