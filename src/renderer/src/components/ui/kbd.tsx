import type { ComponentProps } from 'react';

import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';

import { cn } from '@/lib/utilities';

const kbdVariants = cva(
    'inline-flex items-center justify-center rounded border border-border bg-elevated font-sans leading-none text-foreground select-none',
    {
        variants: {
            size: {
                default: 'h-6 min-w-6 px-1 text-[11px]',
                compact: 'h-4 min-w-4 px-0.5 text-[10px]',
            },
        },
        defaultVariants: { size: 'default' },
    },
);

export interface KbdProperties extends ComponentProps<'kbd'>, VariantProps<typeof kbdVariants> {}

/**
 * Single keycap chip per DESIGN.md's "Command palette" redline: an `--elevated` chip with `border-border` hairline.
 * `size="compact"` is the `badge` (10px) type-scale tier reserved for tiny kbd hints; `size="default"` matches the
 * previously hand-rolled `meta` (11px) keycap used where a shortcut hint stands on its own.
 */
export function Kbd({ className, size, ...properties }: KbdProperties) {
    return <kbd data-slot="kbd" className={cn(kbdVariants({ size }), className)} {...properties} />;
}
