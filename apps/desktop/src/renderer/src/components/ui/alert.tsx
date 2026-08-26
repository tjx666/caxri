import type { ComponentProps } from 'react';

import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';

import { cn } from '@/lib/utilities';

const alertVariants = cva(
    'm-0 rounded border px-3 py-2 text-[11px] leading-[1.45] whitespace-pre-wrap',
    {
        variants: {
            variant: {
                info: 'border-border bg-elevated text-muted',
                warning: 'border-warning text-warning',
                danger: 'border-danger text-danger',
            },
        },
        defaultVariants: { variant: 'info' },
    },
);

/**
 * Inline, non-dismissable notice embedded in forms and dialogs. Status color follows the semantic tokens; toasts own
 * transient notifications instead.
 */
export function Alert({
    className,
    variant,
    ...properties
}: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
    return (
        <div
            role="alert"
            data-slot="alert"
            className={cn(alertVariants({ variant }), className)}
            {...properties}
        />
    );
}
