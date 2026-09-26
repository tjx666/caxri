import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { router } from 'expo-router';

import { ActionButton } from '../../../components/action-button';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { useMobileClient } from '../../connection/mobile-client-provider';

export const PairingEntryScreen = () => {
    const theme = useMobileTheme();
    const { status } = useMobileClient();
    const wasRevoked = status === 'revoked';

    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.safeArea, { backgroundColor: theme.background }]}
            testID="pairing-entry-screen"
        >
            <ScrollView contentContainerStyle={styles.scroll}>
                <View style={styles.frame}>
                    <View
                        accessible
                        accessibilityLabel="Caxri mobile companion"
                        style={styles.brand}
                    >
                        <View style={[styles.mark, { backgroundColor: theme.primary }]}>
                            <Text style={[styles.markText, { color: theme.primaryForeground }]}>
                                C
                            </Text>
                        </View>
                        <Text style={[styles.brandName, { color: theme.text }]}>Caxri</Text>
                    </View>

                    <View style={styles.message}>
                        <Text
                            accessibilityRole="header"
                            style={[styles.title, { color: theme.text }]}
                        >
                            {wasRevoked ? 'Pairing revoked' : 'Pair with Caxri'}
                        </Text>
                        <Text style={[styles.description, { color: theme.muted }]}>
                            {wasRevoked
                                ? 'This device was removed in Caxri. Pair it again to reconnect.'
                                : 'Connect to Caxri running on your computer.'}
                        </Text>
                    </View>

                    <View style={styles.actions}>
                        <View
                            accessible
                            accessibilityLabel={
                                wasRevoked
                                    ? 'Pairing revoked. Pair this device with Caxri again.'
                                    : 'Not connected. Pair this device with Caxri on your Mac.'
                            }
                            style={styles.status}
                            testID="pairing-status"
                        >
                            <View style={[styles.statusDot, { backgroundColor: theme.muted }]} />
                            <Text style={[styles.statusText, { color: theme.muted }]}>
                                {wasRevoked ? 'Pair again' : 'Not connected'}
                            </Text>
                        </View>
                        <ActionButton
                            navigates
                            accessibilityHint="Opens the camera to scan a pairing code shown by Caxri on your Mac."
                            onPress={() => router.push('/pair/scan')}
                            testID="pairing-scan-button"
                            theme={theme}
                        >
                            Scan pairing code
                        </ActionButton>
                        <ActionButton
                            navigates
                            accessibilityHint="Reads a Caxri pairing link from the clipboard."
                            onPress={() => router.push('/pair/paste')}
                            testID="pairing-paste-button"
                            theme={theme}
                            variant="secondary"
                        >
                            Paste pairing link
                        </ActionButton>
                        <Text style={[styles.footnote, { color: theme.muted }]}>
                            On your Mac, open Settings → Mobile and turn on Mobile access.
                        </Text>
                    </View>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    actions: {
        gap: 12,
    },
    brand: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 10,
    },
    brandName: {
        fontSize: 18,
        fontWeight: '700',
        letterSpacing: -0.4,
    },
    description: {
        fontSize: 16,
        lineHeight: 24,
        maxWidth: 460,
    },
    footnote: {
        fontSize: 13,
        lineHeight: 19,
        marginTop: 4,
        textAlign: 'center',
    },
    frame: {
        alignSelf: 'center',
        flex: 1,
        justifyContent: 'space-between',
        maxWidth: 520,
        paddingHorizontal: 24,
        paddingVertical: 22,
        width: '100%',
    },
    mark: {
        alignItems: 'center',
        borderRadius: 10,
        height: 34,
        justifyContent: 'center',
        width: 34,
    },
    markText: {
        fontSize: 17,
        fontWeight: '800',
    },
    message: {
        gap: 14,
        marginVertical: 40,
    },
    safeArea: {
        flex: 1,
    },
    scroll: {
        flexGrow: 1,
    },
    status: {
        alignItems: 'center',
        alignSelf: 'center',
        flexDirection: 'row',
        gap: 8,
        marginBottom: 6,
        paddingHorizontal: 2,
    },
    statusDot: {
        borderRadius: 4,
        height: 7,
        width: 7,
    },
    statusText: {
        fontSize: 14,
        fontWeight: '600',
    },
    title: {
        fontSize: 22,
        fontWeight: '700',
        letterSpacing: -0.5,
        lineHeight: 28,
        maxWidth: 460,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
