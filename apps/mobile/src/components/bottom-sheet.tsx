/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ComponentType, ReactNode } from 'react';
import { useCallback, useEffect } from 'react';
import type { DimensionValue } from 'react-native';
import {
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    useWindowDimensions,
    View,
} from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import type { LucideProps } from 'lucide-react-native';

import { useTranslation } from '../i18n';
import {
    mobileControl,
    mobileRadius,
    mobileSpace,
    mobileType,
    PRESSED_OPACITY,
} from '../theme/scale';
import type { MobileTheme } from '../theme/tokens';
import { Spinner } from './spinner';

const OPEN_MS = 260;
const CLOSE_MS = 180;

/**
 * The one modal sheet primitive for mobile: a dimmed backdrop and a panel that slides up from the bottom edge. Tapping
 * the backdrop, Android Back, or a `dismiss` call from the content slides it away before `onClose` runs, so every sheet
 * leaves the same way it arrived.
 *
 * Mount it only while it is open. A parent that closes it programmatically (for example after a completed action) may
 * simply unmount it instead of calling `dismiss`.
 */
export const BottomSheet = ({
    children,
    closeLabel,
    maxHeight,
    onClose,
    testID,
    theme,
}: {
    children: ReactNode | ((dismiss: () => void) => ReactNode);
    /**
     * Accessible name of the backdrop, which closes the sheet.
     */
    closeLabel: string;
    maxHeight?: DimensionValue;
    onClose: () => void;
    testID?: string;
    theme: MobileTheme;
}) => {
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const progress = useSharedValue(0);
    const sheetHeight = useSharedValue(windowHeight);

    useEffect(() => {
        progress.set(withTiming(1, { duration: OPEN_MS, easing: Easing.out(Easing.cubic) }));
    }, [progress]);

    const dismiss = useCallback((): void => {
        progress.set(
            withTiming(0, { duration: CLOSE_MS, easing: Easing.in(Easing.cubic) }, (finished) => {
                if (finished) scheduleOnRN(onClose);
            }),
        );
    }, [onClose, progress]);

    const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
    const sheetStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: (1 - progress.value) * sheetHeight.value }],
    }));

    return (
        <Modal
            animationType="none"
            navigationBarTranslucent
            onRequestClose={dismiss}
            statusBarTranslucent
            transparent
            visible
        >
            <KeyboardAvoidingView
                /**
                 * Android's `Modal` opens its own Dialog window, but that window still reports
                 * `keyboardDidShow`/`keyboardDidHide` (confirmed on device against react-native@0.86, see #1444), so
                 * `'height'` shrinks the sheet's flex container exactly like it already does outside a Modal
                 * (`session-detail.tsx`). Leaving this `undefined` let the keyboard render on top of the input and the
                 * Save button instead of pushing the sheet up.
                 */
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.root}
            >
                <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
                    <Pressable
                        accessibilityLabel={closeLabel}
                        accessibilityRole="button"
                        onPress={dismiss}
                        style={[styles.backdrop, { backgroundColor: theme.overlay }]}
                        testID={testID ? `${testID}-backdrop` : undefined}
                    />
                </Animated.View>
                <Animated.View
                    onLayout={(event) => {
                        sheetHeight.set(event.nativeEvent.layout.height);
                    }}
                    style={[
                        styles.sheet,
                        {
                            backgroundColor: theme.surface,
                            borderColor: theme.border,
                            maxHeight,
                            paddingBottom: insets.bottom + 12,
                        },
                        sheetStyle,
                    ]}
                    testID={testID}
                >
                    <View style={[styles.grabber, { backgroundColor: theme.border }]} />
                    {typeof children === 'function' ? children(dismiss) : children}
                </Animated.View>
            </KeyboardAvoidingView>
        </Modal>
    );
};

/**
 * The heading at the top of a sheet, with an optional muted line under it. Every sheet that names its subject (a
 * Session's actions, a pull request, a confirmation) uses it, so titles share one size and inset.
 */
