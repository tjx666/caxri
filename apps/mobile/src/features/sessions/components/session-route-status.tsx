import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';

const styles = StyleSheet.create({
    root: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
    body: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
    retry: { justifyContent: 'center', minHeight: 48 },
});

export const SessionRouteStatus = ({
    error,
    isLoading,
    onRetry,
    theme,
}: {
    error: string | null;
    isLoading: boolean;
    onRetry: () => Promise<unknown>;
    theme: MobileTheme;
}) => (
    <View style={styles.root} testID="session-route-status">
        {isLoading && !error ? <ActivityIndicator color={theme.primary} /> : null}
        <Text
            accessibilityRole={error ? 'alert' : 'text'}
            style={[styles.body, { color: theme.muted }]}
        >
            {error ?? 'Opening Session…'}
        </Text>
        {error ? (
            <Pressable
                accessibilityRole="button"
                onPress={onRetry}
                style={styles.retry}
                testID="session-route-retry"
            >
                <Text style={{ color: theme.primary }}>Retry</Text>
            </Pressable>
        ) : null}
    </View>
);
