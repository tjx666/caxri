import { useState } from 'react';

import type { Format } from '@number-flow/react';
import NumberFlow, { NumberFlowGroup } from '@number-flow/react';

import { useIsQuietSinceChange } from '../hooks/use-is-quiet-since-change';
import { useShouldReduceMotion } from '../hooks/use-should-reduce-motion';
import { motionDurationMs, motionEasing } from '../lib/motion';
import { cn } from '../lib/utilities';

/**
 * Animations for one roll, resolved from the motion tokens rather than NumberFlow's own spring so the digits move on
 * the same curve as every other layer (DESIGN.md "Motion").
 */
function numberRollTimings() {
    const easing = (token: string) => `cubic-bezier(${motionEasing(token).join(', ')})`;
    const roll = {
        duration: motionDurationMs('--motion-number-roll'),
        easing: easing('--motion-ease-emphasized'),
    };
    const fade = {
        duration: motionDurationMs('--motion-overlay-enter'),
        easing: easing('--motion-ease-enter'),
    };
    return { opacityTiming: fade, spinTiming: roll, transformTiming: roll };
}

/**
 * How long a figure must hold still before its next change rolls. Comfortably longer than one roll, so a figure that
 * changes every second (the elapsed seconds) or many times a second (tokens while a reply streams) jumps instead of
 * never coming to rest, while minutes, steps, and cost, which move slowly, still roll.
 */
const ROLL_AFTER_QUIET_MS = 1500;

/**
 * A live figure whose digits roll to each new value instead of swapping in place, so a count that climbs while the user
 * watches reads as movement rather than flicker. Only a change after a quiet spell rolls (`ROLL_AFTER_QUIET_MS`). Wraps
 * NumberFlow (https://number-flow.barvian.me) with Caxri's motion tokens, the shared reduced-motion preference, and
 * fixed `en-US` digits, which every compact figure in the app uses.
 *
 * NumberFlow draws into a shadow root that holds a column of every digit at each position, so the element's text is not
 * the figure; a test reads the value from an attribute its owner sets instead. It labels itself as an image named by
 * the figure, so an owner that is not hidden from assistive technology still announces the value once.
 */
export function AnimatedNumber({
    className,
    digits,
    fractionDigits = 0,
    prefix,
    suffix,
    trend,
    value,
}: {
    className?: string;
    /**
     * Per-position digit limits, e.g. `{ 1: { max: 5 } }` so a seconds count rolls from 59 forward to 00.
     */
    digits?: Record<number, { max?: number }>;
    /**
     * Exact fraction digits to show; `0` (the default) shows a whole number.
     */
    fractionDigits?: number;
    prefix?: string;
    suffix?: string;
    /**
     * Which way the digits roll; `1` always rolls upward, as a clock does. Defaults to the sign of the change.
     */
    trend?: number;
    value: number;
}) {
    const isReduced = useShouldReduceMotion();
    const isQuiet = useIsQuietSinceChange(value, ROLL_AFTER_QUIET_MS);
    const [timings] = useState(numberRollTimings);
    const format: Format = {
        maximumFractionDigits: fractionDigits,
        minimumFractionDigits: fractionDigits,
        useGrouping: false,
    };
    return (
        <NumberFlow
            animated={!isReduced && isQuiet}
            className={cn('tabular-nums', className)}
            digits={digits}
            format={format}
            locales="en-US"
            prefix={prefix}
            respectMotionPreference={false}
            suffix={suffix}
            trend={trend}
            value={value}
            {...timings}
        />
    );
}

/**
 * Keeps the rolls of neighboring `AnimatedNumber`s in step when one's width moves another, such as the minutes and
 * seconds of an elapsed time.
 */
export const AnimatedNumberGroup = NumberFlowGroup;
