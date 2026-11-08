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
 * A notice that needs nothing from the user, drawn as a small capsule floating over the top center of the screen like a
 * Dynamic Island: an automatic reconnect, the saved copy on screen, or a truncated Session list. It takes no layout
 * height, so the list and the Session underneath never move when it appears or clears. Only the capsule takes touches;
 * pressing it runs its shortcut (Reconnect now, Search) through a 48dp target, and its accessible name reads the full
 * notice sentence. Motion follows the system's reduce-motion setting.
 */
export const NoticeIsland = ({
    accessibilityLabel,
    action,
    isBusy = false,
    label,
    testID,
    theme,
    wrapperTestID,
}: {
    /**
     * The full notice sentence, which the short label abbreviates.
     */
    accessibilityLabel: string;
    /**
     * The shortcut a tap runs. Without one the capsule is read-only and lets taps through to the header below it.
     */
    action?: { label: string; onPress: () => void; testID: string };
    /**
     * Shows a spinner before the label for work the app is already doing, such as reconnecting.
     */
    isBusy?: boolean;
    label: string;
    testID: string;
    theme: MobileTheme;
    /**
     * An extra id on the floating host for a fact the label carries, such as the saved copy's age.
     */
    wrapperTestID?: string;
}) => {
    const insets = useSafeAreaInsets();
    const content = (
        <>
            {isBusy ? <ActivityIndicator color={theme.muted} size="small" /> : null}
            <Text numberOfLines={1} style={[styles.label, { color: theme.text }]}>
                {label}
            </Text>
        </>
    );
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
                pointerEvents={action ? 'auto' : 'none'}
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
                {action ? (
                    <Pressable
                        accessibilityHint={action.label}
                        accessibilityLabel={accessibilityLabel}
                        accessibilityRole="button"
                        hitSlop={chipHitSlop}
                        onPress={action.onPress}
                        style={({ pressed }) => [styles.content, pressed && styles.pressed]}
                        testID={action.testID}
                    >
                        {content}
                    </Pressable>
                ) : (
                    <View accessibilityLabel={accessibilityLabel} accessible style={styles.content}>
                        {content}
                    </View>
                )}
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
    content: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        height: mobileControl.chip,
        paddingHorizontal: mobileSpace.md,
    },
    pressed: { opacity: PRESSED_OPACITY },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
