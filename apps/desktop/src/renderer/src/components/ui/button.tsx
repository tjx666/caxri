import type { ButtonHTMLAttributes } from 'react';

import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';

import { cn } from '@/lib/utilities';

/**
 * Radius 8 for controls, as the Codex app rounds its buttons, transitions only the background and the focus ring
 * (DESIGN.md "Spacing and radius"). Variants map 1:1 to the pre-Tailwind `.button-*` classes so behavior is unchanged.
 *
 * Keyboard focus draws the same accent border and 3px accent glow as `Input` and `Select`, so tabbing through a form
 * reads as one focus language; pointer clicks do not match `:focus-visible` and stay unmarked.
 *
 * Every hover response is gated on `enabled:`: a disabled button still matches `:hover` in CSS even though Chromium
 * dispatches no pointer events to it, so an ungated hover fill advertises an action the control cannot perform.
 *
 * `aria-disabled` is treated as the same state. A busy control that must keep keyboard focus cannot set the native
 * `disabled` attribute, because Chromium evicts focus from an element the moment it becomes disabled; those call sites
 * set `aria-disabled` and refuse the click in their handler instead. The native `:disabled`/`:enabled` pseudo-classes
 * never match such a button, so the dimming and the hover gate are mirrored onto the attribute.
 */
const buttonVariants = cva(
    'inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-transparent transition-[background,border-color,box-shadow] outline-none focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45',
    {
        variants: {
            variant: {
                default:
                    'border-accent bg-accent text-accent-foreground enabled:not-aria-disabled:hover:brightness-110',
                secondary:
                    'border-border bg-elevated enabled:not-aria-disabled:hover:bg-[var(--selection)]',
                ghost: 'bg-transparent enabled:not-aria-disabled:hover:bg-[var(--selection)]',
                danger: 'border-danger bg-danger text-danger-foreground',
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
