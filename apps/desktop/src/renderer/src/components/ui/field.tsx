import type { ComponentProps } from 'react';

import { cn } from '@/lib/utilities';

import { Label } from './label';

/**
 * Structured form row: label + optional description + control. Horizontal orientation keeps the label block left and
 * the control right: the Settings instant-preference layout from DESIGN.md.
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

/**
 * Semantic color for a status caption; a visible dot keeps urgent states recognizable without color.
 */
export function FieldDescription({
    children,
    className,
    tone = 'muted',
    ...properties
}: ComponentProps<'p'> & { tone?: 'danger' | 'muted' | 'warning' }) {
    return (
        <p
            data-slot="field-description"
            data-tone={tone}
            className={cn(
                'm-0 text-[11px] leading-[1.45]',
                tone === 'muted'
                    ? 'text-muted'
                    : tone === 'warning'
                      ? 'flex items-start gap-1.5 text-warning'
                      : 'flex items-start gap-1.5 text-danger',
                className,
            )}
            {...properties}
        >
            {tone === 'muted' ? (
                children
            ) : (
                <>
                    <span
                        aria-hidden="true"
                        className="mt-1 size-1.5 flex-none rounded-full bg-current"
                    />
                    <span className="min-w-0">{children}</span>
                </>
            )}
        </p>
    );
}
