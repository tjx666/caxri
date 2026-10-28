import { LinearTransition, useReducedMotion } from 'react-native-reanimated';

/**
 * The one height transition of a docked panel that discloses more (the plan's step list, the goal's full objective):
 * 180ms, the same as the composer's extras. Reduced motion gets no transition, so the panel snaps. Never use it inside
 * the timeline's FlashList, whose recycled rows must not animate.
 */
const DOCK_TRANSITION = LinearTransition.duration(180);

export const useDockLayoutTransition = (): typeof DOCK_TRANSITION | undefined => {
    const isReducedMotion = useReducedMotion();
    return isReducedMotion ? undefined : DOCK_TRANSITION;
};
