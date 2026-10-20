import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';

import { cn } from '@/lib/utilities';

/**
 * Pressed state reads `bg-elevated` + `text-foreground`, never `bg-accent`; DESIGN.md's one-accent rule reserves
 * `--accent` for the single focus indicator/primary buttons, not toggle chrome.
 */
const toggleVariants = cva(
    'inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg border border-transparent text-muted transition-[background-color,color] outline-none hover:bg-elevated hover:text-foreground focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--state-focus-ring)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-pressed:bg-elevated data-pressed:text-foreground',
    {
        variants: {
            size: {
                compact: 'h-6 min-w-6 px-1.5 text-[11px]',
                dense: 'h-7 min-w-7 px-2 text-[12px]',
            },
        },
        defaultVariants: { size: 'compact' },
    },
);

export interface ToggleProperties<Value extends string = string>
    extends TogglePrimitive.Props<Value>, VariantProps<typeof toggleVariants> {}

export function Toggle<Value extends string = string>({
    className,
    size,
    ...properties
}: ToggleProperties<Value>) {
    return (
        <TogglePrimitive
            data-slot="toggle"
            className={cn(toggleVariants({ size }), className)}
            {...properties}
        />
    );
}
