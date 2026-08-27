import type { ButtonHTMLAttributes } from 'react';

import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';

import { cn } from '@/lib/utilities';

/**
 * Radius 4 for controls, transitions only the background (DESIGN.md "Spacing and radius"). Variants map 1:1 to the
 * pre-Tailwind `.button-*` classes so behavior is unchanged.
 *
 * Every hover response is gated on `enabled:`: a disabled button still matches `:hover` in CSS even though Chromium
 * dispatches no pointer events to it, so an ungated hover fill advertises an action the control cannot perform.
 */
const buttonVariants = cva(
    'inline-flex cursor-pointer items-center justify-center gap-2 rounded border border-transparent transition-[background] duration-75 ease-out disabled:cursor-not-allowed disabled:opacity-45',
    {
        variants: {
            variant: {
                default:
                    'border-accent bg-accent text-accent-foreground enabled:hover:brightness-110',
                secondary: 'border-border bg-elevated enabled:hover:bg-[var(--selection)]',
                ghost: 'bg-transparent enabled:hover:bg-[var(--selection)]',
                danger: 'border-danger bg-danger text-accent-foreground',
            },
            size: {
                default: 'min-h-9 px-3',
                sm: 'min-h-7 px-2 text-[11px]',
                icon: 'size-7 p-0',
            },
        },
        defaultVariants: { variant: 'default', size: 'default' },
    },
);

export interface ButtonProperties
    extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({
    className,
    variant,
    size,
    type = 'button',
    ...properties
}: ButtonProperties) {
    return (
        <button
            type={type}
            className={cn(buttonVariants({ variant, size }), className)}
            {...properties}
        />
    );
}
