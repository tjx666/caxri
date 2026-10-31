import Animated, { useReducedMotion } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { useSharedSpinStyle } from './shared-spin-clock';

/**
 * One turn of Desktop's `BackgroundArc` (`animation-duration: 3s`).
 */
const BACKGROUND_SPIN_MS = 3_000;

/**
 * Desktop's `BackgroundArc`: a dotted ring that turns slowly, marking a running Session whose Agent only waits on its
 * own background work, so it reads as "working, nothing to watch" next to a live turn's spinner. Background rings share
 * their own rotation phase; reduced motion leaves the ring still.
 */
export const BackgroundRing = ({
    accessibilityLabel,
    color,
    size,
    testID,
}: {
    accessibilityLabel: string;
    color: string;
    size: number;
    testID?: string;
}) => {
    const isReducedMotion = useReducedMotion();
    const spinStyle = useSharedSpinStyle(BACKGROUND_SPIN_MS, !isReducedMotion);
    return (
        <Animated.View
            accessibilityLabel={accessibilityLabel}
            accessibilityRole="progressbar"
            accessible
            style={[{ height: size, width: size }, spinStyle]}
            testID={testID}
        >
            <Svg height={size} viewBox="0 0 20 20" width={size}>
                <Circle
                    cx={10}
                    cy={10}
                    fill="none"
                    r={8.5}
                    stroke={color}
                    strokeDasharray="0.01 6.67"
                    strokeLinecap="round"
                    strokeWidth={3}
                />
            </Svg>
        </Animated.View>
    );
};
