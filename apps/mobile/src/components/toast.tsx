/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useEffect, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Check, CircleAlert } from 'lucide-react-native';

import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../theme/scale';
import { useMobileTheme } from '../theme/use-mobile-theme';
import { toastStore } from './toast-store';

/**
 * Space kept free above the bottom safe area for the Chat Composer (its 52dp Send/Stop button plus padding), so a toast
 * never covers Send or Stop.
 */
const COMPOSER_CLEARANCE = mobileControl.primary + mobileSpace.lg * 2 + mobileSpace.md;

/**
 * Renders the app's one toast, mounted once in the root layout. A small card at the bottom, above the safe area and the
 * Composer; it never takes touches. Android reads it through a polite live region; iOS has none, so the sentence is
 * announced once when it appears. Motion follows the system's reduce-motion setting.
 */
export const ToastHost = () => {
    const toast = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot);
    const theme = useMobileTheme();
    const insets = useSafeAreaInsets();
    const id = toast?.id;
    const spoken = toast && [toast.message, toast.detail].filter(Boolean).join('. ');
    useEffect(() => {
        if (spoken && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(spoken);
    }, [id, spoken]);
    if (!toast) return null;
    const Icon = toast.tone === 'success' ? Check : CircleAlert;
    return (
        <View
            pointerEvents="none"
            style={[styles.host, { bottom: insets.bottom + COMPOSER_CLEARANCE }]}
        >
            <Animated.View
                accessibilityLiveRegion="polite"
                entering={FadeInDown.duration(160).reduceMotion(ReduceMotion.System)}
                exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}
                key={toast.id}
                style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
                testID="toast"
            >
                <Icon color={toast.tone === 'success' ? theme.success : theme.danger} size={18} />
                <View style={styles.texts}>
                    <Text style={[styles.message, { color: theme.text }]}>{toast.message}</Text>
                    {toast.detail ? (
                        <Text style={[styles.detail, { color: theme.muted }]}>{toast.detail}</Text>
                    ) : null}
                </View>
            </Animated.View>
        </View>
    );
};

const styles = StyleSheet.create({
    card: {
        alignItems: 'center',
        borderRadius: mobileRadius.md,
        borderWidth: 1,
        flexDirection: 'row',
        gap: mobileSpace.md,
        maxWidth: '100%',
        paddingHorizontal: mobileSpace.lg,
        paddingVertical: mobileSpace.md,
    },
    detail: { ...mobileType.meta },
    host: {
        alignItems: 'center',
        left: 0,
        paddingHorizontal: mobileSpace.lg,
        position: 'absolute',
        right: 0,
    },
    message: { ...mobileType.bodyStrong },
    texts: { flexShrink: 1 },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
