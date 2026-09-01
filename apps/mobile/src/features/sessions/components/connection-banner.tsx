import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import type { MobileConnectionStatus } from '../../connection/connection-state';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
export const ConnectionBanner = ({
    onRetry,
    status,
    theme,
}: {
    onRetry: () => void;
    status: Extract<MobileConnectionStatus, 'stale' | 'unverified'>;
    theme: MobileTheme;
}) => (
    <View
        style={[styles.banner, { backgroundColor: theme.surface, borderColor: theme.border }]}
        testID="connection-stale-banner"
    >
        <View
            accessible
            accessibilityLabel={
                status === 'unverified'
                    ? 'This pairing could not be verified. If this device was revoked on your Mac, forget it and pair again.'
                    : 'Connection interrupted. Showing the last known Session state.'
            }
            style={styles.copy}
        >
            <Text style={[styles.title, { color: theme.text }]}>
                {status === 'unverified' ? 'Pairing could not be verified' : 'Reconnecting…'}
            </Text>
            <Text style={[styles.body, { color: theme.muted }]}>
                {status === 'unverified'
                    ? 'If this device was revoked on your Mac, forget it and pair again.'
                    : 'Showing the last known state. Replies are paused.'}
            </Text>
        </View>
        {status === 'unverified' ? (
            <Pressable
                accessibilityRole="button"
                onPress={onRetry}
                style={styles.retry}
                testID="connection-retry-button"
            >
                <Text style={[styles.retryLabel, { color: theme.primary }]}>Retry</Text>
            </Pressable>
        ) : null}
    </View>
);

const styles = StyleSheet.create({
    banner: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: 12,
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    body: { fontSize: 13, lineHeight: 18 },
    copy: { flex: 1, gap: 3 },
    retry: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 8 },
    retryLabel: { fontSize: 14, fontWeight: '700' },
    title: { fontSize: 14, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
