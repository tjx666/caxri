/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ComponentType, ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import type { LucideProps } from 'lucide-react-native';

import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../theme/scale';
import type { MobileTheme } from '../theme/tokens';
import type { PopoverPlacement } from './use-popover-anchor';

/**
 * A small menu anchored under a control. Any tap outside it, or Android Back, closes it without reaching the content
 * underneath, matching platform overflow menus.
 */
export const PopoverMenu = ({
    children,
    closeLabel,
    onClose,
    placement,
    theme,
}: {
    children: ReactNode;
    closeLabel: string;
    onClose: () => void;
    placement: PopoverPlacement | null;
    theme: MobileTheme;
}) =>
    placement ? (
        <Modal
            animationType="none"
            navigationBarTranslucent
            onRequestClose={onClose}
            statusBarTranslucent
            transparent
            visible
        >
            <Pressable
                accessibilityLabel={closeLabel}
                accessibilityRole="button"
                onPress={onClose}
                style={StyleSheet.absoluteFill}
            />
            <Animated.View
                entering={FadeIn.duration(140)}
                style={[
                    styles.menu,
                    {
                        backgroundColor: theme.surface,
                        borderColor: theme.border,
                        boxShadow: `0px 6px 16px ${theme.shadow}`,
                    },
                    placement,
                ]}
            >
                {children}
            </Animated.View>
        </Modal>
    ) : null;

/**
 * One row of a {@link PopoverMenu}. `tone="danger"` is for an action that removes something, such as Forget this
 * computer; it should sit last, after a divider of other rows.
 */
export const PopoverAction = ({
    accessibilityHint,
    disabled = false,
    icon: Icon,
    label,
    onPress,
    testID,
    theme,
    tone = 'default',
}: {
    accessibilityHint?: string;
    disabled?: boolean;
    icon: ComponentType<LucideProps>;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
    tone?: 'danger' | 'default';
}) => {
    const color = tone === 'danger' ? theme.danger : theme.text;
    return (
        <Pressable
            accessibilityHint={accessibilityHint}
            accessibilityRole="menuitem"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => [
                styles.action,
                {
                    backgroundColor: pressed ? theme.elevated : 'transparent',
                    opacity: disabled ? 0.4 : 1,
                },
            ]}
            testID={testID}
        >
            <Icon color={tone === 'danger' ? theme.danger : theme.muted} size={18} />
            <Text numberOfLines={1} style={[mobileType.body, styles.actionLabel, { color }]}>
                {label}
            </Text>
        </Pressable>
    );
};

/**
 * A hairline between groups of {@link PopoverAction} rows.
 */
export const PopoverDivider = ({ theme }: { theme: MobileTheme }) => (
    <View style={[styles.divider, { backgroundColor: theme.border }]} />
);

const styles = StyleSheet.create({
    menu: {
        borderRadius: mobileRadius.md,
        borderWidth: 1,
        minWidth: 200,
        paddingVertical: mobileSpace.xs,
        position: 'absolute',
    },
    action: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.md,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.lg,
    },
    actionLabel: { flexShrink: 1 },
    divider: { height: StyleSheet.hairlineWidth, marginVertical: mobileSpace.xs },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
