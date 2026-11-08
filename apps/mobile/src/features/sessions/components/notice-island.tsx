/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { IslandCapsule } from '../../../components/island-capsule';
import { toastStore } from '../../../components/toast-store';
import {
    chipHitSlop,
    mobileControl,
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
 * notice sentence. While a toast is on screen the notice steps aside, since both share the same capsule spot.
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
    const toast = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot);
    // The toast draws in this same top-center spot; the notice steps aside until the toast clears.
    if (toast) return null;
    const content = (
        <>
            {isBusy ? <ActivityIndicator color={theme.muted} size="small" /> : null}
            <Text numberOfLines={1} style={[styles.label, { color: theme.text }]}>
                {label}
            </Text>
        </>
    );
    return (
        <IslandCapsule
            isInteractive={Boolean(action)}
            testID={testID}
            theme={theme}
            wrapperTestID={wrapperTestID}
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
        </IslandCapsule>
    );
};

const styles = StyleSheet.create({
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
