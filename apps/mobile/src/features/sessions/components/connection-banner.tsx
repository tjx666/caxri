import { StyleSheet, Text, View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
export const ConnectionBanner = ({ theme }: { theme: MobileTheme }) => (
    <View
        accessible
        accessibilityLabel="Connection interrupted. Showing the last known Session state."
        style={[styles.banner, { backgroundColor: theme.surface, borderColor: theme.border }]}
        testID="connection-stale-banner"
    >
        <Text style={[styles.title, { color: theme.text }]}>Reconnecting…</Text>
        <Text style={[styles.body, { color: theme.muted }]}>
            Showing the last known state. Replies are paused.
        </Text>
    </View>
);

const styles = StyleSheet.create({
    banner: { borderBottomWidth: 1, gap: 3, paddingHorizontal: 16, paddingVertical: 10 },
    body: { fontSize: 13, lineHeight: 18 },
    title: { fontSize: 14, fontWeight: '700' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
