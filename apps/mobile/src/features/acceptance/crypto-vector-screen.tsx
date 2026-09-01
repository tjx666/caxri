import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { verifyMobileTransportAcceptanceVector } from '@caxri/mobile-transport';

import { useMobileTheme } from '../../theme/use-mobile-theme';

const styles = StyleSheet.create({
    content: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
    detail: { fontSize: 14, lineHeight: 20 },
    safeArea: { flex: 1 },
    status: { fontSize: 16, fontWeight: '700' },
    title: { fontSize: 22, fontWeight: '700' },
});

export const CryptoVectorScreen = () => {
    const theme = useMobileTheme();
    const result = verifyMobileTransportAcceptanceVector();
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.safeArea, { backgroundColor: theme.background }]}
            testID={`acceptance-crypto-vector-${result.status}`}
        >
            <View style={styles.content}>
                <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
                    Crypto runtime check
                </Text>
                <Text style={[styles.detail, { color: theme.muted }]}>
                    {result.vectorId} · protocol {result.protocolVersion}
                </Text>
                <Text style={[styles.status, { color: theme.text }]}>
                    {result.status === 'passed' ? 'Passed' : 'Failed'}
                </Text>
            </View>
        </SafeAreaView>
    );
};
