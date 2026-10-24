/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useEffect, useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native';
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

import { LoaderCircle } from 'lucide-react-native';

import { LOADING_REVEAL_DELAY_MS } from './loading-delay';

/**
 * One turn of Tailwind's `animate-spin`, which Desktop's `Spinner` uses.
 */
const SPIN_MS = 1_000;

/**
 * The shared loading indicator: Desktop's `Spinner` glyph (`LoaderCircle`) turning at the same speed, so the phone's
 * loading states look like Desktop's instead of Android's growing arc or iOS's spokes. Reduced motion leaves the glyph
 * still. With `isDelayed`, it draws nothing for `LOADING_REVEAL_DELAY_MS`, so a read that settles quickly never flashes
 * a spinner; a placeholder of the same size keeps the layout from shifting when it appears.
 */
export const Spinner = ({
    accessibilityLabel,
    color,
    isDelayed = false,
    size = 20,
    style,
    testID,
}: {
    accessibilityLabel?: string;
    color: string;
    isDelayed?: boolean;
    size?: number;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}) => {
    const isReducedMotion = useReducedMotion();
    const [isRevealed, setRevealed] = useState(!isDelayed);
    const turn = useSharedValue(0);
    useEffect(() => {
        if (isRevealed) return;
        const timer = setTimeout(() => setRevealed(true), LOADING_REVEAL_DELAY_MS);
        return () => clearTimeout(timer);
    }, [isRevealed]);
    useEffect(() => {
        if (isReducedMotion || !isRevealed) return;
        turn.set(withRepeat(withTiming(1, { duration: SPIN_MS, easing: Easing.linear }), -1));
        return () => {
            cancelAnimation(turn);
            turn.set(0);
        };
    }, [isReducedMotion, isRevealed, turn]);
    const spinStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${turn.get() * 360}deg` }],
    }));
    return (
        <Animated.View
            accessibilityLabel={accessibilityLabel}
            accessibilityRole={accessibilityLabel ? 'progressbar' : undefined}
            accessible={accessibilityLabel !== undefined}
            style={[styles.root, { height: size, width: size }, style, spinStyle]}
            testID={testID}
        >
            {isRevealed ? <LoaderCircle color={color} size={size} /> : null}
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    root: { alignItems: 'center', justifyContent: 'center' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
