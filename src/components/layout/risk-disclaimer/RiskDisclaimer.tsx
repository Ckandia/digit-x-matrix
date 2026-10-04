// Fixed bottom-left "Risk" badge, present on every tab. Clicking it reveals the
// risk disclosure required by Deriv's third-party site guidelines for apps built
// on the Deriv API. Collapsed by default so it doesn't crowd the trading UI —
// "hidden inside a caution icon" per the partner's request — but is always one
// click away and never dismissible in a way that hides it permanently.
import { useEffect, useRef, useState } from 'react';
import './risk-disclaimer.scss';

export const RiskDisclaimer = () => {
    const [is_open, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!is_open) return;
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [is_open]);

    return (
        <div className='risk-disclaimer' ref={containerRef}>
            {is_open && (
                <div className='risk-disclaimer__panel' role='dialog' aria-label='Risk disclaimer'>
                    <p>
                        Deriv offers complex products (Options, CFDs) with substantial risk. You could lose your
                        entire investment. Trade responsibly and understand the risks.
                    </p>
                    <p className='risk-disclaimer__secondary'>
                        This app is an independent, third-party application built on the Deriv API. It is not
                        operated by Deriv, and Deriv is not responsible for its content, availability, or the
                        outcome of any trades placed through it.
                    </p>
                </div>
            )}
            <button
                type='button'
                className='risk-disclaimer__badge'
                onClick={() => setIsOpen(v => !v)}
                aria-expanded={is_open}
            >
                <svg viewBox='0 0 24 24' width='14' height='14' aria-hidden='true'>
                    <path
                        fill='currentColor'
                        d='M12 2 1 21h22L12 2Zm0 5.5 7.53 12H4.47L12 7.5ZM11 10v5h2v-5h-2Zm0 6.5v2h2v-2h-2Z'
                    />
                </svg>
                <span>Risk</span>
            </button>
        </div>
    );
};
