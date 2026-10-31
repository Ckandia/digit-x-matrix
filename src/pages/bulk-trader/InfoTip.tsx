import React, { useId, useState } from 'react';

/**
 * A small "i" icon that expands a long explanation in place. Keeps the AI tab short: the label stays visible, the narration
 * is one tap away. Safe inside a <label> (the click never toggles the checkbox next to it).
 */
export const InfoTip = ({ text, label = 'More information' }: { text: string; label?: string }) => {
    const [open, setOpen] = useState(false);
    const id = useId();
    return (
        <span className='info-tip'>
            <button
                type='button'
                className='info-tip__btn'
                aria-expanded={open}
                aria-controls={id}
                aria-label={label}
                title={label}
                onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(o => !o);
                }}
            >
                i
            </button>
            {open && (
                <span id={id} role='note' className='info-tip__text'>
                    {text}
                </span>
            )}
        </span>
    );
};
