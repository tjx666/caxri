import type { ComponentProps } from 'react';

import { cn } from '@/lib/utilities';

/**
 * Shared form label. Pairs with Field rows so clicking the text toggles the associated control via the native
 * `htmlFor`/nesting contract.
 */
export function Label({ className, ...properties }: ComponentProps<'label'>) {
    return (
        <label
            data-slot="label"
            className={cn(
                'flex items-center gap-2 text-[13px] leading-[1.45] text-foreground select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
                className,
            )}
            {...properties}
        />
    );
}
