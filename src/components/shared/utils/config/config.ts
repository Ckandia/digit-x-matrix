import {
    buildAuthorizationUrl,
    buildSignUpUrl,
    parseReferralLink,
    parseLandingParams,
    resolveReferralViaProxy,
} from '@/external/deriv-core';
import type { AuthConfig } from '@/external/deriv-core';
import { getInitialLanguage } from '@deriv-com/translations';
import brandConfig from '../../../../../brand.config.json';

// =============================================================================
// Constants - Domain & Server Configuration (from brand.config.json)
// =============================================================================

// Production app domains
export const PRODUCTION_DOMAINS = {
    COM: brandConfig.platform.hostname.production.com,
} as const;

// Staging app domains
export const STAGING_DOMAINS = {
    COM: brandConfig.platform.hostname.staging.com,
} as const;

// WebSocket server URLs.
//
// IMPORTANT: this app's trading layer (src/external/bot-skeleton, built on
// @deriv/deriv-api's DerivAPIBasic) speaks Deriv's CLASSIC protocol — plain
// messages like {active_symbols: 'brief'}, {ticks_history: 'R_100', ...},
// {authorize: token} — against wss://ws.derivws.com/websockets/v3. It is NOT
// built for Deriv's newer "Options Trading API" (trading/v1/options), which
// uses a different field name (underlying_symbol instead of symbol) and a
// different auth model (a short-lived OTP embedded in the connection URL,
// with no separate authorize message).
//
// `api-base.ts`'s authorizeAndSubscribe() already calls `this.api.authorize(token)`
// explicitly after connecting — that's the classic-protocol auth message. If the
// socket URL points at the OTP-authenticated Options endpoint instead, that
// stray authorize message gets sent to a connection that doesn't expect it and
// isn't built to serve it, and every classic-protocol call after that
// (active_symbols, contracts_for, trading_times, ticks_history, buy) times out —
// which is exactly the "No symbols found" / "Invalid symbol" / fetch-timeout
// cascade this fixes.
const WS_APP_ID = process.env.NEXT_PUBLIC_DERIV_WS_APP_ID || '1089';

export const WS_SERVERS = {
    STAGING: `wss://ws.derivws.com/websockets/v3?app_id=${WS_APP_ID}`,
    PRODUCTION: `wss://ws.derivws.com/websockets/v3?app_id=${WS_APP_ID}`,
} as const;

// =============================================================================
// Helper Functions
// =============================================================================

// Helper to check if we're on production.
// NEXT_PUBLIC_DERIV_ENV is the authoritative signal (set at build/deploy time and
// also read by vendored deriv-core for OAuth), so a deployed partner domain resolves the
// same environment for WebSocket and OAuth. Falls back to hostname detection when
// the env var is unset (e.g. local dev).
export const isProduction = () => {
    const env = process.env.NEXT_PUBLIC_DERIV_ENV;
    if (env === 'production') return true;
    if (env === 'preview' || env === 'staging') return false;

    const hostname = window.location.hostname;
    const productionDomains = Object.values(PRODUCTION_DOMAINS) as string[];
    return productionDomains.includes(hostname);
};

export const isLocal = () => /localhost(:\d+)?$/i.test(window.location.hostname);

const getDefaultServerURL = () => {
    const isProductionEnv = isProduction();

    try {
        return isProductionEnv ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
    } catch (error) {
        console.error('Error in getDefaultServerURL:', error);
    }

    return isProductionEnv ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
};

/**
 * Gets the WebSocket URL for the trading socket.
 *
 * This always returns the classic v3 endpoint (see the WS_SERVERS comment
 * above for why) regardless of login state. Authentication for a logged-in
 * session happens afterward, on the open socket, via the explicit
 * `this.api.authorize(token)` call in api-base.ts's authorizeAndSubscribe() —
 * not by connecting to a different, pre-authenticated URL.
 *
 * @returns Promise with the WebSocket URL
 */
export const getSocketURL = async (): Promise<string> => {
    return getDefaultServerURL();
};

export const getDebugServiceWorker = () => {
    const debug_service_worker_flag = window.localStorage.getItem('debug_service_worker');
    if (debug_service_worker_flag) return !!parseInt(debug_service_worker_flag);

    return false;
};

/**
 * Generates the OAuth login or sign-up URL using vendored deriv-core
 *
 * @param prompt - Optional prompt parameter ('registration' for sign-up flow)
 * @returns Promise with the OAuth URL string
 */
export const generateOAuthURL = async (prompt?: string): Promise<string> => {
    try {
        const clientId = process.env.NEXT_PUBLIC_DERIV_APP_ID;
        if (!clientId) return '';

        const config: AuthConfig = {
            clientId,
            redirectUri: window.location.origin,
            scopes: 'trade',
            // Without this a Bot deployed in ES/FR/PT sends its clients to an
            // English login (#804). `getInitialLanguage()` is the same reader
            // `url-redirect-utils` and `transfer-utils` use for their own `lang`
            // params, and resolves exactly what the app booted in: the boot
            // clamp in `app/i18n.ts` has already dropped any code this build
            // cannot render, and a switch from the footer reloads the page.
            lang: getInitialLanguage(),
        };

        // Static referral link (fallback for direct visits without affiliate click)
        const referralLink = process.env.NEXT_PUBLIC_DERIV_REFERRAL_LINK;
        if (referralLink) {
            const referral = parseReferralLink(referralLink);
            if (referral) {
                config.affiliateToken = referral.affiliateToken;
                config.affiliateTokenParam = referral.affiliateTokenParam;
                config.utmCampaign = referral.utmCampaign;
                if (referral.utmSource) config.utmSource = referral.utmSource;
                if (referral.utmMedium) config.utmMedium = referral.utmMedium;
            }
        }

        // Override with live per-click params from landing URL (e.g. Scaleo t= token)
        const landing = parseLandingParams();
        if (landing) {
            // Only override the token when the landing URL actually carries one
            // (t=). parseLandingParams returns non-null for any utm_* param, so an
            // unguarded write would clobber a valid env token with '' on generic
            // marketing links (e.g. ?utm_source=google with no t=).
            if (landing.affiliateToken) {
                config.affiliateToken = landing.affiliateToken;
                config.affiliateTokenParam = landing.affiliateTokenParam;
            }
            if (landing.utmSource) config.utmSource = landing.utmSource;
            if (landing.utmMedium) config.utmMedium = landing.utmMedium;
            if (landing.utmCampaign) config.utmCampaign = landing.utmCampaign;
        }

        // If we still have no token and the referral link is a Scaleo click link,
        // resolve a fresh per-user token via the BFF proxy (non-blocking).
        if (!config.affiliateToken && referralLink) {
            const resolved = await resolveReferralViaProxy(referralLink);
            if (resolved) {
                config.affiliateToken = resolved.affiliateToken;
                config.affiliateTokenParam = resolved.affiliateTokenParam;
                if (resolved.utmSource) config.utmSource = resolved.utmSource;
                if (resolved.utmMedium) config.utmMedium = resolved.utmMedium;
                if (resolved.utmCampaign) config.utmCampaign = resolved.utmCampaign;
            }
        }

        if (prompt === 'registration') {
            return await buildSignUpUrl(config);
        }
        return await buildAuthorizationUrl(config);
    } catch (error) {
        console.error('Error generating OAuth URL:', error);
        return '';
    }
};
