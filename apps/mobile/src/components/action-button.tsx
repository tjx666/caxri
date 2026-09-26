/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ChevronRight } from 'lucide-react-native';

import type { MobileTheme } from '../theme/tokens';

interface ActionButtonProperties {
    accessibilityHint: string;
    children: ReactNode;
    /**
     * Shows a trailing chevron. Only a button that opens another screen gets one; an action in place does not.
     */
    navigates?: boolean;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
    variant?: 'primary' | 'secondary';
}

export const ActionButton = ({
    accessibilityHint,
    children,
    navigates = false,
    onPress,
    testID,
    theme,
    variant = 'primary',
}: ActionButtonProperties) => (
    <Pressable
        accessibilityHint={accessibilityHint}
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [
            styles.button,
            {
                backgroundColor: variant === 'primary' ? theme.primary : theme.surface,
                borderColor: variant === 'primary' ? theme.primary : theme.border,
                opacity: pressed ? 0.76 : 1,
            },
        ]}
        testID={testID}
    >
        <View style={styles.content}>
            <Text
                style={[
                    styles.label,
                    {
                        color: variant === 'primary' ? theme.primaryForeground : theme.text,
                    },
                ]}
            >
                {children}
            </Text>
            {navigates ? (
                <ChevronRight
                    color={variant === 'primary' ? theme.primaryForeground : theme.muted}
                    size={20}
                />
            ) : null}
        </View>
    </Pressable>
);

const styles = StyleSheet.create({
    button: {
        borderRadius: 14,
        borderWidth: 1,
        minHeight: 52,
        paddingHorizontal: 18,
        justifyContent: 'center',
    },
    content: {
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    label: {
        fontSize: 16,
        fontWeight: '600',
        letterSpacing: -0.2,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
