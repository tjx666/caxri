/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import type { MobileTheme } from '../theme/tokens';

/**
 * A full-width 48dp action inside a bottom sheet, such as the Merge and Back pair of a confirmation page. `isBusy`
 * shows a spinner and ignores presses; `isDisabled` dims it.
 */
export const SheetButton = ({
    isBusy = false,
    isDisabled = false,
    label,
    onPress,
    testID,
    theme,
    variant,
}: {
    isBusy?: boolean;
    isDisabled?: boolean;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
    variant: 'success' | 'danger' | 'primary' | 'secondary';
}) => {
    const background = {
        success: theme.success,
        danger: theme.danger,
        primary: theme.primary,
        secondary: theme.elevated,
    }[variant];
    const foreground = variant === 'secondary' ? theme.text : theme.primaryForeground;
    const isInert = isBusy || isDisabled;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: isBusy, disabled: isInert }}
            disabled={isInert}
            onPress={onPress}
            style={({ pressed }) => [
                styles.button,
                { backgroundColor: background, opacity: isDisabled ? 0.4 : pressed ? 0.8 : 1 },
            ]}
            testID={testID}
        >
            {isBusy ? <ActivityIndicator color={foreground} size="small" /> : null}
            <Text style={[styles.buttonText, { color: foreground }]}>{label}</Text>
        </Pressable>
    );
};

const styles = StyleSheet.create({
    button: {
        alignItems: 'center',
        borderRadius: 12,
        flexDirection: 'row',
        gap: 8,
        justifyContent: 'center',
        minHeight: 48,
    },
    buttonText: { fontSize: 16, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
