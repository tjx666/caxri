import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { MobileTheme } from '../theme/tokens';

const styles = StyleSheet.create({
    banner: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    text: { flex: 1, fontSize: 13, lineHeight: 18 },
    button: {
        alignItems: 'center',
        borderRadius: 10,
        justifyContent: 'center',
        minHeight: 48,
        minWidth: 72,
        paddingHorizontal: 14,
    },
    buttonText: { fontSize: 14, fontWeight: '700' },
});

/**
 * A one-line state notice across the top of a Session segment, with an optional separate action button. The sentence
 * itself is never the button, so the action keeps a full touch target and a short accessible name.
 */
export const NoticeBanner = ({
    actionLabel,
    isBusy,
    message,
    onAction,
    testID,
    theme,
    tone,
}: {
    actionLabel?: string;
    isBusy?: boolean;
    message: string;
    onAction?: () => void;
    testID: string;
    theme: MobileTheme;
    tone: 'danger' | 'muted';
}) => (
    <View
        accessibilityRole="alert"
        style={[styles.banner, { borderColor: theme.border }]}
        testID={testID}
    >
        <Text style={[styles.text, { color: tone === 'danger' ? theme.danger : theme.muted }]}>
            {message}
        </Text>
        {actionLabel && onAction ? (
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: isBusy, disabled: isBusy }}
                disabled={isBusy}
                onPress={onAction}
                style={[styles.button, { backgroundColor: theme.surface }]}
                testID={`${testID}-action`}
            >
                {isBusy ? (
                    <ActivityIndicator color={theme.text} />
                ) : (
                    <Text style={[styles.buttonText, { color: theme.text }]}>{actionLabel}</Text>
                )}
            </Pressable>
        ) : null}
    </View>
);
