import type { ComponentProps } from 'react';
import { useContext } from 'react';
import type { View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';

import { SESSION_LIST_MOTION_MS, SessionListMotionContext } from '../session-list-motion';

const rowEntering = FadeIn.duration(SESSION_LIST_MOTION_MS).reduceMotion(ReduceMotion.System);
const rowExiting = FadeOut.duration(SESSION_LIST_MOTION_MS).reduceMotion(ReduceMotion.System);
const rowMoving = LinearTransition.duration(SESSION_LIST_MOTION_MS).reduceMotion(
    ReduceMotion.System,
);

/**
 * FlashList's cell container for the Session list. While a list change is in motion, a mounting cell fades in, an
 * unmounting cell fades out where it stood, and a cell FlashList moves to a new `top` slides there. The transitions sit
 * on the cell itself, the view FlashList mounts, removes, and positions. `ref` still reaches the host view, which
 * FlashList measures.
 */
export const SessionListCell = ({ children, ...rest }: ComponentProps<typeof View>) => {
    const isMoving = useContext(SessionListMotionContext);
    return (
        <Animated.View
            {...rest}
            entering={isMoving ? rowEntering : undefined}
            exiting={isMoving ? rowExiting : undefined}
            layout={isMoving ? rowMoving : undefined}
        >
            {children}
        </Animated.View>
    );
};
