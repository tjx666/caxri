import type { ComponentProps, KeyboardEvent } from 'react';

import { cn } from '../../lib/utilities';

/**
 * A clickable run of markdown text (a cited file path, a link) that wraps like the prose around it.
 *
 * A native `<button>` is always laid out as an atomic inline-block with centered text, even under `display: inline`, so
 * a path or link longer than the line turned into a centered box spanning the whole column instead of continuing the
 * sentence. A `role="button"` span stays a real inline box; `box-decoration-clone` gives every wrapped fragment the
 * chip's padding and rounding.
 */
export function InlineButton({
    className,
    onClick,
    onKeyDown,
    ...properties
}: Omit<ComponentProps<'span'>, 'role' | 'tabIndex'>) {
    function activateFromKeyboard(event: KeyboardEvent<HTMLSpanElement>) {
        onKeyDown?.(event);
        if (event.defaultPrevented || (event.key !== 'Enter' && event.key !== ' ')) return;
        // Space would otherwise scroll the transcript, as it does for any focused non-button element.
        event.preventDefault();
        event.currentTarget.click();
    }
    return (
        <span
            {...properties}
            className={cn('box-decoration-clone', className)}
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={activateFromKeyboard}
        />
    );
}
