/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Check, CircleAlert } from 'lucide-react-native';

import { useTranslation } from '../i18n';
import {
    chipHitSlop,
    mobileControl,
    mobileSpace,
    mobileType,
    PRESSED_OPACITY,
} from '../theme/scale';
import { useMobileTheme } from '../theme/use-mobile-theme';
import { IslandCapsule } from './island-capsule';
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
 * Renders the app's one toast, mounted once in the root layout. It draws as the same top-center capsule as the Session
 * notices (see `IslandCapsule`), so every transient message lands in one place and never covers the Composer's Send or
 * Stop. It takes no touches except on its action (Undo after an archive), which reaches 48dp through its hit slop.
 * Android reads it through a polite live region; iOS has none, so the sentence is announced once when it appears.
 */
export const ToastHost = () => {
    const toast = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot);
    const theme = useMobileTheme();
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
        <IslandCapsule
            accessibilityLiveRegion={isActionAnnounced ? 'none' : 'polite'}
            isInteractive={Boolean(toast.action)}
            key={toast.id}
            testID="toast"
            theme={theme}
        >
            <View style={styles.content}>
                <Icon color={toast.tone === 'success' ? theme.success : theme.danger} size={16} />
                <View style={styles.texts}>
                    <Text numberOfLines={2} style={[styles.message, { color: theme.text }]}>
                        {toast.message}
                    </Text>
                    {toast.detail ? (
                        <Text numberOfLines={2} style={[styles.detail, { color: theme.muted }]}>
                            {toast.detail}
                        </Text>
                    ) : null}
                </View>
                {toast.action ? (
                    <Pressable
                        accessibilityLabel={toast.action.label}
                        accessibilityRole="button"
                        hitSlop={chipHitSlop}
                        onPress={() => toastStore.runAction(toast.id)}
                        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
                        testID="toast-action"
                    >
                        <Text style={[styles.actionLabel, { color: theme.primary }]}>
                            {toast.action.label}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        </IslandCapsule>
    );
};

const styles = StyleSheet.create({
    action: {
        alignItems: 'center',
        height: mobileControl.chip,
        justifyContent: 'center',
        marginRight: -mobileSpace.xs,
        paddingHorizontal: mobileSpace.sm,
    },
    actionLabel: { ...mobileType.meta, fontWeight: '600' },
    content: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: mobileControl.chip,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.xxs,
    },
    detail: { ...mobileType.caption },
    message: { ...mobileType.meta, fontWeight: '600' },
    pressed: { opacity: PRESSED_OPACITY },
    texts: { flexShrink: 1 },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
