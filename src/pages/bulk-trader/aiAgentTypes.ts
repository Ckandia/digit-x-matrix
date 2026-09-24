import { TDigitContractType } from './types';

export type TAiAgentConfig = {
    symbols: string[];
    stake: number;
    /** Deviation-score threshold (0-100) a signal must clear before the agent
     *  will trade it. This is not a win-probability threshold — see the
     *  honesty note in AiAgentPanel.tsx. The backend enforces a floor of 40
     *  regardless of what is sent here. */
    min_confidence: number;
    /** Required. The backend refuses to start an agent run without this. */
    stop_loss: number;
    take_profit?: number;
    max_trades: number;
    duration_ticks: number;
};

export type TAiAgentStatus = {
    id: string;
    status: 'idle' | 'running' | 'stopped' | 'error';
    symbols: string[];
    min_confidence: number;
    stake: number;
    trades: number;
    wins: number;
    losses: number;
    total_profit: number;
    stop_reason?: string;
    error?: string;
};

export type TAiRunStatus = {
    run_id: string;
    loginid: string;
    started_at: string;
    agent: TAiAgentStatus;
};

export type TStartAiRunResponse = {
    run_id: string;
    agent_id: string;
    loginid: string;
};

/** One entry in the live pipeline: every scored signal, gate decision, trade
 *  placement, and settlement the agent actually made — not a simulation. */
export type TAiAgentEvent = {
    agent_id: string;
    ts: number;
    phase: 'started' | 'gate_passed' | 'gate_rejected' | 'executing' | 'settled' | 'error' | 'stopped';
    symbol?: string;
    contract_type?: TDigitContractType;
    label?: string;
    confidence?: number;
    basis?: string;
    reason?: string | null;
    stake?: number;
    result?: 'win' | 'loss';
    profit?: number;
    total_profit?: number;
    trades?: number;
    error?: string;
    symbols?: string[];
    min_confidence?: number;
};
