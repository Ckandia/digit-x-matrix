import { useEffect, useRef, useState } from 'react';
import { deriveWsUrl } from './useDigitSignals';
import { TAiAgentEvent } from './aiAgentTypes';

const RECONNECT_DELAY_MS = 3000;
const MAX_EVENTS = 60; // enough for the pipeline view + a short scrollback, not an unbounded log

/**
 * Subscribes to the same /ws/signals socket useDigitSignals uses, filtering
 * for `agent_event` frames — the AI agent's real decisions (scored, gated,
 * executed, settled), not a client-side simulation of them. Opens its own
 * connection rather than sharing useDigitSignals' so the two hooks stay
 * independent; the backend broadcasts every event to every connected client
 * regardless of how many sockets one browser tab opens.
 */
export const useAiAgentEvents = () => {
    const [events, setEvents] = useState<TAiAgentEvent[]>([]);
    const [connected, setConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        const wsUrl = deriveWsUrl();
        if (!wsUrl) return () => undefined;

        const connect = () => {
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                if (mountedRef.current) setConnected(true);
            };

            ws.onmessage = event => {
                try {
                    const parsed = JSON.parse(event.data);
                    if (parsed.type === 'agent_event' && parsed.data) {
                        setEvents(prev => [...prev.slice(-(MAX_EVENTS - 1)), parsed.data as TAiAgentEvent]);
                    }
                } catch {
                    // ignore malformed frames
                }
            };

            ws.onclose = () => {
                if (!mountedRef.current) return;
                setConnected(false);
                reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
            };

            ws.onerror = () => ws.close();
        };

        connect();

        return () => {
            mountedRef.current = false;
            if (reconnectRef.current) clearTimeout(reconnectRef.current);
            wsRef.current?.close();
        };
    }, []);

    const clear = () => setEvents([]);

    return { events, connected, clear };
};
