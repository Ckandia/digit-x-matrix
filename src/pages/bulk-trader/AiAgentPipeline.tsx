import React, { useMemo } from 'react';
import { localize } from '@deriv-com/translations';
import { TAiAgentEvent } from './aiAgentTypes';

type TStage = 'feed' | 'engine' | 'agent' | 'gate' | 'executor';

/**
 * Renders the agent's own reported events as a pipeline. Every pulse here
 * corresponds to a real `agent_event` frame from the backend — there is no
 * simulated or randomised motion. When the agent is idle, the diagram is
 * static, because nothing is actually happening.
 */
const AiAgentPipeline = ({ events }: { events: TAiAgentEvent[] }) => {
    const latest = events[events.length - 1];
    const active_stage: TStage | null = useMemo(() => {
        if (!latest) return null;
        switch (latest.phase) {
            case 'gate_passed':
            case 'gate_rejected':
                return 'gate';
            case 'executing':
                return 'executor';
            case 'settled':
                return 'executor';
            default:
                return 'agent';
        }
    }, [latest]);

    const recent = events.slice(-8).reverse();
    const passed_count = events.filter(e => e.phase === 'gate_passed').length;
    const rejected_count = events.filter(e => e.phase === 'gate_rejected').length;
    const scored_count = passed_count + rejected_count;
    const settled_count = events.filter(e => e.phase === 'settled').length;

    const stageClass = (stage: TStage) =>
        ['ai-pipeline__node', active_stage === stage && 'ai-pipeline__node--active'].filter(Boolean).join(' ');

    return (
        <div className='ai-pipeline'>
            <div className='ai-pipeline__diagram'>
                <div className={stageClass('feed')}>
                    <span className='ai-pipeline__node-title'>{localize('Market feed')}</span>
                    <span className='ai-pipeline__node-meta'>{localize('10 symbols · live ticks')}</span>
                </div>
                <div className='ai-pipeline__wire' />
                <div className={stageClass('engine')}>
                    <span className='ai-pipeline__node-title'>{localize('Digit engine')}</span>
                    <span className='ai-pipeline__node-meta'>{localize('500-tick window')}</span>
                </div>
                <div className='ai-pipeline__wire' />
                <div className={stageClass('agent')}>
                    <span className='ai-pipeline__node-title'>{localize('Agent')}</span>
                    <span className='ai-pipeline__node-meta'>{scored_count} {localize('scored')}</span>
                </div>
                <div className='ai-pipeline__wire' />
                <div className={stageClass('gate')}>
                    <span className='ai-pipeline__node-title'>{localize('Confidence gate')}</span>
                    <span className='ai-pipeline__node-meta'>
                        {passed_count} {localize('passed')} · {rejected_count} {localize('rejected')}
                    </span>
                </div>
                <div className='ai-pipeline__wire' />
                <div className={stageClass('executor')}>
                    <span className='ai-pipeline__node-title'>{localize('Executor')}</span>
                    <span className='ai-pipeline__node-meta'>{settled_count} {localize('settled')}</span>
                </div>
            </div>

            <div className='ai-pipeline__log' aria-live='polite'>
                {recent.length === 0 && (
                    <p className='ai-pipeline__log-empty'>
                        {localize('No decisions yet. The log fills in once the agent is running.')}
                    </p>
                )}
                {recent.map((event, i) => (
                    <PipelineLogRow key={`${event.ts}-${i}`} event={event} />
                ))}
            </div>
        </div>
    );
};

const PipelineLogRow = ({ event }: { event: TAiAgentEvent }) => {
    const time = new Date(event.ts).toLocaleTimeString();

    if (event.phase === 'gate_passed') {
        return (
            <div className='ai-pipeline__log-row ai-pipeline__log-row--pass'>
                <span className='ai-pipeline__log-time'>{time}</span>
                <span>
                    {localize('Gate passed')} — {event.symbol} {event.label} (
                    {localize('deviation')} {event.confidence})
                </span>
            </div>
        );
    }
    if (event.phase === 'gate_rejected') {
        return (
            <div className='ai-pipeline__log-row ai-pipeline__log-row--reject'>
                <span className='ai-pipeline__log-time'>{time}</span>
                <span>
                    {event.symbol} {event.label} {localize('rejected')} — {event.reason}
                </span>
            </div>
        );
    }
    if (event.phase === 'executing') {
        return (
            <div className='ai-pipeline__log-row ai-pipeline__log-row--exec'>
                <span className='ai-pipeline__log-time'>{time}</span>
                <span>
                    {localize('Placing trade')} — {event.symbol} {event.contract_type} @ {event.stake}
                </span>
            </div>
        );
    }
    if (event.phase === 'settled') {
        const won = event.result === 'win';
        return (
            <div className={`ai-pipeline__log-row ${won ? 'ai-pipeline__log-row--win' : 'ai-pipeline__log-row--loss'}`}>
                <span className='ai-pipeline__log-time'>{time}</span>
                <span>
                    {event.symbol} {won ? localize('won') : localize('lost')} {event.profit} — {localize('total')}{' '}
                    {event.total_profit}
                </span>
            </div>
        );
    }
    if (event.phase === 'error') {
        return (
            <div className='ai-pipeline__log-row ai-pipeline__log-row--error'>
                <span className='ai-pipeline__log-time'>{time}</span>
                <span>{localize('Error')} — {event.error}</span>
            </div>
        );
    }
    if (event.phase === 'started') {
        return (
            <div className='ai-pipeline__log-row'>
                <span className='ai-pipeline__log-time'>{time}</span>
                <span>
                    {localize('Agent started')} — {event.symbols?.length} {localize('symbols, threshold')}{' '}
                    {event.min_confidence}
                </span>
            </div>
        );
    }
    return (
        <div className='ai-pipeline__log-row'>
            <span className='ai-pipeline__log-time'>{time}</span>
            <span>{localize('Agent stopped')} — {event.reason}</span>
        </div>
    );
};

export default AiAgentPipeline;