export const SheetTitle = ({
    detail,
    testID,
    theme,
    title,
}: {
    detail?: string;
    testID?: string;
    theme: MobileTheme;
    title: string;
}) => (
    <View style={styles.title} testID={testID}>
        <Text
            accessibilityRole="header"
            numberOfLines={2}
            style={[mobileType.heading, { color: theme.text }]}
        >
            {title}
        </Text>
        {detail ? <Text style={[mobileType.meta, { color: theme.muted }]}>{detail}</Text> : null}
    </View>
);

/**
 * A full-width row in a `BottomSheet` menu.
 */
export const SheetAction = ({
    busy = false,
    detail,
    detailTestID,
    disabled = false,
    icon: Icon,
    label,
    onPress,
    testID,
    theme,
}: {
    busy?: boolean;
    /**
     * A muted line under the label, in the label's own column: why the row is disabled, or what it does. Only the icon
     * and label dim when the row is disabled, so the explanation stays at full contrast.
     */
    detail?: string;
    detailTestID?: string;
    disabled?: boolean;
    icon: ComponentType<LucideProps>;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy || disabled }}
        disabled={busy || disabled}
        onPress={onPress}
        style={({ pressed }) => [
            styles.action,
            { backgroundColor: pressed ? theme.elevated : 'transparent' },
        ]}
        testID={testID}
    >
        {busy ? (
            <Spinner color={theme.muted} />
        ) : (
            <Icon color={theme.muted} opacity={disabled ? 0.4 : 1} size={20} />
        )}
        <View style={styles.actionBody}>
            <Text style={[styles.actionText, { color: theme.text, opacity: disabled ? 0.4 : 1 }]}>
                {label}
            </Text>
            {detail ? (
                <Text style={[mobileType.meta, { color: theme.muted }]} testID={detailTestID}>
                    {detail}
                </Text>
            ) : null}
        </View>
    </Pressable>
);

/**
 * The explicit way out of a `BottomSheet` menu, for users who do not know the backdrop or Back dismisses it. A sheet
 * whose choices apply as they are tapped labels it `Done`, since there is nothing left to cancel. `label` selects the
 * meaning; the visible text follows the active locale.
 */
export const SheetCancel = ({
    label = 'Cancel',
    onPress,
    testID,
    theme,
}: {
    label?: 'Cancel' | 'Done';
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <Pressable
            accessibilityRole="button"
            onPress={onPress}
            style={({ pressed }) => [
                styles.cancel,
                { backgroundColor: theme.elevated, opacity: pressed ? PRESSED_OPACITY : 1 },
            ]}
            testID={testID}
        >
            <Text style={[styles.cancelText, { color: theme.text }]}>
                {t(label === 'Done' ? 'components.done' : 'common.cancel')}
            </Text>
        </Pressable>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFill },
    sheet: {
        alignSelf: 'center',
        borderTopLeftRadius: mobileRadius.lg,
        borderTopRightRadius: mobileRadius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        maxWidth: 560,
        paddingHorizontal: mobileSpace.md,
        paddingTop: mobileSpace.sm,
        width: '100%',
    },
    grabber: {
        alignSelf: 'center',
        borderRadius: 2,
        height: 4,
        marginBottom: mobileSpace.md,
        width: 36,
    },
    title: {
        gap: mobileSpace.xs,
        paddingBottom: mobileSpace.md,
        paddingHorizontal: mobileSpace.md,
    },
    action: {
        alignItems: 'center',
        borderRadius: mobileRadius.md,
        flexDirection: 'row',
        gap: mobileSpace.md,
        minHeight: mobileControl.primary,
        paddingHorizontal: mobileSpace.md,
    },
    actionBody: { flex: 1, gap: mobileSpace.xxs, paddingVertical: mobileSpace.sm },
    actionText: { ...mobileType.body },
    cancel: {
        alignItems: 'center',
        borderRadius: mobileRadius.md,
        justifyContent: 'center',
        marginTop: mobileSpace.sm,
        minHeight: mobileControl.row,
    },
    cancelText: { ...mobileType.bodyStrong },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
