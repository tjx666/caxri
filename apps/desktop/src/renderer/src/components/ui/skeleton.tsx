import type { ComponentProps } from 'react';

import { cn } from '@/lib/utilities';

/**
 * One placeholder block of a loading skeleton. It is decorative: the enclosing skeleton region carries `role="status"`
 * and the loading label, so assistive tech hears one announcement instead of a list of empty shapes. The reveal fade
 * and the pulse live in `styles.css` (keyed on `data-slot="skeleton"`) because two keyframe animations cannot share one
 * Tailwind `animate-*` utility; that rule sits behind `prefers-reduced-motion: no-preference`, so blocks stay static
 * under reduced motion like every other loading indicator in this repo.
 */
export function Skeleton({ className, ...properties }: ComponentProps<'div'>) {
    return (
        <div
            data-slot="skeleton"
            aria-hidden="true"
            className={cn('rounded-sm bg-muted/15', className)}
            {...properties}
        />
    );
}
