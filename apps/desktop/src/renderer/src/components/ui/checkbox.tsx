import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { Check, Minus } from 'lucide-react';

import { cn } from '@/lib/utilities';

/**
 * Deliberate opt-in control (pre-submit choices). Instant preferences use Switch instead; see the Settings redline in
 * DESIGN.md.
 */
export function Checkbox({ className, ...properties }: CheckboxPrimitive.Root.Props) {
    return (
        <CheckboxPrimitive.Root
            data-slot="checkbox"
            /**
             * Same accessible-name guard as Switch: keep a caller-provided `aria-label` authoritative over Base UI's
             * mirrored label association (aria-labelledby would otherwise outrank it).
             */
            aria-labelledby={properties['aria-label'] ? '' : undefined}
            className={cn(
                'group flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border border-border bg-[color-mix(in_srgb,var(--border)_30%,transparent)] transition-[border-color,background-color,box-shadow] outline-none motion-reduce:transition-none',
                'data-checked:border-accent data-checked:bg-accent data-checked:text-accent-foreground',
                'data-indeterminate:border-accent data-indeterminate:bg-accent data-indeterminate:text-accent-foreground',
                'focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--state-focus-ring)]',
                'aria-invalid:border-danger',
                'data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50',
                className,
            )}
            {...properties}
        >
            <CheckboxPrimitive.Indicator
                data-slot="checkbox-indicator"
                className="flex items-center justify-center text-current data-unchecked:hidden"
            >
                {/* Base UI marks a partial selection with `data-indeterminate`; a dash distinguishes it from checked. */}
                <Check className="group-data-indeterminate:hidden" size={12} strokeWidth={3} />
                <Minus
                    className="hidden group-data-indeterminate:block"
                    size={12}
                    strokeWidth={3}
                />
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
}
