type DerivEnv = 'production' | 'preview';

function getEnv(): DerivEnv {
  // `process.env.NEXT_PUBLIC_DERIV_ENV` is statically replaced at build time by
  // rsbuild's `source.define`. Do NOT guard on `typeof process` — the bare
  // `process` identifier is not defined, so it is `'undefined'` in the browser
  // and would short-circuit this to the production fallback even on staging.
  return process.env.NEXT_PUBLIC_DERIV_ENV === 'preview' ? 'preview' : 'production';
}

const URLS = {
  production: {
    authBase: 'https://auth.deriv.com/oauth2',
    apiBase: 'https://api.derivws.com/trading/v1/options',
    // Not the socket the app's trading layer actually uses (see
    // src/components/shared/utils/config/config.ts for why) — this constant
    // is currently unreferenced by any live code path. Kept accurate rather
    // than deleted in case a future REST-only integration needs it.
    publicWs: 'wss://ws.derivws.com/websockets/v3',
    appBuilder: 'https://developers.deriv.com',
  },
  preview: {
    authBase: 'https://staging-auth.deriv.com/oauth2',
    apiBase: 'https://staging-api.derivws.com/trading/v1/options',
    publicWs: 'wss://ws.derivws.com/websockets/v3',
    appBuilder: 'https://staging-developers.deriv.com',
  },
} as const;

export function getAuthBaseUrl(): string {
  return URLS[getEnv()].authBase;
}

export function getApiBaseUrl(): string {
  return URLS[getEnv()].apiBase;
}

export function getPublicWsUrl(): string {
  return URLS[getEnv()].publicWs;
}

/**
 * Base URL of the app-builder BFF (deriv-api-v2), used to call its runtime
 * affiliate-resolution proxy. Derived from NEXT_PUBLIC_DERIV_ENV.
 */
export function getAppBuilderBaseUrl(): string {
  return URLS[getEnv()].appBuilder;
}
