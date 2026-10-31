import { useEffect } from 'react';
import {
    cancelAnimation,
    Easing,
    makeMutable,
    useAnimatedStyle,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

import { SPIN_CLOCK_MS, spinDegrees } from './spin-phase';

/**
 * Every spinning glyph reads this one clock instead of running its own animation. A per-glyph animation starts at 0°
 * when the glyph mounts, so two running Session rows mounted seconds apart kept turning at different angles for as long
 * as both showed. The clock runs on the UI thread only while at least one glyph holds it.
 */
const clock = makeMutable(0);
const holders = { count: 0 };

const holdClock = (): (() => void) => {
    holders.count += 1;
    if (holders.count === 1) {
        clock.set(0);
        clock.set(
            withRepeat(withTiming(1, { duration: SPIN_CLOCK_MS, easing: Easing.linear }), -1),
        );
    }
    return () => {
        holders.count -= 1;
        if (holders.count === 0) cancelAnimation(clock);
    };
};

/**
 * The rotation style for a glyph turning once per `periodMs` on the shared phase. While `isSpinning` is false (reduced
 * motion, or a delayed spinner not yet revealed) the glyph stays at 0° and does not keep the clock running.
 *
 * @param periodMs One turn's duration; must divide `SPIN_CLOCK_MS`.
 */
export const useSharedSpinStyle = (periodMs: number, isSpinning: boolean) => {
    useEffect(() => (isSpinning ? holdClock() : undefined), [isSpinning]);
    return useAnimatedStyle(
        () => ({
            transform: [{ rotate: `${isSpinning ? spinDegrees(clock.get(), periodMs) : 0}deg` }],
        }),
        [isSpinning, periodMs],
    );
};
