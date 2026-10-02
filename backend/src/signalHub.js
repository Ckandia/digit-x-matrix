import { WebSocketServer } from 'ws';

const THROTTLE_MS = 400; // coalesce bursts of ticks per symbol into one push

/**
 * Bridges MarketFeed → connected frontend clients over a plain (unauthenticated)
 * WebSocket at /ws/signals. Every connected client gets the full snapshot for
 * every symbol on connect, then throttled per-symbol updates as new ticks land.
 * This never touches a user's Deriv token — it's the read-only "brain" feed;
 * the frontend still places any trade itself via its own authorized session.
 */
export function attachSignalHub(httpServer, marketFeed, { path = '/ws/signals', allowedOrigins } = {}) {
    const wss = new WebSocketServer({ server: httpServer, path });
    const pendingBroadcast = new Map(); // symbol -> timeout handle

    const originAllowed = origin => {
        if (!allowedOrigins || allowedOrigins.length === 0) return true;
        return allowedOrigins.includes(origin);
    };

    wss.on('connection', (ws, req) => {
        if (!originAllowed(req.headers.origin)) {
            ws.close(1008, 'Origin not allowed');
            return;
        }

        ws.send(
            JSON.stringify({
                type: 'snapshot',
                data: marketFeed.getAllSnapshots(),
            })
        );

        ws.on('error', () => {
            // eslint-disable-next-line no-console
            console.warn('[signalHub] client socket error');
        });
    });

    marketFeed.onUpdate(symbol => {
        // Throttle: at most one broadcast per symbol per THROTTLE_MS, always
        // carrying the *latest* stats/signals by the time it fires.
        if (pendingBroadcast.has(symbol)) return;
        const timer = setTimeout(() => {
            pendingBroadcast.delete(symbol);
            const snapshot = marketFeed.getSnapshot(symbol);
            if (!snapshot) return;
            const payload = JSON.stringify({
                type: 'update',
                symbol,
                data: snapshot,
            });
            for (const client of wss.clients) {
                if (client.readyState === client.OPEN) client.send(payload);
            }
        }, THROTTLE_MS);
        pendingBroadcast.set(symbol, timer);
    });

    // AI agent decisions (scored / gate-passed / gate-rejected / executing /
    // settled) are pushed unthrottled and immediately — unlike tick stats,
    // these are discrete events, not a stream to coalesce, and the frontend
    // pipeline view needs them in order to stay honest about what the agent
    // actually did rather than animating a guess.
    const broadcastAgentEvent = event => {
        const payload = JSON.stringify({ type: 'agent_event', data: event });
        for (const client of wss.clients) {
            if (client.readyState === client.OPEN) client.send(payload);
        }
    };

    return { wss, broadcastAgentEvent };
}
