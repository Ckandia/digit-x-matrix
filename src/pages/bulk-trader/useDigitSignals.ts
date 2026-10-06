import { useEffect, useSyncExternalStore } from 'react';
import { TConnectionState, TSnapshotMap, TSymbolSnapshot } from './analysis-types';

const RECONNECT_DELAY_MS = 3000;

// Injected at build time (see rsbuild.config.ts source.define), same pattern as
// NEXT_PUBLIC_BULK_TRADER_API_URL. Falls back to deriving it from the REST base
// URL so a single env var covers both if only one is set.
const explicit_ws_url = (process.env.NEXT_PUBLIC_ANALYSIS_WS_URL || '').trim();
const rest_base = (process.env.NEXT_PUBLIC_BULK_TRADER_API_URL || '').trim().replace(/\/$/, '');

export const deriveWsUrl = () => {
    if (explicit_ws_url) return explicit_ws_url;
    if (!rest_base) return '';
    return `${rest_base.replace(/^http/, 'ws')}/ws/signals`;
};

const REST_SNAPSHOT_URL = rest_base ? `${rest_base}/api/analysis/snapshot` : '';

// ---- One shared feed for the whole app -------------------------------------------------------
// The live digit-analysis socket used to belong to whichever component called the hook, so leaving a
// tab closed it. The AI auto-pilot reads these signals every trade, so it must keep receiving them
// while you are on another tab. The feed is therefore a module-level store: it stays open while
// anything holds it (a mounted tab, or a running AI via retainSignals) and closes when nothing does.

type TFeedState = { snapshots: TSnapshotMap; connectionState: TConnectionState };

let state: TFeedState = { snapshots: {}, connectionState: 'connecting' };
const listeners = new Set<() => void>();
const setState = (patch: Partial<TFeedState>) => {
    state = { ...state, ...patch };
    listeners.forEach(l => l());
};

let holders = 0;
let ws: WebSocket | null = null;
let reconnect_timer: ReturnType<typeof setTimeout> | null = null;

const openFeed = () => {
    const wsUrl = deriveWsUrl();

    if (!wsUrl) {
        setState({ connectionState: 'unconfigured' });
        // Still try a one-off REST fetch in case only the REST base is set
        // and the operator forgot NEXT_PUBLIC_ANALYSIS_WS_URL — better to
        // show *something* than nothing.
        if (REST_SNAPSHOT_URL) {
            fetch(REST_SNAPSHOT_URL)
                .then(r => r.json())
                .then(body => {
                    if (holders > 0 && body?.data) setState({ snapshots: body.data });
                })
                .catch(() => undefined);
        }
        return;
    }

    const connect = () => {
        if (holders === 0) return;
        setState({ connectionState: 'connecting' });
        const socket = new WebSocket(wsUrl);
        ws = socket;

        socket.onopen = () => {
            if (ws === socket) setState({ connectionState: 'open' });
        };

        socket.onmessage = event => {
            try {
                const parsed = JSON.parse(event.data);
                if (parsed.type === 'snapshot') {
                    setState({ snapshots: parsed.data as TSnapshotMap });
                } else if (parsed.type === 'update' && parsed.symbol) {
                    setState({ snapshots: { ...state.snapshots, [parsed.symbol]: parsed.data as TSymbolSnapshot } });
                }
            } catch {
                // ignore malformed frames
            }
        };

        socket.onclose = () => {
            if (ws !== socket) return; // an old socket we already replaced or closed on purpose
            ws = null;
            if (holders === 0) return;
            setState({ connectionState: 'closed' });
            reconnect_timer = setTimeout(connect, RECONNECT_DELAY_MS);
        };

        socket.onerror = () => {
            socket.close();
        };
    };

    connect();
};

const closeFeed = () => {
    if (reconnect_timer) clearTimeout(reconnect_timer);
    reconnect_timer = null;
    const socket = ws;
    ws = null; // so its onclose does not schedule a reconnect
    socket?.close();
};

/** Keeps the feed open until the returned function is called (safe to call more than once). */
export const retainSignals = (): (() => void) => {
    holders += 1;
    if (holders === 1) openFeed();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders === 0) closeFeed();
    };
};

/** The latest snapshots, read by the AI engine on every pick. */
export const getSignalSnapshots = (): TSnapshotMap => state.snapshots;

const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
};
const getState = () => state;

/**
 * Live digit-analysis feed (stats + signals per symbol, recomputed as Deriv ticks arrive). Auto-reconnects
 * on drop. This never sends a token — it's read-only market analysis.
 */
export const useDigitSignals = () => {
    useEffect(() => retainSignals(), []);
    return useSyncExternalStore(subscribe, getState);
};
