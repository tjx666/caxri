/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
    chipHitSlop,
    mobileControl,
    mobileRadius,
    mobileSpace,
    mobileType,
    PRESSED_OPACITY,
} from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';

/**
 * The automatic-reconnect notice as a small capsule floating over the top center of the screen, like a Dynamic Island.
 * It takes no layout height, so the list and the Session underneath never move when it appears or clears. Only the
 * capsule takes touches; pressing it runs its action (Reconnect now) through a 48dp target, and its accessible name
 * reads the full notice sentence. Motion follows the system's reduce-motion setting.
 */
export const ConnectionIsland = ({
    accessibilityLabel,
    actionLabel,
    actionTestID,
    label,
    onAction,
    testID,
    theme,
    wrapperTestID,
}: {
    /**
     * The full notice sentence, which the short label abbreviates.
     */
    accessibilityLabel: string;
    actionLabel: string;
    actionTestID: string;
    label: string;
    onAction: () => void;
    testID: string;
    theme: MobileTheme;
    /**
     * An extra id on the floating host for a fact the label carries, such as the saved copy's age.
     */
    wrapperTestID?: string;
}) => {
    const insets = useSafeAreaInsets();
    return (
        <View
            collapsable={false}
            pointerEvents="box-none"
            style={[styles.host, { top: insets.top + mobileSpace.xs }]}
            testID={wrapperTestID}
        >
            <Animated.View
                entering={FadeInUp.duration(160).reduceMotion(ReduceMotion.System)}
                exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
                style={[
                    styles.capsule,
                    {
                        backgroundColor: theme.elevated,
                        borderColor: theme.border,
                        boxShadow: `0px 2px 8px ${theme.shadow}`,
                    },
                ]}
                testID={testID}
            >
                <Pressable
                    accessibilityHint={actionLabel}
                    accessibilityLabel={accessibilityLabel}
                    accessibilityRole="button"
                    hitSlop={chipHitSlop}
                    onPress={onAction}
                    style={({ pressed }) => [styles.pressable, pressed && styles.pressed]}
                    testID={actionTestID}
                >
                    <ActivityIndicator color={theme.muted} size="small" />
                    <Text numberOfLines={1} style={[styles.label, { color: theme.text }]}>
                        {label}
                    </Text>
                </Pressable>
            </Animated.View>
        </View>
    );
};

const styles = StyleSheet.create({
    capsule: {
        borderRadius: mobileRadius.pill,
        borderWidth: 1,
        maxWidth: '100%',
    },
    host: {
        alignItems: 'center',
        left: 0,
        paddingHorizontal: mobileSpace.lg,
        position: 'absolute',
        right: 0,
        zIndex: 1,
    },
    label: { ...mobileType.meta, flexShrink: 1 },
    pressable: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        height: mobileControl.chip,
        paddingHorizontal: mobileSpace.md,
    },
    pressed: { opacity: PRESSED_OPACITY },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
