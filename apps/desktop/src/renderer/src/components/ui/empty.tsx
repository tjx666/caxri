import type { ComponentProps } from 'react';

import { cn } from '@/lib/utilities';

/**
 * Centered placeholder for an secondarySidebar panel or workbench surface with nothing to show yet: an icon, a title,
 * and an optional description/action. Replaces the hand-rolled `empty-panel`/`empty-work`/etc. divs that each panel
 * used to compose on its own.
 */
export function Empty({ className, ...properties }: ComponentProps<'div'>) {
    return (
        <div
            data-slot="empty"
            className={cn(
                'flex w-full min-w-0 flex-col items-center justify-center gap-3 p-6 text-center',
                className,
            )}
            {...properties}
        />
    );
}

export function EmptyMedia({ className, ...properties }: ComponentProps<'div'>) {
    return (
        <div
            data-slot="empty-media"
            className={cn('flex shrink-0 items-center justify-center text-muted', className)}
            {...properties}
        />
    );
}

export function EmptyTitle({ className, ...properties }: ComponentProps<'p'>) {
    return (
        <p
            data-slot="empty-title"
            className={cn('m-0 text-[13px] text-foreground', className)}
            {...properties}
        />
    );
}
