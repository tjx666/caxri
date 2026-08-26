import type { ComponentProps } from 'react';

import { cn } from '@/lib/utilities';

import { Label } from './label';

/**
 * Structured form row: label + optional description + control. Horizontal orientation keeps the label block left and
 * the control right — the Settings instant-preference layout from DESIGN.md.
 */
export function Field({
    className,
    orientation = 'vertical',
    ...properties
}: ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical' }) {
    return (
        <div
            role="group"
            data-slot="field"
            data-orientation={orientation}
            className={cn(
                'group/field flex w-full gap-2',
                orientation === 'vertical'
                    ? 'flex-col'
                    : 'flex-row items-center justify-between gap-3',
                className,
            )}
            {...properties}
        />
    );
}

/**
 * Groups label + description on the growing side of a horizontal Field.
 */
export function FieldContent({ className, ...properties }: ComponentProps<'div'>) {
    return (
        <div
            data-slot="field-content"
            className={cn('flex min-w-0 flex-1 flex-col gap-1', className)}
            {...properties}
        />
    );
}

export function FieldLabel({ className, ...properties }: ComponentProps<typeof Label>) {
    return <Label data-slot="field-label" className={cn('w-fit', className)} {...properties} />;
}

/**
 * Non-interactive row title for rows whose trailing control is a Button or another element that must not be wrapped in
 * a `<label>`.
 */
export function FieldTitle({ className, ...properties }: ComponentProps<'div'>) {
    return (
        <div
            data-slot="field-title"
            className={cn('w-fit text-[13px] leading-[1.45] text-foreground', className)}
            {...properties}
        />
    );
}

export function FieldDescription({ className, ...properties }: ComponentProps<'p'>) {
    return (
        <p
            data-slot="field-description"
            className={cn('m-0 text-[11px] leading-[1.45] text-muted', className)}
            {...properties}
        />
    );
}
