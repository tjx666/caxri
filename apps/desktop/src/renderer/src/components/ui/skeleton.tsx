import type { ComponentProps } from 'react';

import { cn } from '@/lib/utilities';

/**
 * One placeholder block of a loading skeleton. It is decorative: the enclosing skeleton region carries `role="status"`
 * and the loading label, so assistive tech hears one announcement instead of a list of empty shapes. `motion-safe:`
 * keeps the pulse inside the reduced-motion contract every loading indicator in this repo honors.
 */
export function Skeleton({ className, ...properties }: ComponentProps<'div'>) {
    return (
        <div
            data-slot="skeleton"
            aria-hidden="true"
            className={cn('rounded-sm bg-muted/15 motion-safe:animate-pulse', className)}
            {...properties}
        />
    );
}
