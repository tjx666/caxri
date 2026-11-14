import type { LayoutAnimationFunction } from 'react-native-reanimated';
import { useReducedMotion, withTiming } from 'react-native-reanimated';

import { isDockResize } from './dock-layout-motion';

/**
 * The height transition's length, the same as the composer's extras.
 */
const DOCK_TRANSITION_MS = 180;

/**
 * The one height transition of a docked panel that discloses more (the plan's step list, the goal's full objective):
 * `LinearTransition`'s frame animation, but only when the panel's size changes. A move at the same size, which is what
 * the keyboard showing or hiding causes, lands at once so the panel stays with the composer (`isDockResize`). Reduced
 * motion gets no transition, so the panel snaps. Never use it inside the timeline's FlashList, whose recycled rows must
 * not animate.
 */
const dockTransition: LayoutAnimationFunction = (values) => {
    'worklet';
    const target = {
        originX: values.targetOriginX,
        originY: values.targetOriginY,
        width: values.targetWidth,
        height: values.targetHeight,
    };
    if (!isDockResize(values)) {
        return {
            initialValues: target,
            animations: { originY: withTiming(values.targetOriginY, { duration: 0 }) },
        };
    }
    const config = { duration: DOCK_TRANSITION_MS };
    return {
        initialValues: {
            originX: values.currentOriginX,
            originY: values.currentOriginY,
            width: values.currentWidth,
            height: values.currentHeight,
        },
        animations: {
            originX: withTiming(target.originX, config),
            originY: withTiming(target.originY, config),
            width: withTiming(target.width, config),
            height: withTiming(target.height, config),
        },
    };
};

export const useDockLayoutTransition = (): LayoutAnimationFunction | undefined => {
    const isReducedMotion = useReducedMotion();
    return isReducedMotion ? undefined : dockTransition;
};
