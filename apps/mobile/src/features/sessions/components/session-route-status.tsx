import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { router } from 'expo-router';

import type { MobileTheme } from '../../../theme/tokens';

const styles = StyleSheet.create({
    root: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
    body: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
    retry: { justifyContent: 'center', minHeight: 48 },
});

export const SessionRouteStatus = ({
    error,
    hasBack,
    hostId,
    isLoading,
    isOffline,
    onRetry,
    theme,
}: {
    error: string | null;
    /**
     * A phone has no Session list beside this screen, so a dead end needs its own way back.
     */
    hasBack: boolean;
    hostId: string;
    isLoading: boolean;
    isOffline: boolean;
    onRetry: () => Promise<unknown>;
    theme: MobileTheme;
}) => (
    <View style={styles.root} testID="session-route-status">
        {isLoading && !error && !isOffline ? <ActivityIndicator color={theme.primary} /> : null}
        <Text
            accessibilityRole={error ? 'alert' : 'text'}
            style={[styles.body, { color: theme.muted }]}
        >
            {error ?? (isOffline ? 'Reconnect to open this Session.' : 'Opening Session…')}
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
        {hasBack && (error || isOffline) ? (
            <Pressable
                accessibilityRole="button"
                onPress={() => router.dismissTo(`/h/${encodeURIComponent(hostId)}`)}
                style={styles.retry}
                testID="session-route-back"
            >
                <Text style={{ color: theme.primary }}>Back to Sessions</Text>
            </Pressable>
        ) : null}
    </View>
);
