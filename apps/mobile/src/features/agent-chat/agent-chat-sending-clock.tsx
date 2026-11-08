/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
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
    withTiming,
} from 'react-native-reanimated';

import type { AgentChatPendingWait } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { AgentChatHintMark } from './agent-chat-hint-mark';

/**
 * One turn of the minute hand, Desktop's `--motion-sending-clock`; the hour hand takes twelve.
 */
const TURN_MS = 1200;

/**
 * Desktop's `--motion-sending-reveal-delay`: a send that lands at once never flashes the clock.
 */
const REVEAL_DELAY_MS = 400;

/**
 * Desktop's `--motion-overlay-enter`.
 */
const REVEAL_MS = 150;

/**
 * Desktop's `--motion-ease-enter` (easeOutQuint).
 */
const ENTER_EASING = Easing.bezier(0.23, 1, 0.32, 1);

const SIZE = 12;
const STROKE = 1.25;

const SENDING_HINT_KEYS = {
    compaction: 'chat.sendingAfterCompaction',
    delivery: 'chat.sending',
    start: 'chat.sendingAfterStart',
    step: 'chat.sendingAfterStep',
} as const satisfies Record<AgentChatPendingWait, string>;

/**
 * A hand turning from `from` degrees, a full turn per `durationMs`. Reduced motion leaves it still.
 */
const Hand = ({
    color,
    durationMs,
    from,
    length,
}: {
    color: string;
    durationMs: number;
    from: number;
    length: number;
}) => {
    const isReducedMotion = useReducedMotion();
    const angle = useSharedValue(from);
    useEffect(() => {
        if (isReducedMotion) return;
        angle.set(from);
        angle.set(
            withRepeat(withTiming(from + 360, { duration: durationMs, easing: Easing.linear }), -1),
        );
        return () => cancelAnimation(angle);
    }, [angle, durationMs, from, isReducedMotion]);
    const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.get()}deg` }] }));
    return (
        <Animated.View style={[StyleSheet.absoluteFill, style]}>
            <View style={[styles.hand, { backgroundColor: color, height: length }]} />
        </Animated.View>
    );
};

/**
 * A small clock whose hands turn while the message is in flight, in place of a caption, as Desktop's
 * `AgentChatSendingClock`: the minute hand sweeps a full turn per second and a bit while the hour hand creeps, so a
 * slow provider reads as "still on its way" without a line of text. It fades in after a short delay; what it waits for
 * is one tap away and is its accessible name. Reduced motion shows a still clock at once.
 */
export const AgentChatSendingClock = ({
    theme,
    wait,
}: {
    theme: MobileTheme;
    wait: AgentChatPendingWait;
}) => {
    const { t } = useTranslation();
    const isReducedMotion = useReducedMotion();
    const reveal = useSharedValue(isReducedMotion ? 1 : 0);
    useEffect(() => {
        if (isReducedMotion) return;
        const fadeIn = withTiming(1, { duration: REVEAL_MS, easing: ENTER_EASING });
        reveal.set(withDelay(REVEAL_DELAY_MS, fadeIn));
        return () => cancelAnimation(reveal);
    }, [isReducedMotion, reveal]);
    const revealStyle = useAnimatedStyle(() => ({
        opacity: reveal.get(),
        transform: [{ scale: 0.6 + reveal.get() * 0.4 }],
    }));
    return (
        <AgentChatHintMark
            accessibilityRole="text"
            hint={t(SENDING_HINT_KEYS[wait])}
            testID={`agent-chat-sending-${wait}`}
            theme={theme}
        >
            <Animated.View
                accessibilityLiveRegion="polite"
                style={[styles.face, { borderColor: theme.muted }, revealStyle]}
            >
                <Hand color={theme.muted} durationMs={TURN_MS * 12} from={90} length={2.75} />
                <Hand color={theme.muted} durationMs={TURN_MS} from={0} length={3.75} />
            </Animated.View>
        </AgentChatHintMark>
    );
};

const styles = StyleSheet.create({
    face: { borderRadius: SIZE / 2, borderWidth: STROKE, height: SIZE, width: SIZE },
    hand: {
        borderRadius: STROKE,
        bottom: (SIZE - STROKE * 2) / 2 - STROKE / 2,
        left: (SIZE - STROKE * 2) / 2 - STROKE / 2,
        position: 'absolute',
        width: STROKE,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
