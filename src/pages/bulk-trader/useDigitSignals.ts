import { useEffect, useRef, useState } from 'react';
import { TConnectionState, TSnapshotMap, TSymbolSnapshot } from './analysis-types';

const RECONNECT_DELAY_MS = 3000;

// Injected at build time (see rsbuild.config.ts source.define), same pattern as
// NEXT_PUBLIC_BULK_TRADER_API_URL. Falls back to deriving it from the REST base
// URL so a single env var covers both if only one is set.
const explicit_ws_url = (process.env.NEXT_PUBLIC_ANALYSIS_WS_URL || '').trim();
const rest_base = (process.env.NEXT_PUBLIC_BULK_TRADER_API_URL || '').trim().replace(/\/$/, '');

const deriveWsUrl = () => {
    if (explicit_ws_url) return explicit_ws_url;
    if (!rest_base) return '';
    return `${rest_base.replace(/^http/, 'ws')}/ws/signals`;
};

const REST_SNAPSHOT_URL = rest_base ? `${rest_base}/api/analysis/snapshot` : '';

/**
 * Subscribes to the backend's live digit-analysis feed (stats + signals per
 * symbol, recomputed as Deriv ticks arrive). Falls back to one REST fetch for
 * an initial snapshot if the socket hasn't opened yet, and auto-reconnects on
 * drop. This never sends a token — it's read-only market analysis.
 */
export const useDigitSignals = () => {
    const [snapshots, setSnapshots] = useState<TSnapshotMap>({});
    const [connectionState, setConnectionState] = useState<TConnectionState>('connecting');
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        const wsUrl = deriveWsUrl();

        if (!wsUrl) {
            setConnectionState('unconfigured');
            // Still try a one-off REST fetch in case only the REST base is set
            // and the operator forgot NEXT_PUBLIC_ANALYSIS_WS_URL — better to
            // show *something* than nothing.
            if (REST_SNAPSHOT_URL) {
                fetch(REST_SNAPSHOT_URL)
                    .then(r => r.json())
                    .then(body => {
                        if (mountedRef.current && body?.data) setSnapshots(body.data);
                    })
                    .catch(() => undefined);
            }
            return () => {
                mountedRef.current = false;
            };
        }

        const connect = () => {
            setConnectionState('connecting');
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                if (mountedRef.current) setConnectionState('open');
            };

            ws.onmessage = event => {
                try {
                    const parsed = JSON.parse(event.data);
                    if (parsed.type === 'snapshot') {
                        setSnapshots(parsed.data as TSnapshotMap);
                    } else if (parsed.type === 'update' && parsed.symbol) {
                        setSnapshots(prev => ({ ...prev, [parsed.symbol]: parsed.data as TSymbolSnapshot }));
                    }
                } catch {
                    // ignore malformed frames
                }
            };

            ws.onclose = () => {
                if (!mountedRef.current) return;
                setConnectionState('closed');
                reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
            };

            ws.onerror = () => {
                ws.close();
            };
        };

        connect();

        return () => {
            mountedRef.current = false;
            if (reconnectRef.current) clearTimeout(reconnectRef.current);
            wsRef.current?.close();
        };
    }, []);

    return { snapshots, connectionState };
};
