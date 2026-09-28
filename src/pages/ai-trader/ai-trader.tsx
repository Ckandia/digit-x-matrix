import React, { useState } from 'react';
import { localize } from '@deriv-com/translations';
import AiAgentPanel from '../bulk-trader/AiAgentPanel';
import './ai-trader.scss';

// The AI auto-trader's own tab. All the trading logic lives in
// ../bulk-trader/autoPilotEngine.ts and runs in this browser tab; this page
// just hosts the panel plus the risk acknowledgement it requires.
const AiTrader = () => {
    const [hasAcceptedRisk, setHasAcceptedRisk] = useState(false);

    return (
        <div className='ai-trader'>
            <label className={`ai-trader__risk ${hasAcceptedRisk ? 'ai-trader__risk--accepted' : ''}`}>
                <input
                    type='checkbox'
                    checked={hasAcceptedRisk}
                    onChange={e => setHasAcceptedRisk(e.target.checked)}
                />
                <span>
                    {localize(
                        'I understand the AI auto-trader places real trades on my active account, martingale recovery increases stake after losses, and past signals do not predict future results. I can lose my whole balance.'
                    )}
                </span>
            </label>
            <AiAgentPanel
                hasAcceptedRisk={hasAcceptedRisk}
                onNeedsRiskAccept={() =>
                    document.querySelector('.ai-trader__risk')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }
            />
        </div>
    );
};

export default AiTrader;
