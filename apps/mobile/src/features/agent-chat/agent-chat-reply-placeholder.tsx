import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withTiming,
} from 'react-native-reanimated';

import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles } from '../conversation/conversation-styles';

/**
 * One breath of a dot, Desktop's `--motion-compaction-pulse`.
 */
const PULSE_MS = 1800;

/**
 * Desktop's keyframes: full strength at 30% of the breath, dim again by 60%, then rest until the next breath.
 */
const RISE_MS = PULSE_MS * 0.3;

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 24 },
    dot: { width: 6, height: 6, borderRadius: 3 },
});

const Dot = ({ color, index }: { color: string; index: number }) => {
    const isReducedMotion = useReducedMotion();
    const opacity = useSharedValue(0.5);
    useEffect(() => {
        if (isReducedMotion) return;
        const easing = Easing.inOut(Easing.ease);
        const breath = withSequence(
            withTiming(1, { duration: RISE_MS, easing }),
            withTiming(0.35, { duration: RISE_MS, easing }),
            withTiming(0.35, { duration: PULSE_MS - RISE_MS * 2 }),
        );
        opacity.set(0.35);
        // Each dot starts a sixth of a breath after the one before it.
        opacity.set(withDelay((PULSE_MS / 6) * index, withRepeat(breath, -1)));
        return () => cancelAnimation(opacity);
    }, [index, isReducedMotion, opacity]);
    const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
    return <Animated.View style={[styles.dot, { backgroundColor: color }, style]} />;
};

/**
 * Holds the reply's place while a running turn has shown nothing yet, as Desktop's Chat does: three muted dots where
 * the reply's first line will start, so the prompt is not left above a blank screen while the Agent thinks. The
 * composer's activity line already says what the turn is doing, so the dots stay hidden from assistive technology.
 * Reduced motion leaves them still at half strength.
 */
export const AgentChatReplyPlaceholder = ({ theme }: { theme: MobileTheme }) => (
    <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[conversationStyles.message, styles.row]}
        testID="agent-chat-reply-placeholder"
    >
        {[0, 1, 2].map((index) => (
            <Dot color={theme.muted} index={index} key={index} />
        ))}
    </View>
);
