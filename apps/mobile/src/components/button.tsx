/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ComponentType } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Pressable, StyleSheet, Text } from 'react-native';

import type { LucideProps } from 'lucide-react-native';
import { ChevronRight } from 'lucide-react-native';

import {
    mobileControl,
    mobileRadius,
    mobileSpace,
    mobileType,
    PRESSED_OPACITY,
} from '../theme/scale';
import type { MobileTheme } from '../theme/tokens';
import { Spinner } from './spinner';

/**
 * `primary` is the one filled answer of a screen, sheet, or card; `secondary` is a filled companion such as Back on a
 * confirmation page; `outline` is every other answer, Decline included, matching Desktop's outlined buttons; `success`
 * and `danger` are reserved for an action whose outcome is that state (Merge, Forget this computer).
 */
export type ButtonVariant = 'danger' | 'outline' | 'primary' | 'secondary' | 'success';

const colors = (theme: MobileTheme, variant: ButtonVariant) =>
    ({
        danger: {
            background: theme.danger,
            border: theme.danger,
            foreground: theme.dangerForeground,
        },
        outline: { background: 'transparent', border: theme.border, foreground: theme.text },
        primary: {
            background: theme.primary,
            border: theme.primary,
            foreground: theme.primaryForeground,
        },
        secondary: { background: theme.elevated, border: theme.elevated, foreground: theme.text },
        success: {
            background: theme.success,
            border: theme.success,
            foreground: theme.primaryForeground,
        },
    })[variant];

/**
 * The app's one text button. Every filled or outlined action (pairing, sheets, request answers, retry, merge) draws
 * through it, so a primary action looks the same on every screen.
 *
 * `isBusy` shows a spinner beside the label and ignores presses. It deliberately sets no `busy` accessibility state:
 * Android appends "busy" to the native content description and never removes it when `busy` turns false again, so a
 * failed merge kept announcing "Merge, busy". A busy button announces as disabled instead.
 */
export const Button = ({
    accessibilityHint,
    icon: Icon,
    isBusy = false,
    isDisabled = false,
    label,
    navigates = false,
    onDisabledPress,
    onPress,
    size = 'row',
    style,
    testID,
    theme,
    variant,
}: {
    accessibilityHint?: string;
    /**
     * A leading glyph, drawn in the label's color.
     */
    icon?: ComponentType<LucideProps>;
    isBusy?: boolean;
    isDisabled?: boolean;
    label: string;
    /**
     * Shows a trailing chevron. Only a button that opens another screen gets one; an action in place does not.
     */
    navigates?: boolean;
    /**
     * Explains a disabled button on tap. It still looks and announces as disabled, but a tap shows the reason instead
     * of doing nothing.
     */
    onDisabledPress?: () => void;
    onPress: () => void;
    /**
     * `primary` (52dp) is a screen's single primary action; everything else is `row` (48dp).
     */
    size?: 'primary' | 'row';
    /**
     * Layout only (flex, margins, alignment). Colors and shape come from `variant`.
     */
    style?: StyleProp<ViewStyle>;
    testID: string;
    theme: MobileTheme;
    variant: ButtonVariant;
}) => {
    const { background, border, foreground } = colors(theme, variant);
    const isInert = isBusy || isDisabled;
    return (
        <Pressable
            accessibilityHint={accessibilityHint}
            accessibilityLabel={label}
            accessibilityRole="button"
            accessibilityState={{ disabled: isInert }}
            disabled={isBusy || (isDisabled && !onDisabledPress)}
            onPress={isDisabled ? onDisabledPress : onPress}
            style={({ pressed }) => [
                styles.button,
                {
                    backgroundColor:
                        variant === 'outline' && pressed && !isInert ? theme.elevated : background,
                    borderColor: border,
                    justifyContent: navigates ? 'space-between' : 'center',
                    minHeight: size === 'primary' ? mobileControl.primary : mobileControl.row,
                    opacity:
                        isDisabled && !isBusy
                            ? 0.4
                            : pressed && variant !== 'outline'
                              ? PRESSED_OPACITY
                              : 1,
                },
                style,
            ]}
            testID={testID}
        >
            {isBusy ? (
                <Spinner color={foreground} />
            ) : Icon ? (
                <Icon color={foreground} size={18} />
            ) : null}
            <Text numberOfLines={1} style={[styles.label, { color: foreground }]}>
                {label}
            </Text>
            {navigates ? <ChevronRight color={foreground} size={20} /> : null}
        </Pressable>
    );
};

const styles = StyleSheet.create({
    button: {
        alignItems: 'center',
        borderRadius: mobileRadius.md,
        borderWidth: 1,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        paddingHorizontal: mobileSpace.lg,
    },
    label: { ...mobileType.bodyStrong, flexShrink: 1 },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
