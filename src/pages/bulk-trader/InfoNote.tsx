import React, { useState } from 'react';
import { localize } from '@deriv-com/translations';

/**
 * Long explanations collapse behind a small "i" icon so the AI tab stays readable on a phone.
 *  - "Title: explanation" text keeps its short title visible (next to its checkbox, say) and hides the explanation.
 *  - Text with no short title is shown as the icon alone.
 * Tap the icon to open or close it.
 */
export const splitNote = (text: string): { head: string; rest: string } => {
    const colon = text.indexOf(':');
    if (colon > 0 && colon <= 60) return { head: text.slice(0, colon), rest: text.slice(colon + 1).trim() };
    return { head: '', rest: text };
};

const InfoNote = ({ text }: { text: string }) => {
    const [open, setOpen] = useState(false);
    const { head, rest } = splitNote(text);
    return (
        <span className='ai-info'>
            {head && <span className='ai-info__head'>{head}</span>}
            <button
                type='button'
                className={`ai-info__icon${open ? ' is-open' : ''}`}
                aria-expanded={open}
                aria-label={head ? `${head}: ${localize('more info')}` : localize('More info')}
                title={localize('More info')}
                onClick={e => {
                    e.preventDefault(); // inside a <label>: opening the note must not tick the checkbox
                    e.stopPropagation();
                    setOpen(o => !o);
                }}
            >
                i
            </button>
            {open && <span className='ai-info__body'>{rest}</span>}
        </span>
    );
};

export default InfoNote;
