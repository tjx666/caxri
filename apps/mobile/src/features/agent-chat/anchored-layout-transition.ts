import type { LayoutAnimationFunction, WithTimingConfig } from 'react-native-reanimated';
import { withTiming } from 'react-native-reanimated';

import { anchoredLayoutStart } from './anchored-layout-start';

/**
 * A layout transition for a row above the composer that resizes in place: the size animates upward from the target's
 * bottom edge and a move lands at once (`anchoredLayoutStart`), so the row stays with the composer while the keyboard
 * shows or hides. Callers handle reduced motion, since a layout function has no `reduceMotion` setting.
 */
export const anchoredLayoutTransition = (
    duration: number,
    easing?: WithTimingConfig['easing'],
): LayoutAnimationFunction => {
    const config = easing ? { duration, easing } : { duration };
    return (values) => {
        'worklet';
        const start = anchoredLayoutStart(values);
        return {
            initialValues: start,
            animations: {
                originX: withTiming(values.targetOriginX, config),
                originY: withTiming(values.targetOriginY, config),
                width: withTiming(values.targetWidth, config),
                height: withTiming(values.targetHeight, config),
            },
        };
    };
};
