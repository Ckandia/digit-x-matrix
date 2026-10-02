// Keeps a phone's screen on while a run is active. The strategies run inside the browser tab, and
// a locked screen makes mobile browsers pause the tab and drop the Deriv connection.
// Supported on Android Chrome and iOS Safari 16.4+; silently does nothing elsewhere.
const holders = new Set<string>();
let sentinel: { release: () => Promise<void>; addEventListener: (e: string, f: () => void) => void } | null = null;

const acquire = async () => {
    try {
        const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<typeof sentinel> } }).wakeLock;
        if (!wl || sentinel) return;
        sentinel = await wl.request('screen');
        sentinel?.addEventListener('release', () => {
            sentinel = null;
        });
    } catch {
        /* denied or unsupported: not critical */
    }
};

if (typeof document !== 'undefined') {
    // The lock is dropped whenever the tab is hidden; take it again when the user comes back.
    document.addEventListener('visibilitychange', () => {
        if (holders.size > 0 && document.visibilityState === 'visible') void acquire();
    });
}

export const keepScreenAwake = (holder: string, on: boolean) => {
    if (on) {
        holders.add(holder);
        void acquire();
    } else {
        holders.delete(holder);
        if (holders.size === 0 && sentinel) {
            void sentinel.release().catch(() => undefined);
            sentinel = null;
        }
    }
};
