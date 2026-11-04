/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Check, CircleAlert } from 'lucide-react-native';

import { useTranslation } from '../i18n';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../theme/scale';
import { useMobileTheme } from '../theme/use-mobile-theme';
import { Button } from './button';
import { toastAnnouncement, toastStore } from './toast-store';

/**
 * Whether a screen reader is on, mirrored into the toast store so it can lengthen toasts that carry an action.
 */
const useIsScreenReaderOn = (): boolean => {
    const [isOn, setIsOn] = useState(false);
    useEffect(() => {
        const apply = (isEnabled: boolean): void => {
            toastStore.setScreenReaderEnabled(isEnabled);
            setIsOn(isEnabled);
        };
        void AccessibilityInfo.isScreenReaderEnabled().then(apply);
        const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', apply);
        return () => subscription.remove();
    }, []);
    return isOn;
};

/**
 * Space kept free above the bottom safe area for the Chat Composer (its 52dp Send/Stop button plus padding), so a toast
 * never covers Send or Stop.
 */
const COMPOSER_CLEARANCE = mobileControl.primary + mobileSpace.lg * 2 + mobileSpace.md;

/**
 * Renders the app's one toast, mounted once in the root layout. A small card at the bottom, above the safe area and the
 * Composer; it takes no touches except on its action button (Undo after an archive), which stays a 48dp target. Android
 * reads it through a polite live region; iOS has none, so the sentence is announced once when it appears. Motion
 * follows the system's reduce-motion setting.
 */
export const ToastHost = () => {
    const toast = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot);
    const theme = useMobileTheme();
    const insets = useSafeAreaInsets();
    const id = toast?.id;
    const { t } = useTranslation();
    const isScreenReaderOn = useIsScreenReaderOn();
    const spoken =
        toast &&
        toastAnnouncement(toast, (label) =>
            t('components.toastActionAvailable', { action: label }),
        );
    /**
     * A toast with an action is announced explicitly on both platforms while a screen reader is on, so the sentence
     * says the action is available; its live region is switched off then, or Android would read it twice.
     */
    const isActionAnnounced = Boolean(toast?.action) && isScreenReaderOn;
    useEffect(() => {
        if (spoken && (isActionAnnounced || Platform.OS === 'ios'))
            AccessibilityInfo.announceForAccessibility(spoken);
    }, [id, isActionAnnounced, spoken]);
    if (!toast) return null;
    const Icon = toast.tone === 'success' ? Check : CircleAlert;
    return (
        <View
            pointerEvents={toast.action ? 'box-none' : 'none'}
            style={[styles.host, { bottom: insets.bottom + COMPOSER_CLEARANCE }]}
        >
            <Animated.View
                accessibilityLiveRegion={isActionAnnounced ? 'none' : 'polite'}
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
                {toast.action ? (
                    <Button
                        label={toast.action.label}
                        onPress={() => toastStore.runAction(toast.id)}
                        testID="toast-action"
                        theme={theme}
                        variant="secondary"
                    />
                ) : null}
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
