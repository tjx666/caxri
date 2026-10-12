import { Progress as ProgressPrimitive } from '@base-ui/react/progress';

import { cn } from '@/lib/utilities';

const indicatorVariants = {
    /**
     * Work advancing toward done (the update download): an `--accent` fill that eases between readings.
     */
    progress: 'bg-accent transition-[width] duration-150 ease-out',
    /**
     * A measured quantity (a plan-limit window): a `--chart` fill that jumps straight to each new reading, because a
     * data refresh sliding the bar reads as usage growing in real time.
     */
    meter: 'bg-chart',
    /**
     * A meter near its cap.
     */
    meterWarning: 'bg-warning',
} as const;

export type ProgressVariant = keyof typeof indicatorVariants;

/**
 * Progress bar. Base UI's `Progress.Root` owns the `role="progressbar"` semantics and forwards
 * `aria-value*`/`aria-label`, so callers only ever pass `value`. `value={null}` reports indeterminate to assistive tech
 * while the indicator keeps a bounded 20% fill, the visual convention the update download bar established for an
 * unknown total.
 */
export function Progress({
    className,
    value,
    variant = 'progress',
    ...properties
}: ProgressPrimitive.Root.Props & { variant?: ProgressVariant }) {
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
                    className={cn(
                        'block h-full rounded data-indeterminate:w-1/5',
                        indicatorVariants[variant],
                    )}
                />
            </ProgressPrimitive.Track>
        </ProgressPrimitive.Root>
    );
}
