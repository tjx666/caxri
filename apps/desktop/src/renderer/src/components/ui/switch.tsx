import { Switch as SwitchPrimitive } from '@base-ui/react/switch';

import { cn } from '@/lib/utilities';

/**
 * Instant boolean preference control. The fully-round track is the one sanctioned `rounded-full` control exception in
 * DESIGN.md; every other control keeps the 4px radius.
 */
export function Switch({ className, ...properties }: SwitchPrimitive.Root.Props) {
    return (
        <SwitchPrimitive.Root
            data-slot="switch"
            /**
             * Base UI mirrors an associated `<label>` onto the control as `aria-labelledby`, which outranks
             * `aria-label` in accessible-name computation and would collapse per-instance names like "<provider>
             * lifecycle hooks" into the shared visible label text. An explicit empty labelledby suppresses that
             * fallback so a caller-provided `aria-label` wins; label clicks still toggle via the hidden-input
             * association.
             */
            aria-labelledby={properties['aria-label'] ? '' : undefined}
            className={cn(
                'inline-flex h-4.5 w-8 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-[background-color] outline-none motion-reduce:transition-none',
                'data-checked:bg-accent data-unchecked:bg-border',
                'focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_50%,transparent)]',
                'data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50',
                className,
            )}
            {...properties}
        >
            <SwitchPrimitive.Thumb
                data-slot="switch-thumb"
                className="pointer-events-none block size-3.5 rounded-full bg-foreground transition-transform data-checked:translate-x-3.5 data-checked:bg-accent-foreground data-unchecked:translate-x-0 motion-reduce:transition-none"
            />
        </SwitchPrimitive.Root>
    );
}
