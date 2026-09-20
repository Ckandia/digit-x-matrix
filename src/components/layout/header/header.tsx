import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { observer } from 'mobx-react-lite';
import { generateOAuthURL } from '@/components/shared';
import Button from '@/components/shared_ui/button';
import useActiveAccount from '@/hooks/api/account/useActiveAccount';
import { useApiBase } from '@/hooks/useApiBase';
import { useLogout } from '@/hooks/useLogout';
import { useStore } from '@/hooks/useStore';
import { navigateToTransfer } from '@/utils/transfer-utils';
import { Localize } from '@deriv-com/translations';
import { Header, useDevice, Wrapper } from '@deriv-com/ui';
import { AppLogo } from '../app-logo';
import AccountSwitcher from './account-switcher';
import MenuItems from './menu-items';
import MobileMenu from './mobile-menu';
import './header.scss';

// Key used to persist the manually-pasted Deriv API token (a Personal Access
// Token from https://app.deriv.com/account/api-token, "trade" scope). This is
// separate from the OAuth2 browser-session login above: OAuth2 doesn't hand
// the app a simple copyable token, so Bulk Trader's backend needs this
// instead to authenticate on your behalf when placing trades.
const MANUAL_TOKEN_STORAGE_KEY = 'deriv_manual_api_token';

