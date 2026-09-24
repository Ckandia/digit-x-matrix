// @ts-nocheck — vendored bot code with known upstream type gaps; see AGENTS.md
import { localize } from '@deriv-com/translations';

/**
 * Deriv requires third-party sites/apps built on its API to display the phrase
 * "Powered by" above or before the Deriv logo.
 * See: https://deriv.com/terms-and-conditions/important-guidelines
 */
const PoweredByDeriv = () => (
    <a
        className='app-footer__powered-by'
        href='https://deriv.com'
        target='_blank'
        rel='noopener noreferrer'
        title={localize('Powered by Deriv')}
        aria-label={localize('Powered by Deriv')}
    >
        <span className='app-footer__powered-by-text'>{localize('Powered by')}</span>
        <img className='app-footer__powered-by-logo' src={`${window.__webpack_public_path__}deriv-logo.svg`} alt='Deriv' />
    </a>
);

export default PoweredByDeriv;