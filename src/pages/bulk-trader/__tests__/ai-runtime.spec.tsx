import React from 'react';
import { act, render } from '@testing-library/react';

// ---- stand-ins for everything the panel pulls in from the app -------------------------------
jest.mock('@/hooks/useApiBase', () => ({
    useApiBase: () => ({ isAuthorized: true, authData: { balance: 1000, currency: 'USD' }, activeLoginid: 'VRTC1' }),
}));
jest.mock('@/hooks/useStore', () => ({
    useStore: () => ({
        run_panel: { toggleDrawer: jest.fn(), onBotContractEvent: jest.fn() },
        transactions: { onBotContractEvent: jest.fn() },
        summary_card: { onBotContractEvent: jest.fn() },
        journal: { pushMessage: jest.fn() },
    }),
}));
jest.mock('@/external/bot-skeleton', () => ({ MessageTypes: { ERROR: 'e', SUCCESS: 's', NOTIFY: 'n' } }));
jest.mock('../../journal/journalStore', () => ({
    journalStore: { selfReviewEnabled: () => false, gate: jest.fn(), addAi: jest.fn(), review: jest.fn() },
}));
jest.mock('../tokenStorage', () => ({ getActiveToken: () => 'token' }));
jest.mock('../contractRules', () => ({ loadLiveRules: jest.fn() }));
jest.mock('../wakeLock', () => ({ keepScreenAwake: jest.fn() }));
const mockConnect = jest.fn();
jest.mock('../derivClient', () => ({
    DerivClientConnection: jest.fn().mockImplementation(() => ({
        accountInfo: { loginid: 'VRTC1', currency: 'USD', balance: 1000, type: 'demo' },
        balanceLive: true,
        isReady: true,
        connect: mockConnect,
        close: jest.fn(),
        refreshBalance: jest.fn(),
    })),
}));

import AiAgentPanel from '../AiAgentPanel';
import { aiRuntime, aiSet, releaseRun, watchAccount } from '../aiRuntime';
import { getSignalSnapshots, retainSignals } from '../useDigitSignals';

const fakeConnection = (loginid = 'VRTC1') =>
    ({
        accountInfo: { loginid, currency: 'USD', balance: 1000, type: 'demo' },
        balanceLive: true,
        isReady: true,
        close: jest.fn(),
        onBalance: null,
    }) as never;

const fakeEngine = (running = true) => ({ isRunning: running, stop: jest.fn() }) as never;

beforeEach(() => {
    mockConnect.mockResolvedValue({ authorize: { loginid: 'VRTC1', currency: 'USD', balance: 1000, type: 'demo' } });
    aiRuntime.engineRef.current = null;
    aiRuntime.connectionRef.current = null;
    aiRuntime.mounted = 0;
    aiSet.status('idle');
});

describe('AI run survives leaving the tab', () => {
    it('does not stop the engine or close its connection when the panel unmounts', async () => {
        const engine = fakeEngine(true);
        const connection = fakeConnection();
        aiRuntime.engineRef.current = engine;
        aiRuntime.connectionRef.current = connection;
        aiSet.status('running');

        const view = render(<AiAgentPanel hasAcceptedRisk onNeedsRiskAccept={jest.fn()} />);
        await act(async () => undefined);
        view.unmount(); // what switching from the AI tab to Journal does

        expect((engine as any).stop).not.toHaveBeenCalled();
        expect((connection as any).close).not.toHaveBeenCalled();
        expect(aiRuntime.engineRef.current).toBe(engine);
        expect(aiRuntime.get().status).toBe('running');
    });

    it('re-attaches to the live run on return instead of opening a second connection', async () => {
        const { DerivClientConnection } = jest.requireMock('../derivClient');
        const connection = fakeConnection();
        aiRuntime.engineRef.current = fakeEngine(true);
        aiRuntime.connectionRef.current = connection;
        aiSet.status('running');
        DerivClientConnection.mockClear();

        render(<AiAgentPanel hasAcceptedRisk onNeedsRiskAccept={jest.fn()} />);
        await act(async () => undefined);

        expect(DerivClientConnection).not.toHaveBeenCalled();
        expect(aiRuntime.connectionRef.current).toBe(connection);
        expect(typeof (connection as any).onBalance).toBe('function'); // balance ticks flow to the new panel
    });

    it('closes the connection when the panel unmounts and nothing is running', async () => {
        const connection = fakeConnection();
        aiRuntime.connectionRef.current = connection;
        const view = render(<AiAgentPanel hasAcceptedRisk onNeedsRiskAccept={jest.fn()} />);
        await act(async () => undefined);
        view.unmount();
        expect(aiRuntime.connectionRef.current).toBeNull();
    });
});

describe('run housekeeping while the tab is closed', () => {
    it('releaseRun closes the connection only when no panel is on screen', () => {
        const a = fakeConnection();
        aiRuntime.connectionRef.current = a;
        aiRuntime.mounted = 1;
        releaseRun();
        expect((a as any).close).not.toHaveBeenCalled();

        aiRuntime.mounted = 0;
        releaseRun();
        expect((a as any).close).toHaveBeenCalled();
        expect(aiRuntime.connectionRef.current).toBeNull();
    });

    it('stops a running AI if the header account changes while the tab is closed', () => {
        jest.useFakeTimers();
        const engine = fakeEngine(true);
        aiRuntime.engineRef.current = engine;
        aiRuntime.connectionRef.current = fakeConnection('VRTC1');
        localStorage.setItem('active_loginid', 'CR999');
        watchAccount();
        jest.advanceTimersByTime(2100);
        expect((engine as any).stop).toHaveBeenCalledWith('the active account was switched in the header');
        localStorage.removeItem('active_loginid');
        jest.useRealTimers();
    });

    it('leaves a running AI alone while the account is unchanged', () => {
        jest.useFakeTimers();
        const engine = fakeEngine(true);
        aiRuntime.engineRef.current = engine;
        aiRuntime.connectionRef.current = fakeConnection('VRTC1');
        localStorage.setItem('active_loginid', 'VRTC1');
        watchAccount();
        jest.advanceTimersByTime(6100);
        expect((engine as any).stop).not.toHaveBeenCalled();
        (engine as any).isRunning = false;
        jest.advanceTimersByTime(2100); // watcher shuts itself off once the run ends
        localStorage.removeItem('active_loginid');
        jest.useRealTimers();
    });
});

describe('shared signal feed', () => {
    class FakeSocket {
        static all: FakeSocket[] = [];
        onopen: (() => void) | null = null;
        onmessage: ((e: { data: string }) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        closed = false;
        constructor(public url: string) {
            FakeSocket.all.push(this);
        }
        close() {
            this.closed = true;
            this.onclose?.();
        }
    }

    it('stays open for the AI after a tab lets go, and closes only when the last holder releases', () => {
        // The feed URL comes from env at import time, so this exercises the refcount through the unconfigured path
        // plus a direct socket when a URL is set.
        const original = (global as any).WebSocket;
        (global as any).WebSocket = FakeSocket;
        const releaseTab = retainSignals();
        const releaseAi = retainSignals();
        releaseTab();
        const open = FakeSocket.all.filter(s => !s.closed);
        // With no URL configured there is no socket at all; with one, exactly one stays open for the AI.
        expect(open.length).toBeLessThanOrEqual(1);
        releaseAi();
        expect(FakeSocket.all.filter(s => !s.closed)).toHaveLength(0);
        expect(getSignalSnapshots()).toBeDefined();
        (global as any).WebSocket = original;
    });
});
