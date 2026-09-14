import { useState } from 'react';
import brandConfig from '@/../brand.config.json';
import { localize } from '@deriv-com/translations';
import './risk-banner.scss';

/**
 * Deriv requires apps built on its API to carry a visible risk warning and to
 * make clear the app is an independent third party, not Deriv itself.
 * See: https://deriv.com/terms-and-conditions/important-guidelines
 *
 * This banner is intentionally NOT dismissible-forever (only per browser
 * session) so it keeps showing on return visits, in line with that
 * requirement.
 */
const SESSION_KEY = 'risk_banner_dismissed';

const RiskBanner = () => {
    const [isDismissed, setIsDismissed] = useState(() => sessionStorage.getItem(SESSION_KEY) === '1');
    const app_name = brandConfig?.platform?.name || 'This app';

    if (isDismissed) return null;

    const handleDismiss = () => {
        sessionStorage.setItem(SESSION_KEY, '1');
        setIsDismissed(true);
    };

    return (
        <div className='risk-banner' role='note'>
            <span className='risk-banner__text'>
                {localize(
                    '{{app_name}} is an independent third-party application built on the Deriv API and is not operated or endorsed by Deriv. Deriv offers complex products (Options, CFDs, and Multipliers) with substantial risk. You could lose your entire investment. Trade responsibly and understand the risks.',
                    { app_name }
                )}
            </span>
            <button type='button' className='risk-banner__dismiss' onClick={handleDismiss} aria-label={localize('Dismiss')}>
                ×
            </button>
        </div>
    );
};

export default RiskBanner;
