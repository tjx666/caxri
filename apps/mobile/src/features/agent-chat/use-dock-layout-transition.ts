import type { LayoutAnimationFunction } from 'react-native-reanimated';
import { useReducedMotion } from 'react-native-reanimated';

import { anchoredLayoutTransition } from './anchored-layout-transition';

/**
 * The one height transition of a docked panel that discloses more (the plan's step list, the goal's full objective):
 * 180ms, the same as the composer's extras, anchored so the keyboard's move lands at once (`anchoredLayoutTransition`).
 * Reduced motion gets no transition, so the panel snaps. Never use it inside the timeline's FlashList, whose recycled
 * rows must not animate.
 */
const DOCK_TRANSITION = anchoredLayoutTransition(180);

export const useDockLayoutTransition = (): LayoutAnimationFunction | undefined => {
    const isReducedMotion = useReducedMotion();
    return isReducedMotion ? undefined : DOCK_TRANSITION;
};