const AppHeader = observer(() => {
    const { isDesktop } = useDevice();
    const { isAuthorizing, activeLoginid, setIsAuthorizing, authData } = useApiBase();
    const { client } = useStore() ?? {};
    const [authTimeout, setAuthTimeout] = useState(false);
    const is_account_regenerating = client?.is_account_regenerating || false;

    const [isOAuthPending, setIsOAuthPending] = useState(() => {
        const params = new URLSearchParams(window.location.search);
        return Boolean(params.get('code') && params.get('state'));
    });

    const { data: activeAccount } = useActiveAccount({
        allBalanceData: client?.all_accounts_balance,
        directBalance: client?.balance,
    });

    const handleLogout = useLogout();

    // Manual Bulk Trader API token — a separate, pasteable credential since
    // OAuth2 login doesn't expose one. Persisted to localStorage so the Bulk
    // Trades tab can read it when starting a run.
    const [manualToken, setManualToken] = useState<string>(
        () => localStorage.getItem(MANUAL_TOKEN_STORAGE_KEY) || ''
    );
    const [manualTokenDraft, setManualTokenDraft] = useState(manualToken);
    const [manualTokenSaved, setManualTokenSaved] = useState(false);

    const handleSaveManualToken = useCallback(() => {
        const trimmed = manualTokenDraft.trim();
        localStorage.setItem(MANUAL_TOKEN_STORAGE_KEY, trimmed);
        setManualToken(trimmed);
        setManualTokenSaved(true);
        setTimeout(() => setManualTokenSaved(false), 2000);
    }, [manualTokenDraft]);

    const handleClearManualToken = useCallback(() => {
        localStorage.removeItem(MANUAL_TOKEN_STORAGE_KEY);
        setManualToken('');
        setManualTokenDraft('');
    }, []);

    useEffect(() => {
        if (!isOAuthPending) return;
        if (activeLoginid) {
            setIsOAuthPending(false);
            return;
        }
        const timer = setTimeout(() => setIsOAuthPending(false), 30_000);
        return () => clearTimeout(timer);
    }, [isOAuthPending, activeLoginid]);

    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const account_id = urlParams.get('account_id');
        if (account_id) {
            setIsAuthorizing(true);
        }
    }, [setIsAuthorizing]);

    useEffect(() => {
        if (isOAuthPending) return;

        const timer = setTimeout(() => {
            if (isAuthorizing && !activeLoginid) {
                setAuthTimeout(true);
                setIsAuthorizing(false);
            }
        }, 5000);

        if (activeLoginid || !isAuthorizing) {
            if (authTimeout) setAuthTimeout(false);
            clearTimeout(timer);
        }

        return () => clearTimeout(timer);
    }, [isAuthorizing, activeLoginid, setIsAuthorizing, authTimeout, isOAuthPending]);

    const handleSignup = useCallback(async () => {
        try {
            setIsAuthorizing(true);
            const oauthUrl = await generateOAuthURL('registration');
            if (oauthUrl) {
                window.location.replace(oauthUrl);
            } else {
                console.error('Failed to generate OAuth URL for signup');
                setIsAuthorizing(false);
            }
        } catch (error) {
            console.error('Signup redirection failed:', error);
            setIsAuthorizing(false);
        }
    }, [setIsAuthorizing]);

    const handleLogin = useCallback(async () => {
        try {
            setIsAuthorizing(true);
            const oauthUrl = await generateOAuthURL();
            if (oauthUrl) {
                window.location.replace(oauthUrl);
            } else {
                console.error('Failed to generate OAuth URL');
                setIsAuthorizing(false);
            }
        } catch (error) {
            console.error('Login redirection failed:', error);
            setIsAuthorizing(false);
        }
    }, [setIsAuthorizing]);

    const handleTransfer = useCallback(() => {
        const transferCurrency = authData?.currency;
        if (!transferCurrency) {
            console.error('No currency available for transfer');
            return;
        }
        navigateToTransfer(transferCurrency);
    }, [authData?.currency]);

    // Small pasteable-token control, shown only on desktop (there isn't room
    // on mobile) right before the account switcher/balance.
    const renderManualTokenSlot = useCallback(() => {
        if (!isDesktop) return null;
        return (
            <div className='manual-token-slot' title='Deriv API token used by Bulk Trader to place trades'>
                <input
                    type='password'
                    className='manual-token-slot__input'
                    placeholder='Bulk Trader API token'
                    value={manualTokenDraft}
                    onChange={e => setManualTokenDraft(e.target.value)}
                />
                <button
                    type='button'
                    className='manual-token-slot__save'
                    onClick={handleSaveManualToken}
                    disabled={manualTokenDraft.trim() === manualToken}
                >
                    {manualTokenSaved ? '✓' : 'Save'}
                </button>
                {manualToken && (
                    <button
                        type='button'
                        className='manual-token-slot__clear'
                        onClick={handleClearManualToken}
                        title='Remove saved token'
                    >
                        ✕
                    </button>
                )}
            </div>
        );
    }, [isDesktop, manualTokenDraft, manualToken, manualTokenSaved, handleSaveManualToken, handleClearManualToken]);

    const renderAccountSection = useCallback(
        (position: 'left' | 'right' = 'right') => {
            if (activeLoginid && !is_account_regenerating) {
                if (position === 'left' && !isDesktop) {
                    return (
                        <div className='auth-actions'>
                            <div className='account-info'>
                                <AccountSwitcher activeAccount={activeAccount} />
                            </div>
                        </div>
                    );
                } else if (position === 'right') {
                    return (
                        <div className='auth-actions'>
                            {renderManualTokenSlot()}
                            {isDesktop && (
                                <div className='account-info'>
                                    <AccountSwitcher activeAccount={activeAccount} />
                                </div>
                            )}
                            <Button
                                primary
                                disabled={client?.is_logging_out || !authData?.currency}
                                onClick={handleTransfer}
                            >
                                <Localize i18n_default_text='Transfer' />
                            </Button>
                        </div>
                    );
                }
            } else if (
                position === 'right' &&
                !isOAuthPending &&
                ((!is_account_regenerating && !isAuthorizing && !activeLoginid) || authTimeout)
            ) {
                const isAuthConfigured = Boolean(process.env.NEXT_PUBLIC_DERIV_APP_ID);
                return (
                    <div className='auth-actions'>
                        <Button tertiary disabled={!isAuthConfigured} onClick={handleLogin}>
                            <Localize i18n_default_text='Log in' />
                        </Button>
                        <Button primary_light disabled={!isAuthConfigured} onClick={handleSignup}>
                            <Localize i18n_default_text='Sign up' />
                        </Button>
                    </div>
                );
            } else if (position === 'right') {
                return (
                    <div className='auth-actions auth-actions--loading'>
                        <svg
                            className='auth-actions__spinner'
                            viewBox='0 0 24 24'
                            fill='none'
                            xmlns='http://www.w3.org/2000/svg'
                        >
                            <circle
                                cx='12'
                                cy='12'
                                r='10'
                                stroke='currentColor'
                                strokeWidth='2.5'
                                strokeLinecap='round'
                                strokeDasharray='31.416'
                                strokeDashoffset='10'
                            />
                        </svg>
                    </div>
                );
            }

            return null;
        },
        [
            isAuthorizing,
            isDesktop,
            activeLoginid,
            client,
            activeAccount,
            authTimeout,
            is_account_regenerating,
            isOAuthPending,
            authData,
            handleLogin,
            handleSignup,
            handleTransfer,
            renderManualTokenSlot,
        ]
    );

    if (client?.should_hide_header) return null;

    return (
        <>
            <Header
                className={clsx('app-header', {
                    'app-header--desktop': isDesktop,
                    'app-header--mobile': !isDesktop,
                })}
            >
                <Wrapper variant='left'>
                    <MobileMenu onLogout={handleLogout} />
                    <AppLogo />
                    {isDesktop ? <MenuItems /> : renderAccountSection('left')}
                </Wrapper>
                <Wrapper variant='right'>
                    {renderAccountSection('right')}
                </Wrapper>
            </Header>
        </>
    );
});

export default AppHeader;
