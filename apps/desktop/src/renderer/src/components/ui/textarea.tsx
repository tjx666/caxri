import type { ComponentProps } from 'react';

import { cn } from '@/lib/utilities';

/**
 * Multiline companion to `Input`, sharing the same themed field and focus redline.
 */
export function Textarea({ className, ...properties }: ComponentProps<'textarea'>) {
    return (
        <textarea
            data-slot="textarea"
            className={cn(
                'block min-h-[72px] w-full min-w-0 resize-y rounded-lg border border-border bg-[color-mix(in_srgb,var(--border)_30%,transparent)] px-2 py-2 text-[13px] text-inherit transition-[border-color,box-shadow] outline-none placeholder:text-muted focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_50%,transparent)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                className,
            )}
            {...properties}
        />
    );
}
