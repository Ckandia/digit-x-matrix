// A tiny shared feed of trade results and log lines from the Bulk Trader
// engines (which run outside React). The Bulk Trader tab subscribes to it, so
// results survive switching tabs and stay visible after a run stops.
import { mergeTradeRow, TTradeRow } from './tradeHistory';

export type TActivity = { ts: number; kind: 'info' | 'success' | 'error'; text: string };

let rows: TTradeRow[] = [];
let activity: TActivity[] = [];
const listeners = new Set<() => void>();
const log_listeners = new Set<(kind: TActivity['kind'], text: string) => void>();
const contract_listeners = new Set<(c: Record<string, unknown>) => void>();

const notify = () => listeners.forEach(l => l());

export const tradeBus = {
    contract(c: Record<string, unknown>) {
        rows = mergeTradeRow(rows, c);
        contract_listeners.forEach(l => l(c));
        notify();
    },
    log(kind: TActivity['kind'], text: string) {
        activity = [{ ts: Date.now(), kind, text }, ...activity].slice(0, 40);
        log_listeners.forEach(l => l(kind, text));
        notify();
    },
    clear() {
        rows = [];
        activity = [];
        notify();
    },
    snapshot: () => ({ rows, activity }),
    subscribe(l: () => void) {
        listeners.add(l);
        return () => listeners.delete(l);
    },
    onLog(l: (kind: TActivity['kind'], text: string) => void) {
        log_listeners.add(l);
        return () => log_listeners.delete(l);
    },
    onContract(l: (c: Record<string, unknown>) => void) {
        contract_listeners.add(l);
        return () => contract_listeners.delete(l);
    },
};
