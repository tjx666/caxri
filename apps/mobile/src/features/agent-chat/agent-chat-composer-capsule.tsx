/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, FadeIn, LinearTransition, ReduceMotion } from 'react-native-reanimated';

import { mobileSpace } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { sessionDetailStyles } from '../sessions/components/session-detail-styles';

/**
 * The capsule's height change as the draft gains or loses a line, or the capsule expands: short, on Desktop's enter
 * curve (`--motion-ease-enter`), so the field answers each keystroke at once and still settles softly.
 */
const capsuleResize = LinearTransition.duration(160)
    .easing(Easing.bezier(0.23, 1, 0.32, 1))
    .reduceMotion(ReduceMotion.System);

/**
 * The second row appearing as the capsule expands. It mounts already at its final place, below the capsule's still
 * growing frame, so it fades in over the same span instead of showing outside the capsule until the frame catches up.
 */
const rowAppear = FadeIn.duration(160)
    .easing(Easing.bezier(0.23, 1, 0.32, 1))
    .reduceMotion(ReduceMotion.System);

/**
 * The Chat composer's capsule in its two layouts (`agentChatComposerLayout`). Collapsed, it is one row: `+`, the input,
 * and the send controls. Expanded, the input spans the top row and a second row holds `+`, the settings chips, and the
 * send controls. The input keeps the same position among its siblings in both layouts (the slots before and after it
 * render `null` instead of disappearing), so React keeps the same native input and its focus and keyboard survive the
 * switch that focusing it causes.
 *
 * Each row animates its own frame on the capsule's curve: the capsule's frame grows upward while its rows are laid out
 * at their final offsets, so a row left static would hang below the capsule's bottom edge until the resize ends. Moving
 * the rows down by the same amount the frame moves up keeps the bottom row still on screen. The capsule and the input's
 * row clip to their animating frames, as Desktop's composer clips its growing field, so the new lines are revealed
 * instead of drawing over the second row before the input's row catches up.
 */
export const AgentChatComposerCapsule = ({
    add,
    input,
    isExpanded,
    send,
    settings,
    theme,
}: {
    add: ReactNode;
    input: ReactNode;
    isExpanded: boolean;
    send: ReactNode;
    /**
     * The settings chips; shown only while expanded.
     */
    settings: ReactNode;
    theme: MobileTheme;
}) => (
    <Animated.View
        layout={capsuleResize}
        style={[
            sessionDetailStyles.capsule,
            styles.clip,
            { backgroundColor: theme.surface, borderColor: theme.border },
        ]}
        testID="agent-chat-composer-capsule"
    >
        <Animated.View
            layout={capsuleResize}
            style={[styles.clip, isExpanded ? null : sessionDetailStyles.composerRow]}
        >
            {isExpanded ? null : add}
            {input}
            {isExpanded ? null : send}
        </Animated.View>
        {isExpanded ? (
            <Animated.View
                entering={rowAppear}
                layout={capsuleResize}
                style={sessionDetailStyles.composerRow}
            >
                {add}
                <View style={styles.settings}>{settings}</View>
                {send}
            </Animated.View>
        ) : null}
    </Animated.View>
);

const styles = StyleSheet.create({
    clip: { overflow: 'hidden' },
    /**
     * Takes the row's spare width so the send controls stay at the trailing edge; the model chip shrinks first.
     */
    settings: {
        alignItems: 'center',
        alignSelf: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minWidth: 0,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
