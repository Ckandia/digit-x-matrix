// The AI Trader (and Bulk Trader) trade over their OWN Deriv connection, separate from the one the app's header balance
// listens to, so after a trade the header kept showing the old number while the AI tab showed the real one. Every live
// balance the trading connection receives is pushed through here; the app registers one sink that writes it to the
// client store (only when it is the account the header is showing).
type TSink = (loginid: string, balance: number, currency: string) => void;

let sink: TSink | null = null;

export const setHeaderBalanceSink = (fn: TSink | null) => {
    sink = fn;
};

export const pushHeaderBalance = (loginid: string, balance: number, currency: string) => {
    if (!sink || !loginid || !Number.isFinite(balance)) return;
    try {
        sink(loginid, balance, currency);
    } catch {
        /* the header is cosmetic: never let it break trading */
    }
};
