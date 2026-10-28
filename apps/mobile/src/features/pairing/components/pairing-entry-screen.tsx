import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { router } from 'expo-router';

import { Button } from '../../../components/button';
import { useTranslation } from '../../../i18n';
import { useMobileTheme } from '../../../theme/use-mobile-theme';
import { useMobileClient } from '../../connection/mobile-client-provider';

export const PairingEntryScreen = () => {
    const theme = useMobileTheme();
    const { t } = useTranslation();
    const { retryCredentialLoad, status } = useMobileClient();
    if (status === 'storage-error')
        return (
            <SafeAreaView
                edges={['top', 'right', 'bottom', 'left']}
                style={[styles.safeArea, { backgroundColor: theme.background }]}
                testID="credential-storage-error"
            >
                <View style={styles.frame}>
                    <View style={styles.message}>
                        <Text
                            accessibilityRole="header"
                            style={[styles.title, { color: theme.text }]}
                        >
                            {t('pairing.storageError.title')}
                        </Text>
                        <Text style={[styles.description, { color: theme.muted }]}>
                            {t('pairing.storageError.description')}
                        </Text>
                        <Button
                            accessibilityHint={t('pairing.storageError.retryHint')}
                            label={t('components.tryAgain')}
                            onPress={retryCredentialLoad}
                            size="primary"
                            testID="credential-storage-retry"
                            theme={theme}
                            variant="primary"
                        />
                    </View>
                </View>
            </SafeAreaView>
        );

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
                        accessibilityLabel={t('pairing.brandLabel')}
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
                            {t(wasRevoked ? 'pairing.revokedTitle' : 'pairing.pairTitle')}
                        </Text>
                        <Text style={[styles.description, { color: theme.muted }]}>
                            {t(
                                wasRevoked
                                    ? 'pairing.revokedDescription'
                                    : 'pairing.connectDescription',
                            )}
                        </Text>
                    </View>

                    <View style={styles.actions}>
                        <View
                            accessible
                            accessibilityLabel={t(
                                wasRevoked ? 'pairing.revokedLabel' : 'pairing.notConnectedLabel',
                            )}
                            style={styles.status}
                            testID="pairing-status"
                        >
                            <View style={[styles.statusDot, { backgroundColor: theme.muted }]} />
                            <Text style={[styles.statusText, { color: theme.muted }]}>
                                {t(wasRevoked ? 'pairing.pairAgain' : 'pairing.notConnected')}
                            </Text>
                        </View>
                        <Button
                            accessibilityHint={t('pairing.scanHint')}
                            label={t('pairing.scanCode')}
                            navigates
                            onPress={() => router.push('/pair/scan')}
                            size="primary"
                            testID="pairing-scan-button"
                            theme={theme}
                            variant="primary"
                        />
                        <Button
                            accessibilityHint={t('pairing.pasteHint')}
                            label={t('pairing.pasteLink')}
                            navigates
                            onPress={() => router.push('/pair/paste')}
                            size="primary"
                            testID="pairing-paste-button"
                            theme={theme}
                            variant="outline"
                        />
                        <Text style={[styles.footnote, { color: theme.muted }]}>
                            {t('pairing.footnote')}
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
