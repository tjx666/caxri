import { Progress as ProgressPrimitive } from '@base-ui/react/progress';

import { cn } from '@/lib/utilities';

/**
 * Progress bar. Base UI's `Progress.Root` owns the `role="progressbar"` semantics and forwards
 * `aria-value*`/`aria-label`, so callers only ever pass `value`. `value={null}` reports indeterminate to assistive tech
 * while the indicator keeps a bounded 20% fill, the visual convention the update download bar established for an
 * unknown total.
 */
export function Progress({ className, value, ...properties }: ProgressPrimitive.Root.Props) {
    return (
        <ProgressPrimitive.Root
            data-slot="progress"
            value={value}
            className={cn('block w-full', className)}
            {...properties}
        >
            <ProgressPrimitive.Track
                data-slot="progress-track"
                className="relative h-1.5 w-full overflow-hidden rounded bg-[color-mix(in_srgb,var(--border)_50%,var(--elevated))]"
            >
                <ProgressPrimitive.Indicator
                    data-slot="progress-indicator"
                    className="block h-full rounded bg-accent transition-[width] duration-150 ease-out data-indeterminate:w-1/5"
                />
            </ProgressPrimitive.Track>
        </ProgressPrimitive.Root>
    );
}
