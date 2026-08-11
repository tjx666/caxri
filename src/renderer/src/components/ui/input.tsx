import { Input as InputPrimitive } from '@base-ui/react/input';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

const inputVariants = cva(
    'block w-full min-w-0 appearance-none border text-inherit outline-none transition-[border-color,box-shadow,background-color] duration-150 ease-out placeholder:text-muted focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_50%,transparent)] aria-invalid:border-danger aria-invalid:focus-visible:border-danger disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
    {
        variants: {
            appearance: {
                default:
                    'rounded border-border bg-[color-mix(in_srgb,var(--border)_30%,transparent)]',
                workbench: 'rounded border-border bg-background',
                inline: 'rounded border-border bg-surface',
                embedded:
                    'h-full rounded-none border-0 bg-transparent p-0 focus-visible:border-transparent focus-visible:shadow-none',
            },
            size: {
                standard: 'h-9 px-2 text-[13px]',
                dense: 'h-7 px-2 text-[12px]',
                compact: 'h-6 px-1 text-[12px]',
                palette: 'h-11 px-2 text-[13px]',
            },
        },
        defaultVariants: { appearance: 'default', size: 'standard' },
    },
);

const inputGroupVariants = cva(
    'flex w-full min-w-0 items-center border border-border transition-[border-color,box-shadow,background-color] duration-150 ease-out focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_50%,transparent)]',
    {
        variants: {
            appearance: {
                default: 'rounded bg-[color-mix(in_srgb,var(--border)_30%,transparent)]',
                workbench: 'rounded bg-background',
                toolbar:
                    'rounded-none border-x-0 border-t-0 bg-background focus-within:shadow-none',
            },
            size: {
                standard: 'h-9 gap-2 px-2',
                dense: 'h-7 gap-1 px-2',
                palette: 'h-11 gap-0 px-3',
            },
        },
        defaultVariants: { appearance: 'default', size: 'standard' },
    },
);

export interface InputProps
    extends Omit<ComponentProps<'input'>, 'size'>, VariantProps<typeof inputVariants> {}

/** Shared field primitive with the explicit density and appearance tiers from DESIGN.md. */
export function Input({ appearance, className, size, type, ...props }: InputProps) {
    return (
        <InputPrimitive
            type={type}
            data-slot="input"
            className={cn(inputVariants({ appearance, size }), className)}
            {...props}
        />
    );
}

export interface InputGroupProps
    extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof inputGroupVariants> {}

/** Owns shared field chrome when an Input needs leading or trailing adornments. */
export function InputGroup({ appearance, className, size, ...props }: InputGroupProps) {
    return (
        <div
            data-slot="input-group"
            className={cn(inputGroupVariants({ appearance, size }), className)}
            {...props}
        />
    );
}
